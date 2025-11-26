import { OrderModel } from "../model/orderModel.js";
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

const joinMulti = (a) => (a && a.length ? a.join(", ") : "");
import {
  validateAddressLine1,
  validateAddressLine2,
} from "../validators/address.js";
import { normalizeLine2 } from "../utils/normalizeAddress.js";
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
  } = req.body;

  // Missing required fields
  if (
    !firstName ||
    !lastName ||
    !_line1 ||
    !postCode ||
    !email ||
    !productId ||
    !subscription
  ) {
    logFailure({ reason: "Missing required field", request: req.body });
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing required field"));
  }

  // Line 1 validate
  const v1 = validateAddressLine1(_line1);
  if (!v1.ok) {
    logFailure({ reason: v1.error, request: req.body });
    return res.status(200).json(new ApiResponse(400, null, v1.error));
  }
  const line1 = v1.value;

  // Line 2 validate
  const v2 = validateAddressLine2(_line2);
  if (!v2.ok) {
    logFailure({ reason: v2.error, request: req.body });
    return res.status(200).json(new ApiResponse(400, null, v2.error));
  }
  const line2 = v2.value;

  // Validate address lines are not same
  if (line2 && areAddressLinesSame(line1, line2)) {
    const msg = "Address line 1 and line 2 cannot be the same";
    logFailure({ reason: msg, request: req.body });
    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  // External US validation
  const oneLine = `${line1}, West Hollywood, CA ${String(postCode).slice(
    0,
    5
  )}`;
  const v = await validateUSAddress(oneLine);
  if (!v.ok) {
    logFailure({ reason: "Invalid address", request: req.body });
    return res.status(200).json(new ApiResponse(400, null, "Invalid address"));
  }

  if (!isWestHollywoodOK(v.components)) {
    const msg =
      "Service area is West Hollywood, CA (ZIPs: 90038, 90046, 90048, 90069)";
    logFailure({ reason: msg, request: req.body });
    return res.status(200).json(new ApiResponse(200, msg));
  }

  const normalizedAddress1 = v.normalized;
  const normalizedAddress2 = line2 ? normalizeLine2(line2) : "";

  const thirtyDaysMs = 30 * 86400000;

  const query = line2
    ? { normalizedAddress: normalizedAddress1, normalizedAddress2 }
    : { normalizedAddress: normalizedAddress1 };

  const existingOrder = await OrderModel.findOne(query);

  if (
    existingOrder &&
    Date.now() - existingOrder.createdAt.getTime() <= thirtyDaysMs
  ) {
    const msg = "Address already used";
    logFailure({ reason: msg, request: req.body });
    return res.status(200).json(new ApiResponse(400, null, msg));
  }

  // Create order
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
    logFailure({
      reason: "Failed to create an order after validation",
      request: req.body,
    });
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Failed to create an order"));
  }

  // Sheets
  try {
    await appendOrderRow({
      createdAt: order.createdAt,
      firstName: order.firstName,
      lastName: order.lastName,
      streetAddress: order.streetAddress,
      streetAddress2: order.streetAddress2 || "",
      postCode: String(postCode).slice(0, 5),
      email: order.email,
      subscription: order.subscription,
      productId: order.productId,
      age: age || "",
      gender: gender || "",
      identity: identity || "",
      household_size: household_size || "",
      ethnicity: joinMulti(ethnicity),
      household_language: joinMulti(household_language),
    });
  } catch (e) {
    console.error("Sheets append failed:", e);
  }

  // SUCCESS LOG
  logSuccess({
    message: "Order created successfully",
    orderId: order._id,
    email,
    productId,
    timestamp: new Date(),
  });

  return res.status(200).json(new ApiResponse(200, order, "Order created"));
});

const getAll30DaysAgoOrder = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 200);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // monthly first, then one_time, then others; newest first inside groups
  const pipeline = [
    { $match: { createdAt: { $gte: thirtyDaysAgo } } },
    {
      $addFields: {
        _subWeight: {
          $switch: {
            branches: [
              { case: { $eq: ["$subscription", "monthly"] }, then: 0 },
              { case: { $eq: ["$subscription", "one_time"] }, then: 2 },
            ],
            default: 1,
          },
        },
      },
    },
    { $sort: { _subWeight: 1, createdAt: -1, _id: 1 } },
    {
      $facet: {
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
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

  const [result] = await OrderModel.aggregate(pipeline);
  const data = result?.data || [];
  const total = result?.total || 0;

  return res.status(200).json({
    success: true,
    message: "Orders fetched successfully",
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
  });
});

const updateSubscription = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { isActive } = req.body;

  if (!orderId) throw new ApiError(400, "Order ID is required");

  // Keep string field aligned for your reporting/filters
  const subscription = isActive ? "monthly" : "one_time";

  const order = await OrderModel.findByIdAndUpdate(
    orderId,
    { $set: { isActive, subscription } },
    { new: true, runValidators: true }
  );

  if (!order) throw new ApiError(404, "Order not found");

  return res
    .status(200)
    .json(new ApiResponse(200, order, "Subscription updated"));
});

export { createOrder, getAll30DaysAgoOrder, updateSubscription };
