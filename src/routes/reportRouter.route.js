import { Router } from "express";
import {
  createReport,
  locationData,
  reportDetails,
} from "../controller/report.controller.js";

const reportRouter = Router();
reportRouter.route("/").get(reportDetails);
reportRouter.route("/create-report").post(createReport);
reportRouter.route("/location").get(locationData);

export default reportRouter;
