/* ------------------------------------------------------------------ *
 *  retry.controller.js   (NEW)
 *
 *  The manual override for "this order MUST get onto Shopify".
 *
 *  reconcileCron already retries failed orders every 10 minutes and, with
 *  the rate-limit fix, a 429 no longer consumes the attempt budget — so in
 *  normal operation you should never need this. It exists for the two
 *  cases where the automatic machinery has already given up:
 *
 *    1. Orders that burned all MAX_ATTEMPTS before the fix was deployed
 *       (they're frozen out of the reconciler's query — `attempts < MAX`
 *       no longer matches).
 *    2. Orders that failed for a REAL reason you've since fixed — e.g. a
 *       productId pointing at a product that doesn't exist on the store.
 *       You fix the data, then force a retry.
 *
 *  GET  /api/v1/retry/stuck        -> what is stuck, and why
 *  POST /api/v1/retry/force        -> reset + retry now
 * ------------------------------------------------------------------ */

import axios from "axios";
import { resolveRemixUrl } from "../utils/remixUrl.js";
import { OrderModel, RenewalLogModel } from "../model/orderModel.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sleep } from "../utils/retry.js";

/* ++ FIXED ++  Was a hand-rolled fallback that couldn't work:
     reconcileCron       -> "/api/create-order"   (a RELATIVE path — axios can't POST to that)
     retry/shopifyadmin  -> a hardcoded tunnel URL that is now dead
   And none of them normalised SHOPIFY_APP_URL, so a base-URL-only value
   (the Shopify CLI's format) POSTed to "/" and got a 405.
   One resolver, one behaviour, throws loudly if unset. See remixUrl.js. */
const REMIX_URL = () => resolveRemixUrl();

const MAX_ATTEMPTS = Number(process.env.SHOPIFY_MAX_ATTEMPTS || 6);

/* Between forced retries. On a DEV store the order cap is ~5/min, so give
   it room — otherwise you just re-create the 429 storm you're recovering
   from. Same knob as the Shopify app's SHOPIFY_PACE_MS. */
const FORCE_DELAY_MS = Number(process.env.FORCE_RETRY_DELAY_MS || 15_000);

const flagOf = (o) => (o.source === "Defent La" ? "defentLA" : "defentWeho");

const payloadFor = (o, cycle) => ({
  orderId: o._id.toString(),
  cycle,
  retry: true,
  isRenewal: Boolean(cycle),
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

/* ================================================================== *
 *  GET /api/v1/retry/stuck
 *
 *  Everything that has NOT reached Shopify, and whether the reconciler
 *  can still see it. The `capped` ones are the dangerous category — the
 *  automatic retry has given up on them and NOTHING will pick them up.
 * ================================================================== */
export const listStuck = asyncHandler(async (req, res) => {
  const orders = await OrderModel.find({
    shopifyOrderId: null,
    "shopifySync.status": { $in: ["pending", "failed"] },
  })
    .select("firstName lastName email productId source shopifySync createdAt")
    .sort({ createdAt: 1 })
    .lean();

  const renewals = await RenewalLogModel.find({
    shopifyOrderId: null,
    status: { $in: ["processing", "failed"] },
  })
    .populate("orderId", "firstName lastName email productId source")
    .sort({ createdAt: 1 })
    .lean();

  const describe = (attempts, lastError) => {
    const capped = (attempts || 0) >= MAX_ATTEMPTS;
    const rateLimited = /rate limit|429|too many requests/i.test(
      lastError || "",
    );
    return {
      capped,
      willAutoRetry: !capped,
      note: capped
        ? "⚠ CAPPED — reconcileCron can no longer see this. Force-retry it."
        : rateLimited
          ? "rate limited — retries automatically, cap not consumed"
          : "will be retried by reconcileCron within ~10 min",
    };
  };

  const fmt = (id, o, attempts, lastError, cycle) => ({
    id: String(id),
    orderId: String(o?._id || ""),
    name: `${o?.firstName || "?"} ${o?.lastName || ""}`.trim(),
    email: o?.email,
    productId: o?.productId,
    cycle: cycle || null,
    attempts: attempts || 0,
    lastError: (lastError || "").slice(0, 90),
    ...describe(attempts, lastError),
  });

  const firstTime = orders.map((o) =>
    fmt(o._id, o, o.shopifySync?.attempts, o.shopifySync?.lastError),
  );
  const renewalRows = renewals
    .filter((r) => r.orderId)
    .map((r) =>
      fmt(
        r._id,
        r.orderId,
        r.shopifySync?.attempts,
        r.shopifySync?.lastError,
        r.cycle,
      ),
    );

  const capped = [...firstTime, ...renewalRows].filter((r) => r.capped);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        summary: {
          firstTime: firstTime.length,
          renewals: renewalRows.length,
          capped: capped.length,
          maxAttempts: MAX_ATTEMPTS,
        },
        capped,
        firstTime,
        renewals: renewalRows,
      },
      capped.length
        ? `${capped.length} order(s) have hit the attempt cap and will NOT auto-retry. POST /api/v1/retry/force to recover them.`
        : "Nothing capped — everything stuck will auto-retry.",
    ),
  );
});

/* ================================================================== *
 *  POST /api/v1/retry/force
 *
 *  body:
 *    { all: true }                    -> every stuck order + renewal
 *    { orderIds: ["6a54..."] }        -> only these
 *    { resetAttempts: true }          -> also un-cap them (default true)
 *
 *  This BYPASSES the 10-minute lease and the attempt cap. It still goes
 *  through the same tag-lookup heal in Remix, so a forced retry can never
 *  create a duplicate — if Shopify already has the order, it adopts it.
 * ================================================================== */
export const forceRetry = asyncHandler(async (req, res) => {
  const { all = false, orderIds = [], resetAttempts = true } = req?.body || {};

  if (!all && !orderIds.length) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          'Send { "all": true } or { "orderIds": [...] }',
        ),
      );
  }

  const orderFilter = {
    shopifyOrderId: null,
    "shopifySync.status": { $in: ["pending", "failed"] },
    ...(orderIds.length ? { _id: { $in: orderIds } } : {}),
  };

  /* ---- 1. un-cap them, so the reconciler can see them again ---- */
  if (resetAttempts) {
    const a = await OrderModel.updateMany(orderFilter, {
      $set: { "shopifySync.attempts": 0, "shopifySync.lastAttemptAt": null },
    });
    const b = await RenewalLogModel.updateMany(
      {
        shopifyOrderId: null,
        status: { $in: ["processing", "failed"] },
        ...(orderIds.length ? { orderId: { $in: orderIds } } : {}),
      },
      {
        $set: { "shopifySync.attempts": 0, "shopifySync.lastAttemptAt": null },
      },
    );
    console.log(
      `[retry] reset attempts on ${a.modifiedCount} order(s), ${b.modifiedCount} renewal(s)`,
    );
  }

  const results = {
    attempted: 0,
    created: 0,
    healed: 0,
    stillFailing: 0,
    errors: [],
  };

  /* ---- 2. renewals first (they're the ones people notice) ---- */
  const renewals = await RenewalLogModel.find({
    shopifyOrderId: null,
    status: { $in: ["processing", "failed"] },
    ...(orderIds.length ? { orderId: { $in: orderIds } } : {}),
  })
    .populate("orderId")
    .lean();

  for (const log of renewals) {
    const o = log.orderId;
    if (!o?._id) continue;
    results.attempted += 1;
    try {
      const { data } = await axios.post(REMIX_URL(), payloadFor(o, log.cycle), {
        timeout: 120_000, // a rate-limit backoff can legitimately take >60s
      });
      if (data?.healed) results.healed += 1;
      else if (data?.success) results.created += 1;
      else {
        results.stillFailing += 1;
        results.errors.push(`${o.firstName}: ${data?.message}`);
      }
    } catch (e) {
      results.stillFailing += 1;
      results.errors.push(`${o.firstName}: ${e?.message}`);
    }
    await sleep(FORCE_DELAY_MS);
  }

  /* ---- 3. first-time orders ---- */
  const orders = await OrderModel.find(orderFilter).lean();
  for (const o of orders) {
    results.attempted += 1;
    try {
      const { data } = await axios.post(REMIX_URL(), payloadFor(o, null), {
        timeout: 120_000,
      });
      if (data?.healed) results.healed += 1;
      else if (data?.success) results.created += 1;
      else {
        results.stillFailing += 1;
        results.errors.push(`${o.firstName}: ${data?.message}`);
      }
    } catch (e) {
      results.stillFailing += 1;
      results.errors.push(`${o.firstName}: ${e?.message}`);
    }
    await sleep(FORCE_DELAY_MS);
  }

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        results,
        `Attempted ${results.attempted}: ${results.created} created, ${results.healed} healed, ${results.stillFailing} still failing`,
      ),
    );
});
