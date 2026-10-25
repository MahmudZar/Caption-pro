/**
 * Export, browser side. The timeline is cut into spans where the set of visible captions stays
 * the same; each distinct span is drawn once into a transparent frame-sized PNG with the exact
 * editor renderer (fonts and Apple emoji preloaded first), then the server's ffmpeg lays that
 * caption track over the original video (see server/plan.ts).
 */
import type { ExportPlan, ExportQuality, ExportStatus } from "../../shared/types";
import { api } from "../app/api";
import { preloadEmoji, emojiFailed, imageKeyFor, splitRuns } from "../caption/emoji";
import { ensureFonts, renderEpoch } from "../caption/fonts";
import { drawCaption } from "../caption/render";
import { captionsAt, videoEnd } from "../model/edit";
import { EPS } from "../model/time";
import type { Caption, Project } from "../state/types";

export interface CaptionSpan {
  start: number;
  end: number;
  captions: Caption[];
}

/** Spans from 0 to `end` with the captions visible in each (empty spans included). */
export function captionSpans(captions: readonly Caption[], end: number): CaptionSpan[] {
  const points = new Set<number>([0, end]);
  for (const c of captions) {
    if (c.start > 0 && c.start < end) points.add(c.start);
    if (c.end > 0 && c.end < end) points.add(c.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const spans: CaptionSpan[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const stop = sorted[i + 1];
    if (stop - start <= EPS) continue;
    const visible = captionsAt(captions, (start + stop) / 2).filter((c) => c.text.trim());
    const last = spans[spans.length - 1];
    if (last && sameSet(last.captions, visible)) last.end = stop;
    else spans.push({ start, end: stop, captions: visible });
  }
  return spans;
}

function sameSet(a: Caption[], b: Caption[]): boolean {
  return a.length === b.length && a.every((c, i) => c.id === b[i].id);
}

export interface ExportProgress {
  phase: "prepare" | "render" | "encode" | "done" | "error" | "cancelled";
  progress: number;
  message: string;
  status?: ExportStatus;
  warnings: string[];
}

export interface ExportHandle {
  cancel: () => void;
  done: Promise<ExportProgress>;
}

export function startExport(project: Project, output: string, quality: ExportQuality, onProgress: (p: ExportProgress) => void): ExportHandle {
  let cancelled = false;
  let jobId: string | null = null;
  const warnings: string[] = [];
  const report = (p: Omit<ExportProgress, "warnings">) => {
    const full = { ...p, warnings };
    onProgress(full);
    return full;
  };

  const run = async (): Promise<ExportProgress> => {
    const sequence = project.sequence;
    if (!sequence) throw new Error("Nothing to export: import a video first.");
    if (!project.clips.length) throw new Error("The timeline has no video clip.");
    const end = videoEnd(project);
    const W = sequence.width;
    const H = sequence.height;
    report({ phase: "prepare", progress: 0, message: "Loading fonts and Apple emoji…" });
    const used = project.captions.filter((c) => c.start < end - EPS && c.text.trim());
    if (project.captions.some((c) => c.start >= end - EPS && c.text.trim())) warnings.push("Captions that start after the end of the video are not in the export.");
    await ensureFonts(used.map((c) => ({ style: c.style, text: c.text })));
    await preloadEmoji(used.map((c) => c.text));
    const missingEmoji = new Set<string>();
    for (const c of used) {
      for (const run of splitRuns(c.text)) {
        if (run.kind !== "emoji") continue;
        const key = imageKeyFor(run.text);
        if (!key) missingEmoji.add(`${run.text} (no Apple version)`);
        else if (emojiFailed(key)) missingEmoji.add(`${run.text} (image failed to load)`);
      }
    }
    if (missingEmoji.size) warnings.push(`Emoji drawn as plain text: ${[...missingEmoji].join(", ")}`);
    if (cancelled) return report({ phase: "cancelled", progress: 0, message: "Cancelled" });

    const spans = captionSpans(project.captions, end);
    const job = await api.createExport();
    jobId = job.id;

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d")!;
    const epoch = renderEpoch();
    const blank = await canvas.convertToBlob({ type: "image/png" });
    await api.uploadExportImage(job.id, "blank", blank);

    const imageIndex = new Map<string, number>();
    const segments: ExportPlan["segments"] = [];
    const drawn = spans.filter((s) => s.captions.length);
    let done = 0;
    for (const span of spans) {
      if (cancelled) return report({ phase: "cancelled", progress: 0, message: "Cancelled" });
      if (!span.captions.length) {
        segments.push({ start: span.start, end: span.end, image: null });
        continue;
      }
      const key = span.captions.map((c) => c.id).join(",");
      let index = imageIndex.get(key);
      if (index === undefined) {
        index = imageIndex.size;
        imageIndex.set(key, index);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        for (const caption of span.captions) drawCaption(ctx, caption, W, H, epoch, { scale: 1 });
        const png = await canvas.convertToBlob({ type: "image/png" });
        await api.uploadExportImage(job.id, index, png);
      }
      segments.push({ start: span.start, end: span.end, image: index });
      done += 1;
      report({ phase: "render", progress: done / Math.max(1, drawn.length), message: `Drawing captions ${done}/${drawn.length}` });
    }

    const plan: ExportPlan = {
      output,
      width: W,
      height: H,
      fpsNum: sequence.fpsNum,
      fpsDen: sequence.fpsDen,
      clips: project.clips.map((c) => ({ mediaId: c.mediaId, start: c.start, srcIn: c.srcIn, srcOut: c.srcOut })),
      segments,
      quality,
    };
    let status = await api.startExport(job.id, plan);
    report({ phase: "encode", progress: 0, message: "Encoding…", status });
    while (status.state === "encoding" || status.state === "waiting") {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (cancelled) return report({ phase: "cancelled", progress: 0, message: "Cancelled" });
      status = await api.exportStatus(job.id);
      report({ phase: "encode", progress: status.progress, message: `Encoding ${Math.round(status.progress * 100)}%`, status });
    }
    if (status.state === "done") return report({ phase: "done", progress: 1, message: "Done", status });
    if (status.state === "cancelled") return report({ phase: "cancelled", progress: 0, message: "Cancelled", status });
    throw new Error(status.error ?? "Export failed");
  };

  const done = run().catch((error: unknown) => report({ phase: "error", progress: 0, message: error instanceof Error ? error.message : String(error) }));
  return {
    cancel: () => {
      cancelled = true;
      if (jobId) void api.cancelExport(jobId).catch(() => undefined);
    },
    done,
  };
}
