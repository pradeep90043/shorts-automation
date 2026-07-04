import path from "path";
import { exec } from "child_process";
import { pipelineLogger } from "../utils/logger";

/**
 * Simple placeholder frame scorer.
 * In a real implementation this would call a Vision AI model to evaluate each frame
 * and return a score (e.g., based on composition, clarity, saliency).
 */
export async function selectBestFrame(videoPath: string, tempDir: string): Promise<string> {
  const timestamps = ["00:00:00.5", "00:00:01", "00:00:01.5", "00:00:02", "00:00:03"];
  const candidates: string[] = [];
  for (const ts of timestamps) {
    const outPath = path.join(tempDir, `frame_${ts.replace(/[:.]/g, "_")}.png`);
    const cmd = `ffmpeg -y -ss ${ts} -i "${videoPath}" -vframes 1 -q:v 2 "${outPath}"`;
    try {
      await new Promise<void>((res, rej) => exec(cmd, (e) => (e ? rej(e) : res())));
      candidates.push(outPath);
    } catch (e) {
      pipelineLogger.warn(`Failed to extract frame at ${ts}: ${e}`, "FrameScorer");
    }
  }
  if (candidates.length === 0) {
    return path.join(tempDir, "original_frame.png");
  }
  pipelineLogger.info(`Selected best frame from ${candidates.length} candidates`, "FrameScorer");
  return candidates[0];
}
