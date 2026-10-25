/** Editing actions shared by the keyboard, the timeline, the monitor and the panels. */
import { captionSlotFree, captionsAt, clipAt, contentEnd, deleteItems, editPoints, findItem, freeCaptionTrack, nextCaptionStart, splitAt, videoEnd } from "../model/edit";
import { EPS, frameDuration, snapToFrame } from "../model/time";
import { goTo } from "../playback/engine";
import { DEFAULT_CAPTION_SECONDS } from "../state/defaults";
import { newId } from "../state/ids";
import { toast, useEditor, usePlayback, useView } from "../state/store";
import type { Caption, CaptionStyle } from "../state/types";

export function sequenceRate() {
  return useEditor.getState().project.sequence;
}

/** New caption at the playhead (or `time`), on the first free track, lasting up to 2 s. */
export function createCaption(options: { x?: number; y?: number; time?: number; track?: number; text?: string; style?: CaptionStyle } = {}): string | null {
  const { project, lastStyle, update, select, setEditing } = useEditor.getState();
  if (!project.sequence) {
    toast.info("Import a video first: captions take its size and frame rate.");
    return null;
  }
  const rate = project.sequence;
  const frame = frameDuration(rate);
  const start = snapToFrame(Math.max(0, options.time ?? usePlayback.getState().time), rate);
  const limit = videoEnd(project) > start + frame ? videoEnd(project) : start + DEFAULT_CAPTION_SECONDS;
  let end = snapToFrame(Math.min(start + DEFAULT_CAPTION_SECONDS, limit), rate);
  const preferred = options.track ?? 0;
  let track = preferred;
  if (!captionSlotFree(project, track, start, start + frame, new Set())) track = freeCaptionTrack(project, start, start + frame, preferred);
  end = Math.min(end, nextCaptionStart(project, track, start + EPS));
  if (end - start < frame - EPS) end = start + frame;
  const id = newId();
  const caption: Caption = {
    id,
    kind: "caption",
    track,
    start,
    end,
    text: options.text ?? "",
    x: options.x ?? 0.5,
    y: options.y ?? 0.2,
    style: structuredClone(options.style ?? lastStyle),
  };
  update((draft) => void draft.captions.push(caption), `g:create:${id}`);
  select([id]);
  setEditing(id);
  return id;
}

/** Leaving text editing: a caption that is still empty is removed as if it never existed. */
export function finishEditing(): void {
  const { editingId, project, past, setEditing, lastEdit } = useEditor.getState();
  setEditing(null);
  if (!editingId) return;
  const caption = project.captions.find((c) => c.id === editingId);
  if (!caption || caption.text.trim()) return;
  const created = lastEdit === null && past.length > 0 && !past[past.length - 1].captions.some((c) => c.id === editingId);
  if (created) {
    // Drop the creation step from history too.
    useEditor.setState({ project: past[past.length - 1], past: past.slice(0, -1), selection: [] });
  } else {
    useEditor.getState().update((draft) => void (draft.captions = draft.captions.filter((c) => c.id !== editingId)));
  }
}

export function deleteSelection(ripple: boolean): void {
  const { selection, update, project } = useEditor.getState();
  if (!selection.length) return;
  let dropped = 0;
  update((draft) => void (dropped = deleteItems(draft, new Set(selection), ripple, project.sequence)));
  useEditor.getState().select([]);
  if (dropped) toast.info(`${dropped} caption${dropped > 1 ? "s" : ""} inside the removed part ${dropped > 1 ? "were" : "was"} removed too.`);
}

/** Ctrl+K / Shift+razor: cut every item under the playhead (or `time`). */
export function splitAll(time = usePlayback.getState().time): void {
  const { update, project } = useEditor.getState();
  const t = snapToFrame(time, project.sequence);
  let created: string[] = [];
  update((draft) => void (created = splitAt(draft, t, null, draft.sequence)));
  if (!created.length) useEditor.setState({ past: useEditor.getState().past.slice(0, -1), project });
}

/** Razor click on one item: cut it, or all items when `all` (Shift). */
export function splitItem(id: string, time: number, all: boolean): void {
  const { update, project } = useEditor.getState();
  const t = snapToFrame(time, project.sequence);
  let created: string[] = [];
  update((draft) => void (created = splitAt(draft, t, all ? null : new Set([id]), draft.sequence)));
  // A cut at an edge changes nothing: don't leave an empty undo step.
  if (!created.length) useEditor.setState({ past: useEditor.getState().past.slice(0, -1), project });
}

export function stepFrames(count: number): void {
  const rate = sequenceRate();
  const t = usePlayback.getState().time;
  goTo(Math.max(0, snapToFrame(t, rate) + count * frameDuration(rate)));
}

export function jumpEdit(direction: 1 | -1): void {
  const points = editPoints(useEditor.getState().project);
  const t = usePlayback.getState().time;
  const next = direction > 0 ? points.find((p) => p > t + 1e-4) : [...points].reverse().find((p) => p < t - 1e-4);
  if (next !== undefined) goTo(next);
}

export function goToEnd(): void {
  goTo(Math.max(0, contentEnd(useEditor.getState().project)));
}

// ---------------- clipboard (captions) ----------------

let clipboard: Caption[] = [];

export function copySelection(cut: boolean): void {
  const { project, selection } = useEditor.getState();
  const captions = project.captions.filter((c) => selection.includes(c.id));
  if (!captions.length) return;
  clipboard = structuredClone(captions);
  if (cut) deleteSelection(false);
}

/** Pastes copied captions at the playhead, keeping their spacing; free tracks are found per caption. */
export function paste(): void {
  if (!clipboard.length) return;
  const { update, select, project } = useEditor.getState();
  const rate = project.sequence;
  const base = Math.min(...clipboard.map((c) => c.start));
  const at = snapToFrame(usePlayback.getState().time, rate);
  const ids: string[] = [];
  update((draft) => {
    for (const source of clipboard) {
      const start = snapToFrame(at + (source.start - base), rate);
      const end = start + (source.end - source.start);
      const track = captionSlotFree(draft, source.track, start, end, new Set()) ? source.track : freeCaptionTrack(draft, start, end, source.track);
      const id = newId();
      draft.captions.push({ ...structuredClone(source), id, start, end, track });
      ids.push(id);
    }
  });
  select(ids);
}

export function duplicateSelection(): void {
  const { project, selection } = useEditor.getState();
  const captions = project.captions.filter((c) => selection.includes(c.id));
  if (!captions.length) return;
  clipboard = structuredClone(captions);
  const end = Math.max(...captions.map((c) => c.end));
  usePlayback.getState().setTime(end);
  paste();
}

export function selectAll(): void {
  const { project, select } = useEditor.getState();
  select([...project.captions.map((c) => c.id), ...project.clips.map((c) => c.id)]);
}

/** Puts the playhead inside a caption if it isn't, so the monitor shows it. */
export function revealCaption(id: string): void {
  const caption = useEditor.getState().project.captions.find((c) => c.id === id);
  if (!caption) return;
  const t = usePlayback.getState().time;
  if (t < caption.start - EPS || t >= caption.end - EPS) goTo(caption.start);
  const view = useView.getState();
  const visible = view.laneWidth / view.zoom;
  if (caption.start < view.scroll || caption.start > view.scroll + visible * 0.9) view.set({ scroll: Math.max(0, caption.start - visible * 0.2) });
}

export function selectedCaptions(): Caption[] {
  const { project, selection } = useEditor.getState();
  return project.captions.filter((c) => selection.includes(c.id));
}

export function isVisibleNow(id: string): boolean {
  const { project } = useEditor.getState();
  return captionsAt(project.captions, usePlayback.getState().time).some((c) => c.id === id);
}

export function hasItem(id: string): boolean {
  return !!findItem(useEditor.getState().project, id);
}

export function videoUnderPlayhead() {
  return clipAt(useEditor.getState().project.clips, usePlayback.getState().time);
}
