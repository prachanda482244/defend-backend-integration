// cron/recurring.js
import cron from "node-cron";
import axios from "axios";
import { OrderModel, CronLockModel } from "../model/orderModel.js";
import { flushPendingSheets } from "./sheet.js";

const REMIX_URL =
  process.env.SHOPIFY_APP_URL ||
  "https://defent-shopify-app-1.onrender.com/api/create-order";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const LOCK_NAME = "recurring-renewals";
const LOCK_TTL_MS = 30 * 60 * 1000; // lease length; reclaimable if a run dies
const PER_CALL_DELAY_MS = 300; // gentle pacing on top of Remix's Shopify throttle

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- DB-level lock so only ONE run executes, even across instances ---- */
async function acquireLock() {
  const now = new Date();
  const until = new Date(now.getTime() + LOCK_TTL_MS);
  try {
    // Reclaim only if no lock exists OR the existing lease has expired.
    const res = await CronLockModel.findOneAndUpdate(
      { name: LOCK_NAME, lockedUntil: { $lt: now } },
      {
        $set: { lockedUntil: until, holder: process.env.HOSTNAME || "worker" },
      },
      { upsert: true, new: true },
    );
    return !!res;
  } catch (e) {
    // Upsert race -> another instance already holds a live lock.
    if (e?.code === 11000) return false;
    throw e;
  }
}

async function releaseLock() {
  try {
    await CronLockModel.updateOne(
      { name: LOCK_NAME },
      { $set: { lockedUntil: new Date(0) } },
    );
  } catch (e) {
    console.error("[cron] lock release failed:", e?.message);
  }
}

/* ---- find due renewals, DEDUPED to ONE active doc per address ---- *
 * If re-orders ever created multiple active docs at the same address,
 * this guarantees only the newest renews -> never two Shopify orders
 * per cycle for the same household.                                   */
async function findDueRenewals() {
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS);
  return OrderModel.aggregate([
    { $match: { subscription: "monthly", isActive: true, isRenewable: true } },
    { $addFields: { renewAt: { $ifNull: ["$lastRenewAt", "$createdAt"] } } },
    { $match: { renewAt: { $lte: thirtyDaysAgo } } },
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
  ]);
}

async function runRenewals() {
  const got = await acquireLock();
  if (!got) {
    console.log("[cron] another run holds the lock — skipping.");
    return;
  }

  try {
    const due = await findDueRenewals();
    if (!due.length) {
      console.log("[cron] no subscriptions due.");
      return;
    }
    console.log(`[cron] ${due.length} subscription(s) due.`);

    let ok = 0;
    let failed = 0;

    for (const order of due) {
      try {
        const resp = await axios.post(
          REMIX_URL,
          {
            orderId: order._id.toString(),
            firstName: order.firstName,
            lastName: order.lastName,
            streetAddress: order.streetAddress,
            streetAddress2: order.streetAddress2 || "",
            postCode: order.postCode,
            email: order.email,
            productId: order.productId,
            subscription: "monthly",
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
          { timeout: 30000 },
        );

        if (resp.status !== 200 || resp.data?.success !== true) {
          failed += 1;
          console.error(
            "[cron] renewal not ok:",
            order._id.toString(),
            resp.data?.message,
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
        // Continue — confirmOrder already released failed cycles for retry next run.
      }

      await sleep(PER_CALL_DELAY_MS);
    }

    // Backstop: one batched sheet write for everything still pending.
    const sheet = await flushPendingSheets();

    console.log(
      `[cron] done. ok=${ok} failed=${failed} sheet=${JSON.stringify(sheet)}`,
    );
  } catch (err) {
    console.error("[cron] fatal:", err?.message);
  } finally {
    await releaseLock();
  }
}

// ⚠ production: midnight daily. For testing swap to "*/30 * * * * *".
cron.schedule("0 0 * * *", runRenewals);

export { runRenewals }; // exported so /admin can trigger a manual run if needed
