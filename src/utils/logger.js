import winston from "winston";
import "winston-daily-rotate-file";

export const successLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      dirname: "logs/orders-success",
      filename: "success-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
    }),
  ],
});

export const failureLogger = winston.createLogger({
  level: "error",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.DailyRotateFile({
      dirname: "logs/orders-failure",
      filename: "failure-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
    }),
  ],
});

export const logSuccess = (data) => {
  successLogger.info({ type: "success", ...data });
};

export const logFailure = (data) => {
  failureLogger.error({ type: "failure", ...data });
};
