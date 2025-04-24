import { Router } from "express";
import {
  createReport,
  reportDetails,
} from "../controller/report.controller.js";
import { upload } from "../middleware/multer.middleware.js";

const reportRouter = Router();
reportRouter.route("/").get(reportDetails);
reportRouter.route("/create-report").post(upload.single("image"), createReport);

export default reportRouter;
