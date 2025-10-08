// cron/recurring.js
import cron from "node-cron";
import { OrderModel } from "../model/orderModel.js";

cron.schedule("0 0 * * *", async () => {
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = new Date(now - THIRTY_DAYS);

  try {
    // 1) Delete NON-monthly & inactive orders older than 30 days (by lastRenewAt)
    const del = await OrderModel.deleteMany({
      subscription: { $ne: "monthly" },
      isActive: false,
      lastRenewAt: { $lt: thirtyDaysAgo },
    });
    console.log(
      `Deleted ${del.deletedCount} non-monthly inactive orders older than 30 days.`
    );

    // 2) For ACTIVE monthly subs: if lastRenewAt (fallback createdAt) >= 30 days old,
    //    just "renew" by bumping lastRenewAt to now (no new doc)
    const monthlyLatest = await OrderModel.aggregate([
      { $match: { subscription: "monthly", isActive: true } },
      // use renewAt = lastRenewAt || createdAt
      { $addFields: { renewAt: { $ifNull: ["$lastRenewAt", "$createdAt"] } } },
      { $sort: { renewAt: -1 } },
      {
        $group: {
          _id: {
            email: "$email",
            productId: "$productId",
            addr: { $ifNull: ["$normalizedAddress", "$streetAddress"] },
          },
          latest: { $first: "$$ROOT" },
        },
      },
    ]);

    let renewed = 0;
    for (const { latest } of monthlyLatest) {
      const renewAt = latest?.renewAt ? new Date(latest.renewAt).getTime() : 0;
      if (now - renewAt < THIRTY_DAYS) continue; // not due yet

      // bump only lastRenewAt; leave createdAt untouched
      await OrderModel.updateOne(
        { _id: latest._id },
        { $set: { lastRenewAt: new Date() } }
      );
      renewed++;
    }

    console.log(
      `Renewed ${renewed} monthly subscriptions by lastRenewAt bump.`
    );
  } catch (err) {
    console.error("Recurring cron error:", err);
  }
});
