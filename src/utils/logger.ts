import winston from "winston";
import path from "path";
import fs from "fs";
import { config } from "../config";
import { BroadcastTransport } from "./logBroadcast";
import { currentJobId } from "./jobContext";

// Ensure log directory exists
if (!fs.existsSync(config.paths.logDir)) {
  fs.mkdirSync(config.paths.logDir, { recursive: true });
}

// every line made while a job runs carries that job's id (see jobContext.ts)
const stampJob = winston.format((info) => {
  const id = currentJobId();
  if (id) (info as any).jobId = id;
  return info;
});

const logFormat = winston.format.combine(
  stampJob(),
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
      maxsize: 10 * 1024 * 1024, // 10MB per file
      maxFiles: 7, // 7 rotated files max (7-day TTL equivalent)
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(config.paths.logDir, "combined.log"),
      maxsize: 15 * 1024 * 1024, // 15MB per file
      maxFiles: 7, // 7 rotated files max (7-day TTL equivalent)
      tailable: true,
    }),
    new winston.transports.Console({
      format: consoleFormat,
    }),
    new BroadcastTransport(),
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
    let sanitizedError: any = undefined;
    if (error !== undefined && error !== null) {
      if (error instanceof Error) {
        sanitizedError = {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: (error as any).code,
          status: (error as any).status || (error as any).response?.status,
        };
      } else if (typeof error === "object") {
        try {
          sanitizedError = {
            message: error.message || String(error),
            code: error.code,
            status: error.status || error.response?.status,
          };
        } catch {
          sanitizedError = String(error);
        }
      } else {
        sanitizedError = String(error);
      }
    }
    const errMsg = error instanceof Error ? error.message : (error ? String(error) : "");
    logger.error(`${message}${errMsg ? `: ${errMsg}` : ""}`, {
      label: context || "Pipeline",
      error: sanitizedError,
    });
  },
};

