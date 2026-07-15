// tests/ffmpeg.test.ts
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { config } from "../src/config";
import { estimateWordTimings, groupWordsIntoLines, generateASSFile } from "../src/audio/subtitles";

function hasAudioStream(videoPath: string, ffprobePath = "ffprobe"): boolean {
  try {
    const stdout = execSync(
      `"${ffprobePath}" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${videoPath}"`
    ).toString().trim();
    return stdout === "audio";
  } catch (err) {
    return false;
  }
}

(async () => {
  console.log("Running Subtitle FFmpeg Integration test...");

  // Verify if FFmpeg is installed/working on the current system
  try {
    execSync(`"${config.binaries.ffmpeg}" -version`, { stdio: "ignore" });
  } catch (err) {
    console.warn("⚠️ FFmpeg binary not found or not working. Skipping FFmpeg integration test on this build runner.");
    process.exit(0);
  }

  // Verify if FFprobe is installed/working
  try {
    execSync(`"${config.binaries.ffprobe}" -version`, { stdio: "ignore" });
  } catch (err) {
    console.warn("⚠️ FFprobe binary not found or not working. Skipping FFmpeg integration test on this build runner.");
    process.exit(0);
  }

  const tempDir = path.resolve(__dirname, "../temp/test-subtitles");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const rawVideoPath = path.join(tempDir, "video_raw.mp4");
  const voiceoverPath = path.join(tempDir, "voiceover.mp3");
  const assPath = path.join(tempDir, "subtitles.ass");
  const outputPath = path.join(tempDir, "video_output.mp4");

  try {
    // 1. Generate 5-second dummy video (WITHOUT audio stream)
    console.log("Generating dummy video (no audio stream)...");
    execSync(
      `"${config.binaries.ffmpeg}" -y -f lavfi -i color=c=black:s=1080x1920:d=5 -r 30 -pix_fmt yuv420p "${rawVideoPath}"`,
      { stdio: "ignore" }
    );

    // 2. Generate 5-second dummy audio
    console.log("Generating dummy audio...");
    execSync(
      `"${config.binaries.ffmpeg}" -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 5 -c:a mp3 "${voiceoverPath}"`,
      { stdio: "ignore" }
    );

    // 3. Generate ASS subtitle file
    console.log("Generating subtitles ASS file...");
    const script = "This is a flashing subtitle integration test in shorts automation";
    const duration = 5;
    const wordTimings = estimateWordTimings(script, duration);
    const lines = groupWordsIntoLines(wordTimings);
    generateASSFile(lines, assPath);

    // Verify ASS file was written
    if (!fs.existsSync(assPath)) {
      throw new Error("ASS subtitle file was not generated.");
    }
    console.log("✓ ASS file written successfully:", assPath);

    // 4. Check if raw video has audio
    const hasAudio = hasAudioStream(rawVideoPath, config.binaries.ffprobe);
    console.log(`Raw video has audio stream: ${hasAudio}`);

    // 5. Run FFmpeg to burn subtitles and mix audio
    console.log("Burning subtitles using ffmpeg-full...");
    const escapedAssPath = assPath
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:")
      .replace(/'/g, "'\\\\''");

    const fps = 30;
    
    let filterComplex = "";
    if (hasAudio) {
      filterComplex = `[0:v]subtitles='${escapedAssPath}'[vout];[0:a]volume=0.05[a0];[1:a]volume=3.5[a1];[a0][a1]amix=inputs=2:duration=shortest[aout]`;
    } else {
      filterComplex = `[0:v]subtitles='${escapedAssPath}'[vout];[1:a]volume=3.5[aout]`;
    }

    const cmd = `"${config.binaries.ffmpeg}" -y -i "${rawVideoPath}" -i "${voiceoverPath}" -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -r ${fps} -c:a aac -ar 44100 -ac 2 -shortest "${outputPath}"`;
    
    console.log("Executing:", cmd);
    execSync(cmd, { stdio: "inherit" });

    // Verify output video file
    if (!fs.existsSync(outputPath)) {
      throw new Error("Output video file was not generated.");
    }
    const stats = fs.statSync(outputPath);
    console.log(`✓ Output video generated successfully: ${outputPath} (${stats.size} bytes)`);
    console.log("✓ Subtitle FFmpeg integration test completed successfully!");
    
    // Clean up
    fs.unlinkSync(rawVideoPath);
    fs.unlinkSync(voiceoverPath);
    fs.unlinkSync(assPath);
    fs.unlinkSync(outputPath);
    fs.rmdirSync(tempDir);
  } catch (err) {
    console.error("❌ Test failed:", err);
    process.exit(1);
  }
})();
