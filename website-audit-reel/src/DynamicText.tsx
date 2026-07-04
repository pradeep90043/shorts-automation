import {
  AbsoluteFill,
  Img,
  Video,
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
  staticFile,
} from "remotion";
import React from "react";
import { loadFont } from "@remotion/google-fonts/Montserrat";

const { fontFamily } = loadFont("normal", {
  weights: ["800", "900"],
  subsets: ["latin"],
});

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface TextLayer {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isMemeText?: boolean;
}

export interface SafeAreaCandidate {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  reason: string;
}

/**
 * Caption rendering styles (chosen by the AI vision model):
 *
 * style1_outline        – white text + thick black stroke, NO rectangle
 *                         → use on plain/solid-color or cartoon backgrounds
 * style2_banner_replace – paint the exact original banner region (same bg color),
 *                         then write new text centered inside it
 *                         → use when an existing meme caption banner is detected
 * style3_black_banner   – tight solid-black rectangle sized to the text height
 *                         → only when background is genuinely busy
 * style4_gradient       – semi-transparent dark gradient scrim, no hard edges
 *                         → use on real live-action video footage
 */
export type CaptionStyle =
  | "style1_outline"
  | "style2_banner_replace"
  | "style3_black_banner"
  | "style4_gradient";

interface Props {
  mediaUrl?: string;
  mediaType?: "video" | "image";
  textLayers?: TextLayer[];
  memeCaption?: string;
  safeArea?: { x: number; y: number; width: number; height: number };
  safeAreaCandidates?: SafeAreaCandidate[];
  existingBanner?: boolean;
  bannerBounds?: { x: number; y: number; width: number; height: number } | null;
  /** AI-chosen caption rendering style */
  captionStyle?: CaptionStyle;
  /** Background classification in the placement area */
  backgroundType?: "plain" | "busy" | "existing_banner";
  keepOriginalCaption?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const resolveMediaSrc = (url: string) => {
  if (!url) return "";
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("file://") ||
    url.startsWith("/")
  ) {
    return url;
  }
  return staticFile(url);
};

/** Split caption string into display lines, honouring "//" as an explicit break. */
const splitTextIntoLines = (text: string, wordsPerLine = 4): string[][] => {
  if (text.includes("//")) {
    return text
      .split("//")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((seg) => seg.split(/\s+/).filter(Boolean));
  }
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[][] = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine));
  }
  return lines;
};

/** Group OCR TextLayers (with real pixel coordinates) into visual lines. */
const groupWordsIntoLines = (words: TextLayer[]): TextLayer[][] => {
  const sorted = [...words].sort((a, b) => a.top - b.top);
  const lines: TextLayer[][] = [];
  for (const word of sorted) {
    let added = false;
    for (const line of lines) {
      const avgTop = line.reduce((s, w) => s + w.top, 0) / line.length;
      if (Math.abs(word.top - avgTop) < 30) {
        line.push(word);
        added = true;
        break;
      }
    }
    if (!added) lines.push([word]);
  }
  for (const line of lines) line.sort((a, b) => a.left - b.left);
  lines.sort((a, b) => {
    const at = a.reduce((s, w) => s + w.top, 0) / a.length;
    const bt = b.reduce((s, w) => s + w.top, 0) / b.length;
    return at - bt;
  });
  return lines;
};

/** Estimate total pixel height for `n` lines at `size` px with `gap` between. */
const estimateCaptionHeight = (n: number, size: number, gap: number) =>
  n * size * 1.25 + Math.max(0, n - 1) * gap;

/** Binary-search the largest font size that keeps text within `maxH` pixels. */
const fitFontSize = (
  n: number,
  maxH: number,
  gap: number,
  initial: number,
  min: number
) => {
  let s = initial;
  while (s > min && estimateCaptionHeight(n, s, gap) > maxH) s -= 2;
  return Math.max(min, s);
};

// ─── Word colour rules ────────────────────────────────────────────────────────

const hasSub = (w: string, roots: string[]) =>
  roots.some((r) => w.includes(r));

function wordColor(cleanWord: string): {
  color: string;
  textShadow: string;
  scale: number;
} {
  const isAi = hasSub(cleanWord, [
    "chatgpt", "gemini", "claude", "grok", "ai", "copilot", "llm", "openai",
  ]);
  const isNumber =
    /\d/.test(cleanWord) ||
    hasSub(cleanWord, ["million", "billion", "thousand", "10x"]);
  const isOrange = hasSub(cleanWord, [
    "develop", "nowaday", "project", "code", "program", "dev",
    "software", "engineer", "build", "git", "python", "java",
    "script", "rust", "rely", "autom", "syst", "install", "server", "cloud", "data",
  ]);
  const isPositive = hasSub(cleanWord, [
    "succ", "win", "grow", "prof", "rich", "love", "perf", "good", "nice", "happy", "funny", "laugh",
  ]);
  const isNegative = hasSub(cleanWord, [
    "fail", "prank", "unemploy", "loss", "dang", "err", "bad",
    "wrong", "crash", "break", "broken", "destr", "chaos", "over",
  ]);

  if (isAi || isNumber)
    return {
      color: "#FFB800",
      textShadow:
        "0 0 10px rgba(255,184,0,0.6), -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000",
      scale: 1.05,
    };
  if (isOrange)
    return {
      color: "#FF8A00",
      textShadow:
        "0 0 10px rgba(255,138,0,0.5), -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000",
      scale: 1.0,
    };
  if (isPositive)
    return {
      color: "#22C55E",
      textShadow:
        "0 0 10px rgba(34,197,94,0.5), -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000",
      scale: 1.0,
    };
  if (isNegative)
    return {
      color: "#FF3B30",
      textShadow:
        "0 0 10px rgba(255,59,48,0.5), -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000",
      scale: 1.0,
    };
  return {
    color: "#FFFFFF",
    textShadow:
      "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 4px 10px rgba(0,0,0,0.8)",
    scale: 1.0,
  };
}

// ─── Main component ───────────────────────────────────────────────────────────

export const DynamicTextComposition: React.FC<Props> = ({
  mediaUrl = "",
  mediaType = "video",
  textLayers = [],
  memeCaption = "",
  safeArea,
  safeAreaCandidates = [],
  existingBanner = false,
  bannerBounds,
  captionStyle = "style1_outline",
  keepOriginalCaption = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // ── 1. Resolve placement box ─────────────────────────────────────────────
  //
  // Priority chain:
  //   P1 — existingBanner + bannerBounds  (AI detected existing banner)
  //   P2 — highest-scoring safeAreaCandidate
  //   P3 — legacy safeArea field
  //   P4 — OCR meme layers (only when clearly in top/bottom banner zone)
  //   P5 — lower-third default (no background)

  type PlacementBox = {
    left: number;
    top: number;
    width: number;
    height: number;
    maxFontSize: number;
    /** Resolved style — may be overridden by the specific placement source */
    style: CaptionStyle;
  };

  let placement: PlacementBox | null = null;

  // P1 — existing AI-detected banner
  if (existingBanner && bannerBounds) {
    const bL = Math.round(bannerBounds.x * 1080);
    const bT = Math.round(bannerBounds.y * 1920);
    const bW = Math.round(bannerBounds.width * 1080);
    const bH = Math.round(bannerBounds.height * 1920);
    placement = {
      left: bL, top: bT, width: bW, height: bH,
      maxFontSize: Math.max(18, Math.round(bH * 0.42)),
      style: "style2_banner_replace",      // always use banner-replace for confirmed banners
    };
  }

  // P2 — best safe-area candidate
  if (!placement && safeAreaCandidates.length > 0) {
    const best = safeAreaCandidates[0];
    const isBannerCandidate =
      best.reason.toLowerCase().includes("banner") ||
      best.reason.toLowerCase().includes("existing");
    const cL = Math.round(best.x * 1080);
    const cT = Math.round(best.y * 1920);
    const cW = Math.round(best.width * 1080);
    const cH = Math.round(best.height * 1920);
    placement = {
      left: cL, top: cT, width: cW, height: cH,
      maxFontSize: Math.max(18, Math.round(cH * 0.42)),
      style: isBannerCandidate ? "style2_banner_replace" : captionStyle,
    };
  }

  // P3 — legacy safeArea
  if (!placement && safeArea) {
    const sL = Math.round(safeArea.x * 1080);
    const sT = Math.round(safeArea.y * 1920);
    const sW = Math.round(safeArea.width * 1080);
    const sH = Math.round(safeArea.height * 1920);
    placement = {
      left: sL, top: sT, width: sW, height: sH,
      maxFontSize: Math.max(18, Math.round(sH * 0.42)),
      style: captionStyle,
    };
  }

  // P4 — OCR meme layers (only in clear top/bottom banner zones)
  const memeLayers = textLayers.filter((l) => l.isMemeText);
  if (!placement && memeLayers.length > 0) {
    const minTop = Math.min(...memeLayers.map((l) => l.top));
    const maxBot = Math.max(...memeLayers.map((l) => l.top + l.height));
    const ocrH = maxBot - minTop + 20;
    const ocrT = Math.max(0, minTop - 10);
    const isTopZone = ocrT < 1920 * 0.22 && ocrH < 1920 * 0.25;
    const isBotZone = ocrT > 1920 * 0.78 && ocrH < 1920 * 0.20;
    if (isTopZone || isBotZone) {
      placement = {
        left: 0, top: ocrT, width: 1080, height: ocrH,
        maxFontSize: Math.max(18, Math.round(ocrH * 0.42)),
        style: "style2_banner_replace",
      };
    }
  }

  // P5 — no placement → lower-third fallback (style resolved from prop)

  // ── 2. Effective style ───────────────────────────────────────────────────
  // The placement may override the requested style (e.g. confirmed banner → style2).
  // Outside of that, honour captionStyle from AI.
  const effectiveStyle: CaptionStyle = placement?.style ?? captionStyle;

  // ── 3. Parse HOOK / BODY / CTA ───────────────────────────────────────────
  let hookText = "", bodyText = "", ctaText = "";
  const hookMatch = memeCaption.match(/\[HOOK\](.*?)(\[BODY\]|\[CTA\]|$)/is);
  const bodyMatch = memeCaption.match(/\[BODY\](.*?)(\[CTA\]|$)/is);
  const ctaMatch  = memeCaption.match(/\[CTA\](.*?)$/is);
  if (hookMatch || bodyMatch || ctaMatch) {
    hookText = hookMatch ? hookMatch[1].trim() : "";
    bodyText = bodyMatch ? bodyMatch[1].trim() : "";
    ctaText  = ctaMatch  ? ctaMatch[1].trim()  : "";
  }

  const hookFrames = 3 * fps;
  const ctaFrames  = 2 * fps;
  let activeCaption = memeCaption;
  if (hookText || bodyText || ctaText) {
    if (frame < hookFrames && hookText)                             activeCaption = hookText;
    else if (frame >= durationInFrames - ctaFrames && ctaText)     activeCaption = ctaText;
    else                                                            activeCaption = bodyText || hookText || ctaText;
  }

  // Resolve display lines
  const captionLines: string[][] =
    keepOriginalCaption
      ? []
      : activeCaption.trim().length > 0
      ? splitTextIntoLines(activeCaption)
      : groupWordsIntoLines(memeLayers).map((row) => row.map((w) => w.text));

  const nonMemeLayers = textLayers.filter((l) => !l.isMemeText);

  // ── 4. Font sizing ───────────────────────────────────────────────────────
  const GAP = 12;
  const DEFAULT_FONT_SIZE = 52;
  const MIN_FONT_SIZE = 18;

  const resolvedFontSize = placement
    ? fitFontSize(
        captionLines.length,
        placement.height - 40, // 20px padding top+bottom inside placement
        GAP,
        Math.min(DEFAULT_FONT_SIZE, placement.maxFontSize),
        MIN_FONT_SIZE,
      )
    : DEFAULT_FONT_SIZE;

  // ── 5. Animations ────────────────────────────────────────────────────────
  const opIn  = interpolate(frame, [0, 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opOut = interpolate(durationInFrames - frame, [0, 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = Math.min(opIn, opOut);
  const scaleIn = interpolate(frame, [0, 6], [0.95, 1.0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // ── 6. Render one line of words with colour accents ──────────────────────
  const renderLine = (words: string[], fontSize: number, lineIdx: number) => {
    return (
      <div
        key={lineIdx}
        style={{
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          gap: "10px",
          fontSize: `${fontSize}px`,
          fontWeight: 900,
          textTransform: "uppercase",
          textAlign: "center",
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
        }}
      >
        {words.map((word, wi) => {
          const clean = word.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "").toLowerCase();
          const { color, textShadow, scale } = wordColor(clean);
          return (
            <span
              key={wi}
              style={{ color, textShadow, transform: `scale(${scale})`, display: "inline-block" }}
            >
              {word}
            </span>
          );
        })}
      </div>
    );
  };

  const renderAllLines = (fontSize: number) =>
    captionLines.map((words, i) => renderLine(words, fontSize, i));

  // ── 7. Style-specific background layer ───────────────────────────────────
  //
  // Each style paints a different backdrop (or none) before rendering text.
  //
  // style1_outline        → no backdrop at all
  // style2_banner_replace → solid rectangle matching the detected banner color
  //                         (defaults to #000 for black banners, but could be white etc.)
  // style3_black_banner   → tight solid-black rectangle sized to text height only
  // style4_gradient       → linear gradient from transparent to rgba(0,0,0,0.65)

  const renderBackground = () => {
    if (!placement || keepOriginalCaption || captionLines.length === 0) return null;

    const { left, top, width, height } = placement;

    if (effectiveStyle === "style1_outline") return null;

    if (effectiveStyle === "style2_banner_replace") {
      // Paint the entire detected banner region with black (covers old text completely).
      // We use 2px vertical overpaint on each side to ensure no pixel of old text bleeds through.
      return (
        <div
          style={{
            position: "absolute",
            left: `${left}px`,
            top:  `${Math.max(0, top - 2)}px`,
            width: `${width}px`,
            height: `${height + 4}px`,
            backgroundColor: "#000000",
            zIndex: 2,
          }}
        />
      );
    }

    if (effectiveStyle === "style3_black_banner") {
      // Tight banner — height driven by actual text render height, not the full placement box.
      const textH = estimateCaptionHeight(captionLines.length, resolvedFontSize, GAP);
      const bannerH = Math.min(height, textH + 40); // 20px padding top+bottom
      const bannerT = top + Math.round((height - bannerH) / 2);
      return (
        <div
          style={{
            position: "absolute",
            left: `${left}px`,
            top:  `${bannerT}px`,
            width: `${width}px`,
            height: `${bannerH}px`,
            backgroundColor: "#000000",
            zIndex: 2,
          }}
        />
      );
    }

    if (effectiveStyle === "style4_gradient") {
      // Gradient scrim — transparent at the far edge, dark in the center.
      // Detects placement position: top → gradient goes top-to-bottom, bottom → bottom-to-top.
      const isTop = top < 1920 * 0.4;
      return (
        <div
          style={{
            position: "absolute",
            left: `${left}px`,
            top:  `${top}px`,
            width: `${width}px`,
            height: `${height}px`,
            background: isTop
              ? "linear-gradient(to bottom, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.55) 60%, transparent 100%)"
              : "linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.55) 60%, transparent 100%)",
            zIndex: 2,
          }}
        />
      );
    }

    return null;
  };

  // ── 8. Caption container ─────────────────────────────────────────────────
  //
  // Always centered horizontally and vertically within the placement box.
  // For style3_black_banner, vertically centered inside the tighter banner.

  const renderCaptionContainer = () => {
    if (captionLines.length === 0) return null;

    const sharedStyle: React.CSSProperties = {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: `${GAP}px`,
      transform: `scale(${scaleIn})`,
      opacity,
      zIndex: 10,
      padding: "0 20px",
    };

    if (placement) {
      const { left, width } = placement;
      let { top, height } = placement;

      // For style3_black_banner, match the tight banner region
      if (effectiveStyle === "style3_black_banner") {
        const textH = estimateCaptionHeight(captionLines.length, resolvedFontSize, GAP);
        const bannerH = Math.min(height, textH + 40);
        top  = top + Math.round((height - bannerH) / 2);
        height = bannerH;
      }

      return (
        <div
          style={{
            position: "absolute",
            left: `${left}px`,
            top:  `${top}px`,
            width: `${width}px`,
            height: `${height}px`,
            overflow: "hidden",
            ...sharedStyle,
          }}
        >
          {renderAllLines(resolvedFontSize)}
        </div>
      );
    }

    // P5 — lower-third default: no background, centered text
    return (
      <div
        style={{
          position: "absolute",
          bottom: "20%",
          left: "8%",
          right: "8%",
          ...sharedStyle,
        }}
      >
        {renderAllLines(DEFAULT_FONT_SIZE)}
      </div>
    );
  };

  // ── 9. Non-meme watermarks / handles ─────────────────────────────────────
  const renderWatermarks = () =>
    nonMemeLayers.map((layer, i) => {
      const delay = i * 2;
      const af = frame - delay;
      const sc = spring({ frame: af, fps, config: { damping: 14, mass: 0.5, stiffness: 120 } });
      const op = interpolate(af, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      return (
        <div
          key={`wm-${i}`}
          style={{
            position: "absolute",
            left:   `${layer.left}px`,
            top:    `${layer.top}px`,
            width:  `${layer.width}px`,
            height: `${layer.height}px`,
            display: "flex",
            alignItems: "center",
            fontSize: `${Math.max(12, Math.round(layer.height * 0.72))}px`,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            color: "#3B82F6",
            textShadow: "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 4px 10px rgba(0,0,0,0.7)",
            transform: `scale(${sc})`,
            opacity: op,
            zIndex: 3,
          }}
        >
          {layer.text}
        </div>
      );
    });

  // ── 10. Compose the frame ─────────────────────────────────────────────────
  return (
    <AbsoluteFill
      style={{ backgroundColor: "#000000", fontFamily, color: "#FFFFFF", overflow: "hidden" }}
    >
      {/* Background media */}
      {mediaType === "video" && mediaUrl ? (
        <Video
          src={resolveMediaSrc(mediaUrl)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          volume={1.0}
        />
      ) : (
        mediaUrl && (
          <Img
            src={resolveMediaSrc(mediaUrl)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )
      )}

      {/*
        ─────────────────────────────────────────────────────────
        STYLE RENDERING ORDER:
          1. Background layer (covers old text / adds scrim)
          2. Caption text (always centered in placement)
          3. Watermarks
        ─────────────────────────────────────────────────────────

        style1_outline       → skip step 1 entirely (no rectangle)
        style2_banner_replace→ solid rect = exact banner size (old text hidden)
        style3_black_banner  → tight solid rect = text height + 40px padding
        style4_gradient      → soft gradient scrim
      */}
      {renderBackground()}
      {renderCaptionContainer()}
      {renderWatermarks()}
    </AbsoluteFill>
  );
};
