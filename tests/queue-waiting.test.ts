import assert from "assert";
import { JobQueue } from "../src/utils/queue";

(async () => {
  const q = new JobQueue(1);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  q.addJob("first", async () => { await gate; });
  q.addJob("second", async () => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(JobQueue.isWaiting("first"), false, "the running job is not waiting");
  assert.strictEqual(JobQueue.isWaiting("second"), true, "the second job waits for its turn");
  release();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(JobQueue.isWaiting("second"), false, "it left the queue when it started");
  console.log("✓ queue: a waiting job is reported as waiting");
  process.exit(0);
})();
