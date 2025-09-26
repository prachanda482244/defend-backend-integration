import { Schema, model } from "mongoose";

const orderSchema = new Schema(
  {
    productId: {
      type: String,
    },
    firstName: {
      type: String,
    },
    lastName: {
      type: String,
      default: "",
    },
    streetAddress: {
      type: String,
      required: true,
    },
    postCode: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

export const OrderModel = model("Order", orderSchema);
OrderModel.createIndexes({ createdAt: 1 });
