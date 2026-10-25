import { RiCloseLine, RiFolderOpenLine, RiCheckLine } from "@remixicon/react";
import * as React from "react";

import type { ExportQuality } from "../../shared/types";
import { api, basename, dirname, stripExtension } from "../app/api";
import { useMedia } from "../app/media";
import { videoEnd } from "../model/edit";
import { formatTimecode } from "../model/time";
import { useEditor } from "../state/store";
import { IconButton, SelectField, stopKeys } from "../ui/controls";

import { startExport, type ExportHandle, type ExportProgress } from "./exporter";

const QUALITY_OPTIONS: Array<{ value: ExportQuality; label: string }> = [
  { value: "lossless", label: "Visually lossless (CRF 14) · recommended" },
  { value: "high", label: "High (CRF 17)" },
  { value: "small", label: "Smaller file (CRF 21)" },
];

function sep(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

async function defaultOutput(): Promise<string> {
  const { project, savedPath } = useEditor.getState();
  const source = project.media.find((m) => m.id === project.clips[0]?.mediaId);
  const dir = source ? dirname(source.path) : savedPath ? dirname(savedPath) : "";
  const name = stripExtension(source?.name ?? project.name ?? "export");
  const s = sep(dir || "\\");
  for (let i = 1; i < 100; i += 1) {
    const candidate = `${dir}${s}${name} captions${i > 1 ? ` (${i})` : ""}.mp4`;
    const { exists } = await api.exists(candidate).catch(() => ({ exists: false }));
    if (!exists) return candidate;
  }
  return `${dir}${s}${name} captions ${Date.now()}.mp4`;
}

export function ExportDialog() {
  const project = useEditor((s) => s.project);
  const missing = useMedia((s) => s.missing);
  const [output, setOutput] = React.useState("");
  const [quality, setQuality] = React.useState<ExportQuality>("lossless");
  const [progress, setProgress] = React.useState<ExportProgress | null>(null);
  const handle = React.useRef<ExportHandle | null>(null);
  const close = () => useEditor.getState().set({ exportOpen: false });

  React.useEffect(() => {
    void defaultOutput().then(setOutput);
  }, []);

  const running = progress && (progress.phase === "prepare" || progress.phase === "render" || progress.phase === "encode");
  React.useEffect(() => {
    if (!running) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [running]);

  const sequence = project.sequence;
  const source = project.media.find((m) => m.id === project.clips[0]?.mediaId);
  const v = source?.info.video;
  const duration = videoEnd(project);
  const captionCount = project.captions.filter((c) => c.start < duration && c.text.trim()).length;
  const offline = project.clips.some((c) => missing[c.mediaId]);
  const edited =
    project.clips.length !== 1 || Math.abs(project.clips[0].start) > 1e-6 || project.clips[0].srcIn > 1e-3 || (v ? project.clips[0].srcOut < v.duration - 0.5 * (v.fpsDen / v.fpsNum) : false);

  const begin = () => {
    if (!output.trim()) return;
    setProgress({ phase: "prepare", progress: 0, message: "Starting…", warnings: [] });
    handle.current = startExport(project, output.trim(), quality, setProgress);
  };

  const browse = async () => {
    const picked = await api.pickExport(basename(output) || "export.mp4", dirname(output) || undefined).catch(() => ({ path: null }));
    if (picked.path) setOutput(picked.path);
  };

  const result = progress?.status?.result;
  return (
    <div className="dialog-backdrop" role="presentation" onKeyDown={stopKeys}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <div className="dialog__head">
          <h2 id="export-title" className="dialog__title">
            Export video
          </h2>
          <IconButton label="Close" onClick={() => (running ? undefined : close())} disabled={!!running}>
            <RiCloseLine size={18} />
          </IconButton>
        </div>
        <div className="dialog__body">
          {!progress || progress.phase === "error" || progress.phase === "cancelled" ? (
            <>
              <div>
                <span className="dialog__label">Save as</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <label className="field" style={{ flex: 1 }}>
                    <input className="field__input" value={output} onChange={(e) => setOutput(e.target.value)} aria-label="Output file" />
                  </label>
                  <button type="button" className="btn" onClick={() => void browse()}>
                    Browse…
                  </button>
                </div>
              </div>
              <div>
                <span className="dialog__label">Quality (H.264, MP4)</span>
                <SelectField label="Quality" value={quality} options={QUALITY_OPTIONS} onChange={setQuality} />
              </div>
              <dl className="dialog__facts">
                <dt>Size</dt>
                <dd>{sequence ? `${sequence.width}×${sequence.height} (same as the source)` : "—"}</dd>
                <dt>Frame rate</dt>
                <dd>{v ? `${(v.fpsNum / v.fpsDen).toFixed(v.fpsDen === 1 ? 0 : 3)} fps${v.vfr ? ", variable: original frame timing kept" : ", original timing kept"}` : "—"}</dd>
                <dt>Length</dt>
                <dd>{formatTimecode(duration, sequence)}</dd>
                <dt>Audio</dt>
                <dd>{!source?.info.audio ? "None in the source" : edited ? "Re-encoded AAC 320 kb/s (the cut timeline needs it)" : source.info.audio.codec === "aac" || source.info.audio.codec === "mp3" ? "Copied untouched" : "AAC 320 kb/s"}</dd>
                <dt>Captions</dt>
                <dd>{captionCount ? `${captionCount} burned in, Apple emoji included` : "None: the video is copied without re-encoding"}</dd>
              </dl>
              {offline ? <p className="dialog__error">Some media is offline. Relink it in the Project panel first.</p> : null}
              {progress?.phase === "error" ? <pre className="dialog__error">{progress.message}</pre> : null}
              {progress?.phase === "cancelled" ? <p className="section__hint">Export cancelled. Nothing was written.</p> : null}
            </>
          ) : progress.phase === "done" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                <RiCheckLine size={20} color="var(--success-400)" /> Exported in {progress.status?.elapsed?.toFixed(1)} s
              </div>
              <dl className="dialog__facts">
                <dt>File</dt>
                <dd style={{ overflowWrap: "anywhere" }}>{progress.status?.output}</dd>
                {result?.video ? (
                  <>
                    <dt>Video</dt>
                    <dd>
                      {result.video.width}×{result.video.height} · {(result.video.fpsNum / result.video.fpsDen).toFixed(result.video.fpsDen === 1 ? 0 : 3)} fps · {result.video.codec}
                      {result.video.bitRate ? ` · ${(result.video.bitRate / 1e6).toFixed(1)} Mb/s` : ""}
                    </dd>
                    <dt>Length</dt>
                    <dd>{result.duration.toFixed(3)} s</dd>
                    <dt>Audio</dt>
                    <dd>{result.audio ? `${result.audio.codec} ${Math.round(result.audio.sampleRate / 1000)} kHz` : "none"}</dd>
                    <dt>File size</dt>
                    <dd>{(result.size / 1e6).toFixed(1)} MB</dd>
                  </>
                ) : null}
              </dl>
              {progress.status?.log ? (
                <ul className="dialog__notes">
                  {progress.status.log.split("\n").map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <>
              <div>{progress.message}</div>
              <div className="progress">
                <div className="progress__bar" style={{ width: `${Math.round((progress.phase === "encode" ? progress.progress : progress.phase === "render" ? progress.progress * 0.1 : 0) * 100)}%` }} />
              </div>
              {progress.status?.log ? (
                <ul className="dialog__notes">
                  {progress.status.log.split("\n").map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          {progress?.warnings.length ? (
            <ul className="dialog__notes">
              {progress.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="dialog__foot">
          {running ? (
            <button type="button" className="btn" onClick={() => handle.current?.cancel()}>
              Cancel export
            </button>
          ) : progress?.phase === "done" ? (
            <>
              <button type="button" className="btn" onClick={() => progress.status?.output && void api.reveal(progress.status.output)}>
                <RiFolderOpenLine size={15} /> Show in folder
              </button>
              <button type="button" className="btn btn--primary" onClick={close}>
                Close
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" onClick={begin} disabled={!output.trim() || offline || !project.clips.length}>
                Export
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
