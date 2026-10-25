/**
 * Every project that comes from disk goes through here: unknown fields dropped, numbers
 * clamped, missing style fields filled from the default, broken items removed. Bump
 * PROJECT_VERSION and migrate here when the shape changes.
 */
import { TIKTOK_BOX, createProject } from "./defaults";
import type { Caption, CaptionStyle, MediaRef, Project, VideoClip } from "./types";
import { PROJECT_VERSION } from "./types";

type Loose = Record<string, unknown>;

function obj(value: unknown): Loose {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : {};
}

function num(value: unknown, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

export function sanitizeStyle(value: unknown): CaptionStyle {
  const s = obj(value);
  const d = TIKTOK_BOX;
  const stroke = obj(s.stroke);
  const box = obj(s.box);
  const shadow = obj(s.shadow);
  return {
    fontFamily: str(s.fontFamily, d.fontFamily).slice(0, 80) || d.fontFamily,
    fontWeight: Math.round(num(s.fontWeight, d.fontWeight, 100, 900) / 100) * 100,
    italic: bool(s.italic, d.italic),
    fontSize: num(s.fontSize, d.fontSize, 4, 600),
    lineHeight: num(s.lineHeight, d.lineHeight, 0.6, 4),
    letterSpacing: num(s.letterSpacing, d.letterSpacing, -50, 200),
    align: s.align === "left" || s.align === "right" ? s.align : "center",
    uppercase: bool(s.uppercase, d.uppercase),
    color: color(s.color, d.color),
    opacity: num(s.opacity, d.opacity, 0, 1),
    maxWidth: num(s.maxWidth, d.maxWidth, 0.05, 1),
    stroke: { enabled: bool(stroke.enabled, d.stroke.enabled), color: color(stroke.color, d.stroke.color), width: num(stroke.width, d.stroke.width, 0, 100) },
    box: {
      enabled: bool(box.enabled, d.box.enabled),
      mode: box.mode === "block" ? "block" : "line",
      color: color(box.color, d.box.color),
      opacity: num(box.opacity, d.box.opacity, 0, 1),
      padX: num(box.padX, d.box.padX, 0, 400),
      padY: num(box.padY, d.box.padY, 0, 400),
      radius: num(box.radius, d.box.radius, 0, 400),
    },
    shadow: {
      enabled: bool(shadow.enabled, d.shadow.enabled),
      color: color(shadow.color, d.shadow.color),
      opacity: num(shadow.opacity, d.shadow.opacity, 0, 1),
      blur: num(shadow.blur, d.shadow.blur, 0, 400),
      x: num(shadow.x, d.shadow.x, -400, 400),
      y: num(shadow.y, d.shadow.y, -400, 400),
    },
  };
}

export function sanitizeProject(value: unknown): Project {
  const p = obj(value);
  const base = createProject();
  const seq = obj(p.sequence);
  const sequence =
    seq.width && seq.height
      ? { width: Math.round(num(seq.width, 1080, 2, 16384)), height: Math.round(num(seq.height, 1920, 2, 16384)), fpsNum: Math.round(num(seq.fpsNum, 30, 1, 1_000_000)), fpsDen: Math.round(num(seq.fpsDen, 1, 1, 1_000_000)) }
      : null;
  const media: MediaRef[] = (Array.isArray(p.media) ? p.media : [])
    .map(obj)
    .filter((m) => typeof m.id === "string" && typeof m.path === "string" && m.info && obj(m.info).video)
    .map((m) => ({ id: m.id as string, path: m.path as string, name: str(m.name, "video"), info: m.info as MediaRef["info"] }));
  const mediaIds = new Set(media.map((m) => m.id));
  const clips: VideoClip[] = (Array.isArray(p.clips) ? p.clips : [])
    .map(obj)
    .filter((c) => typeof c.id === "string" && mediaIds.has(c.mediaId as string))
    .map((c) => ({
      id: c.id as string,
      kind: "video" as const,
      mediaId: c.mediaId as string,
      start: num(c.start, 0, 0),
      srcIn: num(c.srcIn, 0, 0),
      srcOut: num(c.srcOut, 0, 0),
    }))
    .filter((c) => c.srcOut > c.srcIn);
  const captions: Caption[] = (Array.isArray(p.captions) ? p.captions : [])
    .map(obj)
    .filter((c) => typeof c.id === "string")
    .map((c) => ({
      id: c.id as string,
      kind: "caption" as const,
      track: Math.round(num(c.track, 0, 0, 63)),
      start: num(c.start, 0, 0),
      end: num(c.end, 1, 0),
      text: str(c.text, ""),
      x: num(c.x, 0.5, -1, 2),
      y: num(c.y, 0.5, -1, 2),
      style: sanitizeStyle(c.style),
    }))
    .filter((c) => c.end > c.start);
  return { ...base, version: PROJECT_VERSION, name: str(p.name, base.name).slice(0, 120) || base.name, sequence, media, clips, captions };
}
