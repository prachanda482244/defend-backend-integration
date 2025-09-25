import { OrderModel } from "../model/orderModel.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const createOrder = asyncHandler(async (req, res) => {
  const { firstName, lastName, streetAddress, postCode, email, productId } =
    req.body;

  if (
    !firstName ||
    !lastName ||
    !streetAddress ||
    !postCode ||
    !email ||
    !productId
  )
    throw new ApiError(400, "Missing required field");

  const existingOrder = await OrderModel.findOne({ streetAddress });
  if (existingOrder) {
    const currentDate = new Date();
    const orderDate = existingOrder.createdAt;
    const thirtyDaysInMillis = 30 * 24 * 60 * 60 * 1000;
    const isOrderWithin30Days = currentDate - orderDate <= thirtyDaysInMillis;

    if (isOrderWithin30Days) {
      throw new ApiError(400, "Address already used within the last 30 days");
    }
  }

  const order = await OrderModel.create({
    firstName,
    lastName,
    streetAddress,
    postCode,
    email,
    productId,
  });

  if (!order) throw new ApiError(400, "Failed to create an order");

  return res.status(200).json(new ApiResponse(200, order, "Order created"));
});

const getAll30DaysAgoOrder = asyncHandler(async (req, res) => {
  const currentDate = new Date();
  const thirtyDaysAgo = new Date(
    currentDate.setDate(currentDate.getDate() - 30)
  );

  const orders = await OrderModel.find({
    createdAt: { $gte: thirtyDaysAgo },
  });

  if (!orders || orders.length === 0) {
    return res
      .status(404)
      .json(new ApiResponse(404, [], "No orders found in the last 30 days"));
  }

  return res
    .status(200)
    .json(new ApiResponse(200, orders, "Orders fetched successfully"));
});

export { createOrder, getAll30DaysAgoOrder };
