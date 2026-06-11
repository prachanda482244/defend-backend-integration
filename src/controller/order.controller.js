import { OrderModel } from "../model/orderModel.js";
import { ErrorLogModel } from "../model/errorLog.js";

import {
  areAddressLinesSame,
  isWestHollywoodOK,
  isLosAngelesOK,
  validateUSAddress,
  validateAddressWithZipFallback,
} from "../utils/addressValidation.js";
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
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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
      existing.subscription !== "monthly" ||
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

    // due check — lastRenewAt ?? createdAt; updatedAt deliberately NOT used
    const lastRenew =
      (existing.lastRenewAt ?? existing.createdAt)?.getTime?.() ?? 0;
    if (Date.now() - lastRenew < THIRTY_DAYS_MS) {
      const msg = "Renewal not due yet";
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
        // already claimed for this cycle — idempotent no-op
        return res
          .status(200)
          .json(
            new ApiResponse(
              200,
              { orderId, cycle, alreadyClaimed: true },
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
    const msg = isLA
      ? "The address must be located within Los Angeles, CA."
      : "The address must be located within West Hollywood, CA.";
    await saveErrorLog({
      module: "createOrder",
      stage: "address_validation_api",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: { email, productId, subscription, flag },
      externalService: {
        name: "address-validator",
        endpoint: "validateUSAddress",
        method: "POST",
      },
      meta: { inputAddress: oneLine, validatorResponse: v || null },
    });
    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  const serviceAreaOK = isLA
    ? isLosAngelesOK(v?.components)
    : isWestHollywoodOK(v?.components);
  if (!serviceAreaOK) {
    const msg = isLA
      ? "Service area is Los Angeles, CA."
      : "Service area is West Hollywood, CA (ZIPs: 90038, 90046, 90048, 90069)";
    await saveErrorLog({
      module: "createOrder",
      stage: "service_area_check",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: { email, productId, subscription, flag },
      meta: { inputAddress: oneLine, components: v?.components || null },
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

  if (
    existingOrder &&
    renewRef &&
    Date.now() - renewRef.getTime() <= THIRTY_DAYS_MS
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

  // ---- create the order (sync states default to pending) ----
  const isSub = subscription !== "one_time";
  const order = await OrderModel.create({
    firstName,
    lastName,
    streetAddress: line1,
    streetAddress2: line2 || null,
    postCode,
    email,
    productId,
    subscription,
    isActive: isSub,
    isRenewable: isSub, // subscriptions renew; one_time does not
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
      // 1) finalize the order: advance lastRenewAt (THE fix)
      await OrderModel.updateOne(
        { _id: orderId },
        { $set: { lastRenewAt: now } },
      );
      // 2) complete the cycle log; sheetSync stays pending for the flush
      await RenewalLogModel.updateOne(
        { orderId, cycle },
        {
          $set: {
            status: "completed",
            shopifyOrderId,
            "shopifySync.status": "synced",
            "shopifySync.lastAttemptAt": now,
          },
          $inc: { "shopifySync.attempts": 1 },
        },
      );
      logSuccess({ message: "Renewal confirmed", orderId, timestamp: now });
      return res
        .status(200)
        .json(new ApiResponse(200, { orderId, cycle }, "Renewal confirmed"));
    }

    // FAILED renewal: release the cycle so the next cron retries cleanly.
    // (lastRenewAt was never advanced, so the order is still "due".)
    await RenewalLogModel.deleteOne({ orderId, cycle });
    await saveErrorLog({
      module: "confirmOrder",
      stage: "renewal_failed_release",
      level: "error",
      message: error || "Shopify renewal failed",
      request: buildReqInfo(req),
      context: { orderId, cycle, isRenewal: true },
    });
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { orderId, cycle, released: true },
          "Renewal released for retry",
        ),
      );
  }

  /* ---------- FIRST-TIME confirm ---------- */
  if (status === "synced") {
    await OrderModel.updateOne(
      { _id: orderId },
      {
        $set: {
          shopifyOrderId,
          "shopifySync.status": "synced",
          "shopifySync.lastAttemptAt": now,
        },
        $inc: { "shopifySync.attempts": 1 },
      },
    );
    return res
      .status(200)
      .json(new ApiResponse(200, { orderId }, "Order confirmed"));
  }

  // FAILED first-time: leave retryable for the reconciler.
  await OrderModel.updateOne(
    { _id: orderId },
    {
      $set: {
        "shopifySync.status": "failed",
        "shopifySync.lastError": error || "Shopify create failed",
        "shopifySync.lastAttemptAt": now,
      },
      $inc: { "shopifySync.attempts": 1 },
    },
  );
  await saveErrorLog({
    module: "confirmOrder",
    stage: "firsttime_failed",
    level: "error",
    message: error || "Shopify create failed",
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
          subscription: "monthly",
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
          subscription: "monthly",
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
export {
  createOrder,
  getAll30DaysAgoOrder,
  updateSubscription,
  removeDuplicateOrders,
  getDuplicateOrders,
  addIsRenewableField,
  confirmOrder,
};
