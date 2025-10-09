import { OrderModel } from "../model/orderModel.js";
import {
  isWestHollywoodOK,
  validateUSAddress,
} from "../utils/addressValidation.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { normalizeAddress } from "../utils/normalizeAddress.js";
import { appendOrderRow } from "../utils/sheet.js";

const joinMulti = (a) => (a && a.length ? a.join(", ") : "");
const createOrder = asyncHandler(async (req, res) => {
  const {
    firstName,
    lastName,
    streetAddress,
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

  if (
    !firstName ||
    !lastName ||
    !streetAddress ||
    !postCode ||
    !email ||
    !productId ||
    !subscription
  ) {
    throw new ApiError(400, "Missing required field");
  }

  // ---- Address validation (free, US-only) ----
  const oneLine = `${streetAddress}, West Hollywood, CA ${String(
    postCode
  ).slice(0, 5)}`;
  const v = await validateUSAddress(oneLine);
  if (!v.ok)
    return res.status(400).json(new ApiResponse(400, null, "Invalid address"));
  if (!isWestHollywoodOK(v.components)) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          "Service area is West Hollywood, CA (ZIPs: 90038, 90046, 90048, 90069)"
        )
      );
  }
  const normalizedAddress = v.normalized;

  // ---- 30-day reuse check ----
  const existingOrder = await OrderModel.findOne({ normalizedAddress });
  if (existingOrder) {
    const isOrderWithin30Days =
      Date.now() - existingOrder.createdAt.getTime() <=
      30 * 24 * 60 * 60 * 1000;
    if (isOrderWithin30Days) {
      return res
        .status(200)
        .json(new ApiResponse(400, null, "Address already used"));
    }
  }

  // ---- Create order ----
  const order = await OrderModel.create({
    firstName,
    lastName,
    streetAddress,
    postCode,
    email,
    subscription,
    isActive: subscription === "one_time" ? false : true,
    productId,
    normalizedAddress, // Census-normalized
  });
  if (!order) throw new ApiError(400, "Failed to create an order");

  // ---- Append to Sheet (best-effort) ----
  try {
    await appendOrderRow({
      createdAt: order.createdAt,
      firstName: order.firstName,
      lastName: order.lastName,
      streetAddress: order.streetAddress,
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
