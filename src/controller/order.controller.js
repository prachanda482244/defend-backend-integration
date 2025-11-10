import { OrderModel } from "../model/orderModel.js";
import {
  areAddressLinesSame,
  isWestHollywoodOK,
  validateUSAddress,
} from "../utils/addressValidation.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

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
    streetAddress2: _line2, // optional
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
    !_line1 ||
    !postCode ||
    !email ||
    !productId ||
    !subscription
  ) {
    throw new ApiError(400, "Missing required field");
  }

  // Line 1
  const v1 = validateAddressLine1(_line1);
  if (!v1.ok) return res.status(200).json(new ApiResponse(400, null, v1.error));
  const line1 = v1.value;

  // Line 2 (optional)
  const v2 = validateAddressLine2(_line2);
  if (!v2.ok) return res.status(200).json(new ApiResponse(400, null, v2.error));
  const line2 = v2.value; // "" if absent

  // Validate that address line 1 and line 2 are different
  if (line2 && areAddressLinesSame(line1, line2)) {
    return res
      .status(200)
      .json(
        new ApiResponse(
          400,
          null,
          "Address line 1 and line 2 cannot be the same"
        )
      );
  }

  // External US validation on Line 1 only
  const oneLine = `${line1}, West Hollywood, CA ${String(postCode).slice(
    0,
    5
  )}`;
  const v = await validateUSAddress(oneLine);
  if (!v.ok)
    return res.status(200).json(new ApiResponse(400, null, "Invalid address"));
  if (!isWestHollywoodOK(v.components)) {
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          "Service area is West Hollywood, CA (ZIPs: 90038, 90046, 90048, 90069)"
        )
      );
  }
  const normalizedAddress1 = v.normalized; // canonical from your API
  const normalizedAddress2 = line2 ? normalizeLine2(line2) : ""; // normalized second line

  // 30-day reuse rule:
  // If Line2 present → check reuse by Line2 only.
  // Else             → check reuse by Line1 only.
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  let query;
  if (line2) {
    // When both lines exist, check the COMBINATION of both
    query = {
      normalizedAddress: normalizedAddress1,
      normalizedAddress2: normalizedAddress2,
    };
  } else {
    // When only line1 exists, check line1 only
    query = { normalizedAddress: normalizedAddress1 };
  }

  const existingOrder = await OrderModel.findOne(query);
  if (
    existingOrder &&
    Date.now() - existingOrder.createdAt.getTime() <= thirtyDaysMs
  ) {
    return res
      .status(200)
      .json(new ApiResponse(400, null, "Address already used"));
  }
  // Create
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
  if (!order) throw new ApiError(400, "Failed to create an order");

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
