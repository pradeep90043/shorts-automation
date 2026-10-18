import assert from "assert";
import { Gate, isRateLimitError } from "../src/ai/aiGate";
import { JobQueue } from "../src/utils/queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // vision-style gate: one at a time, in order, with a gap between starts
  {
    const g = new Gate(1, 120, "vision");
    const log: Array<[number, string, number]> = [];
    const t0 = Date.now();
    let inFlight = 0, maxInFlight = 0;
    const job = (name: string) => g.run(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      log.push([Date.now() - t0, name, inFlight]);
      await sleep(40);
      inFlight--;
      return name;
    });
    const out = await Promise.all([job("a"), job("b"), job("c"), job("d")]);
    assert.deepStrictEqual(out, ["a", "b", "c", "d"]);
    assert.deepStrictEqual(log.map((l) => l[1]), ["a", "b", "c", "d"], "first come, first served");
    assert.strictEqual(maxInFlight, 1, "never two vision requests at once");
    for (let i = 1; i < log.length; i++) assert.ok(log[i][0] - log[i - 1][0] >= 110, "starts are at least the gap apart: " + (log[i][0] - log[i - 1][0]));
  }

  // text-style gate: two at a time
  {
    const g = new Gate(2, 0, "text");
    let inFlight = 0, maxInFlight = 0;
    await Promise.all([1, 2, 3, 4, 5].map(() => g.run(async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(40); inFlight--; })));
    assert.strictEqual(maxInFlight, 2);
  }

  // a rate-limit answer pauses the next start
  {
    const g = new Gate(1, 0, "x");
    await g.run(async () => undefined);
    g.backOff(200);
    const t = Date.now();
    await g.run(async () => undefined);
    assert.ok(Date.now() - t >= 190, "waited for the back-off: " + (Date.now() - t));
  }

  // a failing request frees its turn
  {
    const g = new Gate(1, 0, "x");
    await assert.rejects(g.run(async () => { throw new Error("boom"); }), /boom/);
    assert.strictEqual(await g.run(async () => "next"), "next");
  }

  // what counts as "slow down"
  assert.ok(isRateLimitError("FreeLLMAPI (http://x) request failed with status 429: too many"));
  assert.ok(isRateLimitError('request failed with status 503: {"error":{"message":"No candidate model has a configured, usable provider key."'));
  assert.ok(isRateLimitError("rate limited"));
  assert.ok(!isRateLimitError("request failed with status 401: bad key"));
  assert.ok(!isRateLimitError("request timed out after 60 seconds"));

  // the Shorts pipeline: ONE at a time across all channel queues (default)
  {
    const q1 = new JobQueue(1), q2 = new JobQueue(1);
    const events: string[] = [];
    let running = 0, maxRunning = 0;
    const work = (name: string) => async () => { running++; maxRunning = Math.max(maxRunning, running); events.push("start " + name); await sleep(60); events.push("end " + name); running--; };
    q1.addJob("one", work("one"));
    q2.addJob("two", work("two"));
    q1.addJob("three", work("three"));
    for (let i = 0; i < 40 && events.length < 6; i++) await sleep(25);
    assert.strictEqual(maxRunning, 1, "two Shorts never ran at the same time");
    assert.deepStrictEqual(events.filter((e) => e.startsWith("start")).length, 3);
  }

  console.log("✓ ai gate + one pipeline at a time");
  process.exit(0);
})();
