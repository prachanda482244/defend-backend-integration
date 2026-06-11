import { Schema, model } from "mongoose";

/* ------------------------------------------------------------------ *
 *  Reusable sync-state sub-document.
 *  Every external sink (Shopify, Sheets) gets one of these so we always
 *  know, per order, whether the side-effect actually landed.
 *    pending  -> created in DB, not yet pushed
 *    synced   -> confirmed by the sink (Shopify accepted / row appended)
 *    failed   -> push attempted and failed; reconciler will retry
 *    skipped  -> intentionally not pushed (e.g. one_time order, no renewal)
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

    /* ----- NEW: sync tracking for the FIRST-TIME order ----- *
     * Renewal cycles are tracked separately in RenewalLog (below),
     * because each renewal creates its own Shopify order.        */
    shopifyOrderId: { type: String, default: null }, // first-time Shopify order id
    shopifySync: { type: syncStateSchema, default: () => ({}) },
    sheetSync: { type: syncStateSchema, default: () => ({}) },
  },
  { timestamps: true },
);

/* Indexes that actually back our hot queries ----------------------- */
// Dedup lookup (most-recent order at an address)
orderSchema.index({
  normalizedAddress: 1,
  normalizedAddress2: 1,
  createdAt: -1,
});
// Cron candidate scan
orderSchema.index({
  subscription: 1,
  isActive: 1,
  isRenewable: 1,
  lastRenewAt: 1,
});
// Reconciler scans
orderSchema.index({ "shopifySync.status": 1 });
orderSchema.index({ "sheetSync.status": 1 });

export const OrderModel = model("Order", orderSchema);

/* ================================================================== *
 *  RenewalLog — ONE row per (order, renewal-cycle).
 *
 *  This is the duplicate-proof gate for the cron. The unique compound
 *  index on (orderId, cycle) means two concurrent cron runs physically
 *  CANNOT create two renewals for the same cycle — the second insert
 *  throws a duplicate-key error, which we treat as "already handled".
 *
 *  `cycle` = the ISO date (YYYY-MM-DD) we are renewing *from*
 *  (i.e. the order's current lastRenewAt, or createdAt if never renewed).
 *  It is stable across retries of the same due renewal, so a retry maps
 *  to the SAME cycle and is deduped — but advances after a successful
 *  renewal, so next month gets a fresh cycle.
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
    shopifySync: { type: syncStateSchema, default: () => ({}) },
    sheetSync: { type: syncStateSchema, default: () => ({}) },
    // Snapshot of what we sent, handy for reconciliation / export
    snapshot: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

renewalLogSchema.index({ orderId: 1, cycle: 1 }, { unique: true });
renewalLogSchema.index({ "shopifySync.status": 1 });
renewalLogSchema.index({ "sheetSync.status": 1 });

export const RenewalLogModel = model("RenewalLog", renewalLogSchema);

/* ================================================================== *
 *  CronLock — a single mutex row so only one cron run executes at a
 *  time even if Render spins up >1 instance or restarts mid-run.
 *  Lease-based: a stale lock (lockedUntil in the past) can be reclaimed.
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
