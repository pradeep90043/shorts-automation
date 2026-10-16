import assert from "assert";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { AddressInfo } from "net";
import { handleMediaRequest, MediaLinkRegistry, parseRange } from "../src/instagram/mediaLinks";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "igmedia-"));
const file = path.join(dir, "v.mp4");
const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
fs.writeFileSync(file, bytes);

// ---- parseRange
assert.deepStrictEqual(parseRange(undefined, 100), null);
assert.deepStrictEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
assert.deepStrictEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
assert.deepStrictEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
assert.deepStrictEqual(parseRange("bytes=50-5000", 100), { start: 50, end: 99 }, "end is clamped to the file");
assert.strictEqual(parseRange("bytes=100-120", 100), "invalid");
assert.strictEqual(parseRange("bytes=20-10", 100), "invalid");
assert.strictEqual(parseRange("bytes=-0", 100), "invalid");
assert.deepStrictEqual(parseRange("items=0-1", 100), null, "not a bytes range: serve it whole");

// ---- registry: expiry, hit limit, revoke
let t = 1_000;
const reg = new MediaLinkRegistry({ ttlMs: 1000, maxHits: 2, now: () => t });
const a = reg.register(file);
assert.match(a.path, /^\/ig-media\/[A-Za-z0-9_-]{43}\.mp4$/);
assert.ok(reg.get(a.token));
assert.notStrictEqual(reg.register(file).token, a.token, "every link has its own token");
t += 1001;
assert.strictEqual(reg.get(a.token), undefined, "expired");
const b = reg.register(file);
reg.revoke(b.token);
assert.strictEqual(reg.get(b.token), undefined, "revoked");
assert.throws(() => reg.register(path.join(dir, "missing.mp4")));
fs.writeFileSync(path.join(dir, "empty.mp4"), "");
assert.throws(() => reg.register(path.join(dir, "empty.mp4")), /usable/);

// ---- over real HTTP
function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const r = http.request({ port, host: "127.0.0.1", method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    r.end();
  });
}

(async () => {
  const live = new MediaLinkRegistry({ ttlMs: 60_000, maxHits: 4 });
  let otherPaths = 0;
  const server = http.createServer((req, res) => {
    if (handleMediaRequest(req, res, live)) return;
    otherPaths++;
    res.writeHead(200); res.end("app");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const link = live.register(file);

  // whole file
  const full = await request(port, "GET", link.path);
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.headers["content-type"], "video/mp4");
  assert.strictEqual(full.headers["content-length"], "5000");
  assert.strictEqual(full.headers["accept-ranges"], "bytes");
  assert.strictEqual(full.headers["cache-control"], "no-store");
  assert.ok(full.body.equals(bytes));

  // a range (Instagram may fetch in pieces)
  const part = await request(port, "GET", link.path, { Range: "bytes=100-199" });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers["content-range"], "bytes 100-199/5000");
  assert.ok(part.body.equals(bytes.subarray(100, 200)));
  assert.strictEqual((await request(port, "GET", link.path, { Range: "bytes=9000-9100" })).status, 416);

  // HEAD: headers, no body
  const head = await request(port, "HEAD", link.path);
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.body.length, 0);
  assert.strictEqual(head.headers["content-length"], "5000");

  // the 4-hit limit: the link is spent (the 416 above counted as no hit: it never served bytes)
  assert.strictEqual((await request(port, "GET", link.path)).status, 200);
  assert.strictEqual((await request(port, "GET", link.path)).status, 404, "used up");

  // wrong or malformed tokens, other methods, traversal attempts: all closed, all the same bare 404 / 405
  const fresh = live.register(file);
  for (const bad of ["/ig-media/" + "A".repeat(43) + ".mp4", "/ig-media/short.mp4", "/ig-media/", "/ig-media/../../etc/passwd", "/ig-media/" + fresh.token, "/ig-media/" + fresh.token + ".mp4/extra", "/ig-media/%2e%2e%2fsecret.mp4"]) {
    const r = await request(port, "GET", bad);
    assert.strictEqual(r.status, 404, bad);
    assert.strictEqual(r.body.toString(), "Not found", "no hint about why");
  }
  assert.strictEqual((await request(port, "POST", fresh.path)).status, 405);
  assert.strictEqual((await request(port, "DELETE", fresh.path)).status, 405);

  // revoked / file deleted while the link was live
  live.revoke(fresh.token);
  assert.strictEqual((await request(port, "GET", fresh.path)).status, 404);
  const gone = path.join(dir, "gone.mp4"); fs.writeFileSync(gone, "x".repeat(100));
  const g = live.register(gone); fs.unlinkSync(gone);
  assert.strictEqual((await request(port, "GET", g.path)).status, 404);
  assert.strictEqual(live.get(g.token), undefined, "a link to a missing file is revoked");

  // everything that is not /ig-media/ is left to the app
  assert.strictEqual((await request(port, "GET", "/api/dashboard")).body.toString(), "app");
  assert.strictEqual(otherPaths, 1);

  server.close();
  console.log("✓ instagram media links");
})().catch((e) => { console.error(e); process.exit(1); });
