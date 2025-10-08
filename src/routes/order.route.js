import { Router } from "express";
import {
  createOrder,
  updateSubscription,
  getAll30DaysAgoOrder,
} from "../controller/order.controller.js";

const orderRouter = Router();

orderRouter.route("/").post(createOrder).get(getAll30DaysAgoOrder);
orderRouter.route("/:orderId").put(updateSubscription);

export default orderRouter;
