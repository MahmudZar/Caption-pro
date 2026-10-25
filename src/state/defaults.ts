import type { CaptionStyle, Project } from "./types";
import { PROJECT_VERSION } from "./types";

export const DEFAULT_FPS: [number, number] = [30, 1];

/** TikTok's classic caption: dark text on white boxes that hug each line. */
export const TIKTOK_BOX: CaptionStyle = {
  fontFamily: "TikTok Sans Variable",
  fontWeight: 600,
  italic: false,
  fontSize: 54,
  lineHeight: 1.22,
  letterSpacing: 0,
  align: "center",
  uppercase: false,
  color: "#111111",
  opacity: 1,
  maxWidth: 0.82,
  stroke: { enabled: false, color: "#000000", width: 6 },
  box: { enabled: true, mode: "line", color: "#ffffff", opacity: 1, padX: 22, padY: 12, radius: 18 },
  shadow: { enabled: false, color: "#000000", opacity: 0.5, blur: 12, x: 0, y: 4 },
};

export const STYLE_PRESETS: Array<{ id: string; name: string; style: CaptionStyle }> = [
  { id: "tiktok-white", name: "White box", style: TIKTOK_BOX },
  {
    id: "tiktok-black",
    name: "Black box",
    style: { ...TIKTOK_BOX, color: "#ffffff", box: { ...TIKTOK_BOX.box, color: "#000000", opacity: 0.85 } },
  },
  {
    id: "outline",
    name: "Outline",
    style: { ...TIKTOK_BOX, fontWeight: 800, fontSize: 64, color: "#ffffff", stroke: { enabled: true, color: "#000000", width: 7 }, box: { ...TIKTOK_BOX.box, enabled: false } },
  },
  {
    id: "shadow",
    name: "Shadow",
    style: { ...TIKTOK_BOX, fontWeight: 700, fontSize: 60, color: "#ffffff", box: { ...TIKTOK_BOX.box, enabled: false }, shadow: { enabled: true, color: "#000000", opacity: 0.65, blur: 14, x: 0, y: 4 } },
  },
  {
    id: "yellow",
    name: "Yellow pop",
    style: { ...TIKTOK_BOX, fontWeight: 900, fontSize: 68, uppercase: true, color: "#ffe14d", stroke: { enabled: true, color: "#000000", width: 8 }, box: { ...TIKTOK_BOX.box, enabled: false } },
  },
];

export const FONT_CHOICES: Array<{ family: string; label: string; weights: number[]; bundled: boolean }> = [
  { family: "TikTok Sans Variable", label: "TikTok Sans", weights: [300, 400, 500, 600, 700, 800, 900], bundled: true },
  { family: "Inter Variable", label: "Inter", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], bundled: true },
  { family: "Montserrat Variable", label: "Montserrat", weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], bundled: true },
  { family: "Poppins", label: "Poppins", weights: [400, 500, 600, 700, 800, 900], bundled: true },
  { family: "Bebas Neue", label: "Bebas Neue", weights: [400], bundled: true },
  { family: "Arial", label: "Arial (system)", weights: [400, 700], bundled: false },
  { family: "Segoe UI", label: "Segoe UI (system)", weights: [300, 400, 600, 700], bundled: false },
  { family: "Impact", label: "Impact (system)", weights: [400], bundled: false },
  { family: "Georgia", label: "Georgia (system)", weights: [400, 700], bundled: false },
  { family: "Verdana", label: "Verdana (system)", weights: [400, 700], bundled: false },
];

export function createProject(): Project {
  return { version: PROJECT_VERSION, name: "Untitled", sequence: null, media: [], clips: [], captions: [] };
}

/** Seconds a new caption lasts when nothing limits it. */
export const DEFAULT_CAPTION_SECONDS = 2;
