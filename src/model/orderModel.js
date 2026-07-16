import { Schema, model } from "mongoose";

/* ------------------------------------------------------------------ *
 *  Reusable sync-state sub-document.  (UNCHANGED)
 *    pending  -> created in DB, not yet pushed
 *    synced   -> confirmed by the sink (Shopify accepted / row appended)
 *    failed   -> push attempted and failed; reconciler will retry
 *    skipped  -> intentionally not pushed
 *
 *  NOTE: `lastAttemptAt` now doubles as an ATOMIC LEASE for the Shopify
 *  reconciler. A worker "claims" an order by stamping lastAttemptAt in a
 *  findOneAndUpdate; a second worker's filter (lastAttemptAt < cutoff)
 *  then fails, so it cannot double-fire the same order. No enum change,
 *  no new field, no migration.
 * ------------------------------------------------------------------ */
const syncStateSchema = new Schema(
  {
    status: {
      type: String,
      enum: ["pending", "synced", "failed", "skipped"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    productId: { type: String },
    firstName: { type: String },
    lastName: { type: String, default: "" },
    streetAddress: { type: String, required: true },
    streetAddress2: { type: String },
    postCode: { type: String, required: true },
    subscription: { type: String, required: true, default: "one_time" },
    isActive: { type: Boolean, default: false },
    isRenewable: { type: Boolean, default: false },
    email: { type: String, required: true },
    source: { type: String, default: "weho" },

    normalizedAddress: { type: String, index: true },
    normalizedAddress2: { type: String, default: null },

    lastRenewAt: { type: Date, default: Date.now },

    flag: { type: String },

    demographics: {
      age: { type: String },
      gender: { type: String },
      identity: { type: String },
      household_size: { type: String },
      ethnicity: { type: String },
      household_language: { type: String },
      identifyAsLGBTQ: { type: String },
      wehoHearAboutUs: { type: String },
    },

    shopifyOrderId: { type: String, default: null },
    /* Human order number Shopify shows customers, e.g. "#4232".
       Purely additive — used by the "order on the way" email. */
    shopifyOrderName: { type: String, default: "" },
    shopifySync: { type: syncStateSchema, default: () => ({}) },
    sheetSync: { type: syncStateSchema, default: () => ({}) },

    /* ============================================================== *
     *  ++ ADDED (purely additive — existing docs are unaffected;
     *     these are all optional and default to null/"") ++
     *
     *  Audit trail for the 15-day reminder + unsubscribe flow.
     *  The CANCEL itself uses fields that already exist:
     *      subscription -> "one_time", isActive -> false,
     *      isRenewable  -> false
     *  ...which is exactly what the renewal cron filters on, so a
     *  cancelled subscriber is automatically excluded from renewals.
     *  These three fields only record WHEN + HOW it happened.
     * ============================================================== */
    /* ================================================================ *
     *  ++ DERIVED — DISPLAY ONLY. THE CRON NEVER READS THESE. ++
     *
     *  These exist so a human (or a dashboard, or support on the phone)
     *  can see "when is this customer's next box?" without running code.
     *
     *  ⚠ They are NOT a source of truth. `lastRenewAt` is. The crons always
     *  compute dueAt = lastRenewAt + CYCLE_MONTHS themselves, in Mongo, via
     *  $dateAdd — they never trust these fields.
     *
     *  That's deliberate. Derived data that becomes a SECOND source of truth
     *  is exactly how you get a customer whose record says "next: Oct 14"
     *  while the cron thinks otherwise. And if you ever change
     *  RENEWAL_CYCLE_MONTHS from 3 to 4, every stored value here is instantly
     *  wrong — but nothing breaks, because nothing depends on them.
     *
     *  Written atomically alongside lastRenewAt, every time it moves.
     * ================================================================ */
    nextOrderAt: { type: Date, default: null }, // next shipment (derived)
    nextReminderAt: { type: Date, default: null }, // next email (derived)

    reminderSentAt: { type: Date, default: null }, // last 15-day email
    unsubscribedAt: { type: Date, default: null }, // when they cancelled
    unsubscribeSource: { type: String, default: "" }, // "email_link" | "one_click" | "admin"

    /* Set when a NEWER monthly subscription replaced this one (same
       household or same person). The cron retires the old one and records
       the winner here, so "why did this stop renewing?" is answerable. */
    supersededBy: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  },
  { timestamps: true },
);

/* Indexes that actually back our hot queries ----------------------- */
orderSchema.index({
  normalizedAddress: 1,
  normalizedAddress2: 1,
  createdAt: -1,
});
orderSchema.index({
  subscription: 1,
  isActive: 1,
  isRenewable: 1,
  lastRenewAt: 1,
});
orderSchema.index({ "shopifySync.status": 1 });
orderSchema.index({ "sheetSync.status": 1 });

/* ++ ADDED: backs the Shopify reconciler scan (status + lease + cap) ++ */
orderSchema.index({
  "shopifySync.status": 1,
  "shopifySync.lastAttemptAt": 1,
  "shopifySync.attempts": 1,
});

export const OrderModel = model("Order", orderSchema);

/* ================================================================== *
 *  RenewalLog — ONE row per (order, renewal-cycle).   (UNCHANGED)
 * ================================================================== */
const renewalLogSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    cycle: { type: String, required: true }, // "YYYY-MM-DD" renew-from date
    status: {
      type: String,
      enum: ["processing", "completed", "failed"],
      default: "processing",
    },
    shopifyOrderId: { type: String, default: null },
    shopifyOrderName: { type: String, default: "" }, // "#4232" — for the shipment email
    shopifySync: { type: syncStateSchema, default: () => ({}) },
    sheetSync: { type: syncStateSchema, default: () => ({}) },
    snapshot: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

renewalLogSchema.index({ orderId: 1, cycle: 1 }, { unique: true });
renewalLogSchema.index({ "shopifySync.status": 1 });
renewalLogSchema.index({ "sheetSync.status": 1 });
/* ++ ADDED: backs the renewal-retry scan ++ */
renewalLogSchema.index({ status: 1, "shopifySync.lastAttemptAt": 1 });

export const RenewalLogModel = model("RenewalLog", renewalLogSchema);

/* ================================================================== *
 *  CronLock — lease-based mutex.   (UNCHANGED)
 * ================================================================== */
const cronLockSchema = new Schema(
  {
    name: { type: String, required: true, unique: true },
    lockedUntil: { type: Date, required: true },
    holder: { type: String, default: "" },
  },
  { timestamps: true },
);

export const CronLockModel = model("CronLock", cronLockSchema);

/* ================================================================== *
 *  ++ NEW: ReminderLog — ONE row per (order, cycle).
 *
 *  Same duplicate-proof trick as RenewalLog: the unique compound index
 *  on (orderId, cycle) means two concurrent reminder runs physically
 *  CANNOT send two emails for the same cycle — the second insert throws
 *  E11000, which we treat as "already sent".
 *
 *  `cycle` is the SAME key the renewal uses (the ISO date we are
 *  renewing *from*), so:
 *     - retrying a failed send maps to the same cycle  -> deduped
 *     - after a successful renewal, lastRenewAt advances -> new cycle
 *       -> next month gets a fresh reminder. Exactly one email/cycle.
 * ================================================================== */
const reminderLogSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    cycle: { type: String, required: true }, // "YYYY-MM-DD" renew-from date
    kind: { type: String, default: "renewal_15d" },
    status: {
      type: String,
      enum: ["processing", "sent", "failed"],
      default: "processing",
    },
    email: { type: String, default: "" },
    providerMessageId: { type: String, default: null }, // Resend email id
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reminderLogSchema.index({ orderId: 1, cycle: 1 }, { unique: true });
reminderLogSchema.index({ status: 1, lastAttemptAt: 1 });

export const ReminderLogModel = model("ReminderLog", reminderLogSchema);
