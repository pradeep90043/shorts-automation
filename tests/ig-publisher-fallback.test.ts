import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { defaultPublicBaseUrl, InstagramPublisher, PublisherDeps, RESUMABLE_MAX_SEC, TRIMMED_SEC } from "../src/instagram/publisher";
import { MediaLinkRegistry } from "../src/instagram/mediaLinks";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igpub-"));
const video = path.join(dir, "short.mp4");
fs.writeFileSync(video, Buffer.alloc(2048, 7));
const TOKEN = "EAAUsecrettokenvalue123";
const account: any = { name: "PromptGag", accessToken: TOKEN, igUserId: "1784" };
const meta: any = { title: "T", description: "D", tags: ["a b", "c"] };

type Plan = {
  urlInit?: "ok" | "fail"; urlStatus?: "FINISHED" | "ERROR" | "NEVER";
  resInit?: "ok" | "fail"; resUpload?: "ok" | "fail"; publish?: "ok" | "fail"; shortcode?: "ok" | "throw";
};

/** A fake Graph API that records every call. */
function fakeInstagram(plan: Plan) {
  const calls: string[] = [];
  const bodies: any[] = [];
  const statusPolls: Record<string, number> = {};
  const fetchFn: typeof fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (url.startsWith("https://rupload.facebook.com/")) {
      calls.push("rupload");
      return plan.resUpload === "fail"
        ? new Response('{"debug_info":{"type":"ProcessingFailedError"}}', { status: 400 })
        : new Response('{"success":true}', { status: 200 });
    }
    const p = new URL(url).pathname.replace(/^\/v[\d.]+\//, "");
    if (p.endsWith("/media") && init?.method === "POST") {
      bodies.push(body);
      if (body.video_url) {
        calls.push("init:url");
        return plan.urlInit === "fail" ? json(400, { error: { message: "bad url" } }) : json(200, { id: "c-url" });
      }
      calls.push("init:resumable");
      return plan.resInit === "fail" ? json(400, { error: { message: "nope" } }) : json(200, { id: "c-res", uri: "https://rupload.facebook.com/ig-api-upload/v26.0/c-res" });
    }
    if (p.endsWith("/media_publish")) {
      calls.push("publish");
      return plan.publish === "fail" ? json(400, { error: { message: "publish failed" } }) : json(200, { id: "m1" });
    }
    if (p.startsWith("c-url") || p.startsWith("c-res")) {
      const id = p.split("?")[0];
      statusPolls[id] = (statusPolls[id] || 0) + 1;
      calls.push(`status:${id}`);
      if (id === "c-url") {
        if (plan.urlStatus === "ERROR") return json(200, { status_code: "ERROR", status: "Error: could not fetch" });
        if (plan.urlStatus === "NEVER") return json(200, { status_code: "IN_PROGRESS" });
        return json(200, { status_code: statusPolls[id] < 2 ? "IN_PROGRESS" : "FINISHED" });
      }
      return json(200, { status_code: "FINISHED" });
    }
    if (p.startsWith("m1")) {
      calls.push("shortcode");
      if (plan.shortcode === "throw") throw new Error("network down");
      return json(200, { shortcode: "ABC123" });
    }
    throw new Error("unexpected call " + url);
  }) as any;
  return { fetchFn, calls, bodies };
}

function publisher(plan: Plan, duration: number | null, over: Partial<PublisherDeps> = {}) {
  const ig = fakeInstagram(plan);
  const links = new MediaLinkRegistry();
  const copies: string[] = [];
  const sleeps: number[] = [];
  const pub = new InstagramPublisher([account], {
    fetchFn: ig.fetchFn, links,
    sleep: async (ms) => { sleeps.push(ms); },
    publicBaseUrl: () => "https://example.test",
    probeDuration: async () => duration,
    makeShortCopy: async (src, sec) => { const c = path.join(dir, `copy-${copies.length}.mp4`); fs.writeFileSync(c, Buffer.alloc(100)); copies.push(`${sec}:${c}`); return c; },
    pollMs: 1, pollMax: 4, retryDelayMs: 1,
    ...over,
  });
  return { pub, ig, links, copies, sleeps };
}

(async () => {
  // 1) a long video goes straight through the URL method; the link exists only while Instagram needs it
  {
    const t = publisher({}, 82.4);
    const r = await t.pub.uploadToAllAccounts(video, meta);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].url, "https://instagram.com/reel/ABC123/");
    assert.deepStrictEqual(t.ig.calls.filter((c) => c !== "status:c-url"), ["init:url", "publish", "shortcode"], "no resumable upload, no trimming");
    const sent = t.ig.bodies[0];
    assert.match(sent.video_url, /^https:\/\/example\.test\/ig-media\/[A-Za-z0-9_-]{43}\.mp4$/);
    assert.strictEqual(sent.media_type, "REELS");
    assert.strictEqual(sent.caption, "T\n\nD\n\n#ab #c");
    assert.strictEqual(t.links.size(), 0, "the temporary link is revoked after use");
    assert.strictEqual(t.copies.length, 0);
  }

  // 2) URL method fails, video within 60 s -> the resumable upload of the original
  {
    const t = publisher({ urlInit: "fail" }, 40);
    const r = await t.pub.uploadToAllAccounts(video, meta);
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(t.ig.calls, ["init:url", "init:resumable", "rupload", "status:c-res", "publish", "shortcode"]);
    assert.strictEqual(t.links.size(), 0, "revoked even though the method failed");
  }

  // 3) URL method fails (Instagram says ERROR) on a 82 s video: the original is NOT sent resumably (it would be rejected);
  //    a 58.5 s copy is, and the copy is removed afterwards
  {
    const t = publisher({ urlStatus: "ERROR" }, 82.4);
    const r = await t.pub.uploadToAllAccounts(video, meta);
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual(t.ig.calls.filter((c) => !c.startsWith("status:c-url")), ["init:url", "init:resumable", "rupload", "status:c-res", "publish", "shortcode"]);
    assert.strictEqual(t.copies.length, 1);
    assert.ok(t.copies[0].startsWith(`${TRIMMED_SEC}:`));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!fs.existsSync(t.copies[0].split(":")[1]), "the temporary copy is deleted");
    assert.ok(TRIMMED_SEC < RESUMABLE_MAX_SEC);
  }

  // 4) URL method off (no public URL): a 82 s video goes straight to the trimmed copy; a 40 s video to the resumable original
  {
    const long = publisher({}, 82.4, { publicBaseUrl: () => null });
    assert.strictEqual((await long.pub.uploadToAllAccounts(video, meta)).length, 1);
    assert.ok(!long.ig.calls.includes("init:url"));
    assert.strictEqual(long.copies.length, 1);
    const short = publisher({}, 40, { publicBaseUrl: () => null });
    assert.strictEqual((await short.pub.uploadToAllAccounts(video, meta)).length, 1);
    assert.strictEqual(short.copies.length, 0);
  }

  // 5) unknown length (ffprobe failed): the original is still tried resumably after the URL method
  {
    const t = publisher({ urlInit: "fail" }, null);
    assert.strictEqual((await t.pub.uploadToAllAccounts(video, meta)).length, 1);
    assert.ok(t.ig.calls.includes("rupload"));
    assert.strictEqual(t.copies.length, 0);
  }

  // 6) the URL method never finishing is a failure after the poll limit, then the fallback runs
  {
    const t = publisher({ urlStatus: "NEVER" }, 40);
    assert.strictEqual((await t.pub.uploadToAllAccounts(video, meta)).length, 1);
    assert.strictEqual(t.ig.calls.filter((c) => c === "status:c-url").length, 4, "polled exactly pollMax times");
  }

  // 7) every method failing: 3 attempts, no result, and never a publish
  {
    const t = publisher({ urlInit: "fail", resInit: "fail" }, 40);
    const r = await t.pub.uploadToAllAccounts(video, meta);
    assert.deepStrictEqual(r, []);
    assert.strictEqual(t.ig.calls.filter((c) => c === "init:url").length, 3);
    assert.ok(!t.ig.calls.includes("publish"));
    assert.deepStrictEqual(t.sleeps.filter((s) => s === 1).length >= 2, true, "waits between attempts");
    assert.strictEqual(t.links.size(), 0);
  }

  // 8) the Reel is posted once even when the shortcode lookup fails after publishing
  {
    const t = publisher({ shortcode: "throw" }, 82.4);
    const r = await t.pub.uploadToAllAccounts(video, meta);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].url, "https://instagram.com/p/m1/", "falls back to the media id URL");
    assert.strictEqual(t.ig.calls.filter((c) => c === "publish").length, 1, "no second publish");
  }

  // 9) a failing publish is retried as a whole, not silently ignored
  {
    const t = publisher({ publish: "fail" }, 40);
    assert.deepStrictEqual(await t.pub.uploadToAllAccounts(video, meta), []);
  }

  // 10) the access token never appears in what gets thrown or logged
  {
    const ig = fakeInstagram({});
    const leaky: typeof fetch = (async (input: any, init?: any) => {
      if (init?.body && String(init.body).includes("video_url")) throw new Error(`request to https://graph.facebook.com/v21.0/1784/media?access_token=${TOKEN} failed`);
      return ig.fetchFn(input, init);
    }) as any;
    const logged: string[] = [];
    const orig = console.log; const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (c: any, ...a: any[]) => { logged.push(String(c)); return origWrite(c, ...a); };
    const t = publisher({}, 40, { fetchFn: leaky });
    await t.pub.uploadToAllAccounts(video, meta);
    (process.stdout as any).write = origWrite; console.log = orig;
    assert.ok(!logged.join("").includes(TOKEN), "the token was printed");
  }

  // 11) the switch: on by default, IG_VIDEO_URL=off turns the method off
  assert.strictEqual(defaultPublicBaseUrl({} as any), "https://shorts-automation.duckdns.org");
  assert.strictEqual(defaultPublicBaseUrl({ PUBLIC_URL: "https://x.test/" } as any), "https://x.test");
  assert.strictEqual(defaultPublicBaseUrl({ IG_VIDEO_URL: "off" } as any), null);

  // 12) missing credentials are an error result, not an exception
  const none = new InstagramPublisher([{ name: "x", accessToken: "", igUserId: "" } as any], { sleep: async () => undefined });
  assert.deepStrictEqual(await none.uploadToAllAccounts(video, meta), []);

  console.log("✓ instagram publisher fallback chain");
})().catch((e) => { console.error(e); process.exit(1); });
