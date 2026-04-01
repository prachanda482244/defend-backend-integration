import mongoose from "mongoose";

const ErrorLogSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: true,
      index: true,
    },
    module: {
      type: String,
      default: "",
      index: true,
    },
    stage: {
      type: String,
      default: "",
      index: true,
    },
    level: {
      type: String,
      enum: ["info", "warning", "error", "critical"],
      default: "error",
      index: true,
    },
    message: {
      type: String,
      required: true,
    },
    errorName: {
      type: String,
      default: "",
    },
    statusCode: {
      type: Number,
      default: null,
      index: true,
    },
    stack: {
      type: String,
      default: "",
    },

    request: {
      method: { type: String, default: "" },
      url: { type: String, default: "" },
      ip: { type: String, default: "" },
      userAgent: { type: String, default: "" },
      headers: { type: mongoose.Schema.Types.Mixed, default: null },
      body: { type: mongoose.Schema.Types.Mixed, default: null },
      params: { type: mongoose.Schema.Types.Mixed, default: null },
      query: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    response: {
      data: { type: mongoose.Schema.Types.Mixed, default: null },
      headers: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    context: {
      orderId: { type: String, default: "", index: true },
      shopifyOrderId: { type: String, default: "" },
      email: { type: String, default: "", index: true },
      productId: { type: String, default: "" },
      subscription: { type: String, default: "" },
      flag: {
        type: String,
        enum: ["", "defentWeho", "defentLA"],
        default: "",
        index: true,
      },
      normalizedAddress: { type: String, default: "" },
      normalizedAddress2: { type: String, default: "" },
    },

    externalService: {
      name: { type: String, default: "" },
      endpoint: { type: String, default: "" },
      method: { type: String, default: "" },
      statusCode: { type: Number, default: null },
    },

    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    resolved: {
      type: Boolean,
      default: false,
      index: true,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

export const ErrorLogModel =
  mongoose.models.ErrorLog || mongoose.model("ErrorLog", ErrorLogSchema);
