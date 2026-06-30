import winston from "winston";
import path from "path";
import fs from "fs";
import { config } from "../config";

// Ensure log directory exists
if (!fs.existsSync(config.paths.logDir)) {
  fs.mkdirSync(config.paths.logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(({ level, message, timestamp, label }) => {
    const labelStr = label ? ` [${label}]` : "";
    return `${timestamp} ${level}:${labelStr} ${message}`;
  }),
);

export const logger = winston.createLogger({
  level: "info",
  format: logFormat,
  defaultMeta: { service: "shorts-automation" },
  transports: [
    new winston.transports.File({
      filename: path.join(config.paths.logDir, "error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(config.paths.logDir, "combined.log"),
    }),
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

// A helper for step-by-step progress logging in the pipeline
export const pipelineLogger = {
  checkpoint(stepName: string, success = true, info?: string) {
    const mark = success ? "✓" : "✗";
    const message = `${mark} ${stepName}${info ? ` (${info})` : ""}`;
    if (success) {
      logger.info(message, { label: "Pipeline" });
    } else {
      logger.error(message, { label: "Pipeline" });
    }
  },

  info(message: string, context?: string) {
    logger.info(message, { label: context || "Pipeline" });
  },

  warn(message: string, context?: string) {
    logger.warn(message, { label: context || "Pipeline" });
  },

  error(message: string, error?: any, context?: string) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`${message}: ${errMsg}`, {
      label: context || "Pipeline",
      error,
    });
  },
};
