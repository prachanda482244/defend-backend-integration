import { Router } from "express";
import {
  createOrder,
  updateSubscription,
  getAll30DaysAgoOrder,
  removeDuplicateOrders,
  getDuplicateOrders,
  addIsRenewableField,
} from "../controller/order.controller.js";

const orderRouter = Router();

orderRouter.route("/").post(createOrder).get(getAll30DaysAgoOrder);
orderRouter
  .route("/r-g/duplicates-orders")
  .delete(removeDuplicateOrders)
  .get(getDuplicateOrders);
orderRouter.route("/:orderId").put(updateSubscription);
orderRouter.route("/add-field").post(addIsRenewableField);

export default orderRouter;
