import fs from "fs";
import { pipelineLogger } from "../utils/logger";

export interface WordTiming {
  word: string;
  start: number; // seconds
  end: number;   // seconds
}

export interface SubtitleLine {
  text: string;
  start: number; // seconds
  end: number;   // seconds
  words: WordTiming[];
}

/**
 * Estimates the start and end timestamps of each word in a script
 * based on the total audio duration and punctuation pauses.
 */
export function estimateWordTimings(
  script: string,
  totalDuration: number,
): WordTiming[] {
  // Normalize spacing and split
  const cleanScript = script.trim().replace(/\s+/g, " ");
  if (!cleanScript) return [];

  const words = cleanScript.split(" ");
  const weights: number[] = [];
  let totalWeight = 0;

  for (const word of words) {
    // Remove punctuation to measure clean length
    const cleanWord = word.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, "");
    
    // Calculate weight: character count + base word weight
    let w = Math.max(1, cleanWord.length) * 0.1;
    w += 0.2; // base weight per word

    // Add extra weight (pause) for punctuation
    if (/[.!?]$/.test(word)) {
      w += 0.4; // sentence end pause
    } else if (/,:;$/.test(word)) {
      w += 0.2; // clause pause
    }

    weights.push(w);
    totalWeight += w;
  }

  const timings: WordTiming[] = [];
  let currentTime = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const weight = weights[i];
    const duration = (weight / totalWeight) * totalDuration;

    timings.push({
      word,
      start: currentTime,
      end: currentTime + duration,
    });

    currentTime += duration;
  }

  return timings;
}

/**
 * Groups individual word timings into subtitle lines.
 * Ensures lines are not too long and respect punctuation boundaries.
 */
export function groupWordsIntoLines(
  wordTimings: WordTiming[],
  maxChars = 40,
  maxWords = 8,
): SubtitleLine[] {
  const lines: SubtitleLine[] = [];
  let currentWords: WordTiming[] = [];
  let currentLength = 0;

  for (const wt of wordTimings) {
    const wordLength = wt.word.length;
    
    // Check if we should flush the current line before adding this word
    const shouldFlush =
      currentWords.length >= maxWords ||
      (currentWords.length > 0 && currentLength + 1 + wordLength > maxChars) ||
      (currentWords.length > 0 && /[.!?]$/.test(currentWords[currentWords.length - 1].word));

    if (shouldFlush && currentWords.length > 0) {
      lines.push({
        text: currentWords.map((w) => w.word).join(" "),
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end,
        words: currentWords,
      });
      currentWords = [];
      currentLength = 0;
    }

    currentWords.push(wt);
    currentLength += (currentLength === 0 ? 0 : 1) + wordLength;
  }

  // Flush remaining words
  if (currentWords.length > 0) {
    lines.push({
      text: currentWords.map((w) => w.word).join(" "),
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end,
      words: currentWords,
    });
  }

  return lines;
}

/**
 * Helper to format seconds to ASS format: H:MM:SS.cs
 */
function formatASSTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);

  const pad = (n: number) => String(n).padStart(2, "0");
  const padMs = (n: number) => String(n).padStart(2, "0").slice(0, 2);

  return `${hrs}:${pad(mins)}:${pad(secs)}.${padMs(ms)}`;
}

/**
 * Generates an Advanced SubStation Alpha (.ass) file with word-by-word flashing style.
 * Uses a premium yellow accent color (&H00B8FF&) for active highlights.
 */
export function generateASSFile(
  lines: SubtitleLine[],
  outputPath: string,
): void {
  const header = `[Script Info]
Title: Flashing Subtitles
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColor, SecondaryColor, OutlineColor, BackColor, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,85,&H00FFFFFF,&H00FFFFFF,&H000B0B0B,&H00000000,-1,0,0,0,100,100,0,0,1,6,2,5,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let events = "";
  
  for (const line of lines) {
    // Generate exactly one Dialogue event for the entire sentence's duration.
    // Wrap the text in primary color override tag {\c&H00B8FF&} (yellow-orange) so the whole sentence flashes.
    const startStr = formatASSTime(line.start);
    const endStr = formatASSTime(line.end);
    events += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,{\\c&H00B8FF&}${line.text}{\\c}\n`;
  }

  fs.writeFileSync(outputPath, header + events, "utf8");
  pipelineLogger.info(`Generated ASS subtitles: ${outputPath}`, "Subtitles");
}
