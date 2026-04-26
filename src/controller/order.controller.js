import { OrderModel } from "../model/orderModel.js";
import { ErrorLogModel } from "../model/errorLog.js";
import {
  areAddressLinesSame,
  isWestHollywoodOK,
  validateUSAddress,
} from "../utils/addressValidation.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { logSuccess, logFailure } from "../utils/logger.js";
import { appendOrderRow } from "../utils/sheet.js";
import {
  validateAddressLine1,
  validateAddressLine2,
} from "../validators/address.js";
import { normalizeLine2 } from "../utils/normalizeAddress.js";

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

const createOrder = asyncHandler(async (req, res) => {
  const {
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
  } = req?.body || {};

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
        subscription: subscription || "",
        flag: flag || "",
      },
    });

    return res.status(400).json(new ApiResponse(400, null, msg));
  }

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
  const line1 = v1?.value;

  const v2 = validateAddressLine2(_line2);
  if (!v2?.ok) {
    const msg = v2?.error || "Invalid address line 2";
    logFailure({ reason: msg, request: req?.body });

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
  const line2 = v2?.value;

  if (line2 && areAddressLinesSame(line1, line2)) {
    const msg = "Address line 1 and line 2 cannot be the same";
    logFailure({ reason: msg, request: req?.body });

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

  const oneLine = `${line1}, West Hollywood, CA ${String(postCode).slice(0, 5)}`;
  const v = await validateUSAddress(oneLine);

  if (!v?.ok) {
    const msg = "The address must be located within West Hollywood, CA.";
    logFailure({ reason: "Invalid address", request: req?.body });

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
      meta: {
        inputAddress: oneLine,
        validatorResponse: v || null,
      },
    });

    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  if (!isWestHollywoodOK(v?.components)) {
    const msg =
      "Service area is West Hollywood, CA (ZIPs: 90038, 90046, 90048, 90069)";
    logFailure({ reason: msg, request: req?.body });

    await saveErrorLog({
      module: "createOrder",
      stage: "service_area_check",
      level: "warning",
      message: msg,
      statusCode: 400,
      request: buildReqInfo(req),
      context: { email, productId, subscription, flag },
      meta: {
        inputAddress: oneLine,
        components: v?.components || null,
      },
    });

    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  const normalizedAddress1 = v?.normalized;
  const normalizedAddress2 = line2 ? normalizeLine2(line2) : "";
  const thirtyDaysMs = 30 * 86400000;

  const query = line2
    ? { normalizedAddress: normalizedAddress1, normalizedAddress2 }
    : { normalizedAddress: normalizedAddress1 };

  const existingOrder = await OrderModel.findOne(query);

  if (
    existingOrder &&
    Date.now() - existingOrder?.createdAt?.getTime?.() <= thirtyDaysMs
  ) {
    const msg = "Address already used";
    logFailure({ reason: msg, request: req?.body });

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
        normalizedAddress: normalizedAddress1 || "",
        normalizedAddress2: normalizedAddress2 || "",
      },
    });

    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  const order = await OrderModel.create({
    firstName,
    lastName,
    streetAddress: line1,
    streetAddress2: line2 || null,
    postCode,
    email,
    productId,
    subscription,
    isActive: subscription !== "one_time",
    normalizedAddress: normalizedAddress1,
    normalizedAddress2: normalizedAddress2 || null,
  });

  if (!order) {
    const msg = "Failed to create an order";
    logFailure({
      reason: "Failed to create an order after validation",
      request: req?.body,
    });

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
        normalizedAddress: normalizedAddress1 || "",
        normalizedAddress2: normalizedAddress2 || "",
      },
    });

    return res.status(400).json(new ApiResponse(400, null, msg));
  }

  const basePayload = {
    createdAt: order?.createdAt,
    firstName: order?.firstName,
    lastName: order?.lastName,
    streetAddress: order?.streetAddress,
    streetAddress2: order?.streetAddress2 || "",
    postCode: String(postCode).slice(0, 5),
    email: order?.email,
    subscription: order?.subscription,
    productId: order?.productId,
    age: age || "",
    wehoHearAboutUs: wehoHearAboutUs || "Instagram",
    household_size: household_size || "",
    ethnicity: joinMulti(ethnicity),
    household_language: joinMulti(household_language),
  };
  let sheetPayload;

  if (flag === "defentLA") {
    sheetPayload = basePayload;
  } else {
    sheetPayload = {
      ...basePayload,
      gender: gender || "",
      identity: identity || "",
      identifyAsLGBTQ: identifyAsLGBTQ ? "Yes" : "No",
    };
  }
  try {
    await appendOrderRow(sheetPayload, flag);
  } catch (e) {
    console.error("Sheets append failed:", e);

    await saveErrorLog({
      module: "createOrder",
      stage: "sheet_append",
      level: "error",
      message: e?.message || "Sheets append failed",
      errorName: e?.name || "",
      stack: e?.stack || "",
      request: buildReqInfo(req),
      context: {
        orderId: order?._id?.toString?.() || "",
        email,
        productId,
        subscription,
        flag,
        normalizedAddress: normalizedAddress1 || "",
        normalizedAddress2: normalizedAddress2 || "",
      },
      externalService: {
        name: "google-sheets",
        endpoint: "appendOrderRow",
        method: "APPEND",
      },
    });
  }

  logSuccess({
    message: "Order created successfully",
    orderId: order?._id,
    email,
    productId,
    timestamp: new Date(),
  });

  return res.status(200).json(new ApiResponse(200, order, "Order created"));
});

const getAll30DaysAgoOrder = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req?.query?.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req?.query?.limit) || 25, 1), 200);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const pipeline = [
    {
      $match: {
        updatedAt: { $gte: thirtyDaysAgo },
      },
    },
    {
      $sort: {
        updatedAt: -1,
        _id: -1,
      },
    },
    {
      $facet: {
        data: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              _id: 1,
              isActive: 1,
              firstName: 1,
              lastName: 1,
              email: 1,
              subscription: 1,
              streetAddress: 1,
              lastRenewAt: "$updatedAt",
            },
          },
        ],
        meta: [{ $count: "total" }],
      },
    },
    {
      $project: {
        data: 1,
        total: {
          $ifNull: [{ $arrayElemAt: ["$meta.total", 0] }, 0],
        },
      },
    },
  ];

  const [result] = await OrderModel.aggregate(pipeline);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        data: result?.data || [],
        page,
        limit,
        total: result?.total || 0,
        totalPages: Math.ceil((result?.total || 0) / limit) || 1,
      },
      "Orders fetched successfully",
    ),
  );
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

export { createOrder, getAll30DaysAgoOrder, updateSubscription };
