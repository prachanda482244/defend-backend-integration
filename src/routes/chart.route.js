import { Router } from "express";
import {
  addChartData,
  deleteChart,
  showChartData,
} from "../controller/chart.controller.js";
const chartRouter = Router();

chartRouter.route("/add-chart-data").post(addChartData);
chartRouter.route("/show-chart-data").get(showChartData);
chartRouter.route("/delete-chart-data").delete(deleteChart);
export default chartRouter;
