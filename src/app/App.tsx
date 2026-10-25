import { RiArrowGoBackLine, RiArrowGoForwardLine, RiCursorLine, RiDownload2Line, RiFileAddLine, RiFolderOpenLine, RiSave3Line, RiScissorsCutLine, RiText, RiCloseLine } from "@remixicon/react";
import * as React from "react";

import { loadEmojiMap } from "../caption/emoji";
import { ExportDialog } from "../export/ExportDialog";
import { Monitor } from "../monitor/Monitor";
import { ProjectPanel } from "../panels/ProjectPanel";
import { Properties } from "../panels/Properties";
import { useEditor, useToasts } from "../state/store";
import { Timeline } from "../timeline/Timeline";
import { IconButton, cx, stopKeys } from "../ui/controls";

import { importFiles } from "./media";
import { hydrate, newProject, openProject, saveProject, startAutosave } from "./project";
import { installShortcuts } from "./shortcuts";
import { watchOtherTabs } from "./tabs";

function TopBar() {
  const name = useEditor((s) => s.project.name);
  const dirty = useEditor((s) => s.project !== s.savedProject);
  const savedPath = useEditor((s) => s.savedPath);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const hasVideo = useEditor((s) => s.project.clips.length > 0);
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__logo">
          <RiText size={14} />
        </span>
        Caption Pro
      </div>
      <div className="topbar__divider" />
      <div className="topbar__project">
        <input
          className="topbar__name"
          aria-label="Project name"
          value={draft ?? name}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null && draft.trim() && draft !== name) useEditor.getState().update((p) => void (p.name = draft.trim()));
            setDraft(null);
          }}
          onKeyDown={(e) => {
            stopKeys(e);
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          size={Math.max(8, (draft ?? name).length)}
        />
        <span className="topbar__state" title={savedPath ?? "Not saved to a file yet (autosaved)"}>
          {savedPath ? (dirty ? "Unsaved changes · autosaved" : "Saved") : "Autosaved · not saved to a file"}
        </span>
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__group">
        <IconButton label="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
          <RiArrowGoBackLine size={16} />
        </IconButton>
        <IconButton label="Redo" shortcut="Ctrl+Shift+Z" disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
          <RiArrowGoForwardLine size={16} />
        </IconButton>
        <div className="topbar__divider" />
        <IconButton label="New project" shortcut="Ctrl+Alt+N" onClick={() => void newProject()}>
          <RiFileAddLine size={16} />
        </IconButton>
        <IconButton label="Open project" shortcut="Ctrl+O" onClick={() => void openProject()}>
          <RiFolderOpenLine size={16} />
        </IconButton>
        <IconButton label="Save project" shortcut="Ctrl+S (Shift: save as)" onClick={() => void saveProject(false)}>
          <RiSave3Line size={16} />
        </IconButton>
        <div className="topbar__divider" />
        <button type="button" className="btn btn--primary" disabled={!hasVideo} onClick={() => useEditor.getState().set({ exportOpen: true })} title="Export (Ctrl+M)">
          <RiDownload2Line size={15} /> Export
        </button>
      </div>
    </header>
  );
}

function Tools() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  return (
    <div className="tools" role="toolbar" aria-label="Tools">
      <IconButton label="Selection tool: select, move, trim" shortcut="V" on={tool === "select"} onClick={() => setTool("select")}>
        <RiCursorLine size={17} />
      </IconButton>
      <IconButton label="Razor tool: cut clips and captions" shortcut="C" on={tool === "razor"} onClick={() => setTool("razor")}>
        <RiScissorsCutLine size={17} />
      </IconButton>
      <IconButton label="Type tool: click the monitor to add a caption" shortcut="T" on={tool === "text"} onClick={() => setTool("text")}>
        <RiText size={17} />
      </IconButton>
    </div>
  );
}

function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx("toast", `toast--${t.kind}`)}>
          <span className="toast__text">{t.text}</span>
          <IconButton small label="Dismiss" onClick={() => useToasts.getState().dismiss(t.id)}>
            <RiCloseLine size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

const LAYOUT_KEY = "caption-pro:layout";

/** Draggable panel borders; sizes are remembered per browser. */
function useLayout() {
  const [layout, setLayout] = React.useState<{ left: number; right: number; timeline: number }>(() => {
    try {
      return { left: 300, right: 0.34, timeline: 0.42, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
    } catch {
      return { left: 300, right: 0.34, timeline: 0.42 };
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Private mode: sizes just aren't remembered.
    }
  }, [layout]);
  return [layout, setLayout] as const;
}

function Splitters({ host, layout, setLayout }: { host: React.RefObject<HTMLDivElement | null>; layout: { left: number; right: number; timeline: number }; setLayout: React.Dispatch<React.SetStateAction<{ left: number; right: number; timeline: number }>> }) {
  const [dragging, setDragging] = React.useState<string | null>(null);
  const element = host.current;
  const width = element?.clientWidth ?? 1;
  const height = element?.clientHeight ?? 1;
  const rightPx = layout.right * width;
  const timelinePx = layout.timeline * height;
  const start = (kind: "left" | "right" | "timeline") => (event: React.PointerEvent) => {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setDragging(kind);
    const rect = host.current!.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      setLayout((l) => {
        if (kind === "left") return { ...l, left: Math.max(240, Math.min(rect.width * 0.4, e.clientX - rect.left)) };
        if (kind === "right") return { ...l, right: Math.max(0.18, Math.min(0.6, (rect.right - e.clientX) / rect.width)) };
        return { ...l, timeline: Math.max(0.2, Math.min(0.75, (rect.bottom - e.clientY) / rect.height)) };
      });
    };
    const up = () => {
      setDragging(null);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return (
    <>
      <div className={cx("splitter splitter--col", dragging === "left" && "splitter--dragging")} style={{ left: layout.left + 4.5, top: 3, height: height - timelinePx - 6 }} onPointerDown={start("left")} />
      <div className={cx("splitter splitter--col", dragging === "right" && "splitter--dragging")} style={{ left: width - rightPx - 0.5, top: 3, bottom: 3 }} onPointerDown={start("right")} />
      <div className={cx("splitter splitter--row", dragging === "timeline" && "splitter--dragging")} style={{ top: height - timelinePx - 0.5, left: 3, width: width - rightPx - 6 }} onPointerDown={start("timeline")} />
    </>
  );
}

export function App() {
  const exportOpen = useEditor((s) => s.exportOpen);
  const hydrated = useEditor((s) => s.hydrated);
  const workspace = React.useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useLayout();
  const [, force] = React.useState(0);

  React.useEffect(() => {
    void loadEmojiMap();
    void hydrate();
    const stopAutosave = startAutosave();
    const stopShortcuts = installShortcuts();
    const stopTabs = watchOtherTabs();
    const resize = () => force((n) => n + 1);
    window.addEventListener("resize", resize);
    // Dropping a file anywhere imports it (instead of the browser opening it).
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      void importFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", drop);
    return () => {
      stopAutosave();
      stopShortcuts();
      stopTabs();
      window.removeEventListener("resize", resize);
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", drop);
    };
  }, []);
  React.useLayoutEffect(() => force((n) => n + 1), []);

  return (
    <div className="app">
      <TopBar />
      <div
        ref={workspace}
        className="workspace"
        style={{ "--left-w": `${layout.left}px`, "--right-w": `${layout.right * 100}%`, "--timeline-h": `${layout.timeline * 100}%` } as React.CSSProperties}
      >
        <Properties />
        <ProjectPanel />
        <div className="panel panel--monitor">
          <Monitor />
        </div>
        <div className="panel panel--timeline">
          <Tools />
          <Timeline />
        </div>
        <Splitters host={workspace} layout={layout} setLayout={setLayout} />
      </div>
      {exportOpen ? <ExportDialog /> : null}
      <Toasts />
      {!hydrated ? <div className="dialog-backdrop" style={{ background: "transparent" }} /> : null}
    </div>
  );
}
