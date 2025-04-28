import { Schema, model } from "mongoose";
const reportSchema = new Schema(
  {
    age: {
      type: String,
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
    isQualify: {
      type: String,
      enum: ["approved", "new", "rejected"],
      default: "new",
    },
    source: {
      type: String,
    }
    // image: {
    //   type: String,
    // },
    // cloudinaryPublicId: {
    //   type: String
    // }
  },
  { timestamps: true }
);

export const Report = model("Report", reportSchema);
