import cron from "node-cron";
import { OrderModel } from "../model/orderModel.js";

cron.schedule("0 0 * * *", async () => {
  // cron.schedule("* * * * *", async () => {
  try {
    const currentDate = new Date();
    const result = await OrderModel.deleteMany({
      createdAt: { $lt: new Date(currentDate - 30 * 24 * 60 * 60 * 1000) },
    });
    console.log(
      `Deleted ${result.deletedCount} orders that are older than 30 days.`
    );
  } catch (err) {
    console.error("Error deleting orders:", err);
  }
});
