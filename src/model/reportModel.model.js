import { Schema, model } from "mongoose";
const reportSchema = new Schema(
  {
    age: {
      type: Number,
      required: true,
    },
    medication: {
      type: String,
      required: true,
    },
    state: {
      type: String,
      required: true,
    },
    city: {
      type: String,
      required: true,
    },
    location: {
      type: String,
      required: true,
    },
    ipAddress: {
      type: String,
      required: true,
    },
    lastSubmission: {
      type: Date,
    },
  },
  { timestamps: true }
);

export const Report = model("Report", reportSchema);
