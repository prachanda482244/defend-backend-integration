// routes/errorRoutes.js
import express from "express";
import {
  createErrorLog,
  getErrorLogs,
  getErrorLogById,
  updateErrorResolution,
  deleteErrorLog,
  bulkDeleteErrorLogs,
} from "../controller/errorController.js";

const router = express.Router();

router.post("/", createErrorLog);
router.get("/", getErrorLogs);
router.get("/:id", getErrorLogById);
router.patch("/:id/resolution", updateErrorResolution);
router.delete("/:id", deleteErrorLog);
router.delete("/", bulkDeleteErrorLogs);

export default router;
