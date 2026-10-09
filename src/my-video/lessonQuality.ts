/**
 * Pre-render quality gate for programming lessons. A valid plan is not automatically a good lesson: this reads the
 * scenes (narration + visual) and reports what would make the video weak - code that is talked about but never shown,
 * code that jumps between scenes, quiz answers that leak, lines too long to read. It only WARNS; nothing is blocked.
 */

export interface QualityWarning {
  level: "warn" | "info";
  /** 1-based scene number, when the finding is about one scene */
  scene?: number;
  message: string;
}
export interface LessonScene {
  text: string;
  visual: any;
}

const CODE_LINE_MAX = 56;
const CODE_LINES_MAX = 14;

const CODE_WORDS = /\b(annotations?|class(?:es)?|methods?|beans?|inject\w*|autowired|properties|property|application\.(?:properties|ya?ml)|maven|mvn|gradle|java|spring|boot|code|variables?|functions?|constructors?|interfaces?|endpoints?|api|runner|compile\w*|dependenc\w+|jar|annotation)\b|@\w+/gi;
/** things a narrator says when a specific piece of code is on the table */
const NAMES_CODE = /@\w+|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z0-9]+[A-Z]\w*\b|application\.(?:properties|ya?ml)|\bmvn\b|\b\w+\(\)/;

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hasCode = (v: any): boolean => !!v && (Array.isArray(v.code?.lines) || Array.isArray(v.terminal?.lines));
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** A script is treated as a programming lesson when code vocabulary is dense or several scenes already show code. */
export function looksLikeCodingLesson(scenes: LessonScene[]): boolean {
  const text = scenes.map((s) => s.text).join(" ");
  const hits = (text.match(CODE_WORDS) ?? []).length;
  return scenes.filter((s) => hasCode(s.visual)).length >= 3 || (wordCount(text) > 0 && hits / wordCount(text) > 0.04);
}

export function lessonQualityReport(scenes: LessonScene[]): QualityWarning[] {
  const out: QualityWarning[] = [];
  const warn = (message: string, scene?: number) => out.push({ level: "warn", scene, message });
  const info = (message: string, scene?: number) => out.push({ level: "info", scene, message });
  if (!scenes.length) return out;
  const coding = looksLikeCodingLesson(scenes);

  // 1. the share of scenes that actually show code
  const codeScenes = scenes.filter((s) => hasCode(s.visual)).length;
  const share = codeScenes / scenes.length;
  if (coding && share < 0.25) {
    warn(`This looks like a programming lesson but only ${Math.round(share * 100)}% of the scenes show code or a terminal (${codeScenes} of ${scenes.length}); a coding tutorial works best at 35-55%.`);
  }

  // 2. code is named but not shown
  if (coding) {
    const missing = scenes.map((s, i) => ({ i, s })).filter(({ s }) => NAMES_CODE.test(s.text) && !hasCode(s.visual)).map(({ i }) => i + 1);
    if (missing.length) {
      const shown = missing.slice(0, 8).join(", ") + (missing.length > 8 ? ", ..." : "");
      warn(`${missing.length} scene${missing.length > 1 ? "s" : ""} name code (an annotation, class, property or command) but show no code panel: scene ${shown}.`);
    }
  }

  let prev: { title: string; lines: string[] } | null = null;
  scenes.forEach((s, idx) => {
    const n = idx + 1;
    const v = s.visual ?? {};
    // 3. readability of each code panel
    if (Array.isArray(v.code?.lines)) {
      const lines: string[] = v.code.lines.map((l: unknown) => String(l ?? ""));
      const long = lines.filter((l) => l.replace(/\t/g, "  ").trimEnd().length > CODE_LINE_MAX).length;
      if (long) info(`${long} code line${long > 1 ? "s are" : " is"} longer than ${CODE_LINE_MAX} characters and will be wrapped onto the next line.`, n);
      if (lines.length > CODE_LINES_MAX) warn(`The code panel has ${lines.length} lines; only the first ${CODE_LINES_MAX} fit.`, n);
      // 4. quotes balanced on each line (java / bash)
      const language = String(v.code.language ?? (/\.(properties|ya?ml|xml|txt|md)$/i.test(String(v.code.title ?? v.code.filename ?? "")) ? "other" : "java"));
      if (language === "java" || language === "bash") {
        lines.forEach((l, k) => {
          const quotes = (l.replace(/\\"/g, "").match(/"/g) ?? []).length;
          if (quotes % 2 === 1) warn(`Code line ${k + 1} has an unbalanced quote: ${l.trim().slice(0, 50)}`, n);
        });
      }
      // 5. a file built over several scenes must keep its earlier lines
      const title = String(v.code.title ?? v.code.filename ?? "");
      const reveal = Number.isInteger(v.code.revealFrom) ? v.code.revealFrom : 0;
      if (prev && title && prev.title === title && reveal > 0) {
        const same = lines.slice(0, reveal).every((l, k) => (prev!.lines[k] ?? "").trim() === l.trim());
        if (!same) warn(`revealFrom is ${reveal} but the lines before it differ from the previous scene's ${title}; the code would jump instead of growing.`, n);
      }
      prev = { title, lines };
    }
    // 6. a quiz must not give its answer away
    if (v.quiz && Array.isArray(v.quiz.options) && Number.isInteger(v.quiz.answer)) {
      const answer = norm(String(v.quiz.options[v.quiz.answer] ?? ""));
      const visible = norm(`${s.text} ${v.title ?? ""} ${(Array.isArray(v.callouts) ? v.callouts : []).join(" ")} ${v.quiz.question ?? ""}`);
      if (answer.length >= 4 && visible.includes(answer)) warn(`The quiz answer "${String(v.quiz.options[v.quiz.answer]).slice(0, 40)}" already appears in this scene's narration or question.`, n);
    }
    // 7. a terminal should show the command being run
    if (Array.isArray(v.terminal?.lines) && !v.terminal.lines.some((l: unknown) => String(l).trimStart().startsWith("$"))) {
      info(`The terminal shows output but no command line (start one with "$ ").`, n);
    }
  });

  if (coding) {
    if (!scenes.some((s) => s.visual?.quiz)) info(`No "pause and think" question: about one per chapter helps viewers remember (use a quiz panel, placed before the result is shown).`);
    const tail = scenes.slice(-4).map((s) => s.text).join(" ");
    if (!/\b(try|task|exercise|challenge|practice|your turn|homework|on your own|build your)\b/i.test(tail)) info("The lesson ends without a practical task for the viewer.");
  }
  return out.sort((a, b) => Number(a.level === "info") - Number(b.level === "info") || (a.scene ?? 0) - (b.scene ?? 0));
}
