/** Frame grid and timecode helpers. Rates are exact rationals (29.97 = 30000/1001). */

export const EPS = 1e-6;

export interface Rate {
  fpsNum: number;
  fpsDen: number;
}

export function fpsOf(rate: Rate | null | undefined): number {
  return rate ? rate.fpsNum / rate.fpsDen : 30;
}

export function frameDuration(rate: Rate | null | undefined): number {
  return rate ? rate.fpsDen / rate.fpsNum : 1 / 30;
}

/** Nearest frame boundary. */
export function snapToFrame(t: number, rate: Rate | null | undefined): number {
  const fps = fpsOf(rate);
  return Math.round(t * fps) / fps;
}

export function frameIndex(t: number, rate: Rate | null | undefined): number {
  return Math.floor(t * fpsOf(rate) + 1e-4);
}

/** HH:MM:SS:FF like Premiere (non-drop-frame; 29.97 counts 30 frames per second). */
export function formatTimecode(t: number, rate: Rate | null | undefined): string {
  const fps = fpsOf(rate);
  const base = Math.round(fps);
  const frames = Math.max(0, Math.round(t * fps));
  const ff = frames % base;
  const totalSeconds = Math.floor(frames / base);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

/**
 * Parses "HH:MM:SS:FF", "MM:SS:FF", "SS:FF", seconds ("1.5", "2s") or frames ("12f").
 * Returns null for anything else.
 */
export function parseTimecode(text: string, rate: Rate | null | undefined): number | null {
  const fps = fpsOf(rate);
  const base = Math.round(fps);
  const value = text.trim().toLowerCase();
  if (!value) return null;
  let match = /^(\d+(?:\.\d+)?)\s*s?$/.exec(value);
  if (match && !value.includes(":")) return Number(match[1]);
  match = /^(\d+)\s*f$/.exec(value);
  if (match) return Number(match[1]) / fps;
  const parts = value.split(/[:;.]/).map((part) => Number(part));
  if (parts.length < 2 || parts.length > 4 || parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  while (parts.length < 4) parts.unshift(0);
  const [h, m, s, f] = parts;
  return (h * 3600 + m * 60 + s) * base / fps + f / fps;
}

/** Short ruler label: "0:05", "1:00", or "0:05:12" at frame zoom. */
export function rulerLabel(t: number, rate: Rate | null | undefined, showFrames: boolean): string {
  const fps = fpsOf(rate);
  const base = Math.round(fps);
  const frames = Math.round(t * fps);
  const totalSeconds = Math.floor(frames / base);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const label = `${m}:${String(s).padStart(2, "0")}`;
  return showFrames ? `${label}:${String(frames % base).padStart(2, "0")}` : label;
}
