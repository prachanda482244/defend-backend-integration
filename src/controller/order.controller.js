import { ErrorLogModel } from "../model/errorLog.js";
import { OrderModel, RenewalLogModel } from "../model/orderModel.js";

import { appendMonthly, backfillMonthlySheet } from "../utils/monthlySheet.js";
import {
  areAddressLinesSame,
  isWestHollywoodOK,
  isLosAngelesOK,
  validateUSAddress,
  validateAddressWithZipFallback,
  serviceAreaReason,
} from "../utils/addressValidation.js";
import {
  CYCLE_MONTHS,
  reminderAt,
  DEDUPE_MONTHS,
  addMonths,
  nextDueAt,
  isDue,
  nextAnchor,
  cycleSummary,
  RECURRING_MATCH,
  isRecurring,
} from "../utils/cycle.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { logSuccess, logFailure } from "../utils/logger.js";
import {
  validateAddressLine1,
  validateAddressLine2,
} from "../validators/address.js";
import { normalizeLine2 } from "../utils/normalizeAddress.js";
import { appendSingleAndMark } from "../utils/sheet.js";

const cycleKeyFor = (order) =>
  (order.lastRenewAt ?? order.createdAt ?? new Date())
    .toISOString()
    .slice(0, 10);

const joinMulti = (a) =>
  Array.isArray(a) && a.length ? a.join(", ") : a || "";

const redact = (value) => {
  if (!value || typeof value !== "object") return value;
  const cloned = JSON.parse(JSON.stringify(value));
  if (cloned.accessToken) cloned.accessToken = "***redacted***";
  if (cloned.token) cloned.token = "***redacted***";
  if (cloned.password) cloned.password = "***redacted***";
  if (cloned.authorization) cloned.authorization = "***redacted***";
  if (cloned.Authorization) cloned.Authorization = "***redacted***";
  if (cloned["X-Shopify-Access-Token"]) {
    cloned["X-Shopify-Access-Token"] = "***redacted***";
  }
  return cloned;
};

const saveErrorLog = async (payload = {}) => {
  try {
    await ErrorLogModel.create({
      source: payload?.source || "orders-backend",
      module: payload?.module || "",
      stage: payload?.stage || "",
      level: payload?.level || "error",
      message: payload?.message || "Unknown error",
      errorName: payload?.errorName || "",
      statusCode: payload?.statusCode ?? null,
      stack: payload?.stack || "",
      request: payload?.request
        ? {
            ...payload.request,
            headers: redact(payload.request.headers || {}),
            body: redact(payload.request.body),
            params: redact(payload.request.params || {}),
            query: redact(payload.request.query || {}),
          }
        : {},
      response: payload?.response
        ? {
            ...payload.response,
            headers: redact(payload.response.headers || {}),
            data: redact(payload.response.data),
          }
        : {},
      context: payload?.context || {},
      externalService: payload?.externalService || {},
      meta: redact(payload?.meta),
      resolved: false,
    });
  } catch (error) {
    console.error("Failed to save error log:", error?.message || error);
  }
};

const buildReqInfo = (req) => ({
  method: req?.method || "",
  url: req?.originalUrl || "",
  ip: req?.ip || "",
  userAgent: req?.get?.("user-agent") || "",
  headers: req?.headers || {},
  body: req?.body || {},
  params: req?.params || {},
  query: req?.query || {},
});
/* ++ QUARTERLY ++  All cycle maths now lives in one place: cycle.js.
   It used to be a hardcoded THIRTY_DAYS_MS here, a RENEWAL_CYCLE_DAYS in
   cron.js, and another in reminderCron.js — three definitions of "when is
   this customer due", which is three chances to disagree. */
const CYCLE_LABEL = cycleSummary();

/* ------------------------------------------------------------------ *
 *  advancePastCycle(orderId, cycle)
 *
 *  Move `lastRenewAt` forward, but ONLY if it is still sitting inside the
 *  cycle we just completed.
 *
 *  Why not an unconditional `$set: { lastRenewAt: now }`?
 *    Because confirm can legitimately arrive twice (Remix retry, a healed
 *    order, a manual reconcile). An unconditional set would push the
 *    customer's next shipment out by an extra month each time.
 *
 *  Why not "only advance on the first confirm" (what I had before)?
 *    Because if the clock gets stuck — a crash between the two writes, or
 *    someone resets the date by hand — nothing ever advances it, and the
 *    cron re-renews that order every single tick, forever, reporting
 *    success each time. That is exactly the bug this replaces.
 *
 *  So: make the ADVANCE itself idempotent. The cycle key is derived from
 *  lastRenewAt (`lastRenewAt.toISOString().slice(0,10)`), so if lastRenewAt
 *  still falls on the cycle's day, we have not advanced yet — advance.
 *  If it has already moved to another day, the filter misses and this is a
 *  no-op. Safe to call as many times as you like.
 *
 *  Returns true if it actually moved the clock.
 * ------------------------------------------------------------------ */
async function advancePastCycle(orderId, cycle) {
  if (!cycle) return false;

  const cycleStart = new Date(`${cycle}T00:00:00.000Z`);
  if (Number.isNaN(cycleStart.getTime())) return false;
  const cycleEnd = new Date(cycleStart.getTime() + 24 * 60 * 60 * 1000);

  const anchored = nextAnchor(cycleStart);

  const res = await OrderModel.updateOne(
    {
      _id: orderId,
      $or: [
        { lastRenewAt: { $gte: cycleStart, $lt: cycleEnd } }, // still on this cycle
        { lastRenewAt: null }, // never set -> cycle came from createdAt
      ],
    },
    /* ++ QUARTERLY ++  ANCHOR to the schedule, don't drift to now().
     *
     * Setting lastRenewAt = now() means a cron that fires at 00:04 on Apr 1
     * pushes the next shipment to Jul 1 00:04, then Oct 1 00:08... Each late
     * run shoves the schedule further out.
     *
     * nextAnchor() lands on the SCHEDULED date (cycleDate + 3 months), so the
     * customer stays on the 1st forever. And if the cron was down for two
     * whole quarters it jumps to the most RECENT scheduled date rather than
     * shipping a backlog — one outage, one parcel. */
    /* One atomic $set. If lastRenewAt moves, these move with it — they can
       never drift out of sync with the clock they're derived from. */
    {
      $set: {
        lastRenewAt: anchored,
        nextOrderAt: nextDueAt(anchored),
        nextReminderAt: reminderAt(anchored),
      },
    },
  );

  return (res.modifiedCount || 0) > 0;
}

const createOrder = asyncHandler(async (req, res) => {
  const {
    orderId = "",
    firstName,
    lastName,
    streetAddress: _line1,
    streetAddress2: _line2,
    postCode,
    email,
    productId,
    subscription = "one_time",
    age,
    gender,
    identity,
    household_size,
    ethnicity,
    household_language,
    identifyAsLGBTQ,
    wehoHearAboutUs,
    flag = "defentWeho",
    isRenewal = false,
  } = req?.body || {};

  // ---- common required-field check (unchanged) ----
  if (
    !firstName ||
    !lastName ||
    !_line1 ||
    !postCode ||
    !email ||
    !productId ||
    !subscription
  ) {
    const msg = "Missing required field";
    logFailure({ reason: msg, request: req?.body });
    await saveErrorLog({
      module: "createOrder",
      stage: "validation",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: {
        email: email || "",
        productId: productId || "",
        subscription,
        flag,
        isRenewal,
      },
    });
    return res.status(400).json(new ApiResponse(400, null, msg));
  }

  /* ============================================================== *
   *  RENEWAL PATH — claim the cycle, DO NOT finalize yet.
   * ============================================================== */
  if (isRenewal) {
    if (!orderId) {
      return res
        .status(400)
        .json(new ApiResponse(400, null, "orderId required for renewal"));
    }

    const existing = await OrderModel.findById(orderId);
    if (
      !existing ||
      !existing.isActive ||
      !isRecurring(existing.subscription) ||
      !existing.isRenewable
    ) {
      const msg = "No active renewable subscription found";
      await saveErrorLog({
        module: "createOrder",
        stage: "renewal_lookup",
        level: "warning",
        message: msg,
        statusCode: 404,
        request: buildReqInfo(req),
        context: { orderId, email, productId, flag, isRenewal: true },
      });
      return res.status(200).json(new ApiResponse(404, null, msg));
    }

    /* ++ QUARTERLY ++  Due check — calendar months, not a day count.
       lastRenewAt ?? createdAt; updatedAt deliberately NOT used. */
    const lastRenew = existing.lastRenewAt ?? existing.createdAt;
    if (!isDue(lastRenew)) {
      const msg = `Renewal not due yet (next: ${nextDueAt(lastRenew).toISOString().slice(0, 10)})`;
      await saveErrorLog({
        module: "createOrder",
        stage: "renewal_not_due",
        level: "warning",
        message: msg,
        statusCode: 409,
        request: buildReqInfo(req),
        context: { orderId, email, productId, flag, isRenewal: true },
      });
      return res.status(200).json(new ApiResponse(409, null, msg));
    }

    const cycle = cycleKeyFor(existing);

    // ---- ATOMIC, DUPLICATE-PROOF CLAIM ----
    // The unique index on (orderId, cycle) guarantees only ONE claim per
    // cycle. A duplicate-key error means this cycle is already being
    // processed or is done -> we safely skip. This is what prevents the
    // "same order created 10-20 times" disaster.
    let claim;
    try {
      claim = await RenewalLogModel.create({
        orderId: existing._id,
        cycle,
        status: "processing",
        snapshot: {
          firstName: existing.firstName,
          lastName: existing.lastName,
          email: existing.email,
          productId: existing.productId,
          flag: existing.source === "Defent La" ? "defentLA" : "defentWeho",
        },
      });
    } catch (e) {
      if (e?.code === 11000) {
        /* ============================================================== *
         *  ⚠⚠ THIS BRANCH CAUSED AN INFINITE RENEWAL LOOP. ⚠⚠
         *
         *  E11000 means a RenewalLog for (orderId, cycle) already exists.
         *  The old code assumed that meant "another worker is mid-flight"
         *  and returned a cheerful `alreadyClaimed: true`.
         *
         *  But it ALSO fires when the cycle is already COMPLETED — and in
         *  that case nobody is coming back to advance `lastRenewAt`. Remix
         *  sees `alreadyClaimed` and returns success WITHOUT calling
         *  /order/confirm. So:
         *
         *      cron: "9 subscription(s) due"  -> ok=9
         *      cron: "9 subscription(s) due"  -> ok=9    (the same 9)
         *      cron: "9 subscription(s) due"  -> ok=9    (forever)
         *
         *  Reporting success, making zero progress, hammering the cron
         *  every 30 seconds until someone notices.
         *
         *  So: look at what state the log is ACTUALLY in.
         * ============================================================== */
        const existingLog = await RenewalLogModel.findOne({
          orderId,
          cycle,
        }).lean();

        if (existingLog?.status === "completed") {
          /* This cycle is DONE — the Shopify order exists. `lastRenewAt` is
             just stuck (a crash between the two writes, or someone reset the
             date by hand). Advance it now, or we loop forever. */
          const advanced = await advancePastCycle(orderId, cycle);
          return res.status(200).json(
            new ApiResponse(
              200,
              {
                orderId,
                cycle,
                alreadyCompleted: true,
                clockAdvanced: advanced,
                shopifyOrderId: existingLog.shopifyOrderId,
              },
              advanced
                ? "Renewal already completed for this cycle — clock advanced"
                : "Renewal already completed for this cycle",
            ),
          );
        }

        /* status is "processing" or "failed" -> genuinely in flight, or
           waiting on the reconciler. Leave it alone; reconcileCron owns it. */
        return res.status(200).json(
          new ApiResponse(
            200,
            {
              orderId,
              cycle,
              alreadyClaimed: true,
              logStatus: existingLog?.status,
            },
            "Renewal already in progress",
          ),
        );
      }
      throw e;
    }

    // Hand back enough for Remix to create + confirm the Shopify order.
    return res.status(200).json(
      new ApiResponse(
        200,
        {
          orderId: existing._id.toString(),
          renewalLogId: claim._id.toString(),
          cycle,
          isRenewal: true,
          order: existing, // full doc so Remix can build the Shopify payload
        },
        "Renewal claimed",
      ),
    );
  }

  /* ============================================================== *
   *  FIRST-TIME PATH — validations preserved from your code.
   * ============================================================== */
  const v1 = validateAddressLine1(_line1);
  if (!v1?.ok) {
    const msg = v1?.error || "Invalid address line 1";
    logFailure({ reason: msg, request: req?.body });
    await saveErrorLog({
      module: "createOrder",
      stage: "address_line1_validation",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: { email, productId, subscription, flag },
      meta: { streetAddress: _line1 },
    });
    return res.status(200).json(new ApiResponse(400, null, msg));
  }
  const line1 = v1.value;

  const v2 = validateAddressLine2(_line2);
  if (!v2?.ok) {
    const msg = v2?.error || "Invalid address line 2";
    await saveErrorLog({
      module: "createOrder",
      stage: "address_line2_validation",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: { email, productId, subscription, flag },
      meta: { streetAddress2: _line2 },
    });
    return res.status(200).json(new ApiResponse(400, null, msg));
  }
  const line2 = v2.value;

  if (line2 && areAddressLinesSame(line1, line2)) {
    const msg = "Address line 1 and line 2 cannot be the same";
    await saveErrorLog({
      module: "createOrder",
      stage: "address_compare",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: { email, productId, subscription, flag },
      meta: { line1, line2 },
    });
    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  const isLA = flag === "defentLA";
  const city = isLA ? "Los Angeles" : "West Hollywood";
  const oneLine = `${line1}, ${city}, CA ${String(postCode).slice(0, 5)}`;

  const v = await validateAddressWithZipFallback(oneLine, {
    postCode,
    isLA,
    city,
    line1,
  });
  if (!v?.ok) {
    const areaMsg = isLA
      ? "The address must be located within Los Angeles, CA."
      : "The address must be located within West Hollywood, CA.";

    /* ++ CHANGED ++  Tell the customer what actually went wrong.
     *
     * Everything used to collapse into "must be located within ...", which is
     * a lie when the real problem is "we couldn't find that street" or "our
     * address service is down". A resident with a perfectly valid address who
     * hits a Census outage would be told their address is out of the service
     * area — and would give up. */
    const msg =
      v?.reason === "not_found"
        ? "We couldn't find that address. Please check the street number and name and try again."
        : v?.reason === "house_number_mismatch"
          ? "We couldn't verify that street number. Please check it and try again."
          : v?.reason === "unverifiable"
            ? "We couldn't verify your address right now — our address service is temporarily unavailable. Please try again in a few minutes."
            : areaMsg; // zip_mismatch / anything else

    await saveErrorLog({
      module: "createOrder",
      stage: "address_validation_api",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: {
        email,
        productId,
        subscription,
        flag,
        reason: v?.reason || "unknown",
      },
      externalService: {
        name: "address-validator",
        endpoint: "validateUSAddress",
        method: "POST",
      },
      meta: { inputAddress: oneLine, validatorResponse: v || null },
    });

    // 503 for a transient outage so it reads as "try again", not "you're rejected".
    const code = v?.transient ? 503 : 400;
    return res.status(200).json(new ApiResponse(code, null, msg));
  }

  /* ++ NEW ++  BELT AND BRACES.
   *
   * `needsReview` is only ever set when ALLOW_UNVERIFIED_ADDRESS=true, i.e.
   * Census was unreachable and someone deliberately chose to keep taking
   * orders. Even then, an address nobody verified must NOT silently ship a
   * device. The old code set this flag and then never read it anywhere in the
   * repo — so it did exactly the thing it was written to prevent.
   *
   * Fail closed unless someone explicitly opts in to auto-shipping them. */
  if (v?.needsReview && process.env.SHIP_UNVERIFIED_ADDRESS !== "true") {
    const msg =
      "We couldn't verify your address right now — our address service is temporarily unavailable. Please try again in a few minutes.";
    await saveErrorLog({
      module: "createOrder",
      stage: "address_unverified_hold",
      level: "warning",
      message: "Address accepted by fallback but NOT verified — order held",
      statusCode: 503,
      request: buildReqInfo(req),
      context: { email, productId, subscription, flag, reason: "needs_review" },
      meta: { inputAddress: oneLine, validatorResponse: v },
    });
    return res.status(200).json(new ApiResponse(503, null, msg));
  }

  /* ++ CHANGED ++  THE GATE IS NOW THE ADDRESS'S ACTUAL CITY.
   *
   * We pass the WHOLE result (not just `components`) so the gate can read
   * `place` — the Census "Incorporated Places" municipality. The ZIP the
   * customer typed plays no part in this decision.
   *
   *   address is in West Hollywood + customer typed a bad ZIP  -> ACCEPT
   *   address is in Los Angeles    + customer typed a WeHo ZIP -> REJECT
   */
  const serviceAreaOK = isLA ? isLosAngelesOK(v) : isWestHollywoodOK(v);
  if (!serviceAreaOK) {
    const msg = isLA
      ? "The address must be located within the City of Los Angeles, CA."
      : "The address must be located within the City of West Hollywood, CA.";

    await saveErrorLog({
      module: "createOrder",
      stage: "service_area_check",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: {
        email,
        productId,
        subscription,
        flag,
        // What Census says the address actually is — this is the useful bit
        // when someone asks "why was my address rejected?".
        censusPlace: v?.placeRaw || "(no municipality returned)",
        censusZip: v?.components?.zip5 || "",
        typedZip: String(postCode || "").slice(0, 5),
        detail: serviceAreaReason(v, isLA),
      },
      meta: {
        inputAddress: oneLine,
        matchedAddress: v?.normalized || "",
        components: v?.components || null,
      },
    });
    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  const normalizedAddress1 = v.normalized;
  const normalizedAddress2 = line2 ? normalizeLine2(line2) : "";

  // ---- DEDUP (fixed): newest order at this address, lastRenewAt ?? createdAt ----
  const query = line2
    ? { normalizedAddress: normalizedAddress1, normalizedAddress2 }
    : { normalizedAddress: normalizedAddress1 };

  const existingOrder = await OrderModel.findOne(query).sort({ createdAt: -1 });
  const renewRef = existingOrder?.lastRenewAt ?? existingOrder?.createdAt;

  /* ++ QUARTERLY ++  The address block now matches the CYCLE length.
   *
   * It was a fixed 30 days. With a quarterly cycle that opens a hole: an
   * active subscriber's lastRenewAt only moves every 3 months, so 45 days
   * in they'd be outside the 30-day block and could place a SECOND order —
   * and then receive both it AND their quarterly shipment.
   *
   * One shipment per household per cycle. Override with ORDER_DEDUPE_MONTHS
   * if the program's eligibility rule ever diverges from the ship cadence. */
  const dedupeBlockUntil = renewRef
    ? addMonths(new Date(renewRef), DEDUPE_MONTHS)
    : null;

  if (
    existingOrder &&
    dedupeBlockUntil &&
    Date.now() < dedupeBlockUntil.getTime()
  ) {
    const msg = "Address already used";
    await saveErrorLog({
      module: "createOrder",
      stage: "duplicate_address_check",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: {
        email,
        productId,
        subscription,
        flag,
        orderId: existingOrder?._id?.toString?.() || "",
        normalizedAddress: normalizedAddress1,
        normalizedAddress2,
      },
    });
    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  /* ================================================================ *
   *  ++ NEW ++  VALIDATE THE PRODUCT ID AT INTAKE.
   *
   *  createOrder used to store whatever `productId` arrived in the body.
   *  No check, ever. That is how these got into the database:
   *
   *      "PROD_001"                            <- not a Shopify id at all
   *      "gid://shopify/Product/8442746437829" <- the WEHO product, on an
   *                                               LA order
   *
   *  Neither can ever succeed. The first makes us call
   *  GET /products/NaN.json (Shopify: 400). The second 404s because that
   *  product doesn't exist on that store. Both then sit in the retry queue
   *  failing forever until a human digs them out of a cron log.
   *
   *  Catch it at the door, while there's still a customer to tell.
   * ================================================================ */
  const numericProductId = Number(
    (String(productId || "").match(/\/(\d+)$/) || [])[1] || productId,
  );
  if (!Number.isFinite(numericProductId) || numericProductId <= 0) {
    const msg =
      "We couldn't process that product. Please refresh the page and try again.";
    await saveErrorLog({
      module: "createOrder",
      stage: "invalid_product_id",
      level: "error",
      message: `Invalid productId "${productId}" — not a Shopify id`,
      statusCode: 400,
      request: buildReqInfo(req),
      context: { email, productId, flag, subscription },
    });
    console.error(`[createOrder] REJECTED invalid productId "${productId}"`);
    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  /* Optional: pin the product per site, so an LA order can never carry the
     WEHO product. Set PRODUCT_ID_LA / PRODUCT_ID_WEHO and a misconfigured
     WordPress form is caught here instead of as a 404 six weeks later. */
  const expectedProduct = isLA
    ? process.env.PRODUCT_ID_LA
    : process.env.PRODUCT_ID_WEHO;

  if (expectedProduct && productId !== expectedProduct) {
    await saveErrorLog({
      module: "createOrder",
      stage: "product_id_mismatch",
      level: "error",
      message: `${isLA ? "LA" : "WEHO"} order carrying the wrong product`,
      statusCode: 400,
      request: buildReqInfo(req),
      context: { email, flag, got: productId, expected: expectedProduct },
    });
    console.error(
      `[createOrder] REJECTED — ${isLA ? "LA" : "WEHO"} order sent productId ` +
        `"${productId}" but this site's product is "${expectedProduct}".`,
    );
    return res
      .status(200)
      .json(
        new ApiResponse(
          400,
          null,
          "We couldn't process that product. Please refresh the page and try again.",
        ),
      );
  }
  /* ================================================================ *
   *  ++ CHANGED ++  RENEWABILITY GATE
   *
   *  BEFORE: isActive/isRenewable were hardcoded `false` for EVERY order
   *  (the WEHO "no more recurring orders" change). But the renewal cron
   *  matches on { subscription:"monthly", isActive:true, isRenewable:true }
   *  — so with both pinned to false, NOTHING was ever renewable and the
   *  monthly flow was dead for Defent LA too. Your LA monthly requirement
   *  cannot work until this is gated per-site instead of globally off.
   *
   *  AFTER:  WEHO stays off (unchanged behaviour, and still env-flippable
   *          if you ever want it back). LA monthly renews.
   * ================================================================ */
  const isMonthly = isRecurring(subscription); // "monthly" | "quarterly" | "recurring"
  const isLAOrder = flag === "defentLA";
  const wehoRenewalsEnabled = process.env.ENABLE_WEHO_RENEWALS === "true"; // default OFF
  const renewable = isMonthly && (isLAOrder || wehoRenewalsEnabled);

  const order = await OrderModel.create({
    firstName,
    lastName,
    streetAddress: line1,
    streetAddress2: line2 || null,
    postCode,
    email,
    productId,
    subscription,
    isActive: renewable, // LA recurring -> true. WEHO / one_time -> false.
    isRenewable: renewable, // same predicate the renewal cron filters on

    /* Derived, display-only. lastRenewAt defaults to now(), so:
         nextOrderAt    = now + CYCLE_MONTHS
         nextReminderAt = nextOrderAt - REMINDER_BEFORE_DAYS
       The cron does NOT read these — it recomputes from lastRenewAt. */
    ...(renewable
      ? {
          nextOrderAt: nextDueAt(new Date()),
          nextReminderAt: reminderAt(new Date()),
        }
      : { nextOrderAt: null, nextReminderAt: null }),
    normalizedAddress: normalizedAddress1,
    normalizedAddress2: normalizedAddress2 || null,
    source: flag === "defentLA" ? "Defent La" : "Defent Weho",
    demographics: {
      age: age || "",
      gender: gender || "",
      identity: identity || "",
      household_size: household_size || "",
      ethnicity: joinMulti(ethnicity),
      household_language: joinMulti(household_language),
      identifyAsLGBTQ: identifyAsLGBTQ ? "Yes" : "No",
      wehoHearAboutUs: wehoHearAboutUs || "",
    },
    shopifySync: { status: "pending" },
    sheetSync: { status: "pending" },
  });

  if (!order) {
    const msg = "Failed to create an order";
    await saveErrorLog({
      module: "createOrder",
      stage: "db_create",
      level: "error",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: {
        email,
        productId,
        subscription,
        flag,
        normalizedAddress: normalizedAddress1,
        normalizedAddress2,
      },
    });
    return res.status(400).json(new ApiResponse(400, null, msg));
  }

  // ---- intake sheet append (best-effort; flush is the backstop) ----
  await appendSingleAndMark(order, flag);
  if (isRecurring(order.subscription)) {
    await appendMonthly(order);
  }

  logSuccess({
    message: "Order created",
    orderId: order._id,
    email,
    productId,
    timestamp: new Date(),
  });

  // Remix now creates the Shopify order, then calls /order/confirm.
  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { orderId: order._id.toString(), isRenewal: false, order },
        "Order created",
      ),
    );
});

/* ================================================================== *
 *  confirmOrder  (POST /order/confirm)
 *  Called by Remix AFTER attempting the Shopify order.
 *  body: { orderId, cycle?, isRenewal, status: 'synced'|'failed',
 *          shopifyOrderId?, error? }
 * ================================================================== */
const confirmOrder = asyncHandler(async (req, res) => {
  const {
    orderId,
    cycle,
    isRenewal = false,
    status,
    shopifyOrderId = null,
    error = "",
  } = req?.body || {};

  if (!orderId || !["synced", "failed"].includes(status)) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "orderId and valid status required"));
  }

  const now = new Date();

  /* ---------- RENEWAL confirm ---------- */
  if (isRenewal) {
    if (!cycle)
      return res
        .status(400)
        .json(new ApiResponse(400, null, "cycle required for renewal confirm"));

    if (status === "synced") {
      /* ++ CHANGED ++  Two SEPARATE idempotent writes.
       *
       * Before, I gated the clock advance on "was this the first confirm?".
       * That was wrong: a heal (Shopify already had the order) or a manual
       * reconcile confirms an ALREADY-completed cycle — so `claimed` was
       * null, the clock never advanced, and the cron re-renewed that order
       * on every single tick, forever, reporting ok= each time.
       *
       * Now: mark the log completed (idempotent), then advance the clock
       * via advancePastCycle(), which is idempotent on its own terms — it
       * only fires if lastRenewAt is still stuck on this cycle. A double
       * confirm can't double-advance, and a stuck clock always gets
       * unstuck. */
      await RenewalLogModel.updateOne(
        { orderId, cycle },
        {
          $set: {
            status: "completed",
            shopifyOrderId,
            "shopifySync.status": "synced",
            "shopifySync.lastAttemptAt": now,
            "shopifySync.lastError": "",
          },
        },
      );

      const advanced = await advancePastCycle(orderId, cycle);

      if (advanced) {
        logSuccess({ message: "Renewal confirmed", orderId, timestamp: now });
      }

      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { orderId, cycle, clockAdvanced: advanced },
            advanced ? "Renewal confirmed" : "Renewal already confirmed",
          ),
        );
    }

    /* ++ CHANGED ++  FAILED renewal: MARK it, don't DELETE it.
     *
     * BEFORE: `deleteOne({ orderId, cycle })`. That threw away (a) the
     * attempt counter — so a permanently-broken order would be retried by
     * the cron every single night, forever — and (b) the cycle row that
     * the reconciler needs in order to retry with the SAME cycle key, and
     * therefore the same `dbid:<id>;cycle:<c>` Shopify tag. Without that
     * tag stability, a retry cannot recognise an order Shopify already
     * created and would happily create a second one.
     *
     * AFTER: the row survives as "failed". reconcileCron picks it up ~10
     * minutes later, retries with the same cycle, and heals via the tag
     * lookup instead of duplicating. lastRenewAt is still un-advanced, so
     * nothing is lost. */

    /* ⚠ AND THE PART THAT ACTUALLY MATTERS ⚠
     *
     * A RATE LIMIT MUST NOT BURN THE ATTEMPT CAP.
     *
     * `attempts` exists to stop us hammering Shopify forever with a payload
     * it will never accept — a deleted product, a bad variant, a malformed
     * address. Those are OUR fault and they will never succeed.
     *
     * A 429 is not that. A 429 means "you're going too fast, come back in a
     * minute". The order is perfectly valid. If we count it as an attempt,
     * then a store that rate-limits us six times in a row — which a dev
     * store does trivially, and a busy production store can do during a
     * spike — permanently DROPS the order. Silently. Forever.
     *
     * So: rate-limit failures reset the clock but not the counter. They can
     * retry indefinitely. Only a REAL error (4xx that isn't 429, bad
     * product, validation) counts toward the cap. */
    const errText = String(error || "Shopify renewal failed");
    const isRateLimit =
      /rate limit|429|too many requests|exceeded .* api rate/i.test(errText);

    const failUpdate = {
      $set: {
        status: "failed",
        "shopifySync.status": "failed",
        "shopifySync.lastError": errText.slice(0, 500),
        "shopifySync.lastAttemptAt": now,
      },
    };
    // Only count it against the cap if it was genuinely our fault.
    if (!isRateLimit) failUpdate.$inc = { "shopifySync.attempts": 1 };

    await RenewalLogModel.updateOne({ orderId, cycle }, failUpdate);

    await saveErrorLog({
      module: "confirmOrder",
      stage: isRateLimit ? "renewal_rate_limited" : "renewal_failed_retryable",
      level: isRateLimit ? "warning" : "error",
      message: errText,
      request: buildReqInfo(req),
      context: {
        orderId,
        cycle,
        isRenewal: true,
        isRateLimit,
        countedAsAttempt: !isRateLimit,
      },
    });
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { orderId, cycle, retryable: true, isRateLimit },
          isRateLimit
            ? "Rate limited — will retry (attempt cap NOT consumed)"
            : "Renewal marked failed (reconciler will retry)",
        ),
      );
  }

  /* ---------- FIRST-TIME confirm ---------- */
  if (status === "synced") {
    /* ++ CHANGED ++  Never overwrite a shopifyOrderId we already hold.
     * If a stale retry lands after the order is already synced, silently
     * replacing the id would orphan the real Shopify order in our records
     * and hide a duplicate. The filter makes the write a no-op instead. */
    await OrderModel.updateOne(
      {
        _id: orderId,
        $or: [{ shopifyOrderId: null }, { shopifyOrderId: shopifyOrderId }],
      },
      {
        $set: {
          shopifyOrderId,
          "shopifySync.status": "synced",
          "shopifySync.lastAttemptAt": now,
          "shopifySync.lastError": "",
        },
        $inc: { "shopifySync.attempts": 1 },
      },
    );
    return res
      .status(200)
      .json(new ApiResponse(200, { orderId }, "Order confirmed"));
  }

  // FAILED first-time: leave retryable for the reconciler.
  /* ++ CHANGED ++ Same rule as renewals: a rate limit is "come back later",
     not a bad payload. It must NOT eat the attempt budget, or a 429 storm
     silently drops the customer's order forever. */
  const errText = String(error || "Shopify create failed");
  const isRateLimit =
    /rate limit|429|too many requests|exceeded .* api rate/i.test(errText);

  const failUpdate = {
    $set: {
      "shopifySync.status": "failed",
      "shopifySync.lastError": errText.slice(0, 500),
      "shopifySync.lastAttemptAt": now,
    },
  };
  if (!isRateLimit) failUpdate.$inc = { "shopifySync.attempts": 1 };

  await OrderModel.updateOne({ _id: orderId }, failUpdate);
  await saveErrorLog({
    module: "confirmOrder",
    stage: isRateLimit ? "firsttime_rate_limited" : "firsttime_failed",
    level: isRateLimit ? "warning" : "error",
    message: errText,
    request: buildReqInfo(req),
    context: { orderId, isRenewal: false },
  });
  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { orderId, failed: true },
        "Order marked failed (retryable)",
      ),
    );
});

const getAll30DaysAgoOrder = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req?.query?.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req?.query?.limit) || 25, 1), 200);
  const sourceFilterParam = req?.query?.source;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let sourceFilterArray = null;
  let filterDisplayValue = null;

  if (sourceFilterParam === "defentWeho") {
    sourceFilterArray = ["Defent Weho", "weho", null, undefined, ""];
    filterDisplayValue = "Defent Weho";
  } else if (sourceFilterParam === "defentLa") {
    sourceFilterArray = ["Defent La"];
    filterDisplayValue = "Defent La";
  }

  const matchConditions = { updatedAt: { $gte: thirtyDaysAgo } };

  if (sourceFilterParam === "defentWeho") {
    matchConditions.$or = [
      { source: { $in: sourceFilterArray } },
      { source: { $exists: false } },
      { source: null },
      { source: "" },
    ];
  } else if (sourceFilterParam === "defentLa") {
    matchConditions.source = "Defent La";
  }

  const pipeline = [
    { $match: matchConditions },
    { $sort: { updatedAt: -1, _id: -1 } },
    {
      $facet: {
        data: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $addFields: {
              normalizedSource: {
                $cond: {
                  if: {
                    $and: [
                      { $ne: [sourceFilterParam, "defentLa"] },
                      {
                        $or: [
                          { $eq: ["$source", "weho"] },
                          { $eq: ["$source", null] },
                          { $eq: ["$source", ""] },
                          { $not: ["$source"] },
                        ],
                      },
                    ],
                  },
                  then: "Defent Weho",
                  else: { $ifNull: ["$source", "Defent Weho"] },
                },
              },
            },
          },
          {
            $project: {
              _id: 1,
              isActive: 1,
              firstName: 1,
              lastName: 1,
              email: 1,
              subscription: 1,
              streetAddress: 1,
              streetAddress2: 1,
              postCode: 1,
              source: 1,
              normalizedSource: 1,
              normalizedAddress: 1,
              normalizedAddress2: 1,
              lastRenewAt: "$updatedAt",
              flag: 1,
              demographics: 1,
              createdAt: 1,
              updatedAt: 1,
              productId: 1,
            },
          },
        ],
        meta: [{ $count: "total" }],
      },
    },
    {
      $project: {
        data: 1,
        total: { $ifNull: [{ $arrayElemAt: ["$meta.total", 0] }, 0] },
      },
    },
  ];

  try {
    const [result] = await OrderModel.aggregate(pipeline);

    const total = result?.total || 0;
    const totalPages = Math.ceil(total / limit) || 1;

    const nextPage = page < totalPages;
    const prevPage = page > 1;

    const responseData = {
      data: result?.data || [],
      page,
      limit,
      total,
      totalPages,
      nextPage,
      prevPage,
    };

    if (filterDisplayValue) {
      responseData.filteredBy = filterDisplayValue;
    }

    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          responseData,
          filterDisplayValue
            ? `Orders fetched successfully for source: ${filterDisplayValue}`
            : "Orders fetched successfully",
        ),
      );
  } catch (error) {
    console.error("Error fetching orders:", error);
    return res.status(500).json(
      new ApiResponse(
        500,
        {
          data: [],
          page,
          limit,
          total: 0,
          totalPages: 1,
          nextPage: false,
          prevPage: false,
        },
        `Error fetching orders: ${error.message}`,
      ),
    );
  }
});
const updateSubscription = asyncHandler(async (req, res) => {
  const { orderId } = req?.params || {};
  const { isActive } = req?.body || {};

  if (!orderId) throw new ApiError(400, "Order ID is required");
  if (typeof isActive !== "boolean") {
    throw new ApiError(400, "isActive must be boolean");
  }

  const subscription = isActive ? "monthly" : "one_time";

  const order = await OrderModel.findByIdAndUpdate(
    orderId,
    { $set: { isActive, subscription } },
    { new: true, runValidators: true },
  );

  if (!order) throw new ApiError(404, "Order not found");

  return res
    .status(200)
    .json(new ApiResponse(200, order, "Subscription updated"));
});
const removeDuplicateOrders = asyncHandler(async (req, res) => {
  try {
    const pipeline = [
      {
        $match: {
          isActive: true,
          subscription: RECURRING_MATCH,
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $group: {
          _id: "$email",
          documents: { $push: "$$ROOT" },
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
    ];

    const duplicates = await OrderModel.aggregate(pipeline);

    let deletedCount = 0;

    for (const duplicate of duplicates) {
      const docs = duplicate.documents;
      const latestDoc = docs[0];
      const olderDocs = docs.slice(1);

      for (const oldDoc of olderDocs) {
        await OrderModel.deleteOne({ _id: oldDoc._id });
        deletedCount++;
        console.log(
          `Deleted duplicate order for ${duplicate._id} with ID: ${oldDoc._id} (created: ${oldDoc.createdAt})`,
        );
      }
    }

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          deletedCount,
          message: `Removed ${deletedCount} duplicate orders`,
        },
        "Duplicate orders removed successfully",
      ),
    );
  } catch (error) {
    console.error("Error removing duplicates:", error);
    return res
      .status(500)
      .json(
        new ApiResponse(
          500,
          null,
          `Error removing duplicates: ${error.message}`,
        ),
      );
  }
});
const getDuplicateOrders = asyncHandler(async (req, res) => {
  try {
    const pipeline = [
      {
        $match: {
          isActive: true,
          subscription: RECURRING_MATCH,
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $group: {
          _id: "$email",
          documents: { $push: "$$ROOT" },
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
      {
        $project: {
          email: "$_id",
          duplicateCount: "$count",
          orders: {
            $map: {
              input: "$documents",
              as: "doc",
              in: {
                _id: "$$doc._id",
                firstName: "$$doc.firstName",
                lastName: "$$doc.lastName",
                createdAt: "$$doc.createdAt",
                updatedAt: "$$doc.updatedAt",
                isActive: "$$doc.isActive",
                subscription: "$$doc.subscription",
                source: "$$doc.source",
                streetAddress: "$$doc.streetAddress",
                postCode: "$$doc.postCode",
              },
            },
          },
          keepOrder: {
            $arrayElemAt: ["$documents", 0],
          },
          deleteOrders: {
            $slice: ["$documents", 1, { $size: "$documents" }],
          },
        },
      },
      {
        $project: {
          email: 1,
          duplicateCount: 1,
          orders: 1,
          keepOrderId: "$keepOrder._id",
          keepOrderCreatedAt: "$keepOrder.createdAt",
          deleteOrderIds: {
            $map: {
              input: "$deleteOrders",
              as: "order",
              in: "$$order._id",
            },
          },
        },
      },
    ];

    const duplicates = await OrderModel.aggregate(pipeline);

    const totalDuplicates = duplicates.reduce(
      (sum, dup) => sum + (dup.duplicateCount - 1),
      0,
    );

    return res.status(200).json(
      new ApiResponse(
        200,
        {
          totalDuplicateGroups: duplicates.length,
          totalDuplicateOrders: totalDuplicates,
          duplicates: duplicates,
        },
        duplicates.length > 0
          ? `Found ${duplicates.length} customers with duplicate orders (${totalDuplicates} duplicate records)`
          : "No duplicate orders found",
      ),
    );
  } catch (error) {
    console.error("Error checking duplicates:", error);
    return res
      .status(500)
      .json(
        new ApiResponse(
          500,
          null,
          `Error checking duplicates: ${error.message}`,
        ),
      );
  }
});
const addIsRenewableField = async (req, res) => {
  try {
    const result = await OrderModel.updateMany(
      { isRenewable: { $exists: false } },
      { $set: { isRenewable: false } },
    );

    return res.status(200).json({
      success: true,
      message: "isRenewable field added to existing documents",
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to add isRenewable field",
      error: error.message,
    });
  }
};
const backfillSyncStatus = asyncHandler(async (req, res) => {
  // Optional body. status defaults to "synced" (old orders were already
  // fulfilled). Use "skipped" if you'd rather not assert they synced,
  // or "pending" if you actually want reconcile to back-fill them.
  const { status = "synced", seedRenewable = false } = req?.body || {};

  const allowed = ["synced", "skipped", "pending"];
  if (!allowed.includes(status)) {
    throw new ApiError(400, `status must be one of: ${allowed.join(", ")}`);
  }

  // Legacy docs = those missing the sync field entirely (your ~331).
  const legacyFound = await OrderModel.countDocuments({
    "shopifySync.status": { $exists: false },
  });

  // Only touch docs that don't already have a status → safe to re-run.
  const syncResult = await OrderModel.updateMany(
    { "shopifySync.status": { $exists: false } },
    { $set: { "shopifySync.status": status, "sheetSync.status": status } },
  );

  // Optional: turn renewals ON for existing active monthly subscribers,
  // otherwise the cron won't renew them.
  let renewableSeeded = 0;
  if (seedRenewable === true) {
    const r = await OrderModel.updateMany(
      {
        subscription: RECURRING_MATCH,
        isActive: true,
        isRenewable: { $ne: true },
      },
      { $set: { isRenewable: true } },
    );
    renewableSeeded = r.modifiedCount;
  }

  const stillMissing = await OrderModel.countDocuments({
    "shopifySync.status": { $exists: false },
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        status,
        legacyFound,
        syncFieldsBackfilled: syncResult.modifiedCount,
        renewableSeeded,
        stillMissing, // should be 0 after a successful run
      },
      "Backfill complete",
    ),
  );
});

const syncMonthlyToNewSheet = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req?.body?.limit) || 1000, 1), 5000);
  try {
    const result = await backfillMonthlySheet({ limit });
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          result,
          `Synced ${result.appended} monthly order(s); ${result.remaining} remaining`,
        ),
      );
  } catch (error) {
    await saveErrorLog({
      module: "syncMonthlyToNewSheet",
      stage: "monthly_backfill",
      level: "error",
      message: error?.message || "Monthly backfill failed",
      statusCode: 500,
      request: buildReqInfo(req),
    });
    return res
      .status(500)
      .json(new ApiResponse(500, null, `Backfill failed: ${error.message}`));
  }
});

export {
  createOrder,
  getAll30DaysAgoOrder,
  updateSubscription,
  removeDuplicateOrders,
  getDuplicateOrders,
  addIsRenewableField,
  confirmOrder,
  backfillSyncStatus,
  syncMonthlyToNewSheet,
};
