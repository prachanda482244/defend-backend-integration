// cron/recurring.js
import cron from "node-cron";
import axios from "axios";
import { OrderModel } from "../model/orderModel.js";

let isRunning = false;

// ⚠ change to "0 0 * * *" in production
cron.schedule("*/30 * * * * *", async () => {
  // cron.schedule("0 0 * * *", async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS);

    const monthlyDue = await OrderModel.aggregate([
      {
        $match: {
          subscription: "monthly",
          isActive: true,
        },
      },
      {
        $addFields: {
          renewAt: { $ifNull: ["$lastRenewAt", "$createdAt"] },
        },
      },
      {
        $match: {
          renewAt: { $lte: thirtyDaysAgo },
        },
      },
    ]);

    if (!monthlyDue.length) {
      console.log("No subscriptions due.");
      return;
    }

    for (const order of monthlyDue) {
      console.log("Processing renewal:", order.firstName);

      try {
        const response = await axios.post(
          "https://ease-highs-mercy-advice.trycloudflare.com/api/create-order",
          {
            orderId: order._id.toString(),
            firstName: order.firstName,
            lastName: order.lastName,
            streetAddress: order.streetAddress,
            streetAddress2: order.streetAddress2 || "",
            postCode: order.postCode,
            email: order.email,
            productId: order.productId,
            subscription: "monthly",
            flag: order.source === "Defent La" ? "defentLA" : "defentWeho",
            isRenewal: true,
            demographics: {
              age: order.demographics?.age || "",
              gender: order.demographics?.gender || "",
              identity: order.demographics?.identity || "",
              household_size: order.demographics?.household_size || "",
              ethnicity: order.demographics?.ethnicity || "",
              household_language: order.demographics?.household_language || "",
              identifyAsLGBTQ: order.demographics?.identifyAsLGBTQ || "",
              wehoHearAboutUs: order.demographics?.wehoHearAboutUs || "",
            },
          },
          { timeout: 15000 },
        );

        if (response.status !== 200 || response.data?.success !== true) {
          console.error("Renewal blocked:", response.data);
          continue;
        }

        console.log("Renewal succeeded:", order.firstName);
        // lastRenewAt is bumped by the backend via the isRenewal path,
        // so the cron doesn't need to update it here.
      } catch (err) {
        console.error(
          "Renewal error:",
          err?.response?.status,
          err?.response?.data || err?.message,
        );
        continue;
      }
    }
  } catch (err) {
    console.error("Recurring cron error:", err);
  } finally {
    isRunning = false;
  }
});
