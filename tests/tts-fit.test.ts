import assert from "assert";
import { TTSService } from "../src/audio/tts";

/** A fake voice: natural length `natural` seconds, scaled by 1 / (1 + rate), as measured on the real Edge voice. */
class FakeTTS extends TTSService {
  public calls: Array<string | undefined> = [];
  constructor(private natural: number) {
    super();
  }
  public async generateVoiceover(_s: string, _o: string, _k?: string, rate?: string): Promise<number> {
    this.calls.push(rate);
    const r = rate ? parseFloat(rate) / 100 : 0;
    return this.natural / (1 + r);
  }
}

(async () => {
  // Script reads 24s but the reel is 30s: the voice is slowed (about -19%) so it spans the reel.
  let tts = new FakeTTS(24);
  let d = await tts.generateFittedVoiceover("x", "x", 29.7, "codeorcap");
  assert.ok(Math.abs(d - 29.7) < 29.7 * 0.04, `slowed to fit: ${d}`);
  assert.ok(tts.calls[1] && parseFloat(tts.calls[1]!) < 0, `slower rate requested: ${tts.calls[1]}`);

  // Already on target: one synthesis, no rate.
  tts = new FakeTTS(29.5);
  d = await tts.generateFittedVoiceover("x", "x", 29.7, "codeorcap");
  assert.strictEqual(tts.calls.length, 1);
  assert.strictEqual(d, 29.5);

  // Script reads longer than the reel: sped up so it is not cut off.
  tts = new FakeTTS(36);
  d = await tts.generateFittedVoiceover("x", "x", 29.7, "codeorcap");
  assert.ok(d < 36 && d > 29.7 * 0.96, `sped up: ${d}`);
  assert.ok(parseFloat(tts.calls[1]!) > 0, `faster rate requested: ${tts.calls[1]}`);

  // Far too short: the rate stops at -25% and the result stays short (logged, not stretched further).
  tts = new FakeTTS(10);
  d = await tts.generateFittedVoiceover("x", "x", 29.7, "codeorcap");
  assert.ok(Math.abs(d - 10 / 0.75) < 0.01, `clamped at -25%: ${d}`);
  assert.ok(tts.calls.every((c) => c === undefined || parseFloat(c) >= -25));

  console.log("✓ tts fit-to-length");
})().catch((e) => { console.error(e); process.exit(1); });
