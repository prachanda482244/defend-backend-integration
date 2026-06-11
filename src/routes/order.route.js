import { Router } from "express";
import {
  createOrder,
  updateSubscription,
  getAll30DaysAgoOrder,
  removeDuplicateOrders,
  getDuplicateOrders,
  addIsRenewableField,
  confirmOrder,
  backfillSyncStatus,
} from "../controller/order.controller.js";

const orderRouter = Router();

orderRouter.route("/").post(createOrder).get(getAll30DaysAgoOrder);
orderRouter.post("/confirm", confirmOrder);
orderRouter
  .route("/r-g/duplicates-orders")
  .delete(removeDuplicateOrders)
  .get(getDuplicateOrders);
orderRouter.route("/:orderId").put(updateSubscription);
orderRouter.route("/add-field").post(addIsRenewableField);
orderRouter.route("/backfill-sync-status").post(backfillSyncStatus);
export default orderRouter;
