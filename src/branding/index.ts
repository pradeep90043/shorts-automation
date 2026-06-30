import sharp from "sharp";
import path from "path";
import fs from "fs";
import { IBrandingService } from "../types";
import { config } from "../config";
import { pipelineLogger } from "../utils/logger";
import { TOP_RESERVED, BOTTOM_RESERVED } from "../layout";

const CANVAS_W = 1080;
const CANVAS_H = 1920;

export class BrandingService implements IBrandingService {
  public async applyCodeOrCapBranding(
    layoutImagePath: string,
    outputPath: string,
  ): Promise<string> {
    pipelineLogger.info(
      `Applying CodeOrCap branding to ${layoutImagePath}`,
      "BrandingService",
    );

    const logoPath = path.join(config.paths.assetsDir, "logo.png");
    if (!fs.existsSync(logoPath)) {
      throw new Error(`Branding logo not found at ${logoPath}.`);
    }

    const composites: sharp.OverlayOptions[] = [];

    // ── Header SVG (top zone = TOP_RESERVED = 160px) ─────────────────────────
    const headerSvg = `<svg width="${CANVAS_W}" height="${TOP_RESERVED}" viewBox="0 0 ${CANVAS_W} ${TOP_RESERVED}" xmlns="http://www.w3.org/2000/svg">
      <!-- Outer badge boundary -->
      <path d="M 360 60 L 390 20 L 690 20 L 720 60 L 690 100 L 390 100 Z" fill="#000000" stroke="#FFD700" stroke-width="2.5" opacity="0.95"/>
      <!-- Inner accent boundary -->
      <path d="M 368 60 L 395 25 L 685 25 L 712 60 L 685 95 L 395 95 Z" fill="none" stroke="#FFD700" stroke-width="1.2" opacity="0.45"/>
      
      <!-- Text inside badge -->
      <text x="540" y="72" font-family="-apple-system, BlinkMacSystemFont, Impact, Arial Black, sans-serif" font-size="36" font-weight="900" text-anchor="middle">
        <tspan fill="#FFD700">&lt; </tspan>
        <tspan fill="#FFD700">CODE </tspan>
        <tspan fill="#FFF">OR </tspan>
        <tspan fill="#FFD700">CAP </tspan>
        <tspan fill="#FFD700">&gt;</tspan>
      </text>

      <!-- Handle below badge: -> @codeorcap <- (safe ascii arrows to avoid tofu blocks) -->
      <text x="540" y="138" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="22" font-weight="700" fill="#AAA" text-anchor="middle" letter-spacing="2">
        <tspan fill="#FFD700">-&gt; </tspan>
        <tspan fill="#FFF">@codeorcap</tspan>
        <tspan fill="#FFD700"> &lt;-</tspan>
      </text>
    </svg>`;

    const headerBuf = await sharp(Buffer.from(headerSvg)).png().toBuffer();
    composites.push({ input: headerBuf, left: 0, top: 0 });

    // ── Footer (bottom zone = BOTTOM_RESERVED = 260px) ───────────────────────
    const footerY = CANVAS_H - BOTTOM_RESERVED;
    const footerSvg = `<svg width="${CANVAS_W}" height="${BOTTOM_RESERVED}" viewBox="0 0 ${CANVAS_W} ${BOTTOM_RESERVED}" xmlns="http://www.w3.org/2000/svg">
      <!-- Divider lines -->
      <line x1="60" y1="20" x2="1020" y2="20" stroke="#FFD700" stroke-width="2" opacity="0.9"/>
      <line x1="100" y1="26" x2="980" y2="26" stroke="#FFD700" stroke-width="1.2" opacity="0.4" />

      <!-- Left section (Lightbulb + text) -->
      <g transform="translate(100, 45) scale(1.15)" stroke="#FFD700" stroke-width="2" fill="none">
        <path d="M 9 21 L 15 21 M 10 24 L 14 24" stroke-linecap="round"/>
        <path d="M 12 3 C 7.5 3 4 6.5 4 11 C 4 13.5 5.5 15.5 7 17 C 8 18 9 19 9 20 L 15 20 C 15 19 16 18 17 17 C 18.5 15.5 20 13.5 20 11 C 20 6.5 16.5 3 12 3 Z"/>
      </g>
      <text x="145" y="62" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="15" font-weight="600" fill="#DDD">
        <tspan x="145" dy="0">The future of tech isn't just about coding -</tspan>
        <tspan x="145" dy="22">it's about solving problems.</tspan>
      </text>

      <!-- Middle section (Circular logo) -->
      <circle cx="540" cy="85" r="48" fill="#000000" stroke="#FFD700" stroke-width="3" />
      <circle cx="540" cy="85" r="42" fill="none" stroke="#FFD700" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>
      <text x="540" y="72" font-family="-apple-system, BlinkMacSystemFont, Impact, Arial Black, sans-serif" font-size="16" font-weight="900" fill="#FFD700" text-anchor="middle">CODE</text>
      <text x="540" y="89" font-family="-apple-system, BlinkMacSystemFont, Impact, Arial Black, sans-serif" font-size="12" font-weight="900" fill="#FFF" text-anchor="middle">OR</text>
      <text x="540" y="106" font-family="-apple-system, BlinkMacSystemFont, Impact, Arial Black, sans-serif" font-size="16" font-weight="900" fill="#FFD700" text-anchor="middle">CAP</text>

      <!-- Right section (Star + text) -->
      <g transform="translate(715, 52) scale(1.15)" fill="#FFD700" stroke="#FFD700" stroke-width="1">
        <path d="M12 .587l3.668 7.431 8.2 1.192-5.934 5.787 1.4 8.168L12 18.896l-7.334 3.857 1.4-8.168L.132 9.21l8.2-1.192L12 .587z"/>
      </g>
      <text x="750" y="72" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="16" font-weight="700" fill="#DDD">
        <tspan fill="#DDD">Skill today, </tspan>
        <tspan fill="#FFD700">earn tomorrow.</tspan>
      </text>

      <!-- Bottom socials -->
      <!-- YouTube -->
      <g transform="translate(320, 165) scale(1.1)">
        <path d="M23.498 6.163a3.003 3.003 0 0 0-2.11-2.107C19.522 3.543 12 3.543 12 3.543s-7.522 0-9.388.513a3.003 3.003 0 0 0-2.11 2.107C0 8.029 0 12 0 12s0 3.971.502 5.837a3.003 3.003 0 0 0 2.11 2.107c1.866.513 9.388.513 9.388.513s7.522 0 9.388-.513a3.003 3.003 0 0 0 2.11-2.107C24 15.971 24 12 24 12s0-3.971-.502-5.837z" fill="#FF0000"/>
        <polygon points="9.545 15.568 15.818 12 9.545 8.432" fill="#FFFFFF"/>
      </g>
      <text x="358" y="181" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="18" font-weight="700" fill="#FFF">/codeorcap</text>

      <!-- Instagram -->
      <g transform="translate(580, 165) scale(1.1)">
        <rect x="1" y="1" width="22" height="22" rx="6" stroke="#FFD700" stroke-width="2" fill="none"/>
        <circle cx="12" cy="12" r="5" stroke="#FFD700" stroke-width="2" fill="none"/>
        <circle cx="18" cy="6" r="1.5" fill="#FFD700"/>
      </g>
      <text x="618" y="181" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="18" font-weight="700" fill="#FFF">@codeorcap</text>
    </svg>`;

    const footerBuf = await sharp(Buffer.from(footerSvg)).png().toBuffer();
    composites.push({ input: footerBuf, left: 0, top: footerY });

    // ── Composite all layers onto the layout image ────────────────────────────
    await sharp(layoutImagePath).composite(composites).toFile(outputPath);

    pipelineLogger.checkpoint(
      "Branding applied",
      true,
      `Header at top, footer at y:${footerY} → ${outputPath}`,
    );
    return outputPath;
  }
}
