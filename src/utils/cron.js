// cron/recurring.js
import cron from "node-cron";
import axios from "axios";
import { OrderModel } from "../model/orderModel.js";

// ⚠ change to "0 0 * * *" in production
cron.schedule("0 0 * * *", async () => {
  const now = new Date();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS);

  try {
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
      console.log("Processing:", order.email);
      await OrderModel.updateOne(
        { _id: order._id },
        {
          $set: {
            lastRenewAt: now,
            updatedAt: now,
            createdAt: now,
          },
        },
      );

      try {
        const response = await axios.post(
          "https://defent-shopify-app-1.onrender.com/api/create-order",
          {
            firstName: order.firstName,
            lastName: order.lastName,
            streetAddress: order.streetAddress,
            streetAddress2: order.streetAddress2 || "",
            postCode: order.postCode,
            email: order.email,
            productId: order.productId,
            subscription: "monthly",
          },
          { timeout: 15000 },
        );

        try {
          const sheetData = {
            createdAt: now,
            firstName: order.firstName,
            lastName: order.lastName,
            streetAddress: order.streetAddress,
            streetAddress2: order.streetAddress2 || "",
            postCode: String(order.postCode).slice(0, 5),
            email: order.email,
            subscription: "monthly",
            productId: order.productId,
            age: order.age || "",
            wehoHearAboutUs: "Auto-renewal",
            household_size: order.household_size || "",
            ethnicity: Array.isArray(order.ethnicity)
              ? order.ethnicity.join(", ")
              : "",
            household_language: Array.isArray(order.household_language)
              ? order.household_language.join(", ")
              : "",
            gender: order.gender || "",
            identity: order.identity || "",
            identifyAsLGBTQ: order.identifyAsLGBTQ ? "Yes" : "No",
          };

          await appendOrderRow(sheetData, order?.flag || "defentWeho");
          console.log(`✅ Sheet updated for: ${order.email}`);
        } catch (sheetErr) {
          console.error(
            "Sheet append failed for renewal:",
            order.email,
            sheetErr.message,
          );
        }
        // HARD STOP
        if (response.status !== 200 || response.data?.success !== true) {
          console.error("Renewal blocked:", response.data);
          continue;
        }

        // ✅ Move subscription forward
      } catch (err) {
        console.error(
          "Renewal error:",
          JSON.stringify(err) || err.response?.status,
          err.response?.data || err.message,
        );
        continue;
      }
    }
  } catch (err) {
    console.error("Recurring cron error:", err);
  }
});
