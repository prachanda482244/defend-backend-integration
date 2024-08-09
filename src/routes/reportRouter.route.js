import { Router } from "express";
import {
  createReport,
  reportDetails,
} from "../controller/report.controller.js";

const reportRouter = Router();
reportRouter.route("/").get(reportDetails);
reportRouter.route("/create-report").post(createReport);

export default reportRouter;
