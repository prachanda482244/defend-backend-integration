import { Router } from "express";
import { getAllReports, updateAllReport, updateApproval } from "../controller/admin.controller.js";
const adminRouter = Router()

adminRouter.route("/request-approval/:reportId").put(updateApproval)
adminRouter.route("/reports").get(getAllReports)
adminRouter.route("/update-report").post(updateAllReport)


export default adminRouter