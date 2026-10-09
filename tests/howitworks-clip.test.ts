import assert from "assert";
import { FreeLlmApiClient } from "../src/ai/freellmapi";
import {
  buildHowItWorksSpec, directHowItWorks, explanationBeats, howItWorksMyVideoEnabled, keyPhrase, mermaidNodes, propsFor, renderHowItWorksClip,
} from "../src/my-video/howItWorksClip";

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

  // the real failure: no usable diagram in the metadata -> topic-specific nodes from the sentences, never the generic boxes
  const water = "AI data centers use liquid cooling to manage the intense heat of dense hardware. Water absorbs thermal energy from the chips before being evaporated. This creates massive consumption at global scale.";
  const waterSpec = buildHowItWorksSpec({ explanation: water, title: "AI's Massive Water Secret", diagramTitle: "AI Data Center Cooling Loop" }, "hiw-water");
  const waterFlows = waterSpec.scenes.slice(1).map((s) => (s.visual as any).flow);
  assert.ok(waterFlows.every((f) => f && f.nodes.length === 3), "one node per sentence");
  assert.ok(waterFlows[0].nodes.every((n: string) => !/Receive Input|Execute Handler|State & Storage|Output Response/.test(n)));
  assert.ok(/Data Centers|Liquid Cooling/.test(waterFlows[0].nodes[0]) && /Water/.test(waterFlows[0].nodes[1]));
  assert.strictEqual((waterSpec.scenes[1].visual as any).setting, "server"); // data centers -> server room
  assert.strictEqual((waterSpec.scenes[3].visual as any).setting, "city"); // global scale -> city
  assert.deepStrictEqual(keyPhrase("Water absorbs thermal energy from the chips"), "Water Absorbs Thermal");
  assert.ok(propsFor("This creates massive consumption").some((p) => p.type === "chartUp"));
  // a diagram written as "flowchart" (not "graph") is accepted
  assert.deepStrictEqual(mermaidNodes('flowchart LR\n  A["Sun"] --> B["Panel"] --> C["Battery"]'), ["Sun", "Panel", "Battery"]);

  // director visuals are used when usable; bare/missing ones fall back to the sentence-derived visual
  const directedMap = new Map<number, any>([
    [0, { pose: "shocked", mood: "shocked", accent: "red", setting: "server", compare: { mode: "versus", cards: [{ title: "Air", points: ["Cheap"] }, { title: "Water", points: ["Efficient"], winner: true }] } }],
    [1, { pose: "think", setting: "server" }], // bare: no callouts/props/panel
  ]);
  const directedSpec = buildHowItWorksSpec({ explanation: water, diagramTitle: "Cooling" }, "hiw-dir", directedMap);
  assert.ok((directedSpec.scenes[1].visual as any).compare, "director's panel kept");
  assert.ok((directedSpec.scenes[2].visual as any).flow, "bare director scene replaced by the sentence-derived one");
  // invented numbers are dropped (the narration states none)
  const withChart = new Map<number, any>([[0, { pose: "point", setting: "server", chart: { kind: "bar", labels: ["A", "B"], values: [7, 99] } }]]);
  assert.ok(!(buildHowItWorksSpec({ explanation: water }, "hiw-chart", withChart).scenes[1].visual as any).chart);

  // LLM director: one call, gets the beats + the hint; a slow/garbage answer -> undefined (derived visuals)
  process.env.FREELLMAPI_KEY = process.env.FREELLMAPI_KEY || "test";
  const proto = FreeLlmApiClient.prototype as any;
  const real = proto.generateText;
  let prompts: string[] = [];
  proto.generateText = async (p: string) => { prompts.push(p); return JSON.stringify({ scenes: [0, 1, 2].map((i) => ({ i, pose: "present", mood: "happy", accent: "gold", camera: "none", setting: "server", callouts: ["LIQUID COOLING"] })) }); };
  const got = await directHowItWorks({ explanation: water, title: "AI's Massive Water Secret" });
  assert.strictEqual(got?.size, 3);
  assert.strictEqual(prompts.length, 1);
  assert.ok(prompts[0].includes("0. AI data centers use liquid cooling") && prompts[0].includes("AI's Massive Water Secret") && prompts[0].includes("never the same generic boxes"));
  proto.generateText = async () => "not json at all";
  assert.strictEqual(await directHowItWorks({ explanation: water }), undefined);
  process.env.HOWITWORKS_LLM = "off";
  assert.strictEqual(await directHowItWorks({ explanation: water }), undefined);
  delete process.env.HOWITWORKS_LLM;
  proto.generateText = real;

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
