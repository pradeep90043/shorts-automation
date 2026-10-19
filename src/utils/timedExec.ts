import { exec as nodeExec, ChildProcess, ExecException, ExecOptions } from "child_process";
import { pipelineLogger } from "./logger";

type Cb = (error: ExecException | null, stdout: string, stderr: string) => void;

/**
 * child_process.exec with two additions: a 64 MB output buffer (ffmpeg's progress output used to kill steps with "maxBuffer
 * exceeded") and a timing line for every command that takes 20 s or more, so a slow job shows WHICH step was slow.
 */
export function exec(command: string, callback?: Cb): ChildProcess;
export function exec(command: string, options: ExecOptions, callback?: Cb): ChildProcess;
export function exec(command: string, optionsOrCb?: ExecOptions | Cb, cb?: Cb): ChildProcess {
  const done: Cb | undefined = typeof optionsOrCb === "function" ? optionsOrCb : cb;
  const options = typeof optionsOrCb === "function" || optionsOrCb === undefined ? {} : optionsOrCb;
  const started = Date.now();
  return nodeExec(command, { maxBuffer: 64 * 1024 * 1024, ...options }, ((err: ExecException | null, stdout: any, stderr: any) => {
    const sec = Math.round((Date.now() - started) / 1000);
    if (sec >= 20) {
      const what = command.replace(/"[^"]*"/g, '"…"').replace(/\s+/g, " ").slice(0, 90);
      pipelineLogger.info(`${err ? "failed after" : "took"} ${sec}s: ${what}`, "Timing");
    }
    done?.(err, stdout, stderr);
  }) as any);
}
