import fs from "fs";
import os from "os";
import { pipelineLogger } from "./logger";

/**
 * Why is a job slow? The numbers that answer it, read from the container itself (Linux cgroup v2 + pressure stall info):
 * CPU quota and how often it was throttled, memory limit and OOM kills, swap, load, and "pressure" (the share of the last 10 s
 * in which something was waiting for CPU / memory / disk). All reads are best-effort: outside Linux they are simply absent.
 */
const read = (p: string): string => {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; }
};
const kv = (text: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && !Number.isNaN(Number(v))) out[k] = Number(v);
  }
  return out;
};

/** "some avg10=12.34 avg60=..." -> { some: 12.34 } (the share of the last 10 s with a stall); "full" too when present. */
export function parsePressure(text: string): { some?: number; full?: number } {
  const out: { some?: number; full?: number } = {};
  for (const line of text.split("\n")) {
    const m = /^(some|full)\s.*?avg10=([\d.]+)/.exec(line.trim());
    if (m) out[m[1] as "some" | "full"] = Number(m[2]);
  }
  return out;
}

/** "50000 100000" -> 0.5 CPU; "max 100000" -> null (no limit). */
export function cpuLimitOf(cpuMax: string): number | null {
  const [quota, period] = cpuMax.trim().split(/\s+/);
  if (!quota || quota === "max" || !Number(period)) return null;
  return Number(quota) / Number(period);
}

export interface HostSnapshot {
  cpus: number;
  cpuModel: string;
  cpuLimit: number | null;       // CPUs this container may use (null = no limit)
  throttledPct: number | null;   // share of CPU periods in which the container was throttled, since start
  load1: number;
  memTotalMB: number;
  memAvailMB: number;
  swapUsedMB: number;
  containerMemMB: number | null;
  containerMemLimitMB: number | null;
  oomKills: number | null;
  pressure: { cpu: { some?: number; full?: number }; memory: { some?: number; full?: number }; io: { some?: number; full?: number } };
}

export function hostSnapshot(): HostSnapshot {
  const mem = kv(read("/proc/meminfo").replace(/:/g, "").replace(/ kB/g, ""));
  const stat = kv(read("/sys/fs/cgroup/cpu.stat"));
  const events = kv(read("/sys/fs/cgroup/memory.events"));
  const memCur = Number(read("/sys/fs/cgroup/memory.current")) || null;
  const memMaxRaw = read("/sys/fs/cgroup/memory.max");
  const memMax = memMaxRaw && memMaxRaw !== "max" ? Number(memMaxRaw) : null;
  const mb = (kb: number | undefined) => (kb ? Math.round(kb / 1024) : 0);
  return {
    cpus: os.cpus().length,
    cpuModel: (os.cpus()[0]?.model || "?").replace(/\s+/g, " "),
    cpuLimit: cpuLimitOf(read("/sys/fs/cgroup/cpu.max")),
    throttledPct: stat.nr_periods ? Math.round((100 * (stat.nr_throttled || 0)) / stat.nr_periods) : null,
    load1: Number(os.loadavg()[0].toFixed(2)),
    memTotalMB: mb(mem.MemTotal),
    memAvailMB: mb(mem.MemAvailable),
    swapUsedMB: mb((mem.SwapTotal || 0) - (mem.SwapFree || 0)),
    containerMemMB: memCur ? Math.round(memCur / 1048576) : null,
    containerMemLimitMB: memMax ? Math.round(memMax / 1048576) : null,
    oomKills: events.oom_kill ?? null,
    pressure: {
      cpu: parsePressure(read("/proc/pressure/cpu")),
      memory: parsePressure(read("/proc/pressure/memory")),
      io: parsePressure(read("/proc/pressure/io")),
    },
  };
}

export function describeHost(s: HostSnapshot = hostSnapshot()): string {
  const p = (x: { some?: number; full?: number }) => (x.some === undefined ? "n/a" : `${x.some}%`);
  return (
    `cpu ${s.cpus}x ${s.cpuModel}, container limit ${s.cpuLimit ?? "none"}, throttled ${s.throttledPct ?? "n/a"}% | load ${s.load1} | ` +
    `mem ${s.memAvailMB}/${s.memTotalMB} MB free, swap used ${s.swapUsedMB} MB, container ${s.containerMemMB ?? "?"}/${s.containerMemLimitMB ?? "no limit"} MB, oom kills ${s.oomKills ?? "n/a"} | ` +
    `stalled (10 s): cpu ${p(s.pressure.cpu)}, mem ${p(s.pressure.memory)}, io ${p(s.pressure.io)}`
  );
}

let timer: NodeJS.Timeout | undefined;
/** One line at start, then one every few minutes: after a slow job the log says whether the box was starved. */
export function startHostMonitor(everyMs = 3 * 60_000): void {
  if (timer) return;
  const tick = () => pipelineLogger.info(describeHost(), "Host");
  tick();
  timer = setInterval(tick, everyMs);
  timer.unref();
}
