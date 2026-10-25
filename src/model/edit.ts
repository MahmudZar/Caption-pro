/**
 * Pure editing operations on a project draft (the store clones before calling them). They hold
 * the timeline rules: one item at a time per track, clips at least one frame long, video clips
 * inside their source, cuts only strictly inside an item.
 */
import { newId } from "../state/ids";
import type { Caption, MediaRef, Project, TimelineItem, VideoClip } from "../state/types";

import { EPS, frameDuration, type Rate } from "./time";

export function clipEnd(clip: VideoClip): number {
  return clip.start + (clip.srcOut - clip.srcIn);
}

export function itemStart(item: TimelineItem): number {
  return item.start;
}

export function itemEnd(item: TimelineItem): number {
  return item.kind === "video" ? clipEnd(item) : item.end;
}

export function allItems(project: Project): TimelineItem[] {
  return [...project.clips, ...project.captions];
}

export function findItem(project: Project, id: string): TimelineItem | undefined {
  return project.clips.find((c) => c.id === id) ?? project.captions.find((c) => c.id === id);
}

/** End of the video (what gets exported). */
export function videoEnd(project: Project): number {
  return project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

/** End of everything on the timeline, captions included. */
export function contentEnd(project: Project): number {
  return Math.max(videoEnd(project), ...project.captions.map((c) => c.end), 0);
}

export function captionTrackCount(project: Project): number {
  return project.captions.reduce((max, c) => Math.max(max, c.track + 1), 0);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd - EPS && bStart < aEnd - EPS;
}

/** True when [start, end) on `track` is free of other captions. */
export function captionSlotFree(project: Project, track: number, start: number, end: number, ignore: ReadonlySet<string>): boolean {
  if (track < 0 || start < -EPS || end - start < EPS) return false;
  return !project.captions.some((c) => !ignore.has(c.id) && c.track === track && overlaps(start, end, c.start, c.end));
}

export function videoSlotFree(project: Project, start: number, end: number, ignore: ReadonlySet<string>): boolean {
  if (start < -EPS || end - start < EPS) return false;
  return !project.clips.some((c) => !ignore.has(c.id) && overlaps(start, end, c.start, clipEnd(c)));
}

/** Lowest caption track where [start, end) is free, preferring `preferred`. */
export function freeCaptionTrack(project: Project, start: number, end: number, preferred = 0): number {
  if (captionSlotFree(project, preferred, start, end, new Set())) return preferred;
  for (let track = 0; track < 64; track += 1) if (captionSlotFree(project, track, start, end, new Set())) return track;
  return captionTrackCount(project);
}

/** Start of the next caption on the track after `time` (Infinity when none). */
export function nextCaptionStart(project: Project, track: number, time: number, ignore?: string): number {
  return project.captions.filter((c) => c.track === track && c.id !== ignore && c.start >= time - EPS).reduce((min, c) => Math.min(min, c.start), Number.POSITIVE_INFINITY);
}

export function previousCaptionEnd(project: Project, track: number, time: number, ignore?: string): number {
  return project.captions.filter((c) => c.track === track && c.id !== ignore && c.end <= time + EPS).reduce((max, c) => Math.max(max, c.end), 0);
}

export function nextClipStart(project: Project, time: number, ignore?: string): number {
  return project.clips.filter((c) => c.id !== ignore && c.start >= time - EPS).reduce((min, c) => Math.min(min, c.start), Number.POSITIVE_INFINITY);
}

export function previousClipEnd(project: Project, time: number, ignore?: string): number {
  return project.clips.filter((c) => c.id !== ignore && clipEnd(c) <= time + EPS).reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

/**
 * Splits items at `time`. `ids` limits the cut to those items (razor click on one clip); null cuts
 * every item under the time (Ctrl+K / Shift+razor). An item is cut only when both halves keep at
 * least one frame, so cuts at clip edges do nothing. Returns the ids of the new right halves.
 */
export function splitAt(project: Project, time: number, ids: ReadonlySet<string> | null, rate: Rate | null): string[] {
  const minimum = frameDuration(rate) - EPS;
  const created: string[] = [];
  const cut = (start: number, end: number) => time - start >= minimum && end - time >= minimum;
  for (const clip of [...project.clips]) {
    if (ids && !ids.has(clip.id)) continue;
    if (!cut(clip.start, clipEnd(clip))) continue;
    const at = clip.srcIn + (time - clip.start);
    const right: VideoClip = { ...clip, id: newId(), start: time, srcIn: at };
    clip.srcOut = at;
    project.clips.push(right);
    created.push(right.id);
  }
  for (const caption of [...project.captions]) {
    if (ids && !ids.has(caption.id)) continue;
    if (!cut(caption.start, caption.end)) continue;
    const right: Caption = { ...caption, id: newId(), start: time, style: structuredClone(caption.style) };
    caption.end = time;
    project.captions.push(right);
    created.push(right.id);
  }
  project.clips.sort((a, b) => a.start - b.start);
  return created;
}

/**
 * Removes items. With `ripple` the removed time is closed up (Premiere's ripple delete):
 * - Removing video clips takes their time out of the whole sequence. Later clips and captions
 *   move left; captions that ran over the removed part are shortened, and captions that sat
 *   entirely inside it are dropped (their picture is gone). Returns how many were dropped.
 * - Removing only captions closes the gap on their own track.
 */
export function deleteItems(project: Project, ids: ReadonlySet<string>, ripple: boolean, rate: Rate | null = null): number {
  const removed = allItems(project).filter((item) => ids.has(item.id));
  project.clips = project.clips.filter((c) => !ids.has(c.id));
  project.captions = project.captions.filter((c) => !ids.has(c.id));
  if (!ripple) return 0;
  const videoRanges = mergeRanges(removed.filter((i) => i.kind === "video").map((i) => [i.start, itemEnd(i)] as [number, number]));
  if (videoRanges.length) {
    // Ranges still covered by another clip can't close.
    const open = videoRanges.filter(([s, e]) => !project.clips.some((c) => overlaps(c.start, clipEnd(c), s, e)));
    const map = (t: number) => {
      let out = t;
      for (const [s, e] of open) {
        if (t >= e - EPS) out -= e - s;
        else if (t > s) out -= t - s;
      }
      return out;
    };
    for (const clip of project.clips) clip.start = map(clip.start);
    const minimum = frameDuration(rate) - EPS;
    const before = project.captions.length;
    project.captions = project.captions.filter((caption) => {
      caption.start = map(caption.start);
      caption.end = map(caption.end);
      return caption.end - caption.start >= minimum;
    });
    return before - project.captions.length;
  }
  const tracks = new Set(removed.map((i) => (i as Caption).track));
  for (const track of tracks) {
    const ranges = mergeRanges(removed.filter((i) => (i as Caption).track === track).map((i) => [i.start, itemEnd(i)] as [number, number]));
    for (const [start, end] of ranges.reverse()) {
      const length = end - start;
      for (const caption of project.captions) {
        if (caption.track === track && caption.start >= end - EPS) {
          caption.start -= length;
          caption.end -= length;
        }
      }
    }
  }
  return 0;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1] + EPS) last[1] = Math.max(last[1], range[1]);
    else out.push([...range]);
  }
  return out;
}

/** Closes the empty gap on the video track that contains `time` (if any). */
export function closeGapAt(project: Project, time: number): boolean {
  const before = previousClipEnd(project, time);
  const after = nextClipStart(project, time);
  if (!Number.isFinite(after) || after - before < EPS) return false;
  if (project.clips.some((c) => overlaps(c.start, clipEnd(c), before, after))) return false;
  const length = after - before;
  for (const clip of project.clips) if (clip.start >= after - EPS) clip.start -= length;
  for (const caption of project.captions) {
    if (caption.start >= after - EPS) {
      caption.start -= length;
      caption.end -= length;
    }
  }
  return true;
}

/** Every clip and caption start/end, sorted (↑/↓ jump between them). */
export function editPoints(project: Project): number[] {
  const points = new Set<number>([0]);
  for (const item of allItems(project)) {
    points.add(Math.round(item.start * 1e6) / 1e6);
    points.add(Math.round(itemEnd(item) * 1e6) / 1e6);
  }
  return [...points].sort((a, b) => a - b);
}

/** Puts a whole media file at the end of the video track. */
export function appendMedia(project: Project, media: MediaRef): VideoClip {
  const video = media.info.video!;
  const clip: VideoClip = { id: newId(), kind: "video", mediaId: media.id, start: videoEnd(project), srcIn: 0, srcOut: video.duration };
  project.clips.push(clip);
  return clip;
}

/** Captions visible at `time`, bottom track first (draw order). */
export function captionsAt(captions: readonly Caption[], time: number): Caption[] {
  return captions.filter((c) => c.start <= time + EPS && time < c.end - EPS).sort((a, b) => a.track - b.track || a.start - b.start);
}

/** The video clip under `time`, if any. */
export function clipAt(clips: readonly VideoClip[], time: number): VideoClip | undefined {
  return clips.find((c) => c.start <= time + EPS && time < clipEnd(c) - EPS);
}

/** Copy of an item at a given place (Alt+drag leaves this copy behind). */
export function createDuplicate(project: Project, id: string, at: { start: number; track: number }): void {
  const caption = project.captions.find((c) => c.id === id);
  if (caption) {
    const length = caption.end - caption.start;
    project.captions.push({ ...structuredClone(caption), id: newId(), start: at.start, end: at.start + length, track: at.track });
    return;
  }
  const clip = project.clips.find((c) => c.id === id);
  if (clip) project.clips.push({ ...clip, id: newId(), start: at.start });
}
