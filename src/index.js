import cookieParser from "cookie-parser";
import express, { urlencoded } from "express";
import connectToDb from "./db/connectToDb.js";
import cors from "cors";
import { PORT } from "./config/constants.js";
import reportRouter from "./routes/reportRouter.route.js";
import chartRouter from "./routes/chart.route.js";
import adminRouter from "./routes/admin.route.js";
import orderRouter from "./routes/order.route.js";
import errorRouter from "./routes/error.route.js";
import subscriptionRouter from "./routes/subscription.route.js"; // ++ NEW
import retryRouter from "./routes/retry.route.js"; // ++ NEW
import { errorMiddleware } from "./middleware/error.middleware.js";
import "./utils/cron.js"; // renewals + (now) reminder & reconcile crons

const app = express();
connectToDb();

app.use("/logs", express.static("logs"));

app.use(cors({ origin: "*" }));
app.use(cookieParser());
app.use(express.json({ limit: "20mb" }));
app.use(urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static("public"));

/* NOTE: `app.use(errorMiddleware)` used to sit HERE, above the routes.
   Express runs middleware in registration order, so an error thrown in a
   route could never reach it — it was dead code. Moved to the bottom,
   where an error handler belongs. (Pre-existing bug, harmless to fix.) */

app.use("/api/v1/report", reportRouter);
app.use("/api/v1/chart", chartRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/order", orderRouter);
app.use("/api/v1/error", errorRouter);

/* ++ NEW: 15-day email unsubscribe flow ++
   GET  /api/v1/subscription/unsubscribe?t=<token>  -> confirmation page
   POST /api/v1/subscription/unsubscribe            -> actually cancels   */
app.use("/api/v1/subscription", subscriptionRouter);

/* ++ NEW: manual Shopify retry / recovery ++
   GET  /api/v1/retry/stuck  -> what hasn't reached Shopify
   POST /api/v1/retry/force  -> reset the attempt cap and retry now      */
app.use("/api/v1/retry", retryRouter);

app.get("/api/v1/health", (_, res) => {
  res.status(200).json({
    success: true,
    data: [
      {
        name: "Api is running",
      },
    ],
  });
});

// Error handling middleware — must be registered LAST.
app.use(errorMiddleware);

/* ------------------------------------------------------------------ *
 *  Boot banner.
 *
 *  Every "why isn't this working" session so far has come down to a config
 *  value nobody could see. SHOPIFY_APP_URL in particular has a silent
 *  fallback to the PRODUCTION Render app — so a missing var doesn't error,
 *  it just quietly sends your local renewals to the wrong server.
 
 *  Print the resolved values once, at startup. Secrets masked.
 * ------------------------------------------------------------------ */
const mask = (v) =>
  v ? `${String(v).slice(0, 6)}…(${String(v).length})` : "❌ NOT SET";
const flag = (v, want) => (v === want ? "✓" : "⚠");

const REMIX_URL_RESOLVED =
  process.env.SHOPIFY_APP_URL ||
  "https://expectations-surface-suggestion-telecharger.trycloudflare.com/api/create-order";

console.log(`
┌─ DEFENT BACKEND ────────────────────────────────────────────────
│ Shopify app URL   ${REMIX_URL_RESOLVED}
│                   ${process.env.SHOPIFY_APP_URL ? "✓ from SHOPIFY_APP_URL" : "⚠ FALLBACK — SHOPIFY_APP_URL is not set, this is the PROD app"}
│ Mongo             ${process.env.MONGODB_URI || "❌ NOT SET"}
│ Public API URL    ${process.env.PUBLIC_API_URL || "❌ NOT SET (unsubscribe links will throw)"}
│
│ Crons             renewal   ${process.env.RENEWAL_CRON || "0 0 * * * (default)"}
│                   reminder  ${process.env.REMINDER_CRON || "0 9 * * * (default)"}
│                   reconcile ${process.env.RECONCILE_CRON || "*/10 * * * * (default)"}
│                   cycle=${process.env.RENEWAL_CYCLE_DAYS || 30}d  remind@${process.env.REMINDER_AFTER_DAYS || 15}d
│
│ Pacing            renewal   ${process.env.RENEWAL_DELAY_MS || 700}ms ${flag(process.env.RENEWAL_DELAY_MS, "15000")}
│                   reconcile ${process.env.SHOPIFY_RECONCILE_DELAY_MS || 700}ms ${flag(process.env.SHOPIFY_RECONCILE_DELAY_MS, "15000")}
│                   remix timeout ${process.env.REMIX_TIMEOUT_MS || 120000}ms
│                   ⚠ On a DEV store use 15000ms — it caps order creation
│                     at ~5/min, which is NOT the leaky bucket.
│
│ Resend            ${mask(process.env.RESEND_API_KEY)}  from: ${process.env.RESEND_FROM || "❌"}
│ Unsub secret      ${mask(process.env.UNSUBSCRIBE_SECRET)}
│ Test endpoints    ${process.env.ENABLE_TEST_ENDPOINTS === "true" ? "⚠ ENABLED — never do this in prod" : "off"}
│
│ Service area      WEHO -> ${process.env.WEHO_PLACE || "West Hollywood"}   LA -> ${process.env.LA_PLACE || "Los Angeles"}
│ WEHO renewals     ${process.env.ENABLE_WEHO_RENEWALS === "true" ? "ON" : "off"}
└─────────────────────────────────────────────────────────────────`);

app.listen(PORT, () => {
  console.log(`Server is running on ${PORT}`);
});
