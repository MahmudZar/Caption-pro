/**
 * Draws captions onto a 2D canvas in frame coordinates. The caller sets the transform: the
 * monitor scales frame px to screen px, the export draws at 1:1 on a frame-sized canvas.
 * shadowBlur/offset ignore the transform, so they're scaled here by `scale`.
 */
import type { Caption, CaptionStyle } from "../state/types";

import { emojiImage } from "./emoji";
import { baselineOf, canvasMeasurer, layoutCaption, type CaptionLayout } from "./layout";
import { stackedOutline, traceRoundedPolygon } from "./outline";

export function rgba(hex: string, alpha: number): string {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1] ?? "ffffff";
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawOptions {
  /** Device pixels per frame pixel (for shadows). */
  scale: number;
  /** Called when an emoji image isn't loaded yet (the editor redraws later; export preloads). */
  missingEmoji?: () => void;
}

function applyShadow(ctx: Ctx, style: CaptionStyle, layout: CaptionLayout, scale: number): void {
  const shadow = style.shadow;
  ctx.shadowColor = rgba(shadow.color, shadow.opacity);
  ctx.shadowBlur = shadow.blur * layout.unit * scale;
  ctx.shadowOffsetX = shadow.x * layout.unit * scale;
  ctx.shadowOffsetY = shadow.y * layout.unit * scale;
}

function clearShadow(ctx: Ctx): void {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

export function drawLayout(ctx: Ctx, layout: CaptionLayout, style: CaptionStyle, options: DrawOptions): void {
  ctx.save();
  clearShadow(ctx);
  // 1. Background: one rounded outline per group of touching lines.
  if (style.box.enabled && layout.boxGroups.length) {
    ctx.fillStyle = rgba(style.box.color, style.box.opacity);
    ctx.beginPath();
    for (const group of layout.boxGroups) traceRoundedPolygon(ctx, stackedOutline(group), style.box.radius * layout.unit);
    ctx.fill();
  }

  ctx.font = layout.font;
  ctx.letterSpacing = `${layout.letterSpacingPx}px`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fontKerning = "normal";
  const fill = rgba(style.color, style.opacity);
  const strokeWidth = style.stroke.enabled ? style.stroke.width * layout.unit : 0;

  // 2. Stroke under the fill (the outline grows outward only), carrying the shadow if any.
  if (strokeWidth > 0) {
    if (style.shadow.enabled) applyShadow(ctx, style, layout, options.scale);
    ctx.strokeStyle = rgba(style.stroke.color, style.opacity);
    ctx.lineWidth = strokeWidth * 2;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    for (const line of layout.lines) {
      const baseline = baselineOf(layout, line);
      for (const token of line.tokens) if (token.kind === "text") ctx.strokeText(token.text, line.x + token.x, baseline);
    }
    clearShadow(ctx);
  }

  // 3. Fill text and emoji.
  if (style.shadow.enabled && strokeWidth === 0) applyShadow(ctx, style, layout, options.scale);
  ctx.fillStyle = fill;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  for (const line of layout.lines) {
    const baseline = baselineOf(layout, line);
    const centre = line.top + layout.band / 2;
    for (const token of line.tokens) {
      if (token.kind === "text") {
        ctx.fillText(token.text, line.x + token.x, baseline);
        continue;
      }
      const image = token.key ? emojiImage(token.key) : null;
      if (!image) {
        options.missingEmoji?.();
        continue;
      }
      const size = layout.emojiSize;
      ctx.globalAlpha = style.opacity;
      ctx.drawImage(image, line.x + token.x, centre - size / 2, size, size);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

/** Layouts are cached per caption; the key covers everything that changes the result. */
const cache = new Map<string, { key: string; layout: CaptionLayout }>();

export function layoutFor(caption: Caption, frameW: number, frameH: number, epoch: number): CaptionLayout {
  const key = `${epoch}|${frameW}x${frameH}|${caption.x}|${caption.y}|${caption.text}|${JSON.stringify(caption.style)}`;
  const hit = cache.get(caption.id);
  if (hit && hit.key === key) return hit.layout;
  const layout = layoutCaption(caption, frameW, frameH, canvasMeasurer);
  cache.set(caption.id, { key, layout });
  if (cache.size > 2000) cache.clear();
  return layout;
}

export function drawCaption(ctx: Ctx, caption: Caption, frameW: number, frameH: number, epoch: number, options: DrawOptions): CaptionLayout {
  const layout = layoutFor(caption, frameW, frameH, epoch);
  drawLayout(ctx, layout, caption.style, options);
  return layout;
}
