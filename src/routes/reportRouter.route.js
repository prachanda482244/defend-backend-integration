import { Router } from "express";
import {
  createReport,
  getIpInfo,
  reportDetails,
} from "../controller/report.controller.js";
import { upload } from "../middleware/multer.middleware.js";

const reportRouter = Router();
reportRouter.route("/").get(reportDetails);
reportRouter.route("/create-report").post(upload.single("image"), createReport);
reportRouter.route("/ip-setting").post(getIpInfo);

export default reportRouter;
