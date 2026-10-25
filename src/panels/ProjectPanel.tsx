/** Project panel: imported media (with status) and a list of every caption to jump to. */
import { RiAddLine, RiDeleteBinLine, RiErrorWarningLine, RiFileVideoLine, RiLinkM, RiLoader4Line, RiFolderOpenLine } from "@remixicon/react";
import * as React from "react";

import { revealCaption } from "../app/actions";
import { api, dirname } from "../app/api";
import { importByPath, importFiles, importWithDialog, placeMedia, relinkMedia, removeMedia, useMedia } from "../app/media";
import { formatTimecode } from "../model/time";
import { useEditor } from "../state/store";
import type { MediaRef } from "../state/types";
import { IconButton, cx, stopKeys } from "../ui/controls";

function fps(ref: MediaRef): string {
  const v = ref.info.video!;
  const value = v.fpsNum / v.fpsDen;
  return `${value.toFixed(v.fpsDen === 1 ? 0 : 3)}${v.vfr ? " VFR" : ""}`;
}

function mb(bytes: number): string {
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function MediaStatusBadge({ id, info }: Pick<MediaRef, "id" | "info">) {
  const status = useMedia((s) => s.status[id]);
  const missing = useMedia((s) => !!s.missing[id]);
  if (missing)
    return (
      <span className="project__badge project__badge--error">
        <RiErrorWarningLine size={11} /> Offline
      </span>
    );
  if (status?.proxy === "running" || status?.proxy === "pending")
    return (
      <span className="project__badge project__badge--warn">
        <RiLoader4Line size={11} className="spin" /> Preview {Math.round(status.proxyProgress * 100)}%
      </span>
    );
  if (status?.peaks === "running" || status?.peaks === "pending")
    return (
      <span className="project__badge">
        <RiLoader4Line size={11} className="spin" /> Waveform
      </span>
    );
  if (!info.audio) return <span className="project__badge">No audio</span>;
  return null;
}

function PathImport() {
  const [path, setPath] = React.useState("");
  return (
    <form
      className="project__path"
      onSubmit={(e) => {
        e.preventDefault();
        void importByPath(path).then(() => setPath(""));
      }}
    >
      <label className="field" style={{ flex: 1 }}>
        <input className="field__input" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={stopKeys} placeholder='Or paste a file path (Shift+right-click › "Copy as path")' aria-label="Video file path" />
      </label>
      <button type="submit" className="btn" disabled={!path.trim()}>
        Open
      </button>
    </form>
  );
}

function MediaList() {
  const media = useEditor((s) => s.project.media);
  const clips = useEditor((s) => s.project.clips);
  const usedIds = React.useMemo(() => new Set(clips.map((c) => c.mediaId)), [clips]);
  const importing = useMedia((s) => s.importing);
  const missing = useMedia((s) => s.missing);
  const [over, setOver] = React.useState(false);
  const drop = {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        setOver(true);
      }
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
    },
  };
  return (
    <div className="project" {...drop}>
      <div className="project__toolbar">
        <button type="button" className="btn btn--primary" onClick={() => void importWithDialog()} disabled={importing}>
          {importing ? <RiLoader4Line size={15} className="spin" /> : <RiAddLine size={15} />} Import video…
        </button>
        <span className="section__hint">{media.length ? `${media.length} item${media.length > 1 ? "s" : ""}` : ""}</span>
      </div>
      {media.length ? (
        <table className="project__table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Frame rate</th>
              <th>Duration</th>
              <th>Audio</th>
              <th>File</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {media.map((ref) => {
              const v = ref.info.video!;
              return (
                <tr key={ref.id} onDoubleClick={() => placeMedia(ref.id)} title={`${ref.path}\nDouble-click: add to the end of the timeline`}>
                  <td>
                    <span className="project__name">
                      <RiFileVideoLine size={14} />
                      <span>{ref.name}</span>
                      {!usedIds.has(ref.id) ? <span className="project__badge">Unused</span> : null}
                      <MediaStatusBadge id={ref.id} info={ref.info} />
                    </span>
                  </td>
                  <td>
                    {v.width}×{v.height}
                    {v.rotation ? ` ↻${v.rotation}°` : ""}
                  </td>
                  <td>{fps(ref)}</td>
                  <td>{formatTimecode(v.duration, v)}</td>
                  <td>{ref.info.audio ? `${ref.info.audio.codec} ${Math.round(ref.info.audio.sampleRate / 1000)}k` : "—"}</td>
                  <td>
                    {v.codec} · {mb(ref.info.size)}
                  </td>
                  <td>
                    <span style={{ display: "flex", gap: 2 }}>
                      {missing[ref.id] ? (
                        <IconButton small label="Relink media" onClick={() => void relinkMedia(ref.id)}>
                          <RiLinkM size={14} />
                        </IconButton>
                      ) : (
                        <IconButton small label="Show in folder" onClick={() => void api.reveal(ref.path)}>
                          <RiFolderOpenLine size={14} />
                        </IconButton>
                      )}
                      <IconButton small label="Remove from project" onClick={() => removeMedia(ref.id)}>
                        <RiDeleteBinLine size={14} />
                      </IconButton>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <div className={cx("project__drop", over && "project__drop--over")} style={media.length ? { flex: "none", minHeight: 0, padding: 12 } : undefined}>
        {media.length ? null : <RiFileVideoLine size={32} />}
        <div>{media.length ? "Drop more videos here" : "Drop a video here, or import it. The file is read in place (no copy) when picked or pasted as a path."}</div>
        <PathImport />
      </div>
    </div>
  );
}

function CaptionList() {
  const captions = useEditor((s) => s.project.captions);
  const selection = useEditor((s) => s.selection);
  const rate = useEditor((s) => s.project.sequence);
  const sorted = React.useMemo(() => [...captions].sort((a, b) => a.start - b.start || a.track - b.track), [captions]);
  if (!sorted.length) return <div className="props__empty">No captions yet. Press T and click the monitor.</div>;
  return (
    <ul className="captions-list">
      {sorted.map((c) => (
        <li
          key={c.id}
          className={cx("captions-list__item", selection.includes(c.id) && "is-selected")}
          onClick={(e) => {
            const state = useEditor.getState();
            state.select(e.shiftKey || e.ctrlKey ? (selection.includes(c.id) ? selection.filter((id) => id !== c.id) : [...selection, c.id]) : [c.id]);
            revealCaption(c.id);
          }}
          onDoubleClick={() => useEditor.getState().setEditing(c.id)}
        >
          <span className="captions-list__time">{formatTimecode(c.start, rate)}</span>
          <span className="captions-list__text">{c.text || "(empty)"}</span>
          <span className="captions-list__track">C{c.track + 1}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProjectPanel() {
  const [tab, setTab] = React.useState<"media" | "captions">("media");
  const count = useEditor((s) => s.project.captions.length);
  const savedPath = useEditor((s) => s.savedPath);
  return (
    <div className="panel panel--project">
      <div className="panel__tabs">
        <button type="button" className={cx("panel__tab", tab === "media" && "panel__tab--active")} onClick={() => setTab("media")}>
          Project
        </button>
        <button type="button" className={cx("panel__tab", tab === "captions" && "panel__tab--active")} onClick={() => setTab("captions")}>
          Captions{count ? ` (${count})` : ""}
        </button>
        <span className="panel__tabs-spacer" />
        {savedPath ? (
          <span className="section__hint" title={savedPath}>
            {dirname(savedPath)}
          </span>
        ) : null}
      </div>
      <div className="panel__body">{tab === "media" ? <MediaList /> : <CaptionList />}</div>
    </div>
  );
}
