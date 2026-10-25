/**
 * Media actions: import (native dialog, typed path or dropped file), re-linking on project
 * load, status polling (waveform peaks, preview proxies) and the waveform cache.
 */
import { create } from "zustand";

import type { MediaRecord, MediaStatus } from "../../shared/types";
import { appendMedia, videoEnd } from "../model/edit";
import { toast, useEditor, usePlayback } from "../state/store";
import type { MediaRef, Project } from "../state/types";

import { api, basename, dirname } from "./api";

interface MediaRuntime {
  status: Record<string, MediaStatus>;
  peaks: Record<string, Float32Array | null>;
  /** Media whose file can't be found (project opened on another machine, file moved). */
  missing: Record<string, true>;
  importing: boolean;
  set: (partial: Partial<Omit<MediaRuntime, "set">>) => void;
}

export const useMedia = create<MediaRuntime>((set) => ({
  status: {},
  peaks: {},
  missing: {},
  importing: false,
  set: (partial) => set(partial),
}));

const polling = new Set<string>();

/** Polls the server until peaks and proxy are settled for a media id. */
export function watchMedia(id: string): void {
  if (polling.has(id)) return;
  polling.add(id);
  const tick = async () => {
    try {
      const status = await api.mediaStatus(id);
      const state = useMedia.getState();
      state.set({ status: { ...state.status, [id]: status } });
      if (status.peaks === "ready" && !(id in state.peaks)) {
        const peaks = await api.peaks(id);
        useMedia.getState().set({ peaks: { ...useMedia.getState().peaks, [id]: peaks } });
      }
      const busy = status.peaks === "pending" || status.peaks === "running" || status.proxy === "pending" || status.proxy === "running";
      if (busy) window.setTimeout(tick, 500);
      else polling.delete(id);
    } catch {
      polling.delete(id);
    }
  };
  void tick();
}

function toRef(record: MediaRecord): MediaRef {
  return { id: record.id, path: record.info.path, name: record.info.name, info: record.info };
}

/** Adds media to the project; the first video sets the sequence and lands on the timeline. */
function addRecord(record: MediaRecord, placeOnTimeline: boolean): void {
  const ref = toRef(record);
  const { project, update, select } = useEditor.getState();
  const exists = project.media.some((m) => m.id === ref.id);
  let placedId: string | null = null;
  update((draft) => {
    if (!exists) draft.media.push(ref);
    const video = ref.info.video!;
    if (!draft.sequence) {
      draft.sequence = { width: video.width, height: video.height, fpsNum: video.fpsNum, fpsDen: video.fpsDen };
      if (draft.name === "Untitled") draft.name = ref.name.replace(/\.[^.]+$/, "");
    }
    if (placeOnTimeline) placedId = appendMedia(draft, ref).id;
  });
  if (placedId) select([placedId]);
  watchMedia(ref.id);
  const v = ref.info.video!;
  const notes: string[] = [];
  if (v.vfr) notes.push("variable frame rate (timing kept exactly on export)");
  if (!ref.info.audio) notes.push("no audio");
  if (!ref.info.browserPlayable) notes.push("making a preview copy for playback");
  toast.success(`Imported ${ref.name} · ${v.width}×${v.height} · ${(v.fpsNum / v.fpsDen).toFixed(v.fpsDen === 1 ? 0 : 2)} fps${notes.length ? ` · ${notes.join(", ")}` : ""}`);
}

async function withImporting<T>(job: () => Promise<T>): Promise<T | null> {
  useMedia.getState().set({ importing: true });
  try {
    return await job();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    useMedia.getState().set({ importing: false });
  }
}

function shouldPlace(): boolean {
  return useEditor.getState().project.clips.length === 0;
}

export async function importByPath(path: string): Promise<void> {
  const clean = path.trim().replace(/^"(.*)"$/, "$1");
  if (!clean) return;
  await withImporting(async () => addRecord(await api.registerMedia(clean), shouldPlace()));
}

export async function importWithDialog(): Promise<void> {
  const last = useEditor.getState().project.media.at(-1)?.path;
  const picked = await api.pickMedia(last ? dirname(last) : undefined).catch(() => ({ path: null }));
  if (!picked.path) return;
  await importByPath(picked.path);
}

export async function importFiles(files: FileList | File[]): Promise<void> {
  for (const file of Array.from(files)) {
    if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|ts)$/i.test(file.name)) {
      toast.error(`${file.name} isn't a video.`);
      continue;
    }
    await withImporting(async () => addRecord(await api.uploadMedia(file), shouldPlace()));
  }
}

/** Puts a project media file at the end of the video track. */
export function placeMedia(id: string): void {
  const ref = useEditor.getState().project.media.find((m) => m.id === id);
  if (!ref) return;
  let placed = "";
  useEditor.getState().update((draft) => {
    placed = appendMedia(draft, ref).id;
  });
  useEditor.getState().select([placed]);
  usePlayback.getState().setTime(Math.max(0, videoEnd(useEditor.getState().project) - (ref.info.video?.duration ?? 0)));
}

/**
 * Re-registers every media file of a loaded project by path. The server id changes when the
 * file changed on disk; clips follow. Files that can't be found are marked missing (relink).
 */
export async function relinkProject(project: Project): Promise<Project> {
  const missing: Record<string, true> = {};
  const next = structuredClone(project);
  for (const ref of project.media) {
    try {
      const record = await api.registerMedia(ref.path);
      if (record.id !== ref.id) {
        for (const clip of next.clips) if (clip.mediaId === ref.id) clip.mediaId = record.id;
      }
      const index = next.media.findIndex((m) => m.id === ref.id);
      next.media[index] = toRef(record);
      watchMedia(record.id);
    } catch {
      missing[ref.id] = true;
    }
  }
  useMedia.getState().set({ missing });
  return next;
}

/** Points a missing media entry at a new file. */
export async function relinkMedia(id: string): Promise<void> {
  const ref = useEditor.getState().project.media.find((m) => m.id === id);
  const picked = await api.pickMedia(ref ? dirname(ref.path) : undefined).catch(() => ({ path: null }));
  if (!picked.path) return;
  await withImporting(async () => {
    const record = await api.registerMedia(picked.path!);
    useEditor.getState().update((draft) => {
      draft.media = draft.media.filter((m) => m.id !== id && m.id !== record.id);
      draft.media.push(toRef(record));
      for (const clip of draft.clips) {
        if (clip.mediaId !== id) continue;
        clip.mediaId = record.id;
        // A shorter replacement can't play past its own end.
        const duration = record.info.video!.duration;
        clip.srcOut = Math.min(clip.srcOut, duration);
        clip.srcIn = Math.min(clip.srcIn, Math.max(0, clip.srcOut - 1 / 30));
      }
    });
    const missing = { ...useMedia.getState().missing };
    delete missing[id];
    useMedia.getState().set({ missing });
    watchMedia(record.id);
    toast.success(`Relinked to ${basename(picked.path!)}`);
  });
}

export function removeMedia(id: string): void {
  const { project, update } = useEditor.getState();
  const used = project.clips.filter((c) => c.mediaId === id).length;
  update((draft) => {
    draft.media = draft.media.filter((m) => m.id !== id);
    draft.clips = draft.clips.filter((c) => c.mediaId !== id);
    if (!draft.media.length) draft.sequence = draft.captions.length ? draft.sequence : null;
  });
  if (used) toast.info(`Removed the media and its ${used} clip${used > 1 ? "s" : ""} (Ctrl+Z to undo).`);
}
