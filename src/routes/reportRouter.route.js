import { Router } from "express";
import {
  createReport,
  filteredByAge,
  filteredByMedication,
  reportDetails,
  filteredByState,
} from "../controller/report.controller.js";

const reportRouter = Router();
reportRouter.route("/").get(reportDetails);
reportRouter.route("/create-report").post(createReport);
reportRouter.route("/filtered-by-age").post(filteredByAge);
reportRouter.route("/filtered-by-medication").post(filteredByMedication);
reportRouter.route("/filtered-by-state").post(filteredByState);
export default reportRouter;
