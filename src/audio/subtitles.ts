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

export type SubtitleStyle = "classic" | "animated_pop" | "minimal" | "none";

/**
 * Generates an Advanced SubStation Alpha (.ass) file with selectable styling:
 * - 'classic': Crisp white with subtle gold accent (Default)
 * - 'animated_pop': Hormozi / MoneyPrinterTurbo word-by-word karaoke highlight
 * - 'minimal': Modern clean subtle subtitle
 */
export function generateASSFile(
  lines: SubtitleLine[],
  outputPath: string,
  style: SubtitleStyle = "classic",
): void {
  if (style === "none" || lines.length === 0) {
    fs.writeFileSync(outputPath, "", "utf8");
    return;
  }

  // Hindi captions: Arial Black has no Devanagari glyphs, so libass would draw empty boxes
  const hindi = lines.some((l) => /[\u0900-\u097F]/.test(l.text));
  const fontName = hindi ? "Noto Sans Devanagari" : "Arial Black";
  const fontSize = style === "minimal" ? 64 : 85;
  const outline = style === "minimal" ? 4 : 8;
  const marginV = style === "minimal" ? 180 : 250;

  const header = `[Script Info]
Title: Subtitles
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColor, SecondaryColor, OutlineColor, BackColor, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H000B0B0B,&H000B0B0B,-1,0,0,0,100,100,0,0,3,${outline},0,8,80,80,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let events = "";

  if (style === "animated_pop") {
    // Word-by-word active pop-up highlight (MoneyPrinterTurbo / Hormozi style)
    for (const line of lines) {
      const words = line.words || [];
      if (words.length === 0) {
        const startStr = formatASSTime(line.start);
        const endStr = formatASSTime(line.end);
        events += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${line.text}\n`;
        continue;
      }

      for (let i = 0; i < words.length; i++) {
        const activeWord = words[i];
        const wStart = formatASSTime(activeWord.start);
        const wEnd = formatASSTime(activeWord.end);

        // Build line text with active word highlighted in yellow + slightly scaled
        const lineText = words
          .map((w, idx) => {
            if (idx === i) {
              return `{\\c&H0022FF&\\fscx112\\fscy112}${w.word}{\\r\\c&H00FFFFFF&}`;
            }
            return `{\\c&H00E0E0E0&}${w.word}{\\c}`;
          })
          .join(" ");

        events += `Dialogue: 0,${wStart},${wEnd},Default,,0,0,0,,${lineText}\n`;
      }
    }
  } else if (style === "minimal") {
    for (const line of lines) {
      const startStr = formatASSTime(line.start);
      const endStr = formatASSTime(line.end);
      events += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${line.text}\n`;
    }
  } else {
    // 'classic' default: Gold accent highlight on sentence level
    for (const line of lines) {
      const startStr = formatASSTime(line.start);
      const endStr = formatASSTime(line.end);
      events += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,{\\c&H00B8FF&}${line.text}{\\c}\n`;
    }
  }

  fs.writeFileSync(outputPath, header + events, "utf8");
  pipelineLogger.info(`Generated ASS subtitles (${style} style): ${outputPath}`, "Subtitles");
}

/**
 * Captions that say exactly what the voice says: the words of the spoken script, timed across the span in which the voice was
 * actually heard (first to last word Whisper found, so it is right even after the voiceover was sped up or slowed down). Each
 * word gets time in proportion to its length. Whisper's own words are only a guess at Hinglish and can be garbled.
 */
export function alignScriptToSpan(script: string, spanStart: number, spanEnd: number): WordTiming[] {
  const words = script.split(/\s+/).filter(Boolean);
  if (!words.length || spanEnd <= spanStart) return [];
  const weights = words.map((w) => Math.max(2, [...w].length) + (/[,.;:!?।]$/.test(w) ? 2 : 0)); // a pause after punctuation
  const total = weights.reduce((a, b) => a + b, 0);
  const out: WordTiming[] = [];
  let t = spanStart;
  words.forEach((word, i) => {
    const d = ((spanEnd - spanStart) * weights[i]) / total;
    out.push({ word, start: t, end: t + d });
    t += d;
  });
  return out;
}

