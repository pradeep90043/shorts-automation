import { ServerResponse } from "http";
import Transport from "winston-transport";

const clients = new Set<ServerResponse>();

export function addLogClient(res: ServerResponse): void {
  clients.add(res);
}

export function removeLogClient(res: ServerResponse): void {
  clients.delete(res);
}

export class BroadcastTransport extends Transport {
  log(info: any, callback: () => void): void {
    setImmediate(() => this.emit("logged", info));
    const data = JSON.stringify(info);
    for (const res of clients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        clients.delete(res);
      }
    }
    callback();
  }
}
