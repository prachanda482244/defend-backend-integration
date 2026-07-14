import { Router } from "express";
import { listStuck, forceRetry } from "../controller/retry.controller.js";

const retryRouter = Router();

/* GET  /api/v1/retry/stuck  -> what hasn't reached Shopify, and whether the
 *                              reconciler can still see it
 * POST /api/v1/retry/force  -> reset the attempt cap + retry immediately
 *
 * ⚠ Guard both behind admin auth before production. */
retryRouter.route("/stuck").get(listStuck);
retryRouter.route("/force").post(forceRetry);

export default retryRouter;
