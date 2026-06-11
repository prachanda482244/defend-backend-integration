/* ------------------------------------------------------------------ *
 *  adminController.js — the manual escape hatch / reconciliation.
 *
 *  These let you (a) SEE everything that didn't sync, (b) auto-heal by
 *  re-running the pipeline, (c) flush the sheet, and (d) export a CSV
 *  for manual Shopify import / sheet paste when you'd rather fix by hand.
 *
 *  ⚠ Guard these behind admin auth before production. They mutate data
 *    and re-trigger Shopify pushes.
 * ------------------------------------------------------------------ */

import axios from "axios";
import { OrderModel, RenewalLogModel } from "../model/orderModel.js";
import { flushPendingSheets, appendRowsBatch } from "../utils/sheet.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";

// Remix app that owns the Shopify token (same one the cron calls).
const REMIX_URL =
  process.env.SHOPIFY_APP_URL ||
  "https://defent-shopify-app-1.onrender.com/api/create-order";
// "https://warnings-thickness-varieties-frankfurt.trycloudflare.com/api/create-order";

const dateWindow = (req) => {
  const { from, to } = req.query || {};
  const q = {};
  if (from) q.$gte = new Date(from);
  if (to) q.$lte = new Date(to);
  return Object.keys(q).length ? q : null;
};

/* ---------- GET /admin/unsynced ----------
 * Lists first-time orders + renewal cycles that didn't fully sync. */
export const getUnsynced = asyncHandler(async (req, res) => {
  const win = dateWindow(req);
  const orderFilter = {
    $or: [
      { "shopifySync.status": { $ne: "synced" } },
      { "sheetSync.status": { $ne: "synced" } },
    ],
  };
  if (win) orderFilter.createdAt = win;

  const renewalFilter = {
    $or: [
      { "shopifySync.status": { $ne: "synced" } },
      { "sheetSync.status": { $ne: "synced" } },
      { status: { $ne: "completed" } },
    ],
  };
  if (win) renewalFilter.createdAt = win;

  const [orders, renewals] = await Promise.all([
    OrderModel.find(orderFilter)
      .select(
        "firstName lastName email source subscription shopifySync sheetSync shopifyOrderId createdAt",
      )
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean(),
    RenewalLogModel.find(renewalFilter)
      .populate("orderId", "firstName lastName email source")
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean(),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        counts: { orders: orders.length, renewals: renewals.length },
        orders,
        renewals,
      },
      "Unsynced report",
    ),
  );
});

/* ---------- POST /admin/reconcile ----------
 * Re-pushes failed/pending orders & renewals through the SAME pipeline.
 * Idempotency (RenewalLog unique index + Shopify tag lookup in Remix)
 * means this will NOT create duplicates — it only heals gaps. */
export const reconcile = asyncHandler(async (req, res) => {
  const { limit = 50 } = req.body || {};
  const result = { firstTimeRetried: 0, renewalsRetried: 0, errors: [] };

  // --- first-time orders that never reached Shopify ---
  const orders = await OrderModel.find({
    "shopifySync.status": { $in: ["pending", "failed"] },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  for (const o of orders) {
    try {
      // retry mode: Remix skips dedup/create and just (re)creates Shopify + confirms
      await axios.post(
        REMIX_URL,
        {
          retry: true,
          orderId: o._id.toString(),
          firstName: o.firstName,
          lastName: o.lastName,
          streetAddress: o.streetAddress,
          streetAddress2: o.streetAddress2 || "",
          postCode: o.postCode,
          email: o.email,
          productId: o.productId,
          subscription: o.subscription,
          flag: o.source === "Defent La" ? "defentLA" : "defentWeho",
          isRenewal: false,
          demographics: o.demographics || {},
        },
        { timeout: 20000 },
      );
      result.firstTimeRetried += 1;
    } catch (e) {
      result.errors.push({ orderId: o._id.toString(), error: e?.message });
    }
  }

  // --- renewals stuck in "processing" (claimed but never confirmed) ---
  const stale = new Date(Date.now() - 60 * 60 * 1000); // older than 1h
  const renewals = await RenewalLogModel.find({
    status: "processing",
    updatedAt: { $lt: stale },
  })
    .populate("orderId")
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  for (const r of renewals) {
    const o = r.orderId;
    if (!o) continue;
    try {
      await axios.post(
        REMIX_URL,
        {
          retry: true,
          orderId: o._id.toString(),
          cycle: r.cycle,
          firstName: o.firstName,
          lastName: o.lastName,
          streetAddress: o.streetAddress,
          streetAddress2: o.streetAddress2 || "",
          postCode: o.postCode,
          email: o.email,
          productId: o.productId,
          subscription: "monthly",
          flag: o.source === "Defent La" ? "defentLA" : "defentWeho",
          isRenewal: true,
          demographics: o.demographics || {},
        },
        { timeout: 20000 },
      );
      result.renewalsRetried += 1;
    } catch (e) {
      result.errors.push({ renewalId: r._id.toString(), error: e?.message });
    }
  }

  // --- and flush any sheet rows still pending ---
  const sheet = await flushPendingSheets();

  return res
    .status(200)
    .json(new ApiResponse(200, { ...result, sheet }, "Reconcile complete"));
});

/* ---------- POST /admin/sync-one ----------
 * Per-order manual sync from the dashboard.
 * body: { orderId, target: "sheet" | "shopify" | "both" }
 * Sheet runs here directly (Node owns the Sheets client); Shopify is
 * delegated to the Remix retry path (it owns the token + calls /confirm).
 * Returns a per-channel result so the UI can show exactly what landed. */
export const syncOne = asyncHandler(async (req, res) => {
  const { orderId, target = "both" } = req.body || {};
  if (!orderId || !["sheet", "shopify", "both"].includes(target)) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "orderId and valid target required"));
  }

  const order = await OrderModel.findById(orderId);
  if (!order)
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));

  const flag = order.source === "Defent La" ? "defentLA" : "defentWeho";
  const result = { orderId, sheet: "skipped", shopify: "skipped" };

  // ----- SHEET -----
  if (target === "sheet" || target === "both") {
    try {
      await appendRowsBatch([{ order, when: order.createdAt }], flag);
      await OrderModel.updateOne(
        { _id: order._id },
        {
          $set: {
            "sheetSync.status": "synced",
            "sheetSync.lastAttemptAt": new Date(),
          },
          $inc: { "sheetSync.attempts": 1 },
        },
      );
      result.sheet = "synced";
    } catch (e) {
      await OrderModel.updateOne(
        { _id: order._id },
        {
          $set: {
            "sheetSync.status": "failed",
            "sheetSync.lastError": e?.message || "sheet failed",
            "sheetSync.lastAttemptAt": new Date(),
          },
          $inc: { "sheetSync.attempts": 1 },
        },
      );
      result.sheet = `failed: ${e?.message || "sheet failed"}`;
    }
  }

  // ----- SHOPIFY (via Remix retry; idempotent on the tag) -----
  if (target === "shopify" || target === "both") {
    try {
      const { data } = await axios.post(
        REMIX_URL,
        {
          retry: true,
          orderId: order._id.toString(),
          firstName: order.firstName,
          lastName: order.lastName,
          streetAddress: order.streetAddress,
          streetAddress2: order.streetAddress2 || "",
          postCode: order.postCode,
          email: order.email,
          productId: order.productId,
          subscription: order.subscription,
          flag,
          isRenewal: false,
          demographics: order.demographics || {},
        },
        { timeout: 25000 },
      );
      result.shopify = data?.success
        ? "synced"
        : `failed: ${data?.message || "shopify failed"}`;
    } catch (e) {
      result.shopify = `failed: ${e?.response?.data?.message || e?.message || "shopify failed"}`;
    }
  }

  const allOk = [result.sheet, result.shopify].every(
    (s) => s === "synced" || s === "skipped",
  );
  return res
    .status(200)
    .json(
      new ApiResponse(
        allOk ? 200 : 207,
        result,
        allOk ? "Synced" : "Partial sync",
      ),
    );
});

/* ---------- POST /admin/flush-sheets ---------- */
export const flushSheets = asyncHandler(async (_req, res) => {
  const summary = await flushPendingSheets();
  return res.status(200).json(new ApiResponse(200, summary, "Sheets flushed"));
});

/* ---------- GET /admin/export/unsynced.csv ----------
 * Dumps unsynced orders as CSV for manual Shopify import / sheet paste. */
export const exportUnsyncedCsv = asyncHandler(async (req, res) => {
  const win = dateWindow(req);
  const filter = {
    $or: [
      { "shopifySync.status": { $ne: "synced" } },
      { "sheetSync.status": { $ne: "synced" } },
    ],
  };
  if (win) filter.createdAt = win;

  const orders = await OrderModel.find(filter)
    .sort({ createdAt: -1 })
    .limit(5000)
    .lean();

  const cols = [
    "_id",
    "createdAt",
    "firstName",
    "lastName",
    "email",
    "streetAddress",
    "streetAddress2",
    "postCode",
    "productId",
    "subscription",
    "source",
    "shopifyOrderId",
    "shopifySyncStatus",
    "sheetSyncStatus",
  ];
  const esc = (val) => {
    const s = val == null ? "" : String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = orders.map((o) =>
    [
      o._id,
      o.createdAt?.toISOString?.() || "",
      o.firstName,
      o.lastName,
      o.email,
      o.streetAddress,
      o.streetAddress2 || "",
      o.postCode,
      o.productId,
      o.subscription,
      o.source,
      o.shopifyOrderId || "",
      o.shopifySync?.status || "",
      o.sheetSync?.status || "",
    ]
      .map(esc)
      .join(","),
  );
  const csv = [cols.join(","), ...rows].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="unsynced-orders.csv"`,
  );
  return res.status(200).send(csv);
});
