/** Timeline layout: rows, time ↔ x, hit testing, ruler steps, snapping. */
import { captionTrackCount, clipEnd, itemEnd } from "../model/edit";
import { EPS, fpsOf, type Rate } from "../model/time";
import type { Project, TimelineItem } from "../state/types";

export const RULER_H = 28;
export const CAPTION_H = 30;
export const VIDEO_H = 46;
export const AUDIO_MIN_H = 72;
export const AUDIO_MAX_H = 220;
export const SECTION_GAP = 6;
export const EDGE_PX = 7;
export const SNAP_PX = 9;

export type RowKind = "ruler" | "caption" | "video" | "audio";

export interface Row {
  kind: RowKind;
  /** Caption track index (caption rows only). */
  track: number;
  /** Top in canvas px, vertical scroll already applied (the ruler never scrolls). */
  y: number;
  h: number;
}

export interface Rows {
  rows: Row[];
  /** Height of the scrollable track content. */
  contentHeight: number;
  maxScrollY: number;
}

/** Shown caption tracks: every used one plus an empty one on top to drop into (at least 2). */
export function visibleCaptionTracks(project: Project): number {
  return Math.max(2, captionTrackCount(project) + 1);
}

export function computeRows(height: number, captionTracks: number, scrollY: number): Rows {
  const fixed = captionTracks * CAPTION_H + SECTION_GAP + VIDEO_H;
  const available = height - RULER_H - fixed;
  // The waveform takes the space that's left: large when the panel is tall.
  const audioH = Math.max(AUDIO_MIN_H, Math.min(AUDIO_MAX_H, available));
  const contentHeight = fixed + audioH;
  const maxScrollY = Math.max(0, contentHeight - (height - RULER_H));
  const sy = Math.min(maxScrollY, Math.max(0, scrollY));
  const rows: Row[] = [{ kind: "ruler", track: -1, y: 0, h: RULER_H }];
  let y = RULER_H - sy;
  for (let track = captionTracks - 1; track >= 0; track -= 1) {
    rows.push({ kind: "caption", track, y, h: CAPTION_H });
    y += CAPTION_H;
  }
  y += SECTION_GAP;
  rows.push({ kind: "video", track: -1, y, h: VIDEO_H });
  y += VIDEO_H;
  rows.push({ kind: "audio", track: -1, y, h: audioH });
  return { rows, contentHeight, maxScrollY };
}

export function rowAt(rows: Row[], y: number): Row | null {
  if (y < RULER_H) return rows[0];
  for (const row of rows) if (row.kind !== "ruler" && y >= row.y && y < row.y + row.h) return row;
  return null;
}

/** Caption track under a y, clamped to the caption rows (dragging below them means track 0). */
export function captionTrackAt(rows: Row[], y: number): number {
  const captionRows = rows.filter((r) => r.kind === "caption");
  if (!captionRows.length) return 0;
  const top = captionRows[0];
  if (y < top.y) return top.track;
  for (const row of captionRows) if (y >= row.y && y < row.y + row.h) return row.track;
  return 0;
}

export interface Hit {
  row: Row | null;
  item: TimelineItem | null;
  edge: "start" | "end" | null;
}

export function hitTest(project: Project, rows: Row[], x: number, y: number, zoom: number, scroll: number): Hit {
  const row = rowAt(rows, y);
  if (!row || row.kind === "ruler") return { row, item: null, edge: null };
  const time = x / zoom + scroll;
  const candidates: TimelineItem[] = row.kind === "caption" ? project.captions.filter((c) => c.track === row.track) : project.clips;
  for (const item of candidates) {
    const x0 = (item.start - scroll) * zoom;
    const x1 = (itemEnd(item) - scroll) * zoom;
    if (x < x0 - 3 || x > x1 + 3) continue;
    const width = x1 - x0;
    // On short clips the edges get a smaller grab zone so the middle stays movable.
    const edgeZone = Math.min(EDGE_PX, Math.max(3, width / 4));
    if (x - x0 <= edgeZone) return { row, item, edge: "start" };
    if (x1 - x <= edgeZone) return { row, item, edge: "end" };
    if (time >= item.start - EPS && time <= itemEnd(item) + EPS) return { row, item, edge: null };
  }
  return { row, item: null, edge: null };
}

/** Ruler tick spacing: labels at least ~76 px apart, in frames when zoomed in. */
export function rulerStep(zoom: number, rate: Rate | null): { major: number; minor: number; frames: boolean } {
  const fps = fpsOf(rate);
  const frame = 1 / fps;
  const frameSteps = [1, 2, 5, 10, 15].map((n) => n * frame);
  const secondSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const step of frameSteps) {
    if (step * zoom >= 76 && step < 1) return { major: step, minor: frame * zoom >= 5 ? frame : step, frames: true };
  }
  for (const step of secondSteps) {
    if (step * zoom >= 76) {
      const minor = step === 1 ? (zoom * frame * 5 >= 6 ? frame * 5 : 0.5) : step / 5;
      return { major: step, minor, frames: false };
    }
  }
  return { major: 3600, minor: 600, frames: false };
}

/** Snap points: 0, the playhead and every item edge (minus the items being dragged). */
export function snapPoints(project: Project, playhead: number, exclude: ReadonlySet<string>): number[] {
  const points = [0, playhead];
  for (const clip of project.clips) if (!exclude.has(clip.id)) points.push(clip.start, clipEnd(clip));
  for (const caption of project.captions) if (!exclude.has(caption.id)) points.push(caption.start, caption.end);
  return points;
}

/** Nearest snap point within `threshold` seconds, else null. */
export function nearestSnap(points: number[], time: number, threshold: number): number | null {
  let best: number | null = null;
  let distance = threshold;
  for (const p of points) {
    const d = Math.abs(p - time);
    if (d <= distance) {
      distance = d;
      best = p;
    }
  }
  return best;
}
