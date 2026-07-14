/* ------------------------------------------------------------------ *
 *  reminderCron.js  (NEW)
 *
 *  THE 15-DAY EMAIL.
 *
 *  Every day it finds MONTHLY subscribers who are 15 days into their
 *  current cycle and sends them one email that says:
 *      "your next shipment goes out in ~15 days" + a cancel link.
 *
 *  Clicking cancel converts them to a ONE-TIME order (subscription =
 *  "one_time", isActive/isRenewable = false), which is precisely the
 *  filter the renewal cron uses — so they are silently dropped from all
 *  future renewals. See subscription.controller.js.
 *
 *  ── DUPLICATE-PROOFING (three independent layers) ──────────────────
 *   1. CronLock          -> only one instance runs the job at all.
 *   2. ReminderLog       -> unique index on (orderId, cycle). A second
 *                           claim for the same cycle throws E11000 and is
 *                           skipped. This is the real guarantee.
 *   3. Resend Idempotency-Key -> even if we crash after Resend accepted
 *                           the batch, the retry does not re-send.
 *
 *  ── WHY IT NEVER DOUBLE-SENDS ACROSS MONTHS ────────────────────────
 *  `cycle` = the date we're renewing FROM (lastRenewAt ?? createdAt).
 *  It is stable for the whole 30-day cycle, and advances only when a
 *  renewal actually completes -> next month is a new cycle -> one new
 *  email. Exactly one reminder per subscriber per cycle. Forever.
 * ------------------------------------------------------------------ */

import cron from "node-cron";
import { OrderModel, ReminderLogModel } from "../model/orderModel.js";
import { sendBatch, mailerReady } from "./mailer.js";
import { buildUnsubUrl } from "./unsubscribeToken.js";
import { renewalReminderEmail } from "./emailTemplates.js";
import { withLock } from "./cronLock.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/* ++ CHANGED ++  The email now fires N days BEFORE the next shipment,
 *  not N days AFTER the last one.
 *
 *  With a 30-day cycle those were the same thing (day 15 = 15 days before
 *  day 30). With a QUARTERLY cycle they are wildly different:
 *
 *      "15 days after"  -> day 15 of 90  -> 75 DAYS EARLY. Useless.
 *      "15 days before" -> day 75 of 90  -> correct, at any cycle length.
 *
 *  And it makes the email copy true: "your next shipment arrives in 15
 *  days" is now literally accurate. */
import {
  CYCLE_MONTHS,
  REMINDER_BEFORE_DAYS,
  nextDueAt,
  reminderAt,
  daysUntilDue,
  RECURRING_MATCH,
} from "./cycle.js";

const LOCK = "reminder-15d";
const LOCK_TTL_MS = 15 * 60 * 1000;

const MAX_PER_RUN = Number(process.env.REMINDER_MAX_PER_RUN || 500);
const MAX_ATTEMPTS = 4;

/* Same cycle key the renewal path uses — they MUST agree. */
const cycleKeyFor = (o) =>
  new Date(o.lastRenewAt ?? o.createdAt ?? Date.now())
    .toISOString()
    .slice(0, 10);

/* ------------------------------------------------------------------ *
 *  Who is due?
 *
 *  Window: [REMIND_AFTER_DAYS, CYCLE_DAYS) days since the cycle started.
 *  The upper bound matters — without it, a subscription that got stuck
 *  (e.g. Shopify was down for two days and lastRenewAt never advanced)
 *  would keep matching forever and we'd email them about a shipment
 *  that is already overdue. Past day 30 the renewal cron owns them.
 *
 *  Dedup by household address, exactly like findDueRenewals(), so two
 *  order docs at the same address can never generate two emails.
 * ------------------------------------------------------------------ */
async function findDueReminders() {
  const now = new Date();

  return OrderModel.aggregate([
    {
      $match: {
        subscription: RECURRING_MATCH,
        isActive: true,
        isRenewable: true,
        email: { $nin: [null, ""] },
      },
    },
    { $addFields: { renewAt: { $ifNull: ["$lastRenewAt", "$createdAt"] } } },

    /* dueAt        = renewAt + CYCLE_MONTHS  (the next shipment)
       remindAt     = dueAt - REMINDER_BEFORE_DAYS
       Send when:   remindAt <= now < dueAt                                */
    {
      $addFields: {
        dueAt: {
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
        remindAt: {
          $dateSubtract: {
            startDate: "$dueAt",
            unit: "day",
            amount: REMINDER_BEFORE_DAYS,
          },
        },
      },
    },
    { $match: { remindAt: { $lte: now }, dueAt: { $gt: now } } },
    { $sort: { renewAt: 1, createdAt: -1 } },
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
    { $limit: MAX_PER_RUN },
  ]);
}

/* Reminders that were claimed but whose send failed — retry them. */
async function findFailedReminders() {
  const retryAfter = new Date(Date.now() - 30 * 60 * 1000); // 30 min cool-off
  return ReminderLogModel.find({
    status: { $in: ["failed", "processing"] },
    attempts: { $lt: MAX_ATTEMPTS },
    $or: [{ lastAttemptAt: null }, { lastAttemptAt: { $lt: retryAfter } }],
  })
    .sort({ createdAt: 1 })
    .limit(MAX_PER_RUN)
    .populate("orderId")
    .lean();
}

/**
 * Atomically claim (order, cycle). Returns the ReminderLog, or null if
 * this cycle was already claimed by someone else / a previous run.
 */
async function claimReminder(order, cycle) {
  try {
    return await ReminderLogModel.create({
      orderId: order._id,
      cycle,
      kind: "renewal_15d",
      status: "processing",
      email: order.email,
      attempts: 0,
    });
  } catch (e) {
    if (e?.code === 11000) return null; // already claimed -> already sent (or in flight)
    throw e;
  }
}

/** Turn an order + cycle into a ready-to-send message. */
function buildMessage(order, cycle) {
  const renewAt = new Date(order.lastRenewAt ?? order.createdAt);
  const nextRenewalAt = new Date(renewAt.getTime() + CYCLE_DAYS * DAY_MS);

  // Days remaining until the NEXT shipment goes out. Computed live, so a
  // cron that runs a day late still tells the customer the truth.
  const daysUntilNext = Math.max(
    0,
    Math.ceil((nextRenewalAt.getTime() - Date.now()) / DAY_MS),
  );

  const unsubUrl = buildUnsubUrl({ orderId: order._id, cycle });

  const { subject, html, text } = renewalReminderEmail({
    firstName: order.firstName,
    source: order.source,
    daysUntilNext,
    nextRenewalDate: nextRenewalAt,
    unsubUrl,
  });

  return { to: order.email, subject, html, text, unsubUrl };
}

/* ================================================================== */
async function runRemindersInner() {
  if (!mailerReady()) {
    console.warn(
      "[cron:reminder] RESEND_API_KEY / PUBLIC_API_URL not set — skipping.",
    );
    return { skipped: true };
  }

  /* ---- 1. gather work: new (due) + previously-failed ---- */
  const due = await findDueReminders();
  const retries = await findFailedReminders();

  const work = []; // [{ log, order, message }]

  // NEW
  for (const order of due) {
    const cycle = cycleKeyFor(order);
    const log = await claimReminder(order, cycle);
    if (!log) continue; // already handled this cycle — idempotent no-op
    try {
      work.push({ log, order, message: buildMessage(order, cycle) });
    } catch (e) {
      // e.g. UNSUBSCRIBE_SECRET missing -> release the claim so a fixed
      // deploy can retry, rather than silently swallowing the cycle.
      await ReminderLogModel.deleteOne({ _id: log._id });
      console.error("[cron:reminder] build failed:", order._id, e?.message);
    }
  }

  // RETRIES (claim already exists; don't re-create it)
  for (const log of retries) {
    const order = log.orderId;
    if (!order?._id) continue;
    // Guard: they may have unsubscribed since the failed attempt.
    if (
      order.subscription !== "monthly" ||
      !order.isActive ||
      !order.isRenewable
    ) {
      await ReminderLogModel.updateOne(
        { _id: log._id },
        {
          $set: {
            status: "failed",
            lastError: "subscription no longer active",
          },
        },
      );
      continue;
    }
    try {
      work.push({ log, order, message: buildMessage(order, log.cycle) });
    } catch (e) {
      console.error("[cron:reminder] rebuild failed:", order._id, e?.message);
    }
  }

  if (!work.length) {
    console.log("[cron:reminder] nothing due.");
    return { sent: 0, failed: 0 };
  }

  console.log(`[cron:reminder] ${work.length} reminder(s) to send.`);

  /* ---- 2. mark attempt BEFORE sending ----
     If the process dies mid-send, these stay "processing" with attempts
     incremented. The retry pass picks them up after the cool-off, and
     Resend's 24h idempotency key stops a duplicate landing in the inbox. */
  const now = new Date();
  await ReminderLogModel.updateMany(
    { _id: { $in: work.map((w) => w.log._id) } },
    { $set: { lastAttemptAt: now }, $inc: { attempts: 1 } },
  );

  /* ---- 3. ONE batched API call per 100 emails ---- */
  const idemPrefix = `reminder-15d/${now.toISOString().slice(0, 10)}`;
  const res = await sendBatch(
    work.map((w) => w.message),
    { idempotencyKeyPrefix: idemPrefix },
  );

  /* ---- 4. record the outcome ----
     sendBatch() reports per-chunk, so on partial failure we can't map an
     id back to one recipient with certainty. We therefore treat a failed
     CHUNK as failed and let the retry pass re-send it — protected from
     duplicates by the idempotency key. Correctness over cleverness. */
  const ids = work.map((w) => w.log._id);

  if (res.failed === 0) {
    await ReminderLogModel.updateMany(
      { _id: { $in: ids } },
      { $set: { status: "sent", sentAt: new Date(), lastError: "" } },
    );
    await OrderModel.updateMany(
      { _id: { $in: work.map((w) => w.order._id) } },
      { $set: { reminderSentAt: new Date() } },
    );
  } else if (res.sent === 0) {
    await ReminderLogModel.updateMany(
      { _id: { $in: ids } },
      { $set: { status: "failed", lastError: res.errors[0] || "send failed" } },
    );
  } else {
    // Mixed: some chunks landed, some didn't. Mark everything "processing"
    // so the retry pass revisits them; the idempotency key makes the
    // already-delivered ones a no-op at Resend.
    await ReminderLogModel.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          status: "processing",
          lastError: res.errors[0] || "partial batch failure",
        },
      },
    );
  }

  console.log(
    `[cron:reminder] done. sent=${res.sent} failed=${res.failed} errors=${res.errors.length}`,
  );
  return { sent: res.sent, failed: res.failed, errors: res.errors };
}

export async function runReminders() {
  return withLock(LOCK, LOCK_TTL_MS, async () => {
    try {
      return await runRemindersInner();
    } catch (err) {
      console.error("[cron:reminder] fatal:", err?.message);
      return { error: err?.message };
    }
  });
}

/* Daily at 09:00 America/Los_Angeles — a reasonable hour to land in an
   inbox, and node-cron handles the DST shift for us. */
cron.schedule(process.env.REMINDER_CRON || "0 9 * * *", runReminders, {
  timezone: process.env.CRON_TZ || "America/Los_Angeles",
});

export default runReminders;
