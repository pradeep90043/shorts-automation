import sharp from 'sharp';
import { pipelineLogger } from '../utils/logger';

export interface Token {
  text: string;
  type: 'keyword' | 'string' | 'comment' | 'number' | 'default' | 'symbol';
}

const KEYWORDS_JAVA = /\b(class|public|private|protected|void|static|import|package|return|new|if|else|for|while|do|switch|case|break|continue|interface|extends|implements|throws|throw|try|catch|finally|this|super|final|volatile|transient|synchronized|instanceof|enum|abstract|default|native|strictfp|assert)\b/g;
const KEYWORDS_JS   = /\b(class|public|private|protected|void|static|import|export|package|return|new|if|else|for|while|do|switch|case|break|continue|const|let|var|function|async|await|def|from|lambda|try|except|catch|finally|throw|throws|type|interface|implements|extends|require|module)\b/g;

export class CodeRenderer {
  private static tokenize(line: string, isJava: boolean): Token[] {
    const tokens: Token[] = [];
    const trimmed = line.trim();

    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('#')
    ) {
      return [{ text: line, type: 'comment' }];
    }

    const keywords = isJava ? KEYWORDS_JAVA : KEYWORDS_JS;
    const stringRegex = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;
    const numberRegex = /\b(\d+(?:\.\d+)?)\b/g;
    const symbolRegex = /[{}()\[\];.,+\-*\/%=&|<>!?:~^@]/g;

    const items: { start: number; end: number; type: Token['type'] }[] = [];

    const overlaps = (s: number, e: number) =>
      items.some(i => (s >= i.start && s < i.end) || (e > i.start && e <= i.end));

    let m: RegExpExecArray | null;

    stringRegex.lastIndex = 0;
    while ((m = stringRegex.exec(line)) !== null) {
      items.push({ start: m.index, end: stringRegex.lastIndex, type: 'string' });
    }

    numberRegex.lastIndex = 0;
    while ((m = numberRegex.exec(line)) !== null) {
      if (!overlaps(m.index, numberRegex.lastIndex))
        items.push({ start: m.index, end: numberRegex.lastIndex, type: 'number' });
    }

    keywords.lastIndex = 0;
    while ((m = keywords.exec(line)) !== null) {
      if (!overlaps(m.index, keywords.lastIndex))
        items.push({ start: m.index, end: keywords.lastIndex, type: 'keyword' });
    }

    symbolRegex.lastIndex = 0;
    while ((m = symbolRegex.exec(line)) !== null) {
      if (!overlaps(m.index, symbolRegex.lastIndex))
        items.push({ start: m.index, end: symbolRegex.lastIndex, type: 'symbol' });
    }

    items.sort((a, b) => a.start - b.start);

    let pos = 0;
    for (const item of items) {
      if (item.start > pos)
        tokens.push({ text: line.substring(pos, item.start), type: 'default' });
      tokens.push({ text: line.substring(item.start, item.end), type: item.type });
      pos = item.end;
    }
    if (pos < line.length)
      tokens.push({ text: line.substring(pos), type: 'default' });

    return tokens;
  }

  private static escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/ /g, '&#160;');
  }

  public async renderCodeToImage(
    ocrText: string,
    outputPath: string,
    isJava = false
  ): Promise<string> {
    pipelineLogger.info('Rendering syntax-highlighted code card...', 'CodeRenderer');

    const lines = ocrText
      .split('\n')
      .map(l => l.trimEnd())
      .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
      .slice(0, 28);

    if (lines.length === 0) throw new Error('No code text to render.');

    const CARD_WIDTH  = 1040;
    const HEADER_H    = 74;
    const FOOTER_PAD  = 28;

    // Adaptive line height: fill ~75% of the expanded code zone (1500px).
    // Target card body height ≈ 1048px; line height clamped 48–110px.
    const TARGET_BODY_H = Math.round(1500 * 0.75) - HEADER_H - FOOTER_PAD; // ~1048px
    const rawLineH = Math.round(TARGET_BODY_H / lines.length);
    const LINE_H = Math.min(110, Math.max(48, rawLineH));

    // Font size: 24–40px (keeps code highly readable and bold)
    const FONT_SIZE = Math.min(40, Math.max(24, Math.round(LINE_H * 0.55)));

    const LINE_NO_W = 58;
    const CODE_X    = LINE_NO_W + 16;

    const cardHeight = HEADER_H + lines.length * LINE_H + FOOTER_PAD;

    const colors = {
      bg:       '#0D0D0D',
      headerBg: '#070707',
      border:   '#221E14',
      keyword:  '#FFB800',
      string:   '#FFFFFF',
      comment:  '#7C7C7C',
      number:   '#FF8A00',
      symbol:   '#FFD700',
      text:     '#E5E5E5',
      lineNo:   '#555555',
      dot1:     '#FF5F56',
      dot2:     '#FFBD2E',
      dot3:     '#27C93F',
      badge:    '#141414',
    };

    const lang      = isJava ? 'Java' : 'JavaScript';
    const filename  = isJava ? 'Main.java' : 'app.js';
    const langColor = isJava ? '#F89820' : '#F7DF1E';

    let codeRows = '';
    lines.forEach((line, idx) => {
      const y = HEADER_H + idx * LINE_H + FONT_SIZE + 4;
      const tokens = CodeRenderer.tokenize(line, isJava);

      // Row highlight on even lines (very subtle)
      if (idx % 2 === 0) {
        codeRows += `<rect x="0" y="${HEADER_H + idx * LINE_H}" width="${CARD_WIDTH}" height="${LINE_H}" fill="rgba(255,255,255,0.012)"/>\n`;
      }

      // Line number
      codeRows += `<text x="${LINE_NO_W - 6}" y="${y}" fill="${colors.lineNo}" font-family="'Courier New', Courier, monospace" font-size="${FONT_SIZE - 3}" text-anchor="end">${idx + 1}</text>\n`;

      // Thin vertical separator after line numbers
      codeRows += `<line x1="${LINE_NO_W + 4}" y1="${HEADER_H + idx * LINE_H}" x2="${LINE_NO_W + 4}" y2="${HEADER_H + (idx + 1) * LINE_H}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>\n`;

      // Code tokens
      codeRows += `<text x="${CODE_X}" y="${y}" font-family="'Courier New', Courier, monospace" font-size="${FONT_SIZE}" xml:space="preserve">`;
      for (const tok of tokens) {
        let fill = colors.text;
        if (tok.type === 'keyword') fill = colors.keyword;
        else if (tok.type === 'string')  fill = colors.string;
        else if (tok.type === 'comment') fill = colors.comment;
        else if (tok.type === 'number')  fill = colors.number;
        else if (tok.type === 'symbol')  fill = colors.symbol;
        codeRows += `<tspan fill="${fill}">${CodeRenderer.escapeXml(tok.text)}</tspan>`;
      }
      codeRows += `</text>\n`;
    });

    const svg = `<svg width="${CARD_WIDTH}" height="${cardHeight}" viewBox="0 0 ${CARD_WIDTH} ${cardHeight}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="roundedCard">
      <rect width="${CARD_WIDTH}" height="${cardHeight}" rx="14"/>
    </clipPath>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#0A0E17"/>
      <stop offset="100%" stop-color="#0D1320"/>
    </linearGradient>
    <filter id="softShadow" x="-2%" y="-2%" width="104%" height="104%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
  </defs>

  <!-- Card base -->
  <rect width="${CARD_WIDTH}" height="${cardHeight}" rx="14" fill="${colors.bg}" filter="url(#softShadow)"/>

  <!-- Header -->
  <rect width="${CARD_WIDTH}" height="${HEADER_H}" fill="url(#headerGrad)" clip-path="url(#roundedCard)"/>

  <!-- Header bottom divider -->
  <line x1="0" y1="${HEADER_H}" x2="${CARD_WIDTH}" y2="${HEADER_H}" stroke="${colors.border}" stroke-width="1.5"/>

  <!-- macOS traffic-light dots -->
  <circle cx="28" cy="${HEADER_H / 2}" r="8" fill="${colors.dot1}"/>
  <circle cx="52" cy="${HEADER_H / 2}" r="8" fill="${colors.dot2}"/>
  <circle cx="76" cy="${HEADER_H / 2}" r="8" fill="${colors.dot3}"/>

  <!-- Language badge -->
  <rect x="${CARD_WIDTH - 108}" y="${HEADER_H / 2 - 14}" width="88" height="28" rx="6" fill="${colors.badge}"/>
  <circle cx="${CARD_WIDTH - 98}" cy="${HEADER_H / 2}" r="5" fill="${langColor}"/>
  <text x="${CARD_WIDTH - 88}" y="${HEADER_H / 2 + 5}" fill="${langColor}" font-family="'Courier New', Courier, monospace" font-size="13" font-weight="bold">${lang}</text>

  <!-- Filename -->
  <text x="${CARD_WIDTH / 2}" y="${HEADER_H / 2 + 6}" fill="#8A8A8A" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14" font-weight="600" text-anchor="middle" letter-spacing="0.5">${filename}</text>

  <!-- Line number column background -->
  <rect x="0" y="${HEADER_H}" width="${LINE_NO_W + 6}" height="${lines.length * LINE_H + FOOTER_PAD}" fill="rgba(0,0,0,0.2)"/>

  <!-- Code rows -->
  ${codeRows}
</svg>`;

    await sharp(Buffer.from(svg)).png().toFile(outputPath);
    pipelineLogger.checkpoint('Code card rendered', true, `${lines.length} lines, ${cardHeight}px tall → ${outputPath}`);
    return outputPath;
  }
}
