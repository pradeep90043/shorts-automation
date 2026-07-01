import { pipelineLogger } from "./logger";

export interface QueueJob {
  id: string;
  workerFn: () => Promise<void>;
  retries: number;
  maxRetries: number;
}

export class JobQueue {
  private queue: QueueJob[] = [];
  private activeCount = 0;
  private maxConcurrency: number;

  constructor(maxConcurrency = 1) {
    this.maxConcurrency = maxConcurrency;
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
    if (this.activeCount >= this.maxConcurrency) {
      return;
    }

    const job = this.queue.shift();
    if (!job) {
      return;
    }

    this.activeCount++;
    pipelineLogger.info(
      `Starting execution of job ${job.id}. Active jobs: ${this.activeCount}`,
      "JobQueue",
    );

    job
      .workerFn()
      .then(() => {
        this.activeCount--;
        pipelineLogger.checkpoint(`Job ${job.id} completed successfully`, true);
        this.processNext();
      })
      .catch((err) => {
        this.activeCount--;
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

        this.processNext();
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
