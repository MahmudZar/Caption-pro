/**
 * Playback engine (no React). The timeline time is the master; each media file has one <video>
 * element (registered by the monitor) that shows the clip under the playhead.
 *
 * - Paused: every playhead change seeks the active video. Seeks are coalesced: while one is
 *   running only the latest target is kept, so scrubbing stays responsive on long-GOP files.
 * - Playing: the video's own clock drives the playhead (audio stays in sync). At a clip end it
 *   continues seamlessly when the next clip is the same file at the same source time (a razor
 *   cut you didn't move), otherwise it seeks the next clip; gaps play black on a wall clock.
 * - J/K/L shuttle: L plays forward 1×/2×/4×/8×, J plays backward by seeking on a wall clock.
 */
import { clipAt, clipEnd, contentEnd, videoEnd } from "../model/edit";
import { EPS, frameDuration } from "../model/time";
import { useEditor, usePlayback } from "../state/store";
import type { VideoClip } from "../state/types";

const videos = new Map<string, HTMLVideoElement>();
const pendingSeek = new Map<HTMLVideoElement, number>();
let activeId: string | null = null;
let raf = 0;
let mode: "video" | "clock" = "clock";
let currentClipId: string | null = null;
let clockOrigin = 0;
let clockTime = 0;
let internalTime = false;
const activeListeners = new Set<(id: string | null) => void>();

/** Seeking slightly past the frame start makes the decoder pick that frame, not the one before. */
const SEEK_NUDGE = 0.0005;

function project() {
  return useEditor.getState().project;
}

function setTimeInternal(time: number): void {
  internalTime = true;
  usePlayback.getState().setTime(time);
  internalTime = false;
}

function setActive(id: string | null): void {
  if (activeId === id) return;
  activeId = id;
  for (const [mediaId, element] of videos) {
    element.style.visibility = mediaId === id ? "visible" : "hidden";
    if (mediaId !== id && !element.paused) element.pause();
  }
  for (const listener of activeListeners) listener(id);
}

export function onActiveVideoChange(listener: (id: string | null) => void): () => void {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
}

export function activeVideo(): HTMLVideoElement | null {
  return activeId ? (videos.get(activeId) ?? null) : null;
}

function seek(element: HTMLVideoElement, source: number): void {
  const target = Math.max(0, source + SEEK_NUDGE);
  if (element.seeking) {
    pendingSeek.set(element, target);
    return;
  }
  if (Math.abs(element.currentTime - target) < 1e-4) return;
  element.currentTime = target;
}

function onSeeked(this: HTMLVideoElement): void {
  const next = pendingSeek.get(this);
  if (next === undefined) return;
  pendingSeek.delete(this);
  if (Math.abs(this.currentTime - next) > 1e-4) this.currentTime = next;
}

export function registerVideo(mediaId: string, element: HTMLVideoElement): () => void {
  videos.set(mediaId, element);
  element.addEventListener("seeked", onSeeked);
  element.style.visibility = mediaId === activeId ? "visible" : "hidden";
  // A newly mounted element should show the current frame.
  const onReady = () => {
    if (!usePlayback.getState().playing) showFrame(usePlayback.getState().time, true);
  };
  element.addEventListener("loadedmetadata", onReady);
  if (element.readyState >= 1) onReady();
  return () => {
    element.removeEventListener("seeked", onSeeked);
    element.removeEventListener("loadedmetadata", onReady);
    if (videos.get(mediaId) === element) videos.delete(mediaId);
    if (activeId === mediaId) activeId = null;
  };
}

/** Shows the frame at a timeline time (paused). */
function showFrame(time: number, force = false): void {
  const clip = clipAt(project().clips, time);
  if (!clip) {
    setActive(null);
    return;
  }
  const element = videos.get(clip.mediaId);
  setActive(clip.mediaId);
  if (!element || element.readyState < 1) return;
  if (!element.paused) element.pause();
  const source = clip.srcIn + (time - clip.start);
  if (force) pendingSeek.delete(element);
  seek(element, source);
}

function end(): number {
  const p = project();
  return p.clips.length ? videoEnd(p) : contentEnd(p);
}

function startSegment(time: number): void {
  const p = project();
  const clip = clipAt(p.clips, time);
  const rate = usePlayback.getState().rate;
  currentClipId = clip?.id ?? null;
  if (clip && rate > 0) {
    const element = videos.get(clip.mediaId);
    setActive(clip.mediaId);
    if (element && element.readyState >= 1) {
      mode = "video";
      const source = clip.srcIn + (time - clip.start);
      pendingSeek.delete(element);
      if (Math.abs(element.currentTime - source) > frameDuration(p.sequence) / 2) element.currentTime = source + SEEK_NUDGE;
      element.playbackRate = rate;
      element.play().catch(() => {
        // Autoplay blocked or decode error: fall back to the wall clock so the playhead still moves.
        mode = "clock";
        clockOrigin = performance.now();
        clockTime = time;
      });
      return;
    }
  }
  if (!clip) setActive(null);
  mode = "clock";
  clockOrigin = performance.now();
  clockTime = time;
}

function stop(at?: number): void {
  cancelAnimationFrame(raf);
  raf = 0;
  for (const element of videos.values()) if (!element.paused) element.pause();
  usePlayback.setState({ playing: false, rate: 1 });
  if (at !== undefined) setTimeInternal(at);
  showFrame(usePlayback.getState().time, true);
}

function tick(): void {
  raf = requestAnimationFrame(tick);
  const p = project();
  const { rate } = usePlayback.getState();
  const limit = end();
  if (mode === "video") {
    const clip = p.clips.find((c) => c.id === currentClipId);
    const element = clip ? videos.get(clip.mediaId) : undefined;
    if (!clip || !element) {
      startSegment(usePlayback.getState().time);
      return;
    }
    const time = clip.start + (element.currentTime - clip.srcIn);
    const clipFinish = clipEnd(clip);
    if (element.ended || time >= clipFinish - EPS || element.currentTime >= clip.srcOut - 1e-4) {
      if (clipFinish >= limit - EPS) {
        stop(limit);
        return;
      }
      const next = p.clips.find((c) => Math.abs(c.start - clipFinish) < EPS && c.id !== clip.id);
      if (next && next.mediaId === clip.mediaId && Math.abs(next.srcIn - clip.srcOut) < frameDuration(p.sequence) / 2) {
        currentClipId = next.id; // contiguous cut: keep playing, no seek
        setTimeInternal(clipFinish);
        return;
      }
      element.pause();
      setTimeInternal(clipFinish);
      startSegment(clipFinish);
      return;
    }
    if (time > usePlayback.getState().time + 1e-5 || time < usePlayback.getState().time - 0.5) setTimeInternal(Math.max(clip.start, time));
    return;
  }
  // Wall clock: gaps, captions past the video, and reverse shuttle.
  const time = clockTime + ((performance.now() - clockOrigin) / 1000) * rate;
  if (rate < 0) {
    if (time <= 0) {
      stop(0);
      return;
    }
    setTimeInternal(time);
    showFrame(time);
    return;
  }
  if (time >= limit) {
    stop(limit);
    return;
  }
  const clip = clipAt(p.clips, time);
  setTimeInternal(time);
  // Offline media (not loaded) keeps playing on the wall clock instead of restarting every frame.
  if (clip && (videos.get(clip.mediaId)?.readyState ?? 0) >= 1) startSegment(time);
}

export function play(rate = 1): void {
  const state = usePlayback.getState();
  let time = state.time;
  const limit = end();
  if (limit <= EPS) return;
  if (rate > 0 && time >= limit - frameDuration(project().sequence)) time = 0;
  usePlayback.setState({ playing: true, rate, time });
  startSegment(time);
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function pause(): void {
  if (usePlayback.getState().playing) stop();
}

export function togglePlay(): void {
  if (usePlayback.getState().playing) pause();
  else play(1);
}

/** L / J: each press doubles the speed in that direction (up to 8×); K stops. */
export function shuttle(direction: 1 | -1): void {
  const { playing, rate } = usePlayback.getState();
  const next = playing && Math.sign(rate) === direction ? Math.min(8, Math.abs(rate) * 2) * direction : direction;
  if (playing) stop();
  play(next);
}

export function goTo(time: number): void {
  const wasPlaying = usePlayback.getState().playing;
  usePlayback.getState().setTime(time);
  if (!wasPlaying) showFrame(usePlayback.getState().time, true);
}

/** The clip the engine is playing (for the monitor's offline / proxy notes). */
export function currentClip(): VideoClip | undefined {
  return clipAt(project().clips, usePlayback.getState().time);
}

// Playhead changes made by the UI (scrubbing, keys, clicks).
usePlayback.subscribe((state, previous) => {
  if (internalTime || state.time === previous.time) return;
  if (state.playing) {
    for (const element of videos.values()) if (!element.paused) element.pause();
    startSegment(state.time);
  } else showFrame(state.time);
});

// Edits can change what's under a paused playhead (trim, move, delete).
useEditor.subscribe((state, previous) => {
  if (state.project.clips === previous.project.clips) return;
  if (!usePlayback.getState().playing) showFrame(usePlayback.getState().time, true);
});
