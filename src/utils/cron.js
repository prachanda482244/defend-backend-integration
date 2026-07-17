// cron/recurring.js
import cron from "node-cron";
import axios from "axios";
import { resolveRemixUrl } from "./remixUrl.js";
import { OrderModel } from "../model/orderModel.js";
import { flushPendingSheets } from "./sheet.js";
import { withLock } from "./cronLock.js";
import { sleep } from "./retry.js";

/* Registering the two new jobs here means index.js keeps its single
   `import "./utils/cron.js"` line and nothing else changes. */
import "./reminderCron.js"; // 15-day "cancel your subscription" email
import "./reconcileCron.js"; // retry Shopify orders that 429'd / timed out

/* Resolved lazily so a base-URL-only SHOPIFY_APP_URL (the Shopify CLI
   format) still works — see remixUrl.js. */
const REMIX_URL = () => resolveRemixUrl();

/* ++ QUARTERLY ++  The cycle is now CALENDAR MONTHS, not days.
   90-day counting drifts (Apr 1 + 90d = Jun 30, not Jul 1) and never
   recovers. See cycle.js for the full reasoning. */
import {
  CYCLE_MONTHS,
  SNAP_TO_FIRST,
  cycleSummary,
  RECURRING_MATCH,
} from "./cycle.js";

const LOCK_NAME = "recurring-renewals";
const LOCK_TTL_MS = 30 * 60 * 1000;
const PER_CALL_DELAY_MS = Number(process.env.RENEWAL_DELAY_MS || 700);
const MAX_PER_RUN = Number(process.env.RENEWAL_MAX_PER_RUN || 300);

/* One renewal per PERSON as well as per household. Default on — see the
   "customer moved" case in the notes below. */
const DEDUPE_BY_EMAIL = process.env.RENEWAL_DEDUPE_BY_EMAIL !== "false";

/* Turn off replaced subscriptions so they stop showing up as "due" every
   night forever. Default on. */
const RETIRE_SUPERSEDED = process.env.RETIRE_SUPERSEDED !== "false";

/* ================================================================== *
 *  findDueRenewals — WHICH order do we actually renew?
 *
 *  ⚠⚠  THIS WAS A BUG.  ⚠⚠
 *
 *  The old pipeline was:
 *      { $sort:  { renewAt: 1, createdAt: -1 } }        <-- renewAt: 1
 *      { $group: { _id: {addr}, doc: { $first: "$$ROOT" } } }
 *
 *  `renewAt: 1` is ASCENDING — oldest first. `$group` + `$first` returns
 *  the FIRST document in sort order. So it picked the OLDEST order at each
 *  address. The comment above it claimed "this guarantees only the newest
 *  renews" — it did exactly the opposite.
 *
 *  Concretely, with test1@gmail.com holding an old stuck subscription and
 *  a new one:
 *
 *      ORDER_A  created Jan 5   product 1111   (renewals had been failing,
 *                                               so lastRenewAt never moved)
 *      ORDER_B  created Jun 1   product 9999   (the CURRENT subscription)
 *
 *      OLD -> renews ORDER_A and ships product 1111.
 *             ORDER_B — the one they actually signed up for — NEVER renews.
 *      NEW -> renews ORDER_B and ships product 9999.
 *
 *  And since the loop below sends `productId: order.productId` from
 *  whichever doc this returns, picking the wrong doc means shipping the
 *  wrong product. That is the "only the product they subscribed to"
 *  requirement, and it lives here.
 *
 *  ── THE RULE NOW ──────────────────────────────────────────────────
 *   1. NEWEST FIRST     -> renew the order they most recently placed.
 *   2. One per HOUSEHOLD (normalizedAddress + line 2).
 *   3. One per PERSON    (email) -> someone who moved doesn't get a second
 *      shipment sent to the address they moved out of.
 *   4. Two different units / two different emails at one street address
 *      still BOTH renew. Nobody legitimate is denied.
 * ================================================================== */
async function findDueRenewals() {
  const now = new Date();

  const pipeline = [
    {
      $match: {
        subscription: RECURRING_MATCH,
        isActive: true,
        isRenewable: true,
      },
    },
    { $addFields: { renewAt: { $ifNull: ["$lastRenewAt", "$createdAt"] } } },

    /* ++ QUARTERLY ++  Due when renewAt + CYCLE_MONTHS calendar months has
       arrived. $dateAdd does real month arithmetic (and clamps month-ends:
       Jan 31 + 1 month = Feb 28). Requires MongoDB 5.0+, which you have.

       ++ CLIENT RULE ++  SNAPPED TO THE 1st, exactly like cycle.js's
       nextDueAt(): base = renewAt + cycle; if base is already the 1st it
       stays, otherwise round UP to the 1st of the next month.
       (Jun 17 -> Oct 1 -> Jan 1 -> Apr 1.) The two computations MUST
       agree, or the cron would claim renewals the API's isDue() then
       rejects as not-due — a 409 loop. */
    {
      $addFields: {
        dueBase: {
          $dateAdd: {
            startDate: "$renewAt",
            unit: "month",
            amount: CYCLE_MONTHS,
          },
        },
      },
    },
    {
      $addFields: {
        dueAt: SNAP_TO_FIRST
          ? {
              $cond: [
                { $eq: [{ $dayOfMonth: "$dueBase" }, 1] },
                "$dueBase",
                {
                  $dateAdd: {
                    startDate: {
                      $dateTrunc: { date: "$dueBase", unit: "month" },
                    },
                    unit: "month",
                    amount: 1,
                  },
                },
              ],
            }
          : "$dueBase",
      },
    },
    { $match: { dueAt: { $lte: now } } },

    /* ++ NEW ++  DON'T TOUCH A CYCLE THAT'S ALREADY BEEN STARTED.
     *
     * If a RenewalLog exists for (order, currentCycle) — in ANY state —
     * then this cycle is no longer the renewal cron's business:
     *
     *   completed  -> already shipped
     *   processing -> in flight right now
     *   failed     -> reconcileCron is retrying it
     *
     * Without this filter the cron re-picks those orders on EVERY tick,
     * gets "already claimed" back, and logs a no-op. Forever. That's the
     * `[cron] renewal no-op: 6a547a7e...` line you keep seeing every 30
     * seconds — the renewal cron nagging about an order the reconciler
     * already owns.
     *
     * The renewal cron STARTS cycles. The reconciler FINISHES them. */
    {
      $lookup: {
        from: "renewallogs",
        let: {
          oid: "$_id",
          cyc: {
            $dateToString: {
              date: "$renewAt",
              format: "%Y-%m-%d",
              timezone: "UTC", // cycle key is lastRenewAt.toISOString().slice(0,10)
            },
          },
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$orderId", "$$oid"] },
                  { $eq: ["$cycle", "$$cyc"] },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: "currentCycleLog",
      },
    },
    { $match: { currentCycleLog: { $size: 0 } } },

    /* NEWEST FIRST. (was `renewAt: 1` = oldest first — the bug) */
    { $sort: { createdAt: -1, renewAt: -1, _id: -1 } },

    /* ---- one per HOUSEHOLD: the CURRENT subscription at that address ---- */
    {
      $group: {
        _id: {
          addr: "$normalizedAddress",
          addr2: { $ifNull: ["$normalizedAddress2", ""] },
        },
        doc: { $first: "$$ROOT" },
      },
    },
    { $replaceRoot: { newRoot: "$doc" } },
  ];

  if (DEDUPE_BY_EMAIL) {
    /* ---- one per PERSON ----
     * Same email at two different addresses means they moved. Renewing both
     * ships a device to the place they left. Take the newest. */
    pipeline.push(
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: { $toLower: { $ifNull: ["$email", ""] } },
          doc: { $first: "$$ROOT" },
        },
      },
      { $replaceRoot: { newRoot: "$doc" } },
    );
  }

  pipeline.push({ $sort: { createdAt: -1 } }, { $limit: MAX_PER_RUN });

  return OrderModel.aggregate(pipeline);
}

/* ================================================================== *
 *  retireSuperseded — stop replaced subscriptions renewing at all.
 *
 *  findDueRenewals() already refuses to pick them, but left alone they'd
 *  sit in the "due" set forever, re-evaluated every night. Worse: if the
 *  current order were later cancelled, the stale one would quietly take
 *  over and start shipping the OLD product again.
 *
 *  So any monthly subscription replaced by a NEWER monthly subscription
 *  for the same household (or the same person) is retired.
 *  isRenewable/isActive -> false, and `supersededBy` records which order
 *  replaced it — auditable, and reversible if you ever need to.
 * ================================================================== */
async function retireSuperseded() {
  if (!RETIRE_SUPERSEDED) return { retired: 0 };

  const groupsFor = (idExpr) =>
    OrderModel.aggregate([
      {
        $match: {
          subscription: RECURRING_MATCH,
          isActive: true,
          isRenewable: true,
        },
      },
      { $sort: { createdAt: -1, _id: -1 } }, // newest first
      {
        $group: {
          _id: idExpr,
          keep: { $first: "$_id" }, // the current subscription
          all: { $push: "$_id" },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } }, // only groups that actually have a duplicate
    ]);

  const groups = [
    ...(await groupsFor({
      addr: "$normalizedAddress",
      addr2: { $ifNull: ["$normalizedAddress2", ""] },
    })),
    ...(DEDUPE_BY_EMAIL
      ? await groupsFor({ $toLower: { $ifNull: ["$email", ""] } })
      : []),
  ];

  let retired = 0;
  for (const g of groups) {
    const losers = g.all.filter((id) => String(id) !== String(g.keep));
    if (!losers.length) continue;

    const r = await OrderModel.updateMany(
      { _id: { $in: losers }, isRenewable: true },
      {
        $set: {
          isRenewable: false,
          isActive: false,
          supersededBy: g.keep,
        },
      },
    );
    retired += r.modifiedCount || 0;

    if (r.modifiedCount) {
      console.log(
        `[cron] retired ${r.modifiedCount} superseded subscription(s); current = ${g.keep}`,
      );
    }
  }

  return { retired };
}

/* ================================================================== */
async function runRenewalsInner() {
  /* Retire replaced subscriptions BEFORE selecting, so a stale order can
     never be picked even if the selection logic changes later. */
  const { retired } = await retireSuperseded();

  const due = await findDueRenewals();
  if (!due.length) {
    console.log(`[cron] no subscriptions due. (retired=${retired})`);
    await flushPendingSheets(); // an intake row may still be pending
    return { ok: 0, noop: 0, failed: 0, retired };
  }
  console.log(
    `[cron] ${due.length} subscription(s) due. (${cycleSummary()}, retired=${retired})`,
  );

  let ok = 0;
  let failed = 0;
  let noop = 0; // completed-already / in-flight — NOT progress

  for (const order of due) {
    try {
      /* Everything below comes from the ORDER DOC we selected — the
         customer's CURRENT subscription. `productId` in particular is the
         product THEY subscribed to on THIS order, never one inherited from
         an older order at the same address.

         Remix also re-reads this same doc from Node before it touches
         Shopify (see api.create-order.tsx), so even if this payload were
         tampered with in transit, the Shopify order is still built from
         what the database actually holds. */
      const resp = await axios.post(
        REMIX_URL(),
        {
          orderId: order._id.toString(),
          firstName: order.firstName,
          lastName: order.lastName,
          streetAddress: order.streetAddress,
          streetAddress2: order.streetAddress2 || "",
          postCode: order.postCode,
          email: order.email,
          productId: order.productId, // <- the subscribed product
          subscription: RECURRING_MATCH,
          flag: order.source === "Defent La" ? "defentLA" : "defentWeho",
          isRenewal: true,
          demographics: {
            age: order.demographics?.age || "",
            gender: order.demographics?.gender || "",
            identity: order.demographics?.identity || "",
            household_size: order.demographics?.household_size || "",
            ethnicity: order.demographics?.ethnicity || "",
            household_language: order.demographics?.household_language || "",
            identifyAsLGBTQ: order.demographics?.identifyAsLGBTQ || "",
            wehoHearAboutUs: order.demographics?.wehoHearAboutUs || "",
          },
        },
        { timeout: Number(process.env.REMIX_TIMEOUT_MS || 120_000) },
      );

      const d = resp.data || {};

      if (resp.status !== 200 || d.success !== true) {
        failed += 1;
        console.error(
          "[cron] renewal not ok:",
          order._id.toString(),
          d.message,
        );
      } else if (d.alreadyClaimed || d.alreadyCompleted) {
        /* ++ NOT a success. ++
           These used to be counted as ok=, which is how an infinite loop
           managed to report "ok=9" every 30 seconds while advancing
           nothing. A no-op is a no-op — say so. */
        noop += 1;
        console.warn(
          `[cron] renewal no-op: ${order._id} — ${d.alreadyClaimed ? "cycle already claimed (reconciler owns it)" : "cycle already completed"}`,
        );
      } else {
        ok += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(
        "[cron] renewal error:",
        order._id.toString(),
        err?.response?.data || err?.message,
      );
      /* Not lost: confirmOrder marks the RenewalLog "failed" (it no longer
         deletes it) and reconcileCron retries within ~10 minutes, healing
         via the Shopify tag lookup so a retry cannot duplicate. */
    }

    await sleep(PER_CALL_DELAY_MS);
  }

  const sheet = await flushPendingSheets();

  console.log(
    `[cron] done. created=${ok} noop=${noop} failed=${failed} retired=${retired} sheet=${JSON.stringify(sheet)}`,
  );

  /* If EVERY due order was a no-op, the clock isn't advancing and we will
     re-run the identical set on the next tick, forever. Shout about it. */
  if (noop > 0 && ok === 0 && failed === 0) {
    console.warn(
      `[cron] ⚠ ALL ${noop} due renewals were no-ops — lastRenewAt is not advancing.\n` +
        `      These orders will be re-picked every tick. Check:\n` +
        `        db.renewallogs.find({ status: "completed" })   // cycle already done?\n` +
        `      and run:  node scripts/why-no-renewal.mjs`,
    );
  }

  return { ok, noop, failed, retired, sheet };
}

async function runRenewals() {
  return withLock(LOCK_NAME, LOCK_TTL_MS, async () => {
    try {
      return await runRenewalsInner();
    } catch (err) {
      console.error("[cron] fatal:", err?.message);
      return { error: err?.message };
    }
  });
}

// ⚠ production: midnight daily. For testing swap to "*/30 * * * * *".
cron.schedule(process.env.RENEWAL_CRON || "0 0 * * *", runRenewals, {
  timezone: process.env.CRON_TZ || "America/Los_Angeles",
});

export { runRenewals, findDueRenewals, retireSuperseded };
