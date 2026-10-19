import { AsyncLocalStorage } from "async_hooks";

/**
 * Which job is this code running for? The queue runs every job inside `jobContext.run`, and the logger stamps each line with the
 * job id it finds here. Node carries the store through promises and timers, so even a line logged from a deep helper, or from the
 * cloned-voice promise, names its job: the live progress card stays right when several Shorts run at the same time.
 */
export const jobContext = new AsyncLocalStorage<{ jobId: string }>();
export const currentJobId = (): string | undefined => jobContext.getStore()?.jobId;
