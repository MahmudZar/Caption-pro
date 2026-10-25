/** Types shared by the browser app and the local server. */

export interface VideoInfo {
  codec: string;
  /** Display size: rotation and non-square pixels already applied (what players show). */
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  /** Clockwise rotation from the container's display matrix (0, 90, 180, 270). */
  rotation: number;
  /** Sample aspect ratio (1 = square pixels). */
  sar: number;
  /** Frame grid used for editing: r_frame_rate for constant-rate files. */
  fpsNum: number;
  fpsDen: number;
  /** Average rate over the whole file (differs from the grid on variable-frame-rate files). */
  avgFps: number;
  vfr: boolean;
  pixFmt: string;
  colorSpace: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorRange: string | null;
  bitRate: number | null;
  /** First video timestamp in seconds (usually 0). Caption times are relative to it. */
  startTime: number;
  duration: number;
  frames: number | null;
}

export interface AudioInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  bitRate: number | null;
  startTime: number;
}

export interface MediaInfo {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  container: string;
  duration: number;
  video: VideoInfo | null;
  audio: AudioInfo | null;
  /** Chrome can decode it directly; otherwise the server makes a preview proxy. */
  browserPlayable: boolean;
}

export interface MediaRecord {
  id: string;
  info: MediaInfo;
}

export type JobState = "pending" | "running" | "ready" | "none" | "error";

export interface MediaStatus {
  peaks: JobState;
  proxy: JobState;
  proxyProgress: number;
  error?: string;
}

export type ExportQuality = "lossless" | "high" | "small";

export interface ExportClip {
  mediaId: string;
  /** Timeline time where the clip starts. */
  start: number;
  /** Source range [srcIn, srcOut) in seconds from the source's first frame. */
  srcIn: number;
  srcOut: number;
}

export interface ExportSegment {
  start: number;
  end: number;
  /** Index of the uploaded caption PNG for this span, or null when no caption shows. */
  image: number | null;
}

export interface ExportPlan {
  output: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  clips: ExportClip[];
  /** Contiguous spans from 0 to the timeline end. */
  segments: ExportSegment[];
  quality: ExportQuality;
}

export interface ExportStatus {
  id: string;
  state: "waiting" | "encoding" | "done" | "error" | "cancelled";
  progress: number;
  /** "copy" when the video was stream-copied (nothing to burn in). */
  mode?: "overlay" | "edit" | "copy";
  error?: string;
  log?: string;
  output?: string;
  result?: MediaInfo;
  elapsed?: number;
}
