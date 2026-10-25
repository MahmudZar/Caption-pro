/**
 * The project document (saved as .captionpro JSON). Times are seconds on the sequence timeline;
 * edits snap them to the sequence frame grid. Caption sizes are in "reference px": pixels on a
 * 1080-wide frame, scaled to the real frame width, so a style looks the same on any resolution.
 */
import type { MediaInfo } from "../../shared/types";

export const PROJECT_VERSION = 1;

export interface MediaRef {
  /** Server media id (hash of path + size + date). */
  id: string;
  path: string;
  name: string;
  info: MediaInfo;
}

export interface VideoClip {
  id: string;
  kind: "video";
  mediaId: string;
  /** Timeline start. The clip ends at start + (srcOut - srcIn). */
  start: number;
  srcIn: number;
  srcOut: number;
}

export type TextAlign = "left" | "center" | "right";
export type BoxMode = "line" | "block";

export interface CaptionStyle {
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  /** Reference px (on a 1080-wide frame). */
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  align: TextAlign;
  uppercase: boolean;
  color: string;
  opacity: number;
  /** Wrap width as a fraction of the frame width. */
  maxWidth: number;
  stroke: { enabled: boolean; color: string; width: number };
  box: { enabled: boolean; mode: BoxMode; color: string; opacity: number; padX: number; padY: number; radius: number };
  shadow: { enabled: boolean; color: string; opacity: number; blur: number; x: number; y: number };
}

export interface Caption {
  id: string;
  kind: "caption";
  /** 0 = lowest caption track (just above the video). Higher tracks draw on top. */
  track: number;
  start: number;
  end: number;
  text: string;
  /** Centre of the text block, as fractions of the frame (0..1). */
  x: number;
  y: number;
  style: CaptionStyle;
}

export type TimelineItem = VideoClip | Caption;

export interface Sequence {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
}

export interface Project {
  version: number;
  name: string;
  sequence: Sequence | null;
  media: MediaRef[];
  clips: VideoClip[];
  captions: Caption[];
}

export type Tool = "select" | "razor" | "text";
