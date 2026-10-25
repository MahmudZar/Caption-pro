/**
 * Program monitor: the sequence frame fitted into the panel, one <video> per media file, the
 * caption canvas on top (same renderer as the export) and an interaction layer for selecting,
 * moving, resizing and typing captions. The caption canvas redraws only when what it shows
 * changes (visible captions, their content, size, fonts/emoji loading), not every frame.
 */
import { RiPauseFill, RiPlayFill, RiSkipBackFill, RiSkipForwardFill, RiArrowLeftSLine, RiArrowRightSLine, RiVolumeUpLine, RiVolumeMuteLine, RiLayoutGridLine, RiLoader4Line, RiErrorWarningLine, RiFileVideoLine } from "@remixicon/react";
import * as React from "react";

import { api } from "../app/api";
import { createCaption, finishEditing, jumpEdit, stepFrames } from "../app/actions";
import { importWithDialog, useMedia } from "../app/media";
import { onRenderAssetsChange, renderEpoch, requestFont } from "../caption/fonts";
import { inflate, type CaptionLayout, type Rect } from "../caption/layout";
import { drawCaption, layoutFor } from "../caption/render";
import { captionsAt, clipAt, contentEnd, videoEnd } from "../model/edit";
import { formatTimecode } from "../model/time";
import { registerVideo, togglePlay } from "../playback/engine";
import { useEditor, usePlayback } from "../state/store";
import type { Caption, CaptionStyle } from "../state/types";
import { IconButton, cx } from "../ui/controls";

import { EmojiBar } from "./EmojiBar";

interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Screen px per frame px. */
  scale: number;
}

const FrameContext = React.createContext<FrameRect>({ left: 0, top: 0, width: 1, height: 1, scale: 1 });

function useFrameRect(stage: React.RefObject<HTMLDivElement | null>, frameW: number, frameH: number): FrameRect {
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ w: element.clientWidth, h: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage]);
  const pad = 14;
  const scale = Math.max(0.01, Math.min((size.w - pad * 2) / frameW, (size.h - pad * 2) / frameH));
  const width = Math.round(frameW * scale);
  const height = Math.round(frameH * scale);
  return { left: Math.round((size.w - width) / 2), top: Math.round((size.h - height) / 2), width, height, scale: width / frameW };
}

// ---------------- videos ----------------

function MediaVideo({ id, muted }: { id: string; muted: boolean }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const info = useEditor((s) => s.project.media.find((m) => m.id === id)?.info);
  const proxyReady = useMedia((s) => s.status[id]?.proxy === "ready");
  const missing = useMedia((s) => !!s.missing[id]);
  const src = !info || missing ? null : info.browserPlayable ? api.mediaUrl(id, false) : proxyReady ? api.mediaUrl(id, true) : null;
  React.useEffect(() => {
    const element = ref.current;
    if (!element || !src) return;
    return registerVideo(id, element);
  }, [id, src]);
  React.useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);
  if (!src) return null;
  return <video ref={ref} className="monitor__video" src={src} preload="auto" playsInline disablePictureInPicture data-media={id} />;
}

// ---------------- caption canvas ----------------

function CaptionCanvas({ frameW, frameH }: { frameW: number; frameH: number }) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const rect = React.useContext(FrameContext);
  React.useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let frame = 0;
    let lastKey = "";
    const draw = () => {
      frame = 0;
      const dpr = window.devicePixelRatio || 1;
      const pixelW = Math.max(1, Math.round(rect.width * dpr));
      const pixelH = Math.max(1, Math.round(rect.height * dpr));
      const { project } = useEditor.getState();
      const time = usePlayback.getState().time;
      const visible = captionsAt(project.captions, time);
      const epoch = renderEpoch();
      const key = `${pixelW}x${pixelH}|${epoch}|${visible.map((c) => c.id).join(",")}|${project.captions === lastCaptions ? "" : Math.random()}`;
      if (key === lastKey) return;
      lastKey = key;
      lastCaptions = project.captions;
      if (element.width !== pixelW) element.width = pixelW;
      if (element.height !== pixelH) element.height = pixelH;
      const ctx = element.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pixelW, pixelH);
      const scale = pixelW / frameW;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      for (const caption of visible) {
        requestFont(caption.style, caption.text);
        drawCaption(ctx, caption, frameW, frameH, epoch, { scale });
      }
    };
    let lastCaptions: Caption[] | null = null;
    const request = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    request();
    const offTime = usePlayback.subscribe(request);
    const offProject = useEditor.subscribe((s, p) => s.project.captions !== p.project.captions && request());
    const offAssets = onRenderAssetsChange(() => {
      lastKey = "";
      request();
    });
    return () => {
      cancelAnimationFrame(frame);
      offTime();
      offProject();
      offAssets();
    };
  }, [rect.width, rect.height, frameW, frameH]);
  return <canvas ref={canvas} className="monitor__captions" aria-hidden="true" />;
}

// ---------------- interaction layer ----------------

type Handle = "nw" | "ne" | "sw" | "se" | "w" | "e";

/** Scales every size in a style (corner handles). */
function scaleStyle(style: CaptionStyle, factor: number): CaptionStyle {
  const f = (v: number) => Math.round(v * factor * 10) / 10;
  return {
    ...style,
    fontSize: Math.max(4, Math.min(600, f(style.fontSize))),
    letterSpacing: f(style.letterSpacing),
    stroke: { ...style.stroke, width: f(style.stroke.width) },
    box: { ...style.box, padX: f(style.box.padX), padY: f(style.box.padY), radius: f(style.box.radius) },
    shadow: { ...style.shadow, blur: f(style.shadow.blur), x: f(style.shadow.x), y: f(style.shadow.y) },
  };
}

function useVisibleCaptionIds(): string {
  return usePlayback((s) => captionsAt(useEditor.getState().project.captions, s.time).map((c) => c.id).join(","));
}

function Overlay({ frameW, frameH }: { frameW: number; frameH: number }) {
  const rect = React.useContext(FrameContext);
  const layer = React.useRef<HTMLDivElement>(null);
  const tool = useEditor((s) => s.tool);
  const selection = useEditor((s) => s.selection);
  const editingId = useEditor((s) => s.editingId);
  const captions = useEditor((s) => s.project.captions);
  const safeZones = useEditor((s) => s.safeZones);
  // Re-render when the visible set changes (and on caption edits via `captions`).
  const visibleKey = useVisibleCaptionIds();
  const [epoch, setEpoch] = React.useState(0);
  React.useEffect(() => onRenderAssetsChange(() => setEpoch((e) => e + 1)), []);
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  const [guides, setGuides] = React.useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const gestureId = React.useRef(0);

  const visible = React.useMemo(() => {
    const ids = new Set(visibleKey.split(","));
    return captions.filter((c) => ids.has(c.id)).sort((a, b) => a.track - b.track);
  }, [visibleKey, captions]);
  // `epoch` re-measures after a font or emoji finishes loading.
  const layouts = React.useMemo(() => new Map(visible.map((c) => [c.id, layoutFor(c, frameW, frameH, renderEpoch())] as const)), [visible, frameW, frameH, epoch]);

  const toFrame = (clientX: number, clientY: number) => {
    const box = layer.current!.getBoundingClientRect();
    return { x: (clientX - box.left) / rect.scale, y: (clientY - box.top) / rect.scale };
  };
  const hit = (x: number, y: number): Caption | null => {
    for (const caption of [...visible].reverse()) {
      const r = layouts.get(caption.id)?.hitRect;
      if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return caption;
    }
    return null;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const state = useEditor.getState();
    const p = toFrame(event.clientX, event.clientY);
    const target = hit(p.x, p.y);
    if (state.editingId) finishEditing();
    if (state.tool === "text") {
      event.preventDefault();
      if (target) {
        state.select([target.id]);
        state.setEditing(target.id);
      } else createCaption({ x: Math.min(1, Math.max(0, p.x / frameW)), y: Math.min(1, Math.max(0, p.y / frameH)) });
      return;
    }
    if (!target) {
      if (!event.shiftKey) state.select([]);
      return;
    }
    event.preventDefault();
    let ids = state.selection;
    if (event.shiftKey) ids = ids.includes(target.id) ? ids.filter((id) => id !== target.id) : [...ids, target.id];
    else if (!ids.includes(target.id)) ids = [target.id];
    state.select(ids);
    if (event.detail >= 2 && !event.shiftKey) {
      state.setEditing(target.id);
      return;
    }
    // Drag to move every selected caption that is on screen.
    const moving = state.project.captions.filter((c) => ids.includes(c.id) && visible.some((v) => v.id === c.id));
    const start = new Map(moving.map((c) => [c.id, { x: c.x, y: c.y }]));
    const primary = start.get(target.id)!;
    const key = `g:monitor-move:${++gestureId.current}`;
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    let moved = false;
    const move = (e: PointerEvent) => {
      const q = toFrame(e.clientX, e.clientY);
      let dx = (q.x - p.x) / frameW;
      let dy = (q.y - p.y) / frameH;
      if (!moved && Math.hypot(q.x - p.x, q.y - p.y) * rect.scale < 3) return;
      moved = true;
      // Snap the grabbed caption's centre to the frame's centre lines (Alt turns snapping off).
      const threshold = 6 / rect.scale;
      let v = false;
      let h = false;
      if (!e.altKey && useEditor.getState().snapping) {
        if (Math.abs((primary.x + dx - 0.5) * frameW) < threshold) {
          dx = 0.5 - primary.x;
          v = true;
        }
        if (Math.abs((primary.y + dy - 0.5) * frameH) < threshold) {
          dy = 0.5 - primary.y;
          h = true;
        }
      }
      if (e.shiftKey) {
        if (Math.abs(dx * frameW) > Math.abs(dy * frameH)) dy = 0;
        else dx = 0;
      }
      setGuides({ v, h });
      useEditor.getState().update((draft) => {
        for (const c of draft.captions) {
          const s = start.get(c.id);
          if (!s) continue;
          c.x = s.x + dx;
          c.y = s.y + dy;
        }
      }, key);
    };
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      setGuides({ v: false, h: false });
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  const onHandleDown = (event: React.PointerEvent, caption: Caption, layout: CaptionLayout, handle: Handle) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    const cx0 = caption.x * frameW;
    const cy0 = caption.y * frameH;
    const p = toFrame(event.clientX, event.clientY);
    const startDistance = Math.max(4, Math.hypot(p.x - cx0, p.y - cy0));
    const startStyle = caption.style;
    const key = `g:monitor-handle:${++gestureId.current}`;
    void layout;
    const move = (e: PointerEvent) => {
      const q = toFrame(e.clientX, e.clientY);
      useEditor.getState().update((draft) => {
        const c = draft.captions.find((x) => x.id === caption.id);
        if (!c) return;
        if (handle === "w" || handle === "e") {
          // Wrap width, symmetric around the centre.
          c.style.maxWidth = Math.min(1, Math.max(0.05, (Math.abs(q.x - cx0) * 2) / frameW));
        } else {
          const factor = Math.max(0.05, Math.hypot(q.x - cx0, q.y - cy0) / startDistance);
          c.style = scaleStyle(startStyle, factor);
        }
      }, key);
    };
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      const updated = useEditor.getState().project.captions.find((c) => c.id === caption.id);
      if (updated) useEditor.getState().set({ lastStyle: updated.style });
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  const onMove = (event: React.PointerEvent) => {
    if (event.buttons) return;
    const p = toFrame(event.clientX, event.clientY);
    const target = hit(p.x, p.y);
    setHoverId(target?.id ?? null);
  };

  const screen = (r: Rect) => ({ left: r.x * rect.scale, top: r.y * rect.scale, width: r.w * rect.scale, height: r.h * rect.scale });
  const editing = editingId ? captions.find((c) => c.id === editingId) : null;
  const editingLayout = editing ? layoutFor(editing, frameW, frameH, renderEpoch()) : null;

  return (
    <div ref={layer} className={cx("monitor__overlay", tool === "text" && "monitor__overlay--text")} onPointerDown={onPointerDown} onPointerMove={onMove} onPointerLeave={() => setHoverId(null)}>
      {safeZones ? <SafeZones frameW={frameW} frameH={frameH} /> : null}
      {visible.map((caption) => {
        const layout = layouts.get(caption.id);
        if (!layout) return null;
        const selected = selection.includes(caption.id);
        if (!selected && hoverId !== caption.id) return null;
        const box = screen(inflate(layout.hitRect, 2 / rect.scale));
        return (
          <div key={caption.id} className={cx("sel-box", !selected && "sel-box--hover")} style={box}>
            {selected && selection.length === 1 && editingId !== caption.id
              ? (["nw", "ne", "sw", "se", "w", "e"] as Handle[]).map((handle) => (
                  <span
                    key={handle}
                    className={`sel-box__handle sel-box__handle--${handle}`}
                    title={handle === "w" || handle === "e" ? "Drag: wrap width" : "Drag: scale"}
                    style={{
                      left: handle.includes("w") ? 0 : handle.includes("e") ? "100%" : "50%",
                      top: handle === "w" || handle === "e" ? "50%" : handle.includes("n") ? 0 : "100%",
                    }}
                    onPointerDown={(e) => onHandleDown(e, caption, layout, handle)}
                  />
                ))
              : null}
          </div>
        );
      })}
      {guides.v ? <div className="guide guide--v" style={{ left: rect.width / 2 }} /> : null}
      {guides.h ? <div className="guide guide--h" style={{ top: rect.height / 2 }} /> : null}
      {editing && editingLayout ? <TextEditor caption={editing} anchor={screen(editingLayout.hitRect)} frameHeight={rect.height} /> : null}
    </div>
  );
}

/** TikTok's UI covers the right-hand buttons and the bottom caption area (9:16 at 1080×1920). */
function SafeZones({ frameW, frameH }: { frameW: number; frameH: number }) {
  const rect = React.useContext(FrameContext);
  const portrait = frameH > frameW;
  const zones = portrait
    ? [
        { label: "Top bar", x: 0, y: 0, w: 1, h: 0.075 },
        { label: "Buttons", x: 0.86, y: 0.42, w: 0.14, h: 0.43 },
        { label: "Caption & sound", x: 0, y: 0.8, w: 0.86, h: 0.2 },
      ]
    : [{ label: "Bottom UI", x: 0, y: 0.82, w: 1, h: 0.18 }];
  return (
    <>
      {zones.map((zone) => (
        <div key={zone.label} className="safe-zone" style={{ left: zone.x * rect.width, top: zone.y * rect.height, width: zone.w * rect.width, height: zone.h * rect.height }}>
          <span className="safe-zone__label">{zone.label}</span>
        </div>
      ))}
    </>
  );
}

function TextEditor({ caption, anchor, frameHeight }: { caption: Caption; anchor: { left: number; top: number; width: number; height: number }; frameHeight: number }) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const session = React.useRef(Math.random().toString(36).slice(2));
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [caption.id]);
  const setText = (text: string) => {
    useEditor.getState().update((draft) => {
      const c = draft.captions.find((x) => x.id === caption.id);
      if (c) c.text = text;
    }, `g:type:${caption.id}:${session.current}`);
  };
  const insert = (emoji: string) => {
    const element = ref.current;
    if (!element) return;
    const { selectionStart, selectionEnd, value } = element;
    const next = value.slice(0, selectionStart) + emoji + value.slice(selectionEnd);
    setText(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(selectionStart + emoji.length, selectionStart + emoji.length);
    });
  };
  // Below the caption, or above it when there's no room.
  const below = anchor.top + anchor.height + 150 < frameHeight;
  const top = below ? anchor.top + anchor.height + 8 : Math.max(4, anchor.top - 150);
  return (
    <div className="editor-pop" style={{ left: anchor.left + anchor.width / 2, top }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={caption.text}
        placeholder="Type a caption… Win + . for emoji"
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            finishEditing();
          }
        }}
        onBlur={(e) => {
          // Clicks inside the popup (emoji bar) keep editing.
          if (!(e.relatedTarget instanceof Node && e.currentTarget.parentElement?.contains(e.relatedTarget))) finishEditing();
        }}
      />
      <EmojiBar onPick={insert} />
      <div className="editor-pop__hint">
        <span>Enter: new line</span>
        <span>Esc or Ctrl+Enter: done</span>
      </div>
    </div>
  );
}

// ---------------- notes + transport ----------------

function MonitorNote() {
  const clipMedia = usePlayback((s) => clipAt(useEditor.getState().project.clips, s.time)?.mediaId ?? null);
  const info = useEditor((s) => s.project.media.find((m) => m.id === clipMedia)?.info);
  const status = useMedia((s) => (clipMedia ? s.status[clipMedia] : undefined));
  const missing = useMedia((s) => (clipMedia ? !!s.missing[clipMedia] : false));
  if (!clipMedia) return null;
  if (missing)
    return (
      <div className="monitor__note monitor__note--error">
        <RiErrorWarningLine size={14} /> Media offline: relink it in the Project panel
      </div>
    );
  if (info && !info.browserPlayable) {
    if (status?.proxy === "error")
      return (
        <div className="monitor__note monitor__note--error">
          <RiErrorWarningLine size={14} /> Couldn't make a preview of this file ({info.video?.codec})
        </div>
      );
    if (status?.proxy !== "ready")
      return (
        <div className="monitor__note">
          <RiLoader4Line size={14} className="spin" /> Making a preview copy ({info.video?.codec}) {Math.round((status?.proxyProgress ?? 0) * 100)}%
        </div>
      );
  }
  return null;
}

function TimeReadout() {
  const time = usePlayback((s) => s.time);
  const rate = useEditor((s) => s.project.sequence);
  return <span className="monitor__time">{formatTimecode(time, rate)}</span>;
}

function Transport() {
  const playing = usePlayback((s) => s.playing);
  const rate = useEditor((s) => s.project.sequence);
  const total = useEditor((s) => (s.project.clips.length ? videoEnd(s.project) : contentEnd(s.project)));
  const safeZones = useEditor((s) => s.safeZones);
  const [muted, setMuted] = useMuted();
  return (
    <div className="monitor__bar">
      <TimeReadout />
      <div className="monitor__spacer" />
      <IconButton label="Previous edit" shortcut="↑" onClick={() => jumpEdit(-1)}>
        <RiSkipBackFill size={15} />
      </IconButton>
      <IconButton label="Back one frame" shortcut="←" onClick={() => stepFrames(-1)}>
        <RiArrowLeftSLine size={18} />
      </IconButton>
      <IconButton label={playing ? "Pause" : "Play"} shortcut="Space" onClick={togglePlay}>
        {playing ? <RiPauseFill size={18} /> : <RiPlayFill size={18} />}
      </IconButton>
      <IconButton label="Forward one frame" shortcut="→" onClick={() => stepFrames(1)}>
        <RiArrowRightSLine size={18} />
      </IconButton>
      <IconButton label="Next edit" shortcut="↓" onClick={() => jumpEdit(1)}>
        <RiSkipForwardFill size={15} />
      </IconButton>
      <div className="monitor__spacer" />
      <IconButton label={muted ? "Unmute preview" : "Mute preview"} on={muted} onClick={() => setMuted(!muted)}>
        {muted ? <RiVolumeMuteLine size={16} /> : <RiVolumeUpLine size={16} />}
      </IconButton>
      <IconButton label="TikTok safe zones" on={safeZones} onClick={() => useEditor.getState().set({ safeZones: !safeZones })}>
        <RiLayoutGridLine size={16} />
      </IconButton>
      <span className="monitor__time monitor__time--total">{formatTimecode(total, rate)}</span>
    </div>
  );
}

const mutedStore = { value: false, listeners: new Set<() => void>() };
function useMuted(): [boolean, (v: boolean) => void] {
  const value = React.useSyncExternalStore(
    (l) => {
      mutedStore.listeners.add(l);
      return () => mutedStore.listeners.delete(l);
    },
    () => mutedStore.value,
  );
  return [
    value,
    (v) => {
      mutedStore.value = v;
      for (const l of mutedStore.listeners) l();
    },
  ];
}

export function Monitor() {
  const stage = React.useRef<HTMLDivElement>(null);
  const sequence = useEditor((s) => s.project.sequence);
  const mediaIds = useEditor((s) => [...new Set(s.project.clips.map((c) => c.mediaId))].join(","));
  const [muted] = useMuted();
  const frameW = sequence?.width ?? 1080;
  const frameH = sequence?.height ?? 1920;
  const rect = useFrameRect(stage, frameW, frameH);
  return (
    <div className="monitor">
      <div className="panel__tabs">
        <span className="panel__tab panel__tab--active">Program</span>
        <span className="panel__tabs-spacer" />
        {sequence ? (
          <span className="section__hint">
            {sequence.width}×{sequence.height} · {(sequence.fpsNum / sequence.fpsDen).toFixed(sequence.fpsDen === 1 ? 0 : 3)} fps
          </span>
        ) : null}
      </div>
      <div ref={stage} className="monitor__stage">
        {sequence ? (
          <FrameContext.Provider value={rect}>
            <div className="monitor__frame" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
              {mediaIds
                ? mediaIds.split(",").map((id) => <MediaVideo key={id} id={id} muted={muted} />)
                : null}
              <CaptionCanvas frameW={frameW} frameH={frameH} />
              <Overlay frameW={frameW} frameH={frameH} />
            </div>
            <MonitorNote />
          </FrameContext.Provider>
        ) : (
          <div className="monitor__empty">
            <RiFileVideoLine size={40} />
            <div>Import a video to start. Its size and frame rate become the sequence.</div>
            <button type="button" className="btn btn--primary" onClick={() => void importWithDialog()}>
              Import video…
            </button>
          </div>
        )}
      </div>
      <Transport />
    </div>
  );
}

