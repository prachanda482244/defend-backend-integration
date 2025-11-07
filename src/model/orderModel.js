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
    streetAddress2: {
      type: String,
    },
    postCode: {
      type: String,
      required: true,
    },
    subscription: {
      type: String,
      required: true,
      default: "one_time",
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    email: {
      type: String,
      required: true,
    },
    normalizedAddress: { type: String, index: true },
    normalizedAddress2: { type: String, default: null },

    lastRenewAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const OrderModel = model("Order", orderSchema);
OrderModel.createIndexes({ createdAt: 1 });
