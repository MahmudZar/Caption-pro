/**
 * Project files: autosave (data/projects/autosave.json, restored on start), Save / Save as
 * (.captionpro JSON anywhere on disk), Open and New. Saving starts only after the restore has
 * finished, so a slow start can never overwrite the autosave with an empty project.
 */
import { createProject } from "../state/defaults";
import { sanitizeProject } from "../state/sanitize";
import { toast, useEditor, usePlayback } from "../state/store";

import { api, dirname } from "./api";
import { relinkProject, useMedia } from "./media";

interface AutosaveFile {
  project: unknown;
  savedPath: string | null;
  /** The project as last saved, to restore the "unsaved changes" state. */
  dirty: boolean;
}

let hydrating: Promise<void> | null = null;

/**
 * Restores the autosave once per page load. Hot reloads and React's dev double-effects call this
 * again; the store keeps `hydrated` across them, so a second restore can't roll back fresh edits.
 */
export function hydrate(): Promise<void> {
  if (useEditor.getState().hydrated) return Promise.resolve();
  hydrating ??= restore();
  return hydrating;
}

async function restore(): Promise<void> {
  try {
    const stored = (await api.loadAutosave()) as AutosaveFile | null;
    if (stored?.project) {
      const project = await relinkProject(sanitizeProject(stored.project));
      useEditor.getState().replaceProject(project, stored.savedPath);
      if (stored.dirty) useEditor.setState({ savedProject: null });
    }
  } catch (error) {
    console.warn("Could not restore the last session", error);
  } finally {
    useEditor.getState().set({ hydrated: true });
  }
}

let timer: number | undefined;

export function startAutosave(): () => void {
  let last = useEditor.getState().project;
  let lastPath = useEditor.getState().savedPath;
  return useEditor.subscribe((state) => {
    if (!state.hydrated || (state.project === last && state.savedPath === lastPath)) return;
    last = state.project;
    lastPath = state.savedPath;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const s = useEditor.getState();
      const file: AutosaveFile = { project: s.project, savedPath: s.savedPath, dirty: s.project !== s.savedProject };
      api.saveAutosave(file).catch((error: unknown) => console.warn("Autosave failed", error));
    }, 600);
  });
}

export function isDirty(): boolean {
  const s = useEditor.getState();
  return s.project !== s.savedProject && (s.project.clips.length > 0 || s.project.captions.length > 0);
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const { project, savedPath, markSaved } = useEditor.getState();
  let target = savedPath;
  if (!target || saveAs) {
    const sourceDir = project.media[0] ? dirname(project.media[0].path) : undefined;
    const picked = await api.pickProjectSave(`${project.name || "Untitled"}.captionpro`, savedPath ? dirname(savedPath) : sourceDir).catch(() => ({ path: null }));
    if (!picked.path) return false;
    target = picked.path;
  }
  try {
    const result = await api.saveProject(target, project);
    markSaved(result.path);
    toast.success(`Saved ${result.path}`);
    return true;
  } catch (error) {
    toast.error(`Couldn't save: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!isDirty()) return true;
  return window.confirm("The current project has unsaved changes. Continue without saving? (It stays in the autosave until you change it.)");
}

export async function openProjectPath(path: string): Promise<void> {
  try {
    const { project, path: file } = await api.readProject(path);
    const relinked = await relinkProject(sanitizeProject(project));
    useEditor.getState().replaceProject(relinked, file);
    usePlayback.setState({ time: 0, playing: false });
    const missing = Object.keys(useMedia.getState().missing).length;
    toast.success(`Opened ${file}${missing ? ` · ${missing} media file${missing > 1 ? "s" : ""} missing: relink in the Project panel` : ""}`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

export async function openProject(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const picked = await api.pickProject().catch(() => ({ path: null }));
  if (picked.path) await openProjectPath(picked.path);
}

export async function newProject(): Promise<void> {
  if (!(await confirmDiscard())) return;
  useEditor.getState().replaceProject(createProject(), null);
  usePlayback.setState({ time: 0, playing: false });
}
