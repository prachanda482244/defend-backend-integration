// middleware/errorMiddleware.js
import { ErrorLogModel } from "../model/errorLog.js";
import { ApiResponse } from "../utils/ApiResponse.js";

const redact = (value) => {
  if (!value || typeof value !== "object") return value;
  const cloned = JSON.parse(JSON.stringify(value));
  if (cloned.accessToken) cloned.accessToken = "***redacted***";
  if (cloned.token) cloned.token = "***redacted***";
  if (cloned.password) cloned.password = "***redacted***";
  return cloned;
};

export const errorMiddleware = async (err, req, res, _next) => {
  try {
    await ErrorLogModel.create({
      source: "orders-backend",
      module: "global-error-middleware",
      stage: "unhandled_exception",
      level: "critical",
      message: err?.message || "Internal Server Error",
      errorName: err?.name || "",
      statusCode: err?.statusCode || 500,
      stack: err?.stack || "",
      request: {
        method: req?.method || "",
        url: req?.originalUrl || "",
        ip: req?.ip || "",
        userAgent: req?.get?.("user-agent") || "",
        headers: redact(req?.headers || {}),
        body: redact(req?.body || {}),
        params: redact(req?.params || {}),
        query: redact(req?.query || {}),
      },
      response: {},
      context: {},
      externalService: {},
      meta: null,
      resolved: false,
    });
  } catch (logErr) {
    console.error("Failed to save global error log:", logErr);
  }

  return res
    .status(err?.statusCode || 500)
    .json(
      new ApiResponse(
        err?.statusCode || 500,
        null,
        err?.message || "Internal Server Error",
      ),
    );
};
