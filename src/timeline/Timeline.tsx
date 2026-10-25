/**
 * Timeline, Premiere style: caption tracks (C1 at the bottom, higher tracks draw on top) above
 * V1 and its linked audio A1 with a large waveform. Drawn on two canvases (see draw.ts); React
 * only renders the chrome. Zoom and scroll live in useView: Alt+wheel (or pinch) zooms around
 * the pointer, the wheel pans through time, Shift+wheel scrolls the tracks.
 */
import { RiZoomInLine, RiZoomOutLine, RiExpandHorizontalLine } from "@remixicon/react";
import * as React from "react";

import { createCaption, finishEditing, revealCaption, splitItem } from "../app/actions";
import { useMedia } from "../app/media";
import { onRenderAssetsChange } from "../caption/fonts";
import { onEmojiChange } from "../caption/emoji";
import { captionSlotFree, clipEnd, contentEnd, createDuplicate, itemEnd, nextCaptionStart, nextClipStart, previousCaptionEnd, previousClipEnd, videoSlotFree } from "../model/edit";
import { EPS, formatTimecode, frameDuration, parseTimecode, snapToFrame } from "../model/time";
import { goTo, pause } from "../playback/engine";
import { MAX_ZOOM, MIN_ZOOM, useEditor, usePlayback, useView } from "../state/store";
import type { Project } from "../state/types";
import { IconButton, Kbd, MagnetIcon, stopKeys } from "../ui/controls";

import { drawBase, drawOverlay, readPalette, type Palette } from "./draw";
import { SNAP_PX, captionTrackAt, computeRows, hitTest, nearestSnap, snapPoints, visibleCaptionTracks, type Row } from "./geometry";


type Gesture =
  | { kind: "scrub" }
  | { kind: "pan"; startX: number; startScroll: number }
  | { kind: "marquee"; x0: number; y0: number; base: string[] }
  | {
      kind: "move";
      key: string;
      grabTime: number;
      grabTrack: number;
      origins: Map<string, { start: number; track: number }>;
      primary: string;
      duplicate: boolean;
      duplicated: boolean;
      moved: boolean;
      startX: number;
    }
  | { kind: "trim"; key: string; id: string; edge: "start" | "end" };

export function zoomToFit(): void {
  const { project } = useEditor.getState();
  const view = useView.getState();
  const length = Math.max(1, contentEnd(project));
  view.set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (view.laneWidth - 24) / length)), scroll: 0 });
}

/** Zooms keeping `anchorTime` under the same x (default: the playhead). */
export function zoomBy(factor: number, anchorTime?: number, anchorX?: number): void {
  const view = useView.getState();
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const t = anchorTime ?? usePlayback.getState().time;
  const x = anchorX ?? (t - view.scroll) * view.zoom;
  view.set({ zoom, scroll: clampScroll(t - x / zoom, zoom) });
}

function clampScroll(scroll: number, zoom: number): number {
  const { project } = useEditor.getState();
  const view = useView.getState();
  const visible = view.laneWidth / zoom;
  const total = Math.max(contentEnd(project), 5) + visible * 0.5;
  return Math.max(0, Math.min(scroll, Math.max(0, total - visible * 0.5)));
}

function TimecodeInput() {
  const time = usePlayback((s) => s.time);
  const rate = useEditor((s) => s.project.sequence);
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <input
      className="timeline__time"
      aria-label="Playhead timecode"
      title="Playhead: type a timecode, seconds (2.5) or frames (45f)"
      value={draft ?? formatTimecode(time, rate)}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) {
          const t = parseTimecode(draft, rate);
          if (t !== null) goTo(snapToFrame(t, rate));
        }
        setDraft(null);
      }}
      onKeyDown={(e) => {
        stopKeys(e);
        if (e.key === "Enter" || e.key === "Escape") {
          if (e.key === "Escape") setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function TimelineBar() {
  const snapping = useEditor((s) => s.snapping);
  const tool = useEditor((s) => s.tool);
  const hint =
    tool === "razor" ? "Razor: click a clip to cut it · Shift+click cuts every track" : tool === "text" ? "Text: click a caption track or the monitor to add a caption" : "Drag to move · drag edges to trim · Alt+drag duplicates";
  return (
    <div className="timeline__bar">
      <TimecodeInput />
      <IconButton label={snapping ? "Snapping on" : "Snapping off"} shortcut="S" on={snapping} onClick={() => useEditor.getState().set({ snapping: !snapping })}>
        <MagnetIcon />
      </IconButton>
      <span className="timeline__hint">{hint}</span>
      <span style={{ flex: 1 }} />
      <span className="timeline__hint">
        <Kbd>Alt</Kbd> + scroll zoom · scroll pans
      </span>
      <IconButton label="Zoom out" shortcut="-" onClick={() => zoomBy(1 / 1.5)}>
        <RiZoomOutLine size={16} />
      </IconButton>
      <IconButton label="Zoom in" shortcut="=" onClick={() => zoomBy(1.5)}>
        <RiZoomInLine size={16} />
      </IconButton>
      <IconButton label="Zoom to fit" shortcut="\" onClick={zoomToFit}>
        <RiExpandHorizontalLine size={16} />
      </IconButton>
    </div>
  );
}

function TrackHeads({ rows }: { rows: Row[] }) {
  const media = useEditor((s) => s.project.media);
  const clips = useEditor((s) => s.project.clips);
  const firstName = media.find((m) => m.id === clips[0]?.mediaId)?.name ?? "Video";
  return (
    <>
      {rows
        .filter((r) => r.kind !== "ruler")
        .map((row) => (
          <div key={`${row.kind}${row.track}`} className="track-head" style={{ top: row.y, height: row.h }}>
            <span className={`track-head__badge track-head__badge--${row.kind}`}>{row.kind === "caption" ? `C${row.track + 1}` : row.kind === "video" ? "V1" : "A1"}</span>
            <span className="track-head__name">{row.kind === "caption" ? "Captions" : row.kind === "video" ? firstName : "Audio"}</span>
          </div>
        ))}
    </>
  );
}

function ZoomBar() {
  const zoom = useView((s) => s.zoom);
  const scroll = useView((s) => s.scroll);
  const laneWidth = useView((s) => s.laneWidth);
  const total = useEditor((s) => Math.max(contentEnd(s.project), 5));
  const ref = React.useRef<HTMLDivElement>(null);
  const visible = laneWidth / zoom;
  const span = Math.max(total, scroll + visible);
  const width = ref.current?.clientWidth ?? laneWidth;
  const left = (scroll / span) * width;
  const thumb = Math.max(14, (visible / span) * width);
  const drag = (event: React.PointerEvent, mode: "move" | "start" | "end") => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = { scroll, end: scroll + visible };
    const perPx = span / width;
    const move = (e: PointerEvent) => {
      const dt = (e.clientX - startX) * perPx;
      const view = useView.getState();
      if (mode === "move") view.set({ scroll: clampScroll(start.scroll + dt, view.zoom) });
      else {
        const s = mode === "start" ? Math.min(start.end - 0.05, Math.max(0, start.scroll + dt)) : start.scroll;
        const e2 = mode === "end" ? Math.max(start.scroll + 0.05, start.end + dt) : start.end;
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.laneWidth / (e2 - s)));
        view.set({ zoom: z, scroll: Math.max(0, s) });
      }
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return (
    <div className="timeline__scroll">
      <div />
      <div ref={ref} className="zoombar">
        <div className="zoombar__thumb" style={{ left, width: thumb }} onPointerDown={(e) => drag(e, "move")}>
          <span className="zoombar__end" style={{ left: 0 }} onPointerDown={(e) => drag(e, "start")} />
          <span className="zoombar__end" style={{ right: 0 }} onPointerDown={(e) => drag(e, "end")} />
        </div>
      </div>
    </div>
  );
}

export function Timeline() {
  const lanes = React.useRef<HTMLDivElement>(null);
  const baseCanvas = React.useRef<HTMLCanvasElement>(null);
  const overlayCanvas = React.useRef<HTMLCanvasElement>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const scrollY = useView((s) => s.scrollY);
  const liveTracks = useEditor((s) => visibleCaptionTracks(s.project));
  // While dragging, the track rows stay put: a caption moved onto the empty top track would
  // otherwise add a row, shift every row under the pointer and keep climbing.
  const [frozenTracks, setFrozenTracks] = React.useState<number | null>(null);
  const captionTracks = frozenTracks ?? liveTracks;
  const { rows, maxScrollY } = React.useMemo(() => computeRows(size.h, captionTracks, scrollY), [size.h, captionTracks, scrollY]);
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  const gesture = React.useRef<Gesture | null>(null);
  const hoverRef = React.useRef<{ id: string; edge: "start" | "end" | null } | null>(null);
  const overlayState = React.useRef<{ razorTime: number | null; razorRow: Row | null; snapTime: number | null; marquee: { x0: number; y0: number; x1: number; y1: number } | null }>({ razorTime: null, razorRow: null, snapTime: null, marquee: null });
  const gestureCount = React.useRef(0);
  const palette = React.useRef<Palette | null>(null);

  // Size.
  React.useLayoutEffect(() => {
    const element = lanes.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setSize({ w: element.clientWidth, h: element.clientHeight });
      useView.getState().set({ laneWidth: element.clientWidth });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Drawing (outside React): base on project/view/hover changes, overlay on playhead changes.
  const redraw = React.useRef({ base: () => {}, overlay: () => {} });
  React.useEffect(() => {
    const base = baseCanvas.current;
    const overlay = overlayCanvas.current;
    if (!base || !overlay || size.w < 2 || size.h < 2) return;
    palette.current ??= readPalette(document.documentElement);
    let baseFrame = 0;
    let overlayFrame = 0;
    const dpr = window.devicePixelRatio || 1;
    for (const canvas of [base, overlay]) {
      canvas.width = Math.round(size.w * dpr);
      canvas.height = Math.round(size.h * dpr);
    }
    const drawBaseNow = () => {
      baseFrame = 0;
      const { project, selection } = useEditor.getState();
      const view = useView.getState();
      const media = useMedia.getState();
      const peakState: Record<string, string | undefined> = {};
      for (const [id, status] of Object.entries(media.status)) peakState[id] = status.peaks;
      drawBase(
        base.getContext("2d")!,
        { project, rows: rowsRef.current, width: size.w, height: size.h, zoom: view.zoom, scroll: view.scroll, selection: new Set(selection), hover: hoverRef.current, peaks: media.peaks, peakState, dpr },
        palette.current!,
      );
    };
    const drawOverlayNow = () => {
      overlayFrame = 0;
      const view = useView.getState();
      drawOverlay(overlay.getContext("2d")!, { width: size.w, height: size.h, zoom: view.zoom, scroll: view.scroll, time: usePlayback.getState().time, dpr, ...overlayState.current }, palette.current!);
    };
    redraw.current = {
      base: () => {
        if (!baseFrame) baseFrame = requestAnimationFrame(drawBaseNow);
      },
      overlay: () => {
        if (!overlayFrame) overlayFrame = requestAnimationFrame(drawOverlayNow);
      },
    };
    drawBaseNow();
    drawOverlayNow();
    const both = () => {
      redraw.current.base();
      redraw.current.overlay();
    };
    const offs = [
      useEditor.subscribe((s, p) => (s.project !== p.project || s.selection !== p.selection) && redraw.current.base()),
      useView.subscribe(both),
      useMedia.subscribe((s, p) => (s.peaks !== p.peaks || s.status !== p.status) && redraw.current.base()),
      usePlayback.subscribe(() => redraw.current.overlay()),
      onEmojiChange(() => redraw.current.base()),
      onRenderAssetsChange(() => redraw.current.base()),
    ];
    return () => {
      cancelAnimationFrame(baseFrame);
      cancelAnimationFrame(overlayFrame);
      for (const off of offs) off();
    };
  }, [size.w, size.h, rows]);

  // Keep the playhead in view while playing (page by page, like Premiere).
  React.useEffect(
    () =>
      usePlayback.subscribe((s) => {
        if (!s.playing) return;
        const view = useView.getState();
        const visible = view.laneWidth / view.zoom;
        if (s.time > view.scroll + visible * 0.97) view.set({ scroll: s.time - visible * 0.03 });
        else if (s.time < view.scroll) view.set({ scroll: Math.max(0, s.time - visible * 0.1) });
      }),
    [],
  );

  // Fit the first time media appears.
  const clipCount = useEditor((s) => s.project.clips.length);
  const hadClips = React.useRef(false);
  React.useEffect(() => {
    if (clipCount && !hadClips.current && size.w > 0) zoomToFit();
    hadClips.current = clipCount > 0;
  }, [clipCount, size.w]);

  // Wheel: pan / zoom / vertical scroll (non-passive so Alt+wheel doesn't scroll the page).
  React.useEffect(() => {
    const element = lanes.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const view = useView.getState();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const delta = event.deltaMode === 1 ? event.deltaY * 32 : event.deltaY;
      if (event.altKey || event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-delta * (event.ctrlKey && !event.altKey ? 0.01 : 0.0022));
        zoomBy(factor, x / view.zoom + view.scroll, x);
      } else if (event.shiftKey) {
        view.set({ scrollY: Math.max(0, view.scrollY + delta) });
      } else {
        const dx = (Math.abs(event.deltaX) > Math.abs(delta) ? event.deltaX : delta) / view.zoom;
        view.set({ scroll: clampScroll(view.scroll + dx, view.zoom) });
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  React.useEffect(() => {
    if (scrollY > maxScrollY) useView.getState().set({ scrollY: maxScrollY });
  }, [scrollY, maxScrollY]);

  // ---------------- pointer ----------------

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = lanes.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const timeAt = (x: number) => {
    const view = useView.getState();
    return x / view.zoom + view.scroll;
  };
  /** Snaps a time to the frame grid and, with snapping on, to nearby edges. */
  const snapTime = (t: number, exclude: ReadonlySet<string>, force = false): { t: number; snapped: number | null } => {
    const { project, snapping } = useEditor.getState();
    const framed = snapToFrame(Math.max(0, t), project.sequence);
    if (!snapping && !force) return { t: framed, snapped: null };
    const hit = nearestSnap(snapPoints(project, usePlayback.getState().time, exclude), t, SNAP_PX / useView.getState().zoom);
    return hit === null ? { t: framed, snapped: null } : { t: hit, snapped: hit };
  };

  const setOverlay = (partial: Partial<typeof overlayState.current>) => {
    overlayState.current = { ...overlayState.current, ...partial };
    redraw.current.overlay();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const p = local(event);
    const state = useEditor.getState();
    if (state.editingId) finishEditing();
    if (event.button === 1) {
      event.preventDefault();
      gesture.current = { kind: "pan", startX: p.x, startScroll: useView.getState().scroll };
      element.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const view = useView.getState();
    const hit = hitTest(state.project, rowsRef.current, p.x, p.y, view.zoom, view.scroll);
    element.setPointerCapture(event.pointerId);

    if (hit.row?.kind === "ruler") {
      pause();
      gesture.current = { kind: "scrub" };
      goTo(snapTime(timeAt(p.x), new Set(), event.shiftKey).t);
      return;
    }
    if (state.tool === "razor") {
      if (hit.item) splitItem(hit.item.id, snapTime(timeAt(p.x), new Set()).t, event.shiftKey);
      return;
    }
    if (state.tool === "text" && hit.row?.kind === "caption" && !hit.item) {
      const id = createTextAt(timeAt(p.x), hit.row.track);
      if (id) revealCaption(id);
      return;
    }
    if (!hit.item) {
      gesture.current = { kind: "marquee", x0: p.x, y0: p.y, base: event.shiftKey || event.ctrlKey ? state.selection : [] };
      if (!event.shiftKey && !event.ctrlKey) state.select([]);
      return;
    }
    const item = hit.item;
    // Selection: Shift/Ctrl toggles, a plain click on an unselected item selects only it.
    let selection = state.selection;
    if (event.shiftKey || event.ctrlKey) selection = selection.includes(item.id) ? selection.filter((id) => id !== item.id) : [...selection, item.id];
    else if (!selection.includes(item.id)) selection = [item.id];
    state.select(selection);
    if (event.detail >= 2 && item.kind === "caption") {
      revealCaption(item.id);
      state.select([item.id]);
      state.setEditing(item.id);
      gesture.current = null;
      return;
    }
    if (hit.edge && !event.shiftKey && !event.ctrlKey) {
      gesture.current = { kind: "trim", key: `g:trim:${++gestureCount.current}`, id: item.id, edge: hit.edge };
      return;
    }
    if (!selection.includes(item.id)) return;
    const origins = new Map<string, { start: number; track: number }>();
    for (const id of selection) {
      const it = state.project.captions.find((c) => c.id === id) ?? state.project.clips.find((c) => c.id === id);
      if (it) origins.set(id, { start: it.start, track: it.kind === "caption" ? it.track : -1 });
    }
    setFrozenTracks(liveTracks);
    gesture.current = {
      kind: "move",
      key: `g:move:${++gestureCount.current}`,
      grabTime: timeAt(p.x),
      grabTrack: item.kind === "caption" ? item.track : -1,
      origins,
      primary: item.id,
      duplicate: event.altKey,
      duplicated: false,
      moved: false,
      startX: p.x,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = local(event);
    const g = gesture.current;
    const state = useEditor.getState();
    const view = useView.getState();
    if (!g) {
      // Hover: cursor + edge highlight + razor line.
      const hit = hitTest(state.project, rowsRef.current, p.x, p.y, view.zoom, view.scroll);
      const element = event.currentTarget;
      let cursor = "default";
      if (hit.row?.kind === "ruler") cursor = "pointer";
      else if (state.tool === "razor") cursor = hit.item ? "crosshair" : "not-allowed";
      else if (state.tool === "text") cursor = hit.row?.kind === "caption" ? "text" : "default";
      else if (hit.item && hit.edge) cursor = hit.edge === "start" ? "w-resize" : "e-resize";
      else if (hit.item) cursor = "grab";
      element.style.cursor = cursor;
      const hover = hit.item && state.tool === "select" ? { id: hit.item.id, edge: hit.edge } : null;
      if (hover?.id !== hoverRef.current?.id || hover?.edge !== hoverRef.current?.edge) {
        hoverRef.current = hover;
        redraw.current.base();
      }
      if (state.tool === "razor" && hit.item) setOverlay({ razorTime: snapTime(timeAt(p.x), new Set()).t, razorRow: event.shiftKey ? null : hit.row });
      else if (overlayState.current.razorTime !== null) setOverlay({ razorTime: null, razorRow: null });
      return;
    }
    if (g.kind === "pan") {
      view.set({ scroll: clampScroll(g.startScroll - (p.x - g.startX) / view.zoom, view.zoom) });
      return;
    }
    if (g.kind === "scrub") {
      goTo(snapTime(timeAt(p.x), new Set(), event.shiftKey).t);
      return;
    }
    if (g.kind === "marquee") {
      const marquee = { x0: g.x0, y0: g.y0, x1: p.x, y1: p.y };
      setOverlay({ marquee });
      const t0 = timeAt(Math.min(g.x0, p.x));
      const t1 = timeAt(Math.max(g.x0, p.x));
      const yTop = Math.min(g.y0, p.y);
      const yBottom = Math.max(g.y0, p.y);
      const ids = new Set(g.base);
      for (const row of rowsRef.current) {
        if (row.kind === "ruler" || row.y + row.h < yTop || row.y > yBottom) continue;
        const items = row.kind === "caption" ? state.project.captions.filter((c) => c.track === row.track) : row.kind === "video" || row.kind === "audio" ? state.project.clips : [];
        for (const item of items) if (item.start < t1 && itemEnd(item) > t0) ids.add(item.id);
      }
      state.select([...ids]);
      return;
    }
    if (g.kind === "trim") {
      trim(g, timeAt(p.x));
      return;
    }
    if (g.kind === "move") {
      if (!g.moved && Math.abs(p.x - g.startX) < 3 && captionTrackAt(rowsRef.current, p.y) === g.grabTrack) return;
      g.moved = true;
      move(g, timeAt(p.x), captionTrackAt(rowsRef.current, p.y));
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setFrozenTracks(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (g?.kind === "marquee") setOverlay({ marquee: null });
    if (g?.kind === "move" || g?.kind === "trim") setOverlay({ snapTime: null });
  };

  // ---------------- edits ----------------

  function createTextAt(time: number, track: number): string | null {
    const { project } = useEditor.getState();
    const t = snapToFrame(time, project.sequence);
    goTo(t);
    // Through the shared action so new captions behave the same everywhere.
    return createCaption({ time: t, track });
  }

  function trim(g: Extract<Gesture, { kind: "trim" }>, rawTime: number): void {
    const { project, update } = useEditor.getState();
    const rate = project.sequence;
    const frame = frameDuration(rate);
    const exclude = new Set([g.id]);
    const { t, snapped } = snapTime(rawTime, exclude);
    setOverlay({ snapTime: snapped });
    const caption = project.captions.find((c) => c.id === g.id);
    const clip = project.clips.find((c) => c.id === g.id);
    if (caption) {
      const value =
        g.edge === "start"
          ? Math.min(caption.end - frame, Math.max(previousCaptionEnd(project, caption.track, caption.start, caption.id), t))
          : Math.max(caption.start + frame, Math.min(nextCaptionStart(project, caption.track, caption.end - EPS, caption.id), t));
      update((draft) => {
        const c = draft.captions.find((x) => x.id === g.id);
        if (!c) return;
        if (g.edge === "start") c.start = value;
        else c.end = value;
      }, g.key);
    } else if (clip) {
      const media = project.media.find((m) => m.id === clip.mediaId);
      const sourceEnd = media?.info.video?.duration ?? clip.srcOut;
      const end = clipEnd(clip);
      if (g.edge === "start") {
        const min = Math.max(previousClipEnd(project, clip.start, clip.id), clip.start - clip.srcIn);
        const value = Math.min(end - frame, Math.max(min, t));
        update((draft) => {
          const c = draft.clips.find((x) => x.id === g.id);
          if (!c) return;
          c.srcIn = clip.srcIn + (value - clip.start);
          c.start = value;
        }, g.key);
        goTo(value);
      } else {
        const max = Math.min(nextClipStart(project, end - EPS, clip.id), end + (sourceEnd - clip.srcOut));
        const value = Math.max(clip.start + frame, Math.min(max, t));
        update((draft) => {
          const c = draft.clips.find((x) => x.id === g.id);
          if (!c) return;
          c.srcOut = clip.srcIn + (value - clip.start);
        }, g.key);
        goTo(Math.max(clip.start, value - frame));
      }
    }
  }

  function move(g: Extract<Gesture, { kind: "move" }>, rawTime: number, pointerTrack: number): void {
    const { project, update } = useEditor.getState();
    const rate = project.sequence;
    let dt = snapToFrame(rawTime - g.grabTime, rate);
    // Never before 0.
    const minStart = Math.min(...[...g.origins.values()].map((o) => o.start));
    dt = Math.max(dt, -minStart);
    // Snap the primary item's start or end to the nearest edge.
    const primary = project.captions.find((c) => c.id === g.primary) ?? project.clips.find((c) => c.id === g.primary);
    const origin = g.origins.get(g.primary);
    let snapped: number | null = null;
    if (primary && origin && useEditor.getState().snapping) {
      const length = itemEnd(primary) - primary.start;
      const points = snapPoints(project, usePlayback.getState().time, new Set(g.origins.keys()));
      const threshold = SNAP_PX / useView.getState().zoom;
      const a = nearestSnap(points, origin.start + dt, threshold);
      const b = nearestSnap(points, origin.start + length + dt, threshold);
      const da = a === null ? Infinity : Math.abs(a - (origin.start + dt));
      const db = b === null ? Infinity : Math.abs(b - (origin.start + length + dt));
      if (a !== null && da <= db) {
        dt = a - origin.start;
        snapped = a;
      } else if (b !== null) {
        dt = b - origin.start - length;
        snapped = b;
      }
      dt = Math.max(dt, -minStart);
    }
    const captionOrigins = [...g.origins.entries()].filter(([, o]) => o.track >= 0);
    const minTrack = captionOrigins.length ? Math.min(...captionOrigins.map(([, o]) => o.track)) : 0;
    const dTrack = g.grabTrack >= 0 ? Math.max(-minTrack, pointerTrack - g.grabTrack) : 0;
    const ignore = new Set(g.origins.keys());

    // Valid only when every moved item lands on free space (copies count as obstacles).
    const check = (draft: Project): boolean => {
      for (const [id, o] of g.origins) {
        const caption = draft.captions.find((c) => c.id === id);
        if (caption) {
          const length = caption.end - caption.start;
          if (!captionSlotFree(draft, o.track + dTrack, o.start + dt, o.start + dt + length, ignore)) return false;
          continue;
        }
        const clip = draft.clips.find((c) => c.id === id);
        if (clip && !videoSlotFree(draft, o.start + dt, o.start + dt + (clip.srcOut - clip.srcIn), ignore)) return false;
      }
      return true;
    };
    const current = useEditor.getState().project;
    const preview = structuredClone(current);
    if (g.duplicate && !g.duplicated) for (const id of g.origins.keys()) createDuplicate(preview, id, g.origins.get(id)!);
    if (!check(preview)) return; // keep the last valid position
    setOverlay({ snapTime: snapped });
    const makeCopies = g.duplicate && !g.duplicated;
    g.duplicated ||= g.duplicate;
    update((draft) => {
      if (makeCopies) for (const id of g.origins.keys()) createDuplicate(draft, id, g.origins.get(id)!);
      for (const [id, o] of g.origins) {
        const caption = draft.captions.find((c) => c.id === id);
        if (caption) {
          const length = caption.end - caption.start;
          caption.start = o.start + dt;
          caption.end = caption.start + length;
          caption.track = o.track + dTrack;
          continue;
        }
        const clip = draft.clips.find((c) => c.id === id);
        if (clip) clip.start = o.start + dt;
      }
    }, g.key);
  }

  return (
    <div className="timeline">
      <TimelineBar />
      <div className="timeline__main">
        <div className="timeline__heads">
          <TrackHeads rows={rows} />
        </div>
        <div
          ref={lanes}
          className="timeline__lanes"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (!gesture.current && (overlayState.current.razorTime !== null || hoverRef.current)) {
              hoverRef.current = null;
              setOverlay({ razorTime: null, razorRow: null });
              redraw.current.base();
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <canvas ref={baseCanvas} className="timeline__canvas" />
          <canvas ref={overlayCanvas} className="timeline__canvas" style={{ pointerEvents: "none" }} />
        </div>
      </div>
      <ZoomBar />
    </div>
  );
}

