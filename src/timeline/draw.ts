/**
 * Canvas drawing for the timeline. Two layers: the base (ruler, tracks, clips, waveform) redraws
 * only when the project, the view or the hover state changes; the overlay (playhead, razor line,
 * snap line, marquee) is tiny and redraws as often as needed, so playback costs almost nothing.
 * Only what is inside the visible time range gets drawn.
 */
import { emojiImage, imageKeyFor, splitRuns } from "../caption/emoji";
import { clipEnd, videoEnd } from "../model/edit";
import { rulerLabel, type Rate } from "../model/time";
import type { MediaRef, Project } from "../state/types";

import { RULER_H, rulerStep, type Row } from "./geometry";
import { pyramidFor } from "./waveform";

export interface Palette {
  bg: string;
  rowA: string;
  rowB: string;
  ruler: string;
  line: string;
  lineStrong: string;
  text: string;
  textMuted: string;
  caption: string;
  captionSelected: string;
  captionText: string;
  video: string;
  videoSelected: string;
  audio: string;
  audioSelected: string;
  wave: string;
  playhead: string;
  razor: string;
  snap: string;
  white: string;
  beyond: string;
  marquee: string;
}

export function readPalette(element: Element): Palette {
  const css = getComputedStyle(element);
  const v = (name: string) => css.getPropertyValue(name).trim() || "#888";
  return {
    bg: v("--dark-surface-1"),
    rowA: v("--dark-surface-1"),
    rowB: v("--dark-surface-2"),
    ruler: v("--dark-surface-2"),
    line: v("--dark-border-subtle"),
    lineStrong: v("--dark-border-strong"),
    text: v("--dark-text-primary"),
    textMuted: v("--dark-text-muted"),
    caption: v("--primary-700"),
    captionSelected: v("--primary-500"),
    captionText: v("--primary-50"),
    video: v("--info-800"),
    videoSelected: v("--info-600"),
    audio: v("--success-900"),
    audioSelected: v("--success-800"),
    wave: v("--success-300"),
    playhead: v("--primary-300"),
    razor: v("--error-400"),
    snap: v("--warning-400"),
    white: "#ffffff",
    beyond: "rgba(0, 0, 0, 0.32)",
    marquee: v("--primary-400"),
  };
}

export interface BaseInput {
  project: Project;
  rows: Row[];
  width: number;
  height: number;
  zoom: number;
  scroll: number;
  selection: ReadonlySet<string>;
  hover: { id: string; edge: "start" | "end" | null } | null;
  peaks: Record<string, Float32Array | null>;
  peakState: Record<string, string | undefined>;
  dpr: number;
}

const UI_FONT = '500 11px Inter, "Segoe UI", sans-serif';

function captionLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, color: string): void {
  // Same Apple emoji as the captions themselves.
  let cursor = x;
  const limit = x + maxWidth;
  ctx.fillStyle = color;
  for (const run of splitRuns(text.replace(/\s+/g, " "))) {
    if (cursor >= limit) break;
    const key = run.kind === "emoji" ? imageKeyFor(run.text) : null;
    if (key) {
      const image = emojiImage(key);
      if (image && cursor + 13 <= limit) ctx.drawImage(image, cursor, y - 10, 13, 13);
      cursor += 15;
      continue;
    }
    const width = ctx.measureText(run.text).width;
    if (cursor + width <= limit) {
      ctx.fillText(run.text, cursor, y);
      cursor += width;
    } else {
      // Ellipsis inside the clip.
      let shown = run.text;
      while (shown.length && cursor + ctx.measureText(`${shown}…`).width > limit) shown = shown.slice(0, -1);
      if (shown) ctx.fillText(`${shown}…`, cursor, y);
      break;
    }
  }
}

export function drawBase(ctx: CanvasRenderingContext2D, input: BaseInput, palette: Palette): void {
  const { project, rows, width, height, zoom, scroll, selection, hover, dpr } = input;
  const rate: Rate | null = project.sequence;
  const tStart = scroll;
  const tEnd = scroll + width / zoom;
  const x = (t: number) => (t - scroll) * zoom;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);

  // Track rows (clipped below the ruler so scrolled rows slide under it).
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_H, width, height - RULER_H);
  ctx.clip();
  for (const row of rows) {
    if (row.kind === "ruler") continue;
    ctx.fillStyle = row.kind === "caption" && row.track % 2 ? palette.rowB : palette.rowA;
    if (row.kind === "audio") ctx.fillStyle = palette.rowB;
    ctx.fillRect(0, row.y, width, row.h);
    ctx.fillStyle = palette.line;
    ctx.fillRect(0, row.y + row.h - 1, width, 1);
  }

  ctx.font = UI_FONT;
  ctx.textBaseline = "alphabetic";
  const radius = 4;

  // Captions.
  for (const row of rows) {
    if (row.kind !== "caption") continue;
    for (const caption of project.captions) {
      if (caption.track !== row.track || caption.end < tStart || caption.start > tEnd) continue;
      const x0 = x(caption.start);
      const w = Math.max(2, x(caption.end) - x0);
      const selected = selection.has(caption.id);
      ctx.fillStyle = selected ? palette.captionSelected : palette.caption;
      ctx.beginPath();
      ctx.roundRect(x0 + 0.5, row.y + 3, w - 1, row.h - 6, radius);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = palette.white;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (hover?.id === caption.id && hover.edge) {
        ctx.fillStyle = palette.white;
        ctx.fillRect(hover.edge === "start" ? x0 + 1 : x0 + w - 4, row.y + 5, 3, row.h - 10);
      }
      if (w > 18) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 6, row.y, w - 12, row.h);
        ctx.clip();
        captionLabel(ctx, caption.text || "(empty)", Math.max(x0 + 6, Math.min(6, x0 + w - 40)), row.y + row.h / 2 + 4, w - 12, palette.captionText);
        ctx.restore();
      }
    }
  }

  // Video + linked audio.
  const video = rows.find((r) => r.kind === "video");
  const audio = rows.find((r) => r.kind === "audio");
  const mediaById = new Map<string, MediaRef>(project.media.map((m) => [m.id, m]));
  for (const clip of project.clips) {
    const end = clipEnd(clip);
    if (end < tStart || clip.start > tEnd) continue;
    const x0 = x(clip.start);
    const w = Math.max(2, x(end) - x0);
    const selected = selection.has(clip.id);
    const media = mediaById.get(clip.mediaId);
    if (video) {
      ctx.fillStyle = selected ? palette.videoSelected : palette.video;
      ctx.beginPath();
      ctx.roundRect(x0 + 0.5, video.y + 3, w - 1, video.h - 6, radius);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = palette.white;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (hover?.id === clip.id && hover.edge) {
        ctx.fillStyle = palette.white;
        ctx.fillRect(hover.edge === "start" ? x0 + 1 : x0 + w - 4, video.y + 6, 3, video.h - 12);
      }
      if (w > 24) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 6, video.y, w - 12, video.h);
        ctx.clip();
        ctx.fillStyle = palette.text;
        ctx.fillText(media?.name ?? "Missing media", Math.max(x0 + 8, 8), video.y + 19);
        ctx.fillStyle = palette.textMuted;
        ctx.fillText(`${(clip.srcOut - clip.srcIn).toFixed(2)}s`, Math.max(x0 + 8, 8), video.y + 34);
        ctx.restore();
      }
    }
    if (audio && media?.info.audio) {
      ctx.fillStyle = selected ? palette.audioSelected : palette.audio;
      ctx.beginPath();
      ctx.roundRect(x0 + 0.5, audio.y + 3, w - 1, audio.h - 6, radius);
      ctx.fill();
      const peaks = input.peaks[clip.mediaId];
      const mid = audio.y + audio.h / 2;
      const half = audio.h / 2 - 6;
      if (peaks) {
        const pyramid = pyramidFor(peaks);
        ctx.fillStyle = palette.wave;
        const from = Math.max(0, Math.floor(x0 * dpr));
        const to = Math.min(Math.ceil(width * dpr), Math.ceil((x0 + w) * dpr));
        const step = 1 / (zoom * dpr);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (let px = from; px < to; px += 1) {
          const t = px / dpr / zoom + scroll;
          const source = clip.srcIn + (t - clip.start);
          const peak = pyramid.maxBetween(source, source + step);
          const amp = Math.min(1, peak ** 0.75);
          const h = Math.max(0.5, amp * half) * dpr;
          ctx.fillRect(px, mid * dpr - h, 1, h * 2);
        }
        ctx.restore();
      } else {
        ctx.fillStyle = palette.textMuted;
        const state = input.peakState[clip.mediaId];
        if (w > 90) ctx.fillText(state === "error" ? "Couldn't read the audio" : "Reading audio…", Math.max(x0 + 8, 8), mid + 4);
      }
    }
  }
  if (audio && project.clips.length && !project.clips.some((c) => mediaById.get(c.mediaId)?.info.audio)) {
    ctx.fillStyle = palette.textMuted;
    ctx.fillText("No audio in this video", 10, audio.y + audio.h / 2 + 4);
  }

  // Past the end of the video: not exported.
  const end = videoEnd(project);
  if (project.clips.length && end < tEnd) {
    ctx.fillStyle = palette.beyond;
    ctx.fillRect(Math.max(0, x(end)), RULER_H, width, height - RULER_H);
  }
  ctx.restore();

  // Ruler.
  ctx.fillStyle = palette.ruler;
  ctx.fillRect(0, 0, width, RULER_H);
  ctx.fillStyle = palette.line;
  ctx.fillRect(0, RULER_H - 1, width, 1);
  const { major, minor, frames } = rulerStep(zoom, rate);
  ctx.fillStyle = palette.lineStrong;
  if (minor * zoom >= 4) {
    const first = Math.floor(tStart / minor);
    for (let i = first; i * minor <= tEnd; i += 1) {
      const px = Math.round(x(i * minor)) + 0.5;
      ctx.fillRect(px, RULER_H - 6, 1, 5);
    }
  }
  ctx.fillStyle = palette.textMuted;
  ctx.font = '500 10px Inter, "Segoe UI", sans-serif';
  const firstMajor = Math.floor(tStart / major);
  for (let i = firstMajor; i * major <= tEnd + major; i += 1) {
    const t = i * major;
    if (t < 0) continue;
    const px = Math.round(x(t)) + 0.5;
    ctx.fillStyle = palette.lineStrong;
    ctx.fillRect(px, RULER_H - 12, 1, 11);
    ctx.fillStyle = palette.textMuted;
    ctx.fillText(rulerLabel(t, rate, frames), px + 4, 12);
  }
  if (project.clips.length && end >= tStart && end <= tEnd) {
    ctx.fillStyle = palette.razor;
    ctx.fillRect(Math.round(x(end)), RULER_H - 4, 1, 4);
  }
}

export interface OverlayInput {
  width: number;
  height: number;
  zoom: number;
  scroll: number;
  time: number;
  dpr: number;
  razorTime: number | null;
  razorRow: Row | null;
  snapTime: number | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, input: OverlayInput, palette: Palette): void {
  const { width, height, zoom, scroll, time, dpr } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const x = (t: number) => Math.round((t - scroll) * zoom) + 0.5;
  if (input.snapTime !== null) {
    ctx.fillStyle = palette.snap;
    ctx.fillRect(x(input.snapTime) - 0.5, RULER_H, 1, height - RULER_H);
  }
  if (input.razorTime !== null) {
    ctx.fillStyle = palette.razor;
    const row = input.razorRow;
    const px = x(input.razorTime) - 0.5;
    if (row && row.kind !== "ruler") ctx.fillRect(px, row.y, 1.5, row.h);
    else ctx.fillRect(px, RULER_H, 1.5, height - RULER_H);
  }
  if (input.marquee) {
    const { x0, y0, x1, y1 } = input.marquee;
    ctx.fillStyle = "rgba(120, 160, 255, 0.12)";
    ctx.strokeStyle = palette.marquee;
    ctx.lineWidth = 1;
    const rx = Math.min(x0, x1);
    const ry = Math.min(y0, y1);
    ctx.fillRect(rx, ry, Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
  const px = x(time);
  if (px >= -8 && px <= width + 8) {
    ctx.fillStyle = palette.playhead;
    ctx.fillRect(px - 0.5, 4, 1, height - 4);
    ctx.beginPath();
    ctx.moveTo(px - 6, 2);
    ctx.lineTo(px + 6, 2);
    ctx.lineTo(px + 6, 12);
    ctx.lineTo(px, 18);
    ctx.lineTo(px - 6, 12);
    ctx.closePath();
    ctx.fill();
  }
}
