import { OrderModel } from "../model/orderModel.js";
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
  )
    throw new ApiError(400, "Missing required field");

  const normalizedAddress = normalizeAddress(streetAddress);

  const existingOrder = await OrderModel.findOne({ normalizedAddress });
  if (existingOrder) {
    const currentDate = new Date();
    const orderDate = existingOrder.createdAt;
    const thirtyDaysInMillis = 30 * 24 * 60 * 60 * 1000;
    const isOrderWithin30Days = currentDate - orderDate <= thirtyDaysInMillis;

    if (isOrderWithin30Days) {
      return res
        .status(200)
        .json(new ApiResponse(400, null, "Address already used"));
    }
  }

  const order = await OrderModel.create({
    firstName,
    lastName,
    streetAddress,
    postCode,
    email,
    subscription,
    isActive: subscription === "one_time" ? false : true,
    productId,
    normalizedAddress,
  });

  if (!order) throw new ApiError(400, "Failed to create an order");
  try {
    await appendOrderRow({
      createdAt: order.createdAt,
      firstName: order.firstName,
      lastName: order.lastName,
      streetAddress: order.streetAddress,
      postCode: order.postCode,
      email: order.email,
      subscription: order.subscription,
      productId: order.productId,

      // extras (labels or raw)
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
