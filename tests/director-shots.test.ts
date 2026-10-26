import assert from "assert";
import { addDirectorShots, carryHolds, directorShotsEnabled, sanitizeCast, sanitizeShot } from "../src/my-video/directorShots";
import type { StickmanPlan } from "../src/my-video/stickmanPlanner";

(async () => {
  // 1) the switch: on for every channel by default, off, or a list of channels
  assert.strictEqual(directorShotsEnabled("storiyum", {}), true);
  assert.strictEqual(directorShotsEnabled("codeorcap", { DIRECTOR_SHOTS: "off" }), false);
  assert.strictEqual(directorShotsEnabled("storiyum", { DIRECTOR_SHOTS: "storiyum" }), true);
  assert.strictEqual(directorShotsEnabled("codeorcap", { DIRECTOR_SHOTS: "storiyum, infoonspot" }), false);
  assert.strictEqual(directorShotsEnabled("infoonspot", { DIRECTOR_SHOTS: "storiyum, infoonspot" }), true);
  assert.strictEqual(directorShotsEnabled("codeorcap", { DIRECTOR_SHOTS: "all" }), true);
  assert.strictEqual(directorShotsEnabled(undefined, { DIRECTOR_SHOTS: "storiyum" }), false);
  assert.strictEqual(directorShotsEnabled(undefined, {}), true);

  // 2) cast: known looks only, unique ids, at most 5, one skin for everyone
  const cast = sanitizeCast({ skin: "medium", cast: [
    { id: "Raju", age: "child", gender: "male", hair: "spiky", outfit: "uniform", top: "#ffffff", bottom: "#223355" },
    { id: "maa", age: "adult", gender: "female", hair: "bun", outfit: "saree", top: "#c0392b", wings: true, beard: "huge" },
    { id: "raju", age: "old" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" },
  ] });
  assert.deepStrictEqual([...cast.keys()], ["raju", "maa", "a", "b", "c"]);
  assert.deepStrictEqual(cast.get("maa"), { age: "adult", gender: "female", hair: "bun", outfit: "saree", top: "#c0392b", skin: "medium" });

  // 3) a shot: furniture of the place is known, unknown things are removed, the look comes from the cast design, no speech
  const { shot, problems } = sanitizeShot({
    place: "study", time: "night",
    props: [{ id: "laptop", kind: "laptop", on: "desk", at: 0.4 }, { id: "x", kind: "spaceship" }, { id: "desk", kind: "desk" }],
    cast: [{ id: "raju", at: 0.2, mood: "tired", outfit: "saree" }, { id: "ghost", at: 0.5 }],
    actions: [
      { at: 0.5, who: "raju", do: "sit", target: "chair" },
      { at: 1.5, who: "raju", do: "use", target: "laptop", dur: 2 },
      { at: 2, who: "raju", do: "say", text: "hello" },
      { at: 2, who: "raju", do: "teleport" },
      { at: 2.5, who: "raju", do: "pick", target: "moon" },
      { at: 99, who: "raju", do: "nod" },
    ],
    camera: { shot: "medium", on: "raju", move: "zoom-crazy" },
  }, cast, 4);
  assert.ok(shot);
  assert.deepStrictEqual(shot!.props.map((p: any) => p.id), ["laptop"]);
  assert.deepStrictEqual(shot!.cast.map((c: any) => [c.id, c.outfit, c.mood]), [["raju", "uniform", "tired"]]);
  assert.deepStrictEqual(shot!.actions.map((a: any) => a.do), ["sit", "use", "nod"]);
  assert.ok(shot!.actions[2].at <= 4, "times stay inside the shot");
  assert.deepStrictEqual(shot!.camera, { shot: "medium", move: "static", feel: "steady", on: "raju" });
  assert.ok(problems.length >= 4, `problems reported: ${problems.join("; ")}`);
  assert.strictEqual(sanitizeShot({ place: "mars" }, cast, 3).shot, null);

  // 3b) repairs: a pose without its verb, an object used but never added (goes in the hand), picked up (goes on a surface)
  const rep = sanitizeShot({ place: "bedroom", cast: [{ id: "raju", sitOn: "bed" }, { id: "maa", at: 0.8 }], actions: [
    { at: 0.2, who: "raju", pose: "think" }, { at: 0.5, who: "raju", do: "use", target: "phone" }, { at: 1, who: "maa", do: "pick", target: "cup" },
  ] }, cast, 4).shot!;
  assert.deepStrictEqual(rep.actions.map((a: any) => [a.do, a.target]), [["pose", undefined], ["use", "phone"], ["pick", "cup"]]);
  assert.deepStrictEqual(rep.props.map((p: any) => [p.id, p.kind, p.on]), [["phone", "phone", "nightstand"], ["cup", "mug", "nightstand"]]);
  assert.strictEqual(rep.cast.find((c: any) => c.id === "raju").holds, "phone", "the phone being used is in his hand");
  assert.strictEqual(rep.cast.find((c: any) => c.id === "maa").holds, undefined, "the cup to pick up waits on the nightstand");

  // 3c) hands carry over between shots: had the cup, then puts it down
  const s1 = sanitizeShot({ place: "bedroom", props: [{ id: "cup", kind: "mug", on: "nightstand" }], cast: [{ id: "maa", at: 0.6 }], actions: [{ at: 0.3, who: "maa", do: "pick", target: "cup" }] }, cast, 3).shot!;
  const s2 = sanitizeShot({ place: "bedroom", cast: [{ id: "maa", at: 0.6 }], actions: [{ at: 0.5, who: "maa", do: "put", target: "nightstand" }] }, cast, 3).shot!;
  assert.deepStrictEqual(carryHolds(s1, s2), ["maa still holds the mug"]);
  assert.strictEqual(s2.cast[0].holds, "cup");
  assert.ok(s2.props.find((p: any) => p.id === "cup"));
  const s3 = sanitizeShot({ place: "bedroom", cast: [{ id: "maa", at: 0.6 }], actions: [{ at: 0.5, who: "maa", do: "nod" }] }, cast, 3).shot!;
  assert.deepStrictEqual(carryHolds(s1, s3), [], "only when the hands are needed");

  // 3d) "put the book on the phone" -> on the desk
  const putOn = sanitizeShot({ place: "study", props: [{ id: "phone", kind: "phone", on: "desk" }, { id: "book", kind: "book", on: "desk" }], cast: [{ id: "raju", sitOn: "chair", holds: "book" }], actions: [{ at: 1, who: "raju", do: "put", target: "phone" }] }, cast, 3).shot!;
  assert.strictEqual(putOn.actions[0].target, "desk");

  // 4) the whole step with a fake AI: cast once, shots in batches, an unusable answer leaves the beat's visual alone
  const plan: StickmanPlan = {
    title: "t", description: "d", tags: [], aiVisuals: true,
    scenes: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, text: `Line number ${i} of the story where Raju studies.`, visual: { pose: "idle" } as any })),
  };
  const calls: string[] = [];
  const ask = async (prompt: string) => {
    calls.push(prompt);
    if (prompt.includes("casting director")) return JSON.stringify({ skin: "tan", cast: [{ id: "raju", age: "teen", outfit: "tshirt", top: "#3e6fa8" }] });
    const lines = [...prompt.matchAll(/^(\d+)\. \(/gm)].map((m) => Number(m[1]));
    return JSON.stringify({ shots: lines.map((i) => ({ i, shot: i === 3 ? { place: "volcano" } : { place: "park", cast: [{ id: "raju", at: 0.5 }], actions: [{ at: 0.5, who: "raju", do: "walk", to: 0.8 }], camera: { shot: "full", on: "raju" } } })) });
  };
  const logs: string[] = [];
  const r = await addDirectorShots(plan, ask, (m) => logs.push(m), 4);
  assert.deepStrictEqual([r.cast, r.staged, r.beats], [1, 9, 10]);
  assert.strictEqual(calls.length, 1 + 3, "one cast call + 3 batches of 4");
  assert.strictEqual((plan.scenes[3].visual as any).shot, undefined, "the unusable shot left the normal visual");
  assert.strictEqual((plan.scenes[0].visual as any).shot.cast[0].skin, "tan");
  assert.ok(calls[1].includes("raju:") && calls[1].includes("Never put the narration on screen"));
  assert.ok(logs.some((l) => l.includes("9/10 story beats staged")));

  // 4b) explainer beats with a teaching panel keep it; only the others are staged (and only they are sent to the AI)
  const mixed: StickmanPlan = { ...plan, scenes: plan.scenes.map((s, i) => ({ ...s, visual: (i % 2 ? { code: { lines: ["x"] } } : i === 4 ? { photo: { url: "u" } } : { pose: "idle" }) as any })) };
  const asked: string[] = [];
  const r3 = await addDirectorShots(mixed, async (p) => { asked.push(p); return ask(p); }, () => {}, 4);
  assert.deepStrictEqual([r3.beats, r3.staged], [4, 4], "beats 0, 2, 6, 8 staged; odd beats keep code, beat 4 keeps its photo");
  assert.ok(mixed.scenes.every((s, i) => !!(s.visual as any).shot === [0, 2, 6, 8].includes(i)));
  assert.ok(!asked.slice(1).join("").includes("Line number 1 "), "a code beat is not sent to the AI as a line to stage");

  // 5) the AI is down: nothing breaks, nothing is staged
  const plan2: StickmanPlan = { ...plan, scenes: plan.scenes.map((s) => ({ ...s, visual: { pose: "idle" } as any })) };
  const r2 = await addDirectorShots(plan2, async () => "", () => {});
  assert.strictEqual(r2.staged, 0);
  console.log("✓ director-shots: switch, cast, shot sanitising, batching, fallbacks");
})().catch((e) => { console.error(e); process.exit(1); });
