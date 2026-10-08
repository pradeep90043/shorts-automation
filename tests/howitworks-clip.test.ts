import assert from "assert";
import { buildHowItWorksSpec, explanationBeats, howItWorksMyVideoEnabled, mermaidNodes, renderHowItWorksClip } from "../src/my-video/howItWorksClip";

const autoMermaid = `graph TD\n  A["📥 1. Receive Input: Spring Boot REST API"] --> B["⚡ 2. Execute Handler"]\n  B --> C["💾 3. State & Storage"]\n  C --> D["🚀 4. Output Response"]`;

(async () => {
  // diagram labels: emoji, numbering and the ": <title>" tail are removed
  assert.deepStrictEqual(mermaidNodes(autoMermaid), ["Receive Input", "Execute Handler", "State & Storage", "Output Response"]);
  assert.deepStrictEqual(mermaidNodes("graph LR\n  A[Client] --> B(Server) --> C{Cache?} --> D[(DB)]").slice(0, 3), ["Client", "Server", "Cache?"]);
  assert.strictEqual(mermaidNodes("graph TD\n" + "ABCDEFG".split("").map((c) => `${c}[Step ${c}]`).join(" --> ")).length, 5);
  assert.deepStrictEqual(mermaidNodes(undefined), []);

  // narration: list numbers gone, at most 5 beats
  const beats = explanationBeats("1. The client sends a request. 2. The controller validates the input. 3. The service runs the business logic. 4. The repository saves the data. 5. The database stores it safely. 6. The API returns a JSON response. 7. The client renders the result.");
  assert.ok(beats.length >= 1 && beats.length <= 5);
  assert.ok(beats.every((b) => !/^\d+[.)]/.test(b)));

  // spec: vertical dark clip, intro + body, flow panel walks along the diagram, valid for my-video
  const spec = buildHowItWorksSpec({ explanation: "1. Parses the request. 2. Runs the handler. 3. Returns the response.", mermaid: autoMermaid, diagramTitle: "Request Flow" }, "hiw-test");
  assert.strictEqual(spec.orientation, "vertical");
  assert.strictEqual(spec.theme, "dark");
  assert.strictEqual(spec.noBranding, true);
  assert.strictEqual(spec.scenes[0].text, "Let us check how is it working.");
  assert.ok(spec.scenes.length >= 2);
  const flows = spec.scenes.slice(1).map((s) => (s.visual as any).flow);
  assert.ok(flows.every((f) => f && f.nodes.length === 4));
  const actives = flows.map((f) => f.active as number);
  assert.deepStrictEqual([...actives].sort((a, b) => a - b), actives); // moves forward only
  assert.strictEqual(actives[actives.length - 1], 3); // ends on the last node
  assert.ok(spec.scenes.every((s) => (s.visual as any).setting && (s.visual as any).setting !== "none"));
  assert.ok(spec.scenes.every((s) => (s.visual as any).accent === "gold"));

  // no usable diagram -> props + callouts instead of a panel
  const plain = buildHowItWorksSpec({ explanation: "It parses the request and returns the response." }, "hiw-plain");
  assert.ok(plain.scenes.slice(1).every((s) => !(s.visual as any).flow && (s.visual as any).callouts?.length));

  // safe by default: nothing to render with -> returns false without throwing
  const saved = { gh: process.env.GITHUB_TOKEN, g2: process.env.GH_TOKEN, loc: process.env.RENDER_LOCAL, off: process.env.HOWITWORKS_MYVIDEO };
  delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; delete process.env.RENDER_LOCAL; delete process.env.HOWITWORKS_MYVIDEO;
  assert.strictEqual(howItWorksMyVideoEnabled(), false);
  assert.strictEqual(await renderHowItWorksClip({ explanation: "x y z" }, "/tmp/never.mp4"), false);
  process.env.GITHUB_TOKEN = "t";
  assert.strictEqual(howItWorksMyVideoEnabled(), true);
  process.env.HOWITWORKS_MYVIDEO = "off";
  assert.strictEqual(howItWorksMyVideoEnabled(), false);
  for (const [k, v] of Object.entries({ GITHUB_TOKEN: saved.gh, GH_TOKEN: saved.g2, RENDER_LOCAL: saved.loc, HOWITWORKS_MYVIDEO: saved.off })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  console.log("✓ how-it-works clip: diagram, narration, spec, safe fallback");
})().catch((e) => { console.error(e); process.exit(1); });
