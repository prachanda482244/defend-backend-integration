import { Router } from "express";
import {
  createOrder,
  getAll30DaysAgoOrder,
} from "../controller/order.controller.js";

const orderRouter = Router();

orderRouter.route("/").post(createOrder).get(getAll30DaysAgoOrder);

export default orderRouter;
