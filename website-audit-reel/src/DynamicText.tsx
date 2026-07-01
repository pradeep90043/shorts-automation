import { AbsoluteFill, Img, Video, useCurrentFrame, interpolate, spring, useVideoConfig, staticFile } from "remotion";
import React from "react";
import { loadFont } from "@remotion/google-fonts/Montserrat";

const { fontFamily } = loadFont("normal", {
  weights: ["800", "900"],
  subsets: ["latin"],
});

export interface TextLayer {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isMemeText?: boolean;
}

interface Props {
  mediaUrl?: string;
  mediaType?: "video" | "image";
  textLayers?: TextLayer[];
  memeCaption?: string;
  safeArea?: { x: number; y: number; width: number; height: number };
}

const splitTextIntoLines = (text: string, wordsPerLine = 4): TextLayer[][] => {
  const lines: TextLayer[][] = [];

  if (text.includes("//")) {
    const segments = text.split("//").map((s) => s.trim()).filter(Boolean);
    for (const segment of segments) {
      const segmentWords = segment.split(/\s+/).filter(Boolean);
      if (segmentWords.length > 0) {
        lines.push(
          segmentWords.map((word) => ({
            text: word,
            left: 0,
            top: 0,
            width: 0,
            height: 60,
          }))
        );
      }
    }
  } else {
    const words = text.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += wordsPerLine) {
      const chunk = words.slice(i, i + wordsPerLine);
      lines.push(
        chunk.map((word) => ({
          text: word,
          left: 0,
          top: 0,
          width: 0,
          height: 60,
        }))
      );
    }
  }
  return lines;
};

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

const groupWordsIntoLines = (words: TextLayer[]): TextLayer[][] => {
  const sorted = [...words].sort((a, b) => a.top - b.top);
  const lines: TextLayer[][] = [];

  for (const word of sorted) {
    let added = false;
    for (const line of lines) {
      const avgTop = line.reduce((sum, w) => sum + w.top, 0) / line.length;
      // Group words within 30px vertically
      if (Math.abs(word.top - avgTop) < 30) {
        line.push(word);
        added = true;
        break;
      }
    }
    if (!added) {
      lines.push([word]);
    }
  }

  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);
  }

  lines.sort((a, b) => {
    const aTop = a.reduce((sum, w) => sum + w.top, 0) / a.length;
    const bTop = b.reduce((sum, w) => sum + w.top, 0) / b.length;
    return aTop - bTop;
  });

  return lines;
};

export const DynamicTextComposition: React.FC<Props> = ({
  mediaUrl = "",
  mediaType = "video",
  textLayers = [],
  memeCaption = "",
  safeArea,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const safeAreaPx = safeArea
    ? {
        left: Math.round(safeArea.x * 1080),
        top: Math.round(safeArea.y * 1920),
        width: Math.round(safeArea.width * 1080),
        height: Math.round(safeArea.height * 1920),
      }
    : null;

  // Compute the combined bounding box of all top black bar meme text to cover it completely in one solid block
  const memeLayers = textLayers.filter((l) => l.isMemeText);
  let maskBox = null;
  if (memeLayers.length > 0) {
    const minTop = Math.min(...memeLayers.map((l) => l.top));
    const maxBottom = Math.max(...memeLayers.map((l) => l.top + l.height));

    // Pad the covering block slightly (8px vertical) for complete coverage and stretch full width
    maskBox = {
      left: 0,
      top: Math.max(0, minTop - 8),
      width: 1080,
      height: Math.min(1920, maxBottom - minTop + 16),
    };
  }

  // Parse HOOK, BODY, CTA segments for dynamic caption timing
  let hookText = "";
  let bodyText = "";
  let ctaText = "";

  const hookMatch = memeCaption.match(/\[HOOK\](.*?)(\[BODY\]|\[CTA\]|$)/is);
  const bodyMatch = memeCaption.match(/\[BODY\](.*?)(\[CTA\]|$)/is);
  const ctaMatch = memeCaption.match(/\[CTA\](.*?)$/is);

  if (hookMatch || bodyMatch || ctaMatch) {
    hookText = hookMatch ? hookMatch[1].trim() : "";
    bodyText = bodyMatch ? bodyMatch[1].trim() : "";
    ctaText = ctaMatch ? ctaMatch[1].trim() : "";
  }

  let activeCaption = memeCaption;
  if (hookText || bodyText || ctaText) {
    const hookDurationFrames = 3 * fps; // first 3s
    const ctaDurationFrames = 2 * fps; // last 2s
    const totalDurationFrames = durationInFrames;

    if (frame < hookDurationFrames && hookText) {
      activeCaption = hookText;
    } else if (frame >= totalDurationFrames - ctaDurationFrames && ctaText) {
      activeCaption = ctaText;
    } else {
      activeCaption = bodyText || hookText || ctaText;
    }
  }

  const memeLines = activeCaption.trim().length > 0
    ? splitTextIntoLines(activeCaption)
    : groupWordsIntoLines(memeLayers);
  const nonMemeLayers = textLayers.filter((l) => !l.isMemeText);

  // Global Caption Block Animation Rules (Netflix Documentary Hold Style)
  // FADE IN: 120ms is ~3.6 frames. Fade in over first 4 frames.
  const opacityIn = interpolate(frame, [0, 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // FADE OUT: 120ms is ~3.6 frames. Fade out over last 4 frames.
  const remainingFrames = durationInFrames - frame;
  const opacityOut = interpolate(remainingFrames, [0, 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const blockOpacity = Math.min(opacityIn, opacityOut);

  // SCALE: 95% -> 100% over the first 6 frames, then hold completely steady
  const blockScale = interpolate(frame, [0, 6], [0.95, 1.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const renderMemeText = () => {
    if (memeLines.length === 0) return null;

    return memeLines.map((line, lineIdx) => {
      const lineText = line.map((w) => w.text).join(" ");
      const avgHeight = line.reduce((sum, w) => sum + w.height, 0) / line.length;
      const fontSize = Math.max(14, Math.round(avgHeight * 0.72));

      // Special badge check for "Le ChatGPT:" matching original meme style
      const isBadge = lineText.toLowerCase().includes("le chatgpt");

      const words = lineText.split(" ");

      return (
        <div
          key={lineIdx}
          style={{
            display: "flex",
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "center",
            gap: "14px",
            fontSize: `${fontSize}px`,
            fontSizeAdjust: "none",
            fontWeight: 900,
            textTransform: "uppercase",
            textAlign: "center",
            letterSpacing: "-0.02em",
            color: isBadge ? "#000000" : "#FFFFFF",
            backgroundColor: isBadge ? "#FFFFFF" : "transparent",
            padding: isBadge ? "4px 14px" : "0",
            borderRadius: isBadge ? "6px" : "0",
            textShadow: isBadge
              ? "none"
              : "-2px -2px 0 #000000, 2px -2px 0 #000000, -2px 2px 0 #000000, 2px 2px 0 #000000, 0px 4px 10px rgba(0, 0, 0, 0.8)",
          }}
        >
          {isBadge ? (
            lineText
          ) : (
            words.map((word, wordIdx) => {
              const cleanWord = word.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "").toLowerCase();

              let color = "#FFFFFF";
              let textShadow = "-2px -2px 0 #000000, 2px -2px 0 #000000, -2px 2px 0 #000000, 2px 2px 0 #000000, 0px 4px 10px rgba(0, 0, 0, 0.8)";
              let wordScale = 1.0;

              const hasSub = (wordStr: string, roots: string[]) =>
                roots.some((root) => wordStr.includes(root));

              const isAi = hasSub(cleanWord, ["chatgpt", "gemini", "claude", "grok", "ai", "copilot", "llm", "openai"]);
              const isNumber = /\d/.test(cleanWord) || hasSub(cleanWord, ["million", "billion", "thousand", "10x"]);

              const isOrange = hasSub(cleanWord, [
                "develop", "nowaday", "project", "code", "program", "dev", 
                "software", "engineer", "build", "bharose", "utha", "leta",
                "git", "python", "java", "script", "rust", "c++", "rely",
                "autom", "syst", "install", "server", "cloud", "data"
              ]);

              const isPositive = hasSub(cleanWord, ["succ", "win", "grow", "prof", "rich", "love", "perf", "good", "nice", "happy", "funny", "laugh"]);
              const isNegative = hasSub(cleanWord, ["fail", "prank", "unemploy", "loss", "dang", "err", "bad", "wrong", "crash", "break", "broken", "destr", "chaos", "over"]);

              if (isAi || isNumber) {
                color = "#FFB800"; // Neon Yellow Accent
                textShadow = "0 0 10px rgba(255, 184, 0, 0.6), -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000";
                wordScale = 1.05;
              } else if (isOrange) {
                color = "#FF8A00"; // Orange Emphasis
                textShadow = "0 0 10px rgba(255, 138, 0, 0.5), -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000";
              } else if (isPositive) {
                color = "#22C55E"; // Success Green
                textShadow = "0 0 10px rgba(34, 197, 94, 0.5), -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000";
              } else if (isNegative) {
                color = "#FF3B30"; // Warning Red
                textShadow = "0 0 10px rgba(255, 59, 48, 0.5), -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000";
              }

              return (
                <span
                  key={wordIdx}
                  style={{
                    color,
                    textShadow,
                    transform: `scale(${wordScale})`,
                    display: "inline-block",
                  }}
                >
                  {word}
                </span>
              );
            })
          )}
        </div>
      );
    });
  };

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#000000",
        fontFamily,
        color: "#FFFFFF",
        overflow: "hidden",
      }}
    >
      {/* 1. Background Media */}
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

      {/* 2. Combined Background Mask to wipe out original text block completely */}
      {maskBox && (
        <div
          style={{
            position: "absolute",
            left: `${maskBox.left}px`,
            top: `${maskBox.top}px`,
            width: `${maskBox.width}px`,
            height: `${maskBox.height}px`,
            backgroundColor: "#000000",
            zIndex: 1,
          }}
        />
      )}

      {/* 3. Cyberpunk Netflix-Style Meme Caption Block */}
      {maskBox ? (
        /* If original text was at the top, render our typeset captions in the top safe area */
        <div
          style={{
            position: "absolute",
            left: `${maskBox.left}px`,
            top: `${maskBox.top}px`,
            width: `${maskBox.width}px`,
            height: `${maskBox.height}px`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "14px",
            transform: `scale(${blockScale})`,
            opacity: blockOpacity,
            zIndex: 10,
          }}
        >
          {renderMemeText()}
        </div>
      ) : safeAreaPx ? (
        /* If AI-detected safe area is provided, render inside it to avoid covering faces/UI */
        memeLines.length > 0 && (
          <div
            style={{
              position: "absolute",
              left: `${safeAreaPx.left}px`,
              top: `${safeAreaPx.top}px`,
              width: `${safeAreaPx.width}px`,
              height: `${safeAreaPx.height}px`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "14px",
              transform: `scale(${blockScale})`,
              opacity: blockOpacity,
              zIndex: 10,
            }}
          >
            {renderMemeText()}
          </div>
        )
      ) : (
        /* Default fallback: center the captions in the lower third */
        memeLines.length > 0 && (
          <div
            style={{
              position: "absolute",
              bottom: "22%",
              left: "8%",
              right: "8%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "14px",
              transform: `scale(${blockScale})`,
              opacity: blockOpacity,
              zIndex: 10,
            }}
          >
            {renderMemeText()}
          </div>
        )
      )}

      {/* 4. Non-Meme Watermarks/Handles Overlay */}
      {nonMemeLayers.map((layer, index) => {
        const delay = index * 2;
        const animFrame = frame - delay;
        const scale = spring({
          frame: animFrame,
          fps,
          config: { damping: 14, mass: 0.5, stiffness: 120 },
        });
        const opacity = interpolate(animFrame, [0, 8], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        const fontSize = Math.max(12, Math.round(layer.height * 0.72));

        return (
          <div
            key={`non-meme-${index}`}
            style={{
              position: "absolute",
              left: `${layer.left}px`,
              top: `${layer.top}px`,
              width: `${layer.width}px`,
              height: `${layer.height}px`,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              fontSize: `${fontSize}px`,
              fontWeight: 800,
              letterSpacing: "-0.03em",
              color: "#3B82F6", // Branding blue
              textShadow: `
                -2px -2px 0 #000000,  
                 2px -2px 0 #000000,
                -2px  2px 0 #000000,
                 2px  2px 0 #000000,
                 0px  4px 10px rgba(0, 0, 0, 0.7)
              `,
              transform: `scale(${scale})`,
              opacity,
              zIndex: 3,
            }}
          >
            {layer.text}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
