import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { pipelineLogger } from "../utils/logger";

/**
 * Extracts vocals from a video file using Demucs.
 * Requires `demucs` to be installed on the system (e.g. via `pip install demucs`).
 * 
 * @param videoPath Path to the input video
 * @param outputDir Directory to save the extracted vocals
 * @returns Path to the generated vocal-only audio file, or null if failed/not installed.
 */
export const extractVocals = (videoPath: string, outputDir: string): Promise<string | null> => {
  return new Promise((resolve) => {
    // Check if demucs is available
    exec("demucs --version", (err) => {
      if (err) {
        pipelineLogger.warn(
          "Demucs is not installed or not in PATH. Skipping vocal extraction. To enable music removal, run: pip install demucs",
          "VocalExtractor"
        );
        return resolve(null);
      }

      pipelineLogger.info(`Extracting vocals from ${videoPath} using Demucs... This may take a few minutes.`, "VocalExtractor");
      
      const basename = path.basename(videoPath, path.extname(videoPath));
      const demucsOutputDir = path.join(outputDir, "demucs_out");
      
      // --two-stems=vocals separates into 'vocals' and 'no_vocals'
      const cmd = `demucs --two-stems=vocals -n htdemucs "${videoPath}" -o "${demucsOutputDir}"`;
      
      exec(cmd, (demucsErr, _stdout, stderr) => {
        if (demucsErr) {
          pipelineLogger.error(`Demucs failed: ${stderr}`, demucsErr, "VocalExtractor");
          return resolve(null);
        }
        
        const vocalsPath = path.join(demucsOutputDir, "htdemucs", basename, "vocals.wav");
        if (fs.existsSync(vocalsPath)) {
          pipelineLogger.info(`Successfully extracted vocals to ${vocalsPath}`, "VocalExtractor");
          resolve(vocalsPath);
        } else {
          pipelineLogger.error(`Demucs succeeded but vocals file not found at ${vocalsPath}`, undefined, "VocalExtractor");
          resolve(null);
        }
      });
    });
  });
};
