import { ServerResponse } from "http";
import Transport from "winston-transport";
import { jobProgress } from "./jobProgress";

const clients = new Set<ServerResponse>();

export function addLogClient(res: ServerResponse): void {
  clients.add(res);
}

export function removeLogClient(res: ServerResponse): void {
  clients.delete(res);
}

function safeStringify(obj: any): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({
      level: obj?.level || "info",
      message: String(obj?.message || obj),
      timestamp: obj?.timestamp || new Date().toISOString(),
    });
  }
}

export class BroadcastTransport extends Transport {
  log(info: any, callback: () => void): void {
    setImmediate(() => this.emit("logged", info));
    try {
      // follow each job through its stages (dashboard "live job" card, /api/pipeline/live)
      jobProgress().observe(String(info?.message ?? ""), String(info?.label ?? ""), String(info?.level ?? "info"));
    } catch {
      // progress tracking must never break logging
    }
    try {
      const data = safeStringify(info);
      for (const res of clients) {
        try {
          res.write(`data: ${data}\n\n`);
        } catch {
          clients.delete(res);
        }
      }
    } catch {
      // Ignore broadcast errors so logging never throws
    }
    callback();
  }
}

