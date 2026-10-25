/**
 * Premiere-style keyboard shortcuts. Ignored while typing in a field (fields also stop their key
 * events), and while the export dialog is open.
 */
import { pause, shuttle, togglePlay } from "../playback/engine";
import { useEditor, usePlayback } from "../state/store";
import { zoomBy, zoomToFit } from "../timeline/Timeline";

import { copySelection, createCaption, deleteSelection, duplicateSelection, finishEditing, goToEnd, jumpEdit, paste, selectAll, splitAll, stepFrames } from "./actions";
import { importWithDialog } from "./media";
import { newProject, openProject, saveProject } from "./project";
import { goTo } from "../playback/engine";

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function installShortcuts(): () => void {
  const onKey = (event: KeyboardEvent) => {
    const state = useEditor.getState();
    if (state.exportOpen || typing(event.target)) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (ctrl) {
      if (key === "z" && !event.shiftKey) return handled(), state.undo();
      if ((key === "z" && event.shiftKey) || key === "y") return handled(), state.redo();
      if (key === "s") return handled(), void saveProject(event.shiftKey);
      if (key === "o") return handled(), void openProject();
      if (key === "n" && event.altKey) return handled(), void newProject();
      if (key === "i") return handled(), void importWithDialog();
      if (key === "m" || key === "e") return handled(), state.set({ exportOpen: true });
      if (key === "k") return handled(), splitAll();
      if (key === "c") return handled(), copySelection(false);
      if (key === "x") return handled(), copySelection(true);
      if (key === "v") return handled(), paste();
      if (key === "d") return handled(), duplicateSelection();
      if (key === "a") return handled(), selectAll();
      return;
    }
    if (event.altKey) return;

    switch (event.key) {
      case " ":
        handled();
        togglePlay();
        return;
      case "ArrowLeft":
        handled();
        pause();
        stepFrames(event.shiftKey ? -5 : -1);
        return;
      case "ArrowRight":
        handled();
        pause();
        stepFrames(event.shiftKey ? 5 : 1);
        return;
      case "ArrowUp":
        handled();
        pause();
        jumpEdit(-1);
        return;
      case "ArrowDown":
        handled();
        pause();
        jumpEdit(1);
        return;
      case "Home":
        handled();
        goTo(0);
        return;
      case "End":
        handled();
        goToEnd();
        return;
      case "Delete":
      case "Backspace":
        handled();
        deleteSelection(event.shiftKey);
        return;
      case "Escape":
        if (state.editingId) finishEditing();
        else state.select([]);
        return;
      case "Enter": {
        const caption = state.project.captions.find((c) => state.selection.length === 1 && c.id === state.selection[0]);
        if (caption) {
          handled();
          const t = usePlayback.getState().time;
          if (t < caption.start || t >= caption.end) goTo(caption.start);
          state.setEditing(caption.id);
        }
        return;
      }
      case "=":
      case "+":
        handled();
        zoomBy(1.5);
        return;
      case "-":
        handled();
        zoomBy(1 / 1.5);
        return;
      case "\\":
        handled();
        zoomToFit();
        return;
    }
    switch (key) {
      case "v":
        return handled(), state.setTool("select");
      case "c":
        return handled(), state.setTool("razor");
      case "t":
        return handled(), state.setTool("text");
      case "s":
        return handled(), state.set({ snapping: !state.snapping });
      case "j":
        return handled(), shuttle(-1);
      case "k":
        return handled(), pause();
      case "l":
        return handled(), shuttle(1);
      case "n":
        // N: new caption at the playhead (centre top), straight into typing.
        return handled(), void createCaption();
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
