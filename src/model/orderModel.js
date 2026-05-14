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
    source: {
      type: String,
      default: "weho",
    },
    normalizedAddress: { type: String, index: true },
    normalizedAddress2: { type: String, default: null },

    lastRenewAt: { type: Date, default: Date.now },

    flag: {
      type: String,
    },
    demographics: {
      age: { type: String },
      gender: { type: String },
      identity: { type: String },
      household_size: { type: String },
      ethnicity: { type: String },
      household_language: { type: String },
      identifyAsLGBTQ: { type: String },
      wehoHearAboutUs: { type: String },
    },
  },
  { timestamps: true },
);

export const OrderModel = model("Order", orderSchema);
OrderModel.createIndexes({ createdAt: 1 });
