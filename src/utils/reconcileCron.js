/* ------------------------------------------------------------------ *
 *  reconcileCron.js  (NEW)
 *
 *  "Shopify threw a 429 / timed out — make sure that order still gets
 *   created, and make sure it gets created exactly ONCE."
 *
 *  There was already a MANUAL POST /admin/reconcile endpoint, but nothing
 *  ever called it. So a failed order sat as `shopifySync.status: "failed"`
 *  forever unless a human noticed. This runs it on a schedule.
 *
 *  ── HOW A DOUBLE-CREATE IS PREVENTED (the bug you asked about) ──────
 *
 *  A) ATOMIC LEASE. Candidates are claimed with a conditional
 *     findOneAndUpdate that stamps `shopifySync.lastAttemptAt`. Two
 *     workers racing the same order: the first stamps it; the second's
 *     filter (`lastAttemptAt < cutoff`) no longer matches, so it gets
 *     null and skips. Uses only fields that already exist — no migration.
 *
 *  B) AGE GATE. We only touch orders whose last attempt is older than
 *     RETRY_AFTER_MS (10 min). This is what the old /admin/reconcile got
 *     wrong: it scanned `status: "pending"` with NO age filter, so it
 *     would grab an order that was *still mid-flight* to Shopify and fire
 *     a SECOND create for it. That alone could duplicate an order.
 *
 *  C) shopifyOrderId GUARD. If we already know the Shopify id, the order
 *     is done — it is never a candidate, full stop.
 *
 *  D) TAG HEAL (in the Remix app). Before creating, Remix now searches
 *     Shopify for an order tagged `dbid:<orderId>`. If Shopify actually
 *     created it and only the RESPONSE was lost (timeout / dropped
 *     socket), we adopt that order instead of making a twin.
 *     -> see shopifyClient.ts :: findShopifyOrderByTag
 *
 *  E) ATTEMPT CAP. After MAX_ATTEMPTS we stop and leave it for a human,
 *     rather than hammering Shopify forever with a payload it hates.
 * ------------------------------------------------------------------ */

import cron from "node-cron";
import { RECURRING_MATCH } from "./cycle.js";
import axios from "axios";
import { resolveRemixUrl } from "./remixUrl.js";
import { OrderModel, RenewalLogModel } from "../model/orderModel.js";
import { flushPendingSheets } from "./sheet.js";
import { backfillMonthlySheet } from "./monthlySheet.js";
import { withLock } from "./cronLock.js";
import { sleep } from "./retry.js";

/* ++ FIXED ++  Was a hand-rolled fallback that couldn't work:
     reconcileCron       -> "/api/create-order"   (a RELATIVE path — axios can't POST to that)
     retry/shopifyadmin  -> a hardcoded tunnel URL that is now dead
   And none of them normalised SHOPIFY_APP_URL, so a base-URL-only value
   (the Shopify CLI's format) POSTed to "/" and got a 405.
   One resolver, one behaviour, throws loudly if unset. See remixUrl.js. */
const REMIX_URL = () => resolveRemixUrl();

const LOCK = "shopify-reconcile";
const LOCK_TTL_MS = 20 * 60 * 1000;

/* Do not touch an order whose last attempt is newer than this — it may
   still be in flight. This is the single most important knob here. */
const RETRY_AFTER_MS = Number(
  process.env.SHOPIFY_RETRY_AFTER_MS || 10 * 60 * 1000,
);

const MAX_ATTEMPTS = Number(process.env.SHOPIFY_MAX_ATTEMPTS || 6);

/* ⚠ AGE CAP.
 *
 * The reconciler's job is "make sure every order eventually reaches
 * Shopify". Left uncapped, "eventually" means FOREVER — it will happily
 * keep trying to push an order that was placed a month ago and has been
 * failing every 10 minutes ever since.
 *
 * That's wrong on two counts:
 *   - Nobody wants a 26-day-old unfulfilled order to suddenly ship itself
 *     without a human looking at it. The customer ordered in JUNE.
 *   - It buries the log in noise, so the orders you COULD still save are
 *     invisible among the ones you can't.
 *
 * Past this age we stop and mark the order "skipped". It stays in the DB,
 * it shows up in GET /api/v1/retry/stuck, and POST /api/v1/retry/force
 * still revives it — but a human has to decide, not a cron. */
/* ⚠ DRY RUN — set this for the FIRST cycle in production.
 *
 * The reconciler will scan, log exactly what it WOULD push to Shopify, and
 * then do absolutely nothing. Read one cycle of logs, satisfy yourself the
 * list is what you expect, then turn it off.
 *
 * This exists because the first tick in a production database is the single
 * most dangerous moment in this system's life: it will happily create every
 * order that ever failed to sync, however old, on the LIVE store. Real
 * devices, real addresses, nobody watching. Look before you leap. */
const DRY_RUN = process.env.RECONCILE_DRY_RUN === "true";

const MAX_AGE_DAYS = Number(process.env.RECONCILE_MAX_AGE_DAYS || 7);
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = Number(process.env.SHOPIFY_RECONCILE_LIMIT || 100);

/* Remix already paces + backs off internally (shopifyClient.ts). This is
   a second, coarser throttle so a backlog of 100 failures doesn't become
   a 100-request burst the moment Shopify comes back up. */
const PER_CALL_DELAY_MS = Number(process.env.SHOPIFY_RECONCILE_DELAY_MS || 700);

/* ⚠ MUST EXCEED Remix's worst case.
   Remix: 1 order-cap retry x 61s + request time ≈ 65s.
   45s (the old value) meant Node gave up BEFORE Remix even woke from its
   backoff — the request was abandoned mid-flight and the RenewalLog sat at
   status:"processing" forever. */
const REMIX_TIMEOUT_MS = Number(process.env.REMIX_TIMEOUT_MS || 120_000);

/* A TIMEOUT is not a failure — it's "we stopped listening". Remix may well
   still be working, and may still call /order/confirm. So a timeout must
   NOT (a) burn the attempt cap or (b) force the row to "failed". We just
   let the lease expire and re-check on the next round; by then Remix will
   have confirmed, or not. */
const isTimeout = (e) =>
  e?.code === "ECONNABORTED" ||
  e?.code === "ETIMEDOUT" ||
  /timeout/i.test(String(e?.message || ""));

/* A rate limit is NOT a bad payload. It must not consume the attempt cap —
   otherwise a store that 429s us MAX_ATTEMPTS times in a row drops the order
   permanently. See confirmOrder for the full reasoning. */
const isRateLimitErr = (e) => {
  const txt =
    JSON.stringify(e?.response?.data ?? "") + " " + String(e?.message || "");
  return (
    /rate limit|too many requests|exceeded .* api rate/i.test(txt) ||
    e?.response?.status === 429
  );
};

const flagOf = (o) => (o.source === "Defent La" ? "defentLA" : "defentWeho");

const basePayload = (o) => ({
  orderId: o._id.toString(),
  firstName: o.firstName,
  lastName: o.lastName,
  streetAddress: o.streetAddress,
  streetAddress2: o.streetAddress2 || "",
  postCode: o.postCode,
  email: o.email,
  productId: o.productId,
  subscription: o.subscription,
  flag: flagOf(o),
  demographics: {
    age: o.demographics?.age || "",
    gender: o.demographics?.gender || "",
    identity: o.demographics?.identity || "",
    household_size: o.demographics?.household_size || "",
    ethnicity: o.demographics?.ethnicity || "",
    household_language: o.demographics?.household_language || "",
    identifyAsLGBTQ: o.demographics?.identifyAsLGBTQ || "",
    wehoHearAboutUs: o.demographics?.wehoHearAboutUs || "",
  },
});

/* ------------------------------------------------------------------ *
 *  (A) FIRST-TIME orders that never reached Shopify.
 * ------------------------------------------------------------------ */
async function findFailedFirstTime() {
  const cutoff = new Date(Date.now() - RETRY_AFTER_MS);
  return OrderModel.find({
    shopifyOrderId: null, // (C) never re-push a synced order
    "shopifySync.status": { $in: ["pending", "failed"] },
    "shopifySync.attempts": { $lt: MAX_ATTEMPTS }, // (E)
    $or: [
      { "shopifySync.lastAttemptAt": null },
      { "shopifySync.lastAttemptAt": { $lt: cutoff } }, // (B)
    ],
    createdAt: {
      $lt: cutoff, // brand-new: still in flight
      $gt: new Date(Date.now() - MAX_AGE_MS), // too old: don't auto-ship
    },
  })
    .sort({ createdAt: 1 })
    .limit(MAX_PER_RUN)
    .lean();
}

/** (A) Atomic claim. Only ONE worker can win an order. */
async function claimOrder(orderId) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETRY_AFTER_MS);
  return OrderModel.findOneAndUpdate(
    {
      _id: orderId,
      shopifyOrderId: null,
      "shopifySync.status": { $in: ["pending", "failed"] },
      "shopifySync.attempts": { $lt: MAX_ATTEMPTS },
      $or: [
        { "shopifySync.lastAttemptAt": null },
        { "shopifySync.lastAttemptAt": { $lt: cutoff } },
      ],
    },
    // Stamping lastAttemptAt IS the lease: a racing worker's filter above
    // stops matching the instant this lands.
    { $set: { "shopifySync.lastAttemptAt": now } },
    { new: true },
  ).lean();
}

/* ------------------------------------------------------------------ *
 *  (B) RENEWAL cycles that were claimed but never confirmed, or that
 *      failed outright. Same lease pattern on the RenewalLog.
 * ------------------------------------------------------------------ */
async function findStuckRenewals() {
  const cutoff = new Date(Date.now() - RETRY_AFTER_MS);
  return RenewalLogModel.find({
    status: { $in: ["processing", "failed"] },
    shopifyOrderId: null,
    "shopifySync.attempts": { $lt: MAX_ATTEMPTS },
    $or: [
      { "shopifySync.lastAttemptAt": null },
      { "shopifySync.lastAttemptAt": { $lt: cutoff } },
    ],
    updatedAt: { $lt: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(MAX_PER_RUN)
    .populate("orderId")
    .lean();
}

async function claimRenewal(logId) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETRY_AFTER_MS);
  return RenewalLogModel.findOneAndUpdate(
    {
      _id: logId,
      status: { $in: ["processing", "failed"] },
      shopifyOrderId: null,
      "shopifySync.attempts": { $lt: MAX_ATTEMPTS },
      $or: [
        { "shopifySync.lastAttemptAt": null },
        { "shopifySync.lastAttemptAt": { $lt: cutoff } },
      ],
    },
    { $set: { status: "processing", "shopifySync.lastAttemptAt": now } },
    { new: true },
  ).lean();
}

/* ================================================================== */
/* Retire orders too old to auto-ship. They're not lost — /retry/stuck lists
   them and /retry/force revives them — but the cron stops churning on them. */
async function deadLetterStale() {
  const cutoff = new Date(Date.now() - MAX_AGE_MS);

  if (DRY_RUN) {
    const n = await OrderModel.countDocuments({
      shopifyOrderId: null,
      "shopifySync.status": { $in: ["pending", "failed"] },
      createdAt: { $lt: cutoff },
    });
    if (n) {
      console.warn(
        `[cron:reconcile] 🔍 DRY RUN — would retire ${n} order(s) older than ${MAX_AGE_DAYS} days (not shipped, left for a human)`,
      );
    }
    return 0; // a dry run writes NOTHING
  }

  const orders = await OrderModel.updateMany(
    {
      shopifyOrderId: null,
      "shopifySync.status": { $in: ["pending", "failed"] },
      createdAt: { $lt: cutoff },
    },
    {
      $set: {
        "shopifySync.status": "skipped",
        "shopifySync.lastError": `never reached Shopify within ${MAX_AGE_DAYS} days — needs a human (POST /api/v1/retry/force to revive)`,
      },
    },
  );

  const logs = await RenewalLogModel.updateMany(
    {
      shopifyOrderId: null,
      status: { $in: ["processing", "failed"] },
      createdAt: { $lt: cutoff },
    },
    {
      $set: {
        "shopifySync.status": "skipped",
        "shopifySync.lastError": `renewal never reached Shopify within ${MAX_AGE_DAYS} days — needs a human`,
      },
    },
  );

  const n = (orders.modifiedCount || 0) + (logs.modifiedCount || 0);
  if (n) {
    console.warn(
      `[cron:reconcile] ⚠ retired ${n} item(s) older than ${MAX_AGE_DAYS} days — ` +
        `they will NOT auto-ship. See: GET /api/v1/retry/stuck`,
    );
  }
  return n;
}

async function runReconcileInner() {
  const deadLettered = await deadLetterStale();

  const result = {
    firstTimeRetried: 0,
    renewalsRetried: 0,
    healed: 0,
    stillFailing: 0,
    rateLimited: 0,
    timedOut: 0,
    deadLettered,
    sheet: null,
  };

  /* ---------- first-time orders ---------- */
  const candidates = await findFailedFirstTime();

  if (DRY_RUN && candidates.length) {
    console.warn(
      `\n[cron:reconcile] 🔍 DRY RUN — would push ${candidates.length} first-time order(s) to Shopify:`,
    );
    for (const c of candidates) {
      const age = Math.round((Date.now() - new Date(c.createdAt)) / 864e5);
      console.warn(
        `   ${c._id}  ${c.firstName} ${c.lastName}  <${c.email}>  ` +
          `${c.subscription}  ${age}d old  product=${c.productId}`,
      );
    }
    console.warn(
      `   (nothing was sent. unset RECONCILE_DRY_RUN to go live.)\n`,
    );
  }

  for (const cand of candidates) {
    if (DRY_RUN) continue;
    const claimed = await claimOrder(cand._id);
    if (!claimed) continue; // another worker got it

    try {
      // retry:true -> Remix skips validation/dedup, checks Shopify for an
      // existing `dbid:` tag first (heal), then creates + confirms.
      const { data } = await axios.post(
        REMIX_URL(),
        { ...basePayload(claimed), retry: true, isRenewal: false },
        { timeout: REMIX_TIMEOUT_MS },
      );

      if (data?.healed) result.healed += 1;
      if (data?.success) result.firstTimeRetried += 1;
      else result.stillFailing += 1;
    } catch (e) {
      result.stillFailing += 1;
      const rl = isRateLimitErr(e);
      const to = isTimeout(e);
      if (rl) result.rateLimited += 1;
      if (to) result.timedOut += 1;

      const upd = {
        $set: {
          "shopifySync.lastError": (e?.message || "reconcile failed").slice(
            0,
            500,
          ),
        },
      };
      /* A timeout means Remix may STILL be working and may still confirm.
         Don't stomp the row to "failed" — just let the lease expire. */
      if (!to) upd.$set["shopifySync.status"] = "failed";
      /* Only a REAL error counts toward the cap. Rate limits and timeouts
         are "come back later", not "this payload is broken". */
      if (!rl && !to) upd.$inc = { "shopifySync.attempts": 1 };

      await OrderModel.updateOne({ _id: claimed._id }, upd);
      console.error(
        `[cron:reconcile] first-time ${rl ? "RATE LIMITED" : to ? "TIMED OUT (Remix may still finish)" : "FAILED"}` +
          `${rl || to ? " — cap not consumed" : ""}:`,
        String(claimed._id),
        e?.message,
      );
    }

    await sleep(PER_CALL_DELAY_MS);
  }

  /* ---------- stuck / failed renewals ---------- */
  const stuck = await findStuckRenewals();

  if (DRY_RUN && stuck.length) {
    console.warn(
      `[cron:reconcile] 🔍 DRY RUN — would retry ${stuck.length} renewal cycle(s):`,
    );
    for (const l of stuck) {
      const o = l.orderId;
      console.warn(
        `   ${l._id}  order=${o?._id}  cycle=${l.cycle}  status=${l.status}`,
      );
    }
    console.warn(`   (nothing was sent.)\n`);
  }

  for (const log of stuck) {
    if (DRY_RUN) continue;
    const order = log.orderId;
    if (!order?._id) continue;

    const claimed = await claimRenewal(log._id);
    if (!claimed) continue;

    try {
      const { data } = await axios.post(
        REMIX_URL(),
        {
          ...basePayload(order),
          subscription: RECURRING_MATCH,
          cycle: log.cycle, // SAME cycle -> same tag -> heals, never twins
          retry: true,
          isRenewal: true,
        },
        { timeout: REMIX_TIMEOUT_MS },
      );

      if (data?.healed) result.healed += 1;
      if (data?.success) result.renewalsRetried += 1;
      else result.stillFailing += 1;
    } catch (e) {
      result.stillFailing += 1;
      const rl = isRateLimitErr(e);
      const to = isTimeout(e);
      if (rl) result.rateLimited += 1;
      if (to) result.timedOut += 1;

      const upd = {
        $set: {
          "shopifySync.lastError": (e?.message || "reconcile failed").slice(
            0,
            500,
          ),
        },
      };
      if (!to) {
        upd.$set.status = "failed";
        upd.$set["shopifySync.status"] = "failed";
      }
      if (!rl && !to) upd.$inc = { "shopifySync.attempts": 1 };

      await RenewalLogModel.updateOne({ _id: log._id }, upd);
      console.error(
        `[cron:reconcile] renewal ${rl ? "RATE LIMITED" : to ? "TIMED OUT (Remix may still finish)" : "FAILED"}` +
          `${rl || to ? " — cap not consumed" : ""}:`,
        String(log._id),
        e?.message,
      );
    }

    await sleep(PER_CALL_DELAY_MS);
  }

  /* ---------- sheets backstop ---------- */
  // Weho / LA "Orders" sheets: re-append anything still pending or failed.
  result.sheet = DRY_RUN ? { dryRun: true } : await flushPendingSheets();

  /* Consolidated MONTHLY sheet: appendMonthly() is best-effort and can lose
     a row to a Sheets 429 at intake. The backfill is idempotent (it skips
     Order IDs already present in column A), so running it here turns that
     silent loss into a ≤10-minute delay instead of "gone until a human
     hits /order/sync-monthly-sheet". */
  try {
    result.monthlySheet = await backfillMonthlySheet({ limit: 500 });
  } catch (e) {
    console.error("[cron:reconcile] monthly backfill failed:", e?.message);
    result.monthlySheet = { error: e?.message };
  }

  const touched =
    result.firstTimeRetried + result.renewalsRetried + result.stillFailing;
  if (
    touched ||
    result.sheet?.firstTime ||
    result.sheet?.renewals ||
    result.monthlySheet?.appended
  ) {
    console.log(`[cron:reconcile] ${JSON.stringify(result)}`);
  }
  return result;
}

export async function runReconcile() {
  return withLock(LOCK, LOCK_TTL_MS, async () => {
    try {
      return await runReconcileInner();
    } catch (err) {
      console.error("[cron:reconcile] fatal:", err?.message);
      return { error: err?.message };
    }
  });
}

/* Every 10 minutes. Frequent enough that a Shopify 429 storm is cleaned
   up within the hour; spaced enough that we never become the storm. */
if (DRY_RUN) {
  console.warn(
    "\n  🔍 RECONCILE_DRY_RUN=true — the reconciler will LOG what it would do and push NOTHING.\n",
  );
}

cron.schedule(process.env.RECONCILE_CRON || "*/10 * * * *", runReconcile);

export default runReconcile;
