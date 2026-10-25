/**
 * Editor state (zustand). Only the project document has undo/redo: every edit clones it, runs a
 * recipe on the clone and pushes the old one. Gestures (drags) pass a coalesce key so the whole
 * drag is one undo step. The playhead and the timeline view live in their own small stores
 * because they change every frame; only the few components that show them subscribe.
 */
import { create } from "zustand";

import { findItem } from "../model/edit";
import { snapToFrame } from "../model/time";

import { createProject } from "./defaults";
import type { CaptionStyle, Project, Tool } from "./types";
import { TIKTOK_BOX } from "./defaults";

const HISTORY_LIMIT = 200;
const COALESCE_MS = 700;

interface EditorState {
  project: Project;
  past: Project[];
  future: Project[];
  lastEdit: { key: string; at: number } | null;

  selection: string[];
  tool: Tool;
  /** Caption whose text is being typed on the monitor. */
  editingId: string | null;
  snapping: boolean;
  safeZones: boolean;
  /** Style the next new caption gets (the last one edited, like TikTok). */
  lastStyle: CaptionStyle;
  savedPath: string | null;
  /** The project as it was last saved/opened (dirty = project !== savedProject). */
  savedProject: Project | null;
  hydrated: boolean;
  exportOpen: boolean;

  update: (recipe: (draft: Project) => void, coalesceKey?: string) => void;
  replaceProject: (project: Project, savedPath?: string | null) => void;
  markSaved: (path: string) => void;
  undo: () => void;
  redo: () => void;
  select: (ids: string[]) => void;
  setTool: (tool: Tool) => void;
  setEditing: (id: string | null) => void;
  set: (partial: Partial<Pick<EditorState, "snapping" | "safeZones" | "lastStyle" | "hydrated" | "exportOpen">>) => void;
}

function cleanSelection(project: Project, ids: string[]): string[] {
  return ids.filter((id) => findItem(project, id));
}

export const useEditor = create<EditorState>((set, get) => ({
  project: createProject(),
  past: [],
  future: [],
  lastEdit: null,
  selection: [],
  tool: "select",
  editingId: null,
  snapping: true,
  safeZones: false,
  lastStyle: TIKTOK_BOX,
  savedPath: null,
  savedProject: null,
  hydrated: false,
  exportOpen: false,

  update(recipe, coalesceKey) {
    const { project, past, lastEdit } = get();
    const draft = structuredClone(project);
    recipe(draft);
    draft.clips.sort((a, b) => a.start - b.start);
    const now = performance.now();
    const coalesce = !!coalesceKey && lastEdit?.key === coalesceKey && (coalesceKey.startsWith("g:") || now - lastEdit.at < COALESCE_MS);
    set({
      project: draft,
      past: coalesce ? past : [...past, project].slice(-HISTORY_LIMIT),
      future: [],
      lastEdit: coalesceKey ? { key: coalesceKey, at: now } : null,
      selection: cleanSelection(draft, get().selection),
    });
  },
  replaceProject(project, savedPath = null) {
    set({ project, past: [], future: [], lastEdit: null, selection: [], editingId: null, savedPath, savedProject: project });
  },
  markSaved(path) {
    set({ savedPath: path, savedProject: get().project });
  },
  undo() {
    const { past, project, future } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    set({ project: previous, past: past.slice(0, -1), future: [project, ...future], lastEdit: null, editingId: null, selection: cleanSelection(previous, get().selection) });
  },
  redo() {
    const { past, project, future } = get();
    const next = future[0];
    if (!next) return;
    set({ project: next, past: [...past, project], future: future.slice(1), lastEdit: null, editingId: null, selection: cleanSelection(next, get().selection) });
  },
  select: (selection) => set({ selection }),
  setTool: (tool) => set({ tool, editingId: tool === "razor" ? null : get().editingId }),
  setEditing: (editingId) => set({ editingId, lastEdit: null }),
  set: (partial) => set(partial),
}));

// ---------------- playhead ----------------

interface PlaybackState {
  time: number;
  playing: boolean;
  /** 1 = normal, 2/4/8 = L pressed again, negative = J (reverse). */
  rate: number;
  setTime: (time: number) => void;
}

export const usePlayback = create<PlaybackState>((set) => ({
  time: 0,
  playing: false,
  rate: 1,
  setTime: (time) => set({ time: Math.max(0, time) }),
}));

/** Moves the playhead to a frame boundary of the sequence. */
export function seekFrame(time: number): void {
  const sequence = useEditor.getState().project.sequence;
  usePlayback.getState().setTime(Math.max(0, snapToFrame(time, sequence)));
}

// ---------------- timeline view ----------------

interface ViewState {
  /** Pixels per second. */
  zoom: number;
  /** Seconds at the left edge of the lanes. */
  scroll: number;
  /** Vertical scroll of the track area in px. */
  scrollY: number;
  /** Lane width in px (set by the timeline). */
  laneWidth: number;
  set: (partial: Partial<Omit<ViewState, "set">>) => void;
}

export const useView = create<ViewState>((set) => ({
  zoom: 60,
  scroll: 0,
  scrollY: 0,
  laneWidth: 800,
  set: (partial) => set(partial),
}));

export const MIN_ZOOM = 2;
export const MAX_ZOOM = 4000;

// ---------------- toasts ----------------

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast["kind"], text: string) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(kind, text) {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
    window.setTimeout(() => get().dismiss(id), kind === "error" ? 7000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (text: string) => useToasts.getState().push("info", text),
  error: (text: string) => useToasts.getState().push("error", text),
  success: (text: string) => useToasts.getState().push("success", text),
};
