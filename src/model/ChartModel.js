import { Schema, model } from "mongoose";
const chartSchema = new Schema(
  {
    name: {
      type: String,
    },
    lat: {
      type: Number,
      required: true,
    },
    lon: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

export const Chart = model("Chart", chartSchema);
