import { pipelineLogger } from "./logger";
import { jobContext } from "./jobContext";

export interface QueueJob {
  id: string;
  workerFn: () => Promise<void>;
  retries: number;
  maxRetries: number;
  /** arrival number across ALL channel queues: with one Short at a time, the oldest waiting job starts first */
  order?: number;
}

export class JobQueue {
  private queue: QueueJob[] = [];
  private activeCount = 0;
  private maxConcurrency: number;

  // All channel queues share the same small VM: cap total simultaneous pipelines
  // (Whisper + OCR + ffmpeg each) so they stop starving the API and long renders. ONE at a time by default (MAX_PARALLEL_PIPELINES
  // raises it): the channels share the same free AI keys, and parallel Shorts rate-limit them.
  private static all = new Set<JobQueue>();
  private static globalActive = 0;
  private static arrivals = 0;
  private static readonly GLOBAL_LIMIT = Math.max(1, Number(process.env.MAX_PARALLEL_PIPELINES) || 1);

  constructor(maxConcurrency = 1) {
    this.maxConcurrency = maxConcurrency;
    JobQueue.all.add(this);
  }

  /** True when no pipeline is running or waiting on any channel queue: the long-video worker only starts then. */
  public static isIdle(): boolean {
    if (JobQueue.globalActive > 0) return false;
    for (const q of JobQueue.all) if (q.queue.length > 0 || q.activeCount > 0) return false;
    return true;
  }

  /** True while the job is still waiting for its turn on some channel queue (it has not started, so it has no job record yet). */
  public static isWaiting(id: string): boolean {
    for (const q of JobQueue.all) if (q.queue.some((j) => j.id === id)) return true;
    return false;
  }

  private static wakeAll(): void {
    // the queue whose oldest job arrived first gets the free slot first (first come, first served across channels)
    const byAge = [...JobQueue.all].sort((a, b) => (a.queue[0]?.order ?? Infinity) - (b.queue[0]?.order ?? Infinity));
    for (const q of byAge) q.processNext();
  }

  /**
   * Add a job to the execution queue.
   */
  public addJob(
    id: string,
    workerFn: () => Promise<void>,
    maxRetries = 2,
  ): void {
    const job: QueueJob = {
      id,
      workerFn,
      retries: 0,
      maxRetries,
      order: ++JobQueue.arrivals,
    };

    // Check if job is already queued to prevent duplicates
    if (this.queue.some((j) => j.id === id)) {
      pipelineLogger.warn(
        `Job ${id} is already in the execution queue. Skipping add.`,
        "JobQueue",
      );
      return;
    }

    this.queue.push(job);
    pipelineLogger.info(
      `Job ${id} successfully added to queue. Queue length: ${this.queue.length}`,
      "JobQueue",
    );

    // Trigger execution loop asynchronously
    this.processNext();
  }

  /**
   * Process the next job in the queue if concurrency limit allows.
   */
  private processNext(): void {
    if (this.activeCount >= this.maxConcurrency || JobQueue.globalActive >= JobQueue.GLOBAL_LIMIT) {
      return;
    }

    const job = this.queue.shift();
    if (!job) {
      return;
    }

    this.activeCount++;
    JobQueue.globalActive++;
    pipelineLogger.info(
      `Starting execution of job ${job.id}. Active jobs: ${this.activeCount}`,
      "JobQueue",
    );

    jobContext
      .run({ jobId: job.id }, () => job.workerFn())
      .then(() => {
        this.activeCount--;
        JobQueue.globalActive--;
        pipelineLogger.checkpoint(`Job ${job.id} completed successfully`, true);
        JobQueue.wakeAll();
      })
      .catch((err) => {
        this.activeCount--;
        JobQueue.globalActive--;
        pipelineLogger.error(
          `Job ${job.id} failed during execution`,
          err,
          "JobQueue",
        );

        if (job.retries < job.maxRetries) {
          job.retries++;
          pipelineLogger.warn(
            `Retrying job ${job.id} (Retry ${job.retries}/${job.maxRetries})...`,
            "JobQueue",
          );
          this.queue.push(job); // Push back to queue for retry
        } else {
          pipelineLogger.checkpoint(
            `Job ${job.id} failed after reaching max retries`,
            false,
          );
        }

        JobQueue.wakeAll();
      });
  }

  /**
   * Clear all pending jobs in the queue.
   */
  public clear(): void {
    this.queue = [];
    pipelineLogger.info("Job queue cleared successfully", "JobQueue");
  }

  /**
   * Get the current length of the queue.
   */
  public get length(): number {
    return this.queue.length;
  }
}
