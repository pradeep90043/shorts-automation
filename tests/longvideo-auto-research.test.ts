import assert from "assert";
import { extractReadableText, findDate, isSafePublicUrl, parseDuckDuckGoHtml, researchTopic, FetchText } from "../src/longvideo-auto/research";

const ddg = `
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fspring-boot&rut=abc">Spring Boot &amp; REST</a>
<a class="result__snippet" href="x">Spring Boot makes REST APIs quick to build with embedded servers.</a></div>
<div class="result"><a class="result__a" href="https://news.site/finance">Market closes</a>
<a class="result__snippet" href="x">Sensex ended higher on Tuesday.</a></div>
<div class="result"><a class="result__a" href="https://www.youtube.com/watch?v=1">A video</a></div>`;
const r = parseDuckDuckGoHtml(ddg);
assert.strictEqual(r.length, 3);
assert.strictEqual(r[0].url, "https://example.com/spring-boot", "the redirect is unwrapped");
assert.strictEqual(r[0].title, "Spring Boot & REST");
assert.ok(r[0].snippet.includes("embedded servers"));

const page = `<html><head><script>var x=1;</script><meta property="article:published_time" content="2026-10-12T05:00:00Z"></head>
<body><nav>Home About</nav><p>Spring Boot auto configuration reads the classpath and wires beans for you without any XML files at all.</p>
<p>Menu</p><footer>copyright</footer></body></html>`;
const text = extractReadableText(page);
assert.ok(text.includes("auto configuration reads the classpath"));
assert.ok(!text.includes("Menu") && !text.includes("copyright") && !text.includes("var x"));
assert.strictEqual(findDate(page), "2026-10-12");
assert.strictEqual(findDate("<p>Posted on 5 Oct 2026 by staff</p>"), "5 Oct 2026");
assert.strictEqual(findDate("<p>nothing</p>"), undefined);

assert.strictEqual(isSafePublicUrl("https://example.com/a"), true);
for (const bad of ["http://localhost:3001/x", "http://127.0.0.1/x", "http://192.168.1.5/x", "http://10.0.0.2/", "file:///etc/passwd", "ftp://a.b/c", "not a url"]) {
  assert.strictEqual(isSafePublicUrl(bad), false, bad);
}

(async () => {
  const long = "<p>" + Array(60).fill("meaningful sentence about the topic with enough words").join(" ") + "</p>";
  const calls: string[] = [];
  const fetchText: FetchText = async (url) => {
    calls.push(url);
    if (url.includes("duckduckgo")) return ddg;
    if (url.includes("example.com")) return long;
    throw new Error("down");
  };
  const res = await researchTopic("spring boot rest", fetchText);
  assert.strictEqual(res.sources.length, 1, "unreachable pages and video sites are skipped, not fatal");
  assert.ok(res.text.startsWith("[1] Spring Boot & REST"));
  assert.ok(!calls.some((u) => u.includes("youtube.com")), "video sites are never fetched");

  // search down -> empty research, no throw
  const none = await researchTopic("x", async () => { throw new Error("offline"); });
  assert.deepStrictEqual(none.sources, []);

  // pages unreadable but snippets present -> snippets are used as sources
  const snip = await researchTopic("x", async (u) => { if (u.includes("duckduckgo")) return ddg; throw new Error("blocked"); });
  assert.ok(snip.sources.length >= 1 && snip.sources[0].text.includes("embedded servers"));
  console.log("✓ longvideo-auto research");
})().catch((e) => { console.error(e); process.exit(1); });
