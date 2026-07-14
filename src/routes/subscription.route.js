import { Router } from "express";
import {
  getUnsubscribe,
  postUnsubscribe,
  resubscribe,
} from "../controller/subscription.controller.js";

const subscriptionRouter = Router();

/* GET  -> confirmation page only (safe for email link-scanners to prefetch)
 * POST -> actually cancels (our form posts here; Gmail's RFC-8058
 *         one-click Unsubscribe button also posts here)                  */
subscriptionRouter
  .route("/unsubscribe")
  .get(getUnsubscribe)
  .post(postUnsubscribe);

// Support/admin escape hatch — guard this behind admin auth before prod.
subscriptionRouter.route("/resubscribe").post(resubscribe);

export default subscriptionRouter;
