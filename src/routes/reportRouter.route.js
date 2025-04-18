import { Router } from "express";
import {
  createReport,
  ipSettings,
  reportDetails,
} from "../controller/report.controller.js";

const reportRouter = Router();
reportRouter.route("/").get(reportDetails);
reportRouter.route("/create-report").post(createReport);
reportRouter.route("/ip-setting").post(ipSettings)
export default reportRouter;
