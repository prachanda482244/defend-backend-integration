import { Router } from "express";
import {
  bulkDelete,
  deleteReport,
  getAllReports,
  getSingleReport,
  updateAllReport,
  updateApproval,
} from "../controller/admin.controller.js";
import {
  exportUnsyncedCsv,
  flushSheets,
  getUnsynced,
  reconcile,
  syncOne,
} from "../controller/shopifyadmin.controller.js";
const adminRouter = Router();

adminRouter.route("/request-approval/:reportId").put(updateApproval);
adminRouter
  .route("/reports/:reportId")
  .delete(deleteReport)
  .get(getSingleReport);
adminRouter.route("/reports").get(getAllReports);
adminRouter.route("/bulk/delete").delete(bulkDelete);
adminRouter.route("/update-report").post(updateAllReport);

// Orders
adminRouter.get("/unsynced", getUnsynced);
adminRouter.post("/reconcile", reconcile);
adminRouter.post("/flush-sheets", flushSheets);
adminRouter.post("/sync-one", syncOne);
adminRouter.get("/export/unsynced.csv", exportUnsyncedCsv);

export default adminRouter;
