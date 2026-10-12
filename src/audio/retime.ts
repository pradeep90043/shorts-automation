import { execFile } from "child_process";
import { config } from "../config";

const run = (bin: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(`${stdout}\n${stderr}`)));
  });

export async function audioDuration(file: string): Promise<number> {
  const out = await run(config.binaries.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(out.trim());
}

/** "+5%" -> 1.05, "-10%" -> 0.9: the same rate notation Edge TTS takes, as a tempo factor. */
export function rateToTempo(rate: string | undefined): number {
  const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec((rate ?? "").trim());
  return m ? Math.min(2, Math.max(0.5, 1 + parseFloat(m[1]) / 100)) : 1;
}

/** The files one after another into `output` (mp3), with a short pause between them. Returns the length in seconds. */
export async function concatAudio(inputs: string[], output: string, gapSec = 0.25): Promise<number> {
  if (!inputs.length) throw new Error("nothing to join");
  const args = ["-y"];
  for (const f of inputs) args.push("-i", f);
  const parts = inputs.map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=${gapSec}[a${i}]`).join(";");
  const graph = `${parts};${inputs.map((_, i) => `[a${i}]`).join("")}concat=n=${inputs.length}:v=0:a=1[out]`;
  await run(config.binaries.ffmpeg, [...args, "-filter_complex", graph, "-map", "[out]", "-codec:a", "libmp3lame", "-q:a", "2", output]);
  return audioDuration(output);
}

/** Plays `input` at `tempo` times its speed (pitch kept) into `output` (mp3). Returns the new length in seconds. */
export async function retimeAudio(input: string, output: string, tempo: number): Promise<number> {
  const t = Math.min(2, Math.max(0.5, tempo));
  await run(config.binaries.ffmpeg, [
    "-y", "-i", input, "-vn",
    ...(Math.abs(t - 1) > 0.002 ? ["-af", `atempo=${t.toFixed(4)}`] : []),
    "-ar", "44100", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "2", output,
  ]);
  return audioDuration(output);
}
