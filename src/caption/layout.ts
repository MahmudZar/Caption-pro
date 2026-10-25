/**
 * Caption layout: wraps text into lines and places text and emoji tokens, in frame pixels.
 * The editor and the export both draw from this one layout, so they always match.
 *
 * Lines sit in bands of fontSize × lineHeight. The font box (ascent + descent) is centred in
 * its band like CSS does, and TikTok-style boxes are the bands themselves, widened by padX and,
 * at the ends of a group of lines, heightened by padY.
 */
import type { Caption, CaptionStyle } from "../state/types";

import { imageKeyFor, splitRuns } from "./emoji";

export const REFERENCE_WIDTH = 1080;
/** Emoji are drawn a bit larger than the font size, like on iOS. */
export const EMOJI_SCALE = 1.18;
const EMOJI_SIDE_BEARING = 0.04;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Measurer {
  width(text: string, font: string, letterSpacing: number): number;
  metrics(font: string): { ascent: number; descent: number };
}

export interface Token {
  kind: "text" | "emoji";
  text: string;
  /** Apple image key for emoji tokens (null → no Apple image; drawn as text). */
  key: string | null;
  x: number;
  width: number;
}

export interface Line {
  tokens: Token[];
  width: number;
  /** Left edge of the text. */
  x: number;
  /** Top of the line's band. */
  top: number;
}

export interface CaptionLayout {
  frameW: number;
  frameH: number;
  /** Frame px per reference px. */
  unit: number;
  font: string;
  fontPx: number;
  letterSpacingPx: number;
  ascent: number;
  descent: number;
  band: number;
  emojiSize: number;
  lines: Line[];
  /** One box per non-empty line (line mode) or one for the whole block. */
  boxes: Rect[];
  /** Box rects grouped into runs of touching lines (each run becomes one outline). */
  boxGroups: Rect[][];
  textRect: Rect;
  /** What a click can grab. */
  hitRect: Rect;
  /** Everything that gets painted, stroke and shadow included. */
  paintRect: Rect;
}

export function fontString(style: CaptionStyle, px: number): string {
  // Quoted family; generic fallback keeps metrics sane while a web font loads.
  return `${style.italic ? "italic " : ""}${style.fontWeight} ${px}px "${style.fontFamily}", sans-serif`;
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

export function graphemes(text: string): string[] {
  if (segmenter) return [...segmenter.segment(text)].map((s) => s.segment);
  return [...text];
}

interface Piece {
  text: string;
  space: boolean;
  width: number;
}

function union(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

export function layoutCaption(caption: Pick<Caption, "text" | "x" | "y" | "style">, frameW: number, frameH: number, measurer: Measurer): CaptionLayout {
  const style = caption.style;
  const unit = frameW / REFERENCE_WIDTH;
  const fontPx = Math.max(1, style.fontSize * unit);
  const font = fontString(style, fontPx);
  const letterSpacingPx = style.letterSpacing * unit;
  const { ascent, descent } = measurer.metrics(font);
  const band = fontPx * style.lineHeight;
  const emojiSize = fontPx * EMOJI_SCALE;
  const emojiAdvance = emojiSize + fontPx * EMOJI_SIDE_BEARING * 2;
  const maxWidth = Math.max(fontPx, style.maxWidth * frameW);

  const measureText = (text: string) => measurer.width(text, font, letterSpacingPx);
  const runWidth = (text: string): number =>
    splitRuns(text).reduce((sum, run) => sum + (run.kind === "emoji" ? (imageKeyFor(run.text) ? emojiAdvance : measureText(run.text)) : measureText(run.text)), 0);

  const text = style.uppercase ? caption.text.toLocaleUpperCase() : caption.text;
  const lineTexts: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    const raw: Piece[] = paragraph
      .split(/(\s+)/)
      .filter((part) => part.length > 0)
      .map((part) => ({ text: part, space: /^\s+$/.test(part), width: runWidth(part) }));
    // An emoji-only word stays with the word before it ("problem 😩" never leaves 😩 alone on a line),
    // unless the pair wouldn't fit on any line.
    const pieces: Piece[] = [];
    for (const piece of raw) {
      const prevSpace = pieces[pieces.length - 1];
      const prevWord = pieces[pieces.length - 2];
      const emojiOnly = !piece.space && splitRuns(piece.text).every((run) => run.kind === "emoji");
      if (emojiOnly && prevSpace?.space && prevWord && !prevWord.space && prevWord.width + prevSpace.width + piece.width <= maxWidth) {
        pieces.length -= 2;
        pieces.push({ text: prevWord.text + prevSpace.text + piece.text, space: false, width: prevWord.width + prevSpace.width + piece.width });
      } else pieces.push(piece);
    }
    let current = "";
    let currentWidth = 0;
    const flush = () => {
      lineTexts.push(current.trim());
      current = "";
      currentWidth = 0;
    };
    for (const piece of pieces) {
      if (piece.space) {
        if (current) {
          current += piece.text;
          currentWidth += piece.width;
        }
        continue;
      }
      if (current.trim() && currentWidth + piece.width > maxWidth) flush();
      if (piece.width <= maxWidth) {
        current += piece.text;
        currentWidth += piece.width;
        continue;
      }
      // A word longer than the whole line: break it between graphemes (an emoji never splits).
      for (const g of graphemes(piece.text)) {
        const w = runWidth(g);
        if (current.trim() && currentWidth + w > maxWidth) flush();
        current += g;
        currentWidth += w;
      }
    }
    flush();
  }
  // Text that is only whitespace has no lines.
  if (lineTexts.every((l) => l === "")) lineTexts.length = 0;

  // Tokens: neighbouring text is measured as one run (keeps kerning), emoji are their own token.
  const lines: Line[] = lineTexts.map((lineText) => {
    const tokens: Token[] = [];
    let x = 0;
    for (const run of splitRuns(lineText)) {
      const key = run.kind === "emoji" ? imageKeyFor(run.text) : null;
      if (run.kind === "emoji" && key) {
        tokens.push({ kind: "emoji", text: run.text, key, x: x + fontPx * EMOJI_SIDE_BEARING, width: emojiSize });
        x += emojiAdvance;
      } else {
        const last = tokens[tokens.length - 1];
        if (last && last.kind === "text") {
          last.text += run.text;
          last.width = measureText(last.text);
          x = last.x + last.width;
        } else {
          const width = measureText(run.text);
          tokens.push({ kind: "text", text: run.text, key: null, x, width });
          x += width;
        }
      }
    }
    // Canvas letter spacing also follows the last letter: don't count it in the line width.
    const width = Math.max(0, x - (tokens[tokens.length - 1]?.kind === "text" ? letterSpacingPx : 0));
    return { tokens, width, x: 0, top: 0 };
  });

  const blockWidth = lines.reduce((max, l) => Math.max(max, l.width), 0);
  const blockHeight = lines.length * band;
  const cx = caption.x * frameW;
  const cy = caption.y * frameH;
  const top = cy - blockHeight / 2;
  lines.forEach((line, i) => {
    line.top = top + i * band;
    line.x = style.align === "left" ? cx - blockWidth / 2 : style.align === "right" ? cx + blockWidth / 2 - line.width : cx - line.width / 2;
  });

  const padX = style.box.padX * unit;
  const padY = style.box.padY * unit;
  const boxes: Rect[] = [];
  const boxGroups: Rect[][] = [];
  if (style.box.enabled && lines.length) {
    if (style.box.mode === "block") {
      const nonEmpty = lines.filter((l) => l.width > 0);
      if (nonEmpty.length) {
        const left = Math.min(...nonEmpty.map((l) => l.x));
        const rect = { x: left - padX, y: top - padY, w: blockWidth + padX * 2, h: blockHeight + padY * 2 };
        boxes.push(rect);
        boxGroups.push([rect]);
      }
    } else {
      let group: Rect[] = [];
      lines.forEach((line, i) => {
        if (line.width <= 0) {
          if (group.length) boxGroups.push(group);
          group = [];
          return;
        }
        const startsGroup = i === 0 || lines[i - 1].width <= 0;
        const endsGroup = i === lines.length - 1 || lines[i + 1].width <= 0;
        const y = line.top - (startsGroup ? padY : 0);
        const h = band + (startsGroup ? padY : 0) + (endsGroup ? padY : 0);
        const rect = { x: line.x - padX, y, w: line.width + padX * 2, h };
        boxes.push(rect);
        group.push(rect);
      });
      if (group.length) boxGroups.push(group);
    }
  }

  const textRect = lines.length ? { x: Math.min(...lines.map((l) => l.x)), y: top, w: blockWidth, h: blockHeight } : { x: cx - fontPx, y: cy - band / 2, w: fontPx * 2, h: band };
  const hitRect = boxes.length ? union(boxes) : inflate(textRect, 8 * unit);
  let paintRect = union([...(boxes.length ? [union(boxes)] : []), textRect]);
  if (style.stroke.enabled) paintRect = inflate(paintRect, style.stroke.width * unit + 2);
  if (style.shadow.enabled) {
    const reach = (style.shadow.blur * 1.5 + Math.max(Math.abs(style.shadow.x), Math.abs(style.shadow.y))) * unit;
    paintRect = inflate(paintRect, reach + 2);
  }
  // Emoji are taller than the font box on tight line heights.
  paintRect = inflate(paintRect, Math.max(0, (emojiSize - band) / 2) + 2);

  return { frameW, frameH, unit, font, fontPx, letterSpacingPx, ascent, descent, band, emojiSize, lines, boxes, boxGroups, textRect, hitRect, paintRect };
}

/** Baseline of a line: the font box (ascent + descent) centred in the band. */
export function baselineOf(layout: CaptionLayout, line: Line): number {
  return line.top + (layout.band - (layout.ascent + layout.descent)) / 2 + layout.ascent;
}

// ---------------- browser measurer ----------------

let measureContext: OffscreenCanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
const metricCache = new Map<string, { ascent: number; descent: number }>();

function context(): OffscreenCanvasRenderingContext2D {
  measureContext ??= new OffscreenCanvas(4, 4).getContext("2d")!;
  return measureContext;
}

/** Measurements depend on loaded fonts: clear the caches when a font finishes loading. */
export function clearMeasureCache(): void {
  widthCache.clear();
  metricCache.clear();
}

export const canvasMeasurer: Measurer = {
  width(text, font, letterSpacing) {
    const key = `${font}|${letterSpacing}|${text}`;
    let width = widthCache.get(key);
    if (width === undefined) {
      const ctx = context();
      ctx.font = font;
      ctx.letterSpacing = `${letterSpacing}px`;
      width = ctx.measureText(text).width;
      if (widthCache.size > 20_000) widthCache.clear();
      widthCache.set(key, width);
    }
    return width;
  },
  metrics(font) {
    let metrics = metricCache.get(font);
    if (!metrics) {
      const ctx = context();
      ctx.font = font;
      ctx.letterSpacing = "0px";
      const m = ctx.measureText("Hg");
      metrics = { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
      metricCache.set(font, metrics);
    }
    return metrics;
  },
};
