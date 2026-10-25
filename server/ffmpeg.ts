/**
 * ffprobe/ffmpeg helpers: probing media into MediaInfo, waveform peaks, preview proxies and a
 * small process runner with progress parsing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { MediaInfo } from "../shared/types.ts";

import { FFMPEG, FFPROBE } from "./paths.ts";

/** Peaks per second of audio. 100/s is enough for frame-level zoom at 60 fps. */
export const PEAK_RATE = 100;
const PEAK_SAMPLE_RATE = 8000;

const BROWSER_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const BROWSER_PIX_FMTS = new Set(["yuv420p", "yuvj420p", "nv12"]);

export function run(bin: string, args: string[], onStdout?: (chunk: Buffer) => void): { child: ChildProcess; done: Promise<{ code: number; stderr: string }> } {
  const child = spawn(bin, args, { windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    // Keep the tail only; ffmpeg can be chatty on long files.
    if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
  });
  if (onStdout) child.stdout?.on("data", onStdout);
  const done = new Promise<{ code: number; stderr: string }>((resolve) => {
    child.on("error", (error) => resolve({ code: -1, stderr: stderr + String(error) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
  return { child, done };
}

function ratio(value: unknown): number {
  if (typeof value !== "string") return 0;
  const [a, b] = value.split(/[/:]/).map(Number);
  if (!Number.isFinite(a)) return 0;
  if (b === undefined) return a;
  return b ? a / b : 0;
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** Valid colour tag or null ("unknown", "reserved" and missing values are all treated as unset). */
function colorTag(value: unknown): string | null {
  return typeof value === "string" && value && !/^(unknown|reserved|unspecified)$/i.test(value) ? value : null;
}

/** Rotation in clockwise degrees, from the display matrix (new ffprobe) or the rotate tag (old). */
function rotationOf(stream: Record<string, unknown>): number {
  let degrees = 0;
  const tags = stream.tags as Record<string, string> | undefined;
  if (tags?.rotate) degrees = Number.parseFloat(tags.rotate);
  const sideData = stream.side_data_list as Array<Record<string, unknown>> | undefined;
  for (const entry of sideData ?? []) {
    if (typeof entry.rotation === "number") degrees = -entry.rotation; // display matrix is counter-clockwise
  }
  const normalized = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return normalized;
}

/** Common frame rates written as exact rationals (29.97 = 30000/1001). */
function snapRate(fps: number): [number, number] {
  const known: Array<[number, number]> = [
    [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1], [60000, 1001], [60, 1], [90, 1], [100, 1], [120000, 1001], [120, 1],
  ];
  for (const [n, d] of known) if (Math.abs(n / d - fps) < 0.002) return [n, d];
  return [Math.round(fps * 1000), 1000];
}

export async function probe(filePath: string): Promise<MediaInfo> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("Not a file");
  let json = "";
  const { done } = run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-select_streams", "v:0", filePath], (c) => (json += c.toString()));
  const result = await done;
  let audioJson = "";
  const audioRun = run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-select_streams", "a:0", filePath], (c) => (audioJson += c.toString()));
  await audioRun.done;
  if (result.code !== 0) throw new Error(`ffprobe could not read this file. ${result.stderr.trim().split("\n").pop() ?? ""}`);
  const data = JSON.parse(json) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const audioData = JSON.parse(audioJson || "{}") as { streams?: Array<Record<string, unknown>> };
  const format = data.format ?? {};
  const v = data.streams?.find((s) => s.codec_type === "video" && !(s.disposition as Record<string, number> | undefined)?.attached_pic);
  const a = audioData.streams?.find((s) => s.codec_type === "audio");
  const formatDuration = num(format.duration) ?? 0;

  let video: MediaInfo["video"] = null;
  if (v) {
    const codedWidth = Number(v.width) || 0;
    const codedHeight = Number(v.height) || 0;
    const rotation = rotationOf(v);
    const sar = ratio(v.sample_aspect_ratio) || 1;
    const sarWidth = Math.round(codedWidth * (Math.abs(sar - 1) > 0.001 ? sar : 1));
    let width = sarWidth;
    let height = codedHeight;
    if (rotation === 90 || rotation === 270) [width, height] = [height, width];
    // H.264 needs even sizes; display sizes from odd SAR maths get rounded down to even.
    width -= width % 2;
    height -= height % 2;
    const rFps = ratio(v.r_frame_rate);
    const avgFps = ratio(v.avg_frame_rate) || rFps;
    const frames = num(v.nb_frames);
    const duration = num(v.duration) ?? formatDuration;
    // Phones record variable frame rate: the average drifts away from the nominal rate.
    const vfr = rFps > 0 && avgFps > 0 && Math.abs(rFps - avgFps) / rFps > 0.01;
    const gridFps = rFps > 0 && rFps <= 240 ? rFps : avgFps || 30;
    const [fpsNum, fpsDen] = snapRate(gridFps);
    video = {
      codec: String(v.codec_name ?? "unknown"),
      width,
      height,
      codedWidth,
      codedHeight,
      rotation,
      sar,
      fpsNum,
      fpsDen,
      avgFps,
      vfr,
      pixFmt: String(v.pix_fmt ?? "unknown"),
      colorSpace: colorTag(v.color_space),
      colorPrimaries: colorTag(v.color_primaries),
      colorTransfer: colorTag(v.color_transfer),
      colorRange: colorTag(v.color_range),
      bitRate: num(v.bit_rate),
      startTime: num(v.start_time) ?? 0,
      duration,
      frames,
    };
  }

  let audio: MediaInfo["audio"] = null;
  if (a) {
    audio = {
      codec: String(a.codec_name ?? "unknown"),
      sampleRate: Number(a.sample_rate) || 48000,
      channels: Number(a.channels) || 2,
      bitRate: num(a.bit_rate),
      startTime: num(a.start_time) ?? 0,
    };
  }

  // Chrome plays H.264 from MP4/MOV and VP8/VP9/AV1 from WebM/MP4; Matroska, AVI and TS get a proxy.
  const containerName = String(format.format_name ?? "");
  const container = /mp4|mov/.test(containerName) ? "mp4" : /webm|matroska/.test(containerName) ? "webm" : "other";
  const browserPlayable =
    !!video &&
    BROWSER_VIDEO_CODECS.has(video.codec) &&
    BROWSER_PIX_FMTS.has(video.pixFmt) &&
    (container === "mp4" || (container === "webm" && video.codec !== "h264")) &&
    (!audio || ["aac", "mp3", "opus", "vorbis", "flac"].includes(audio.codec));
  return {
    path: filePath,
    name: path.basename(filePath),
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    container: String(format.format_name ?? "unknown"),
    duration: video?.duration || formatDuration,
    video,
    audio,
    browserPlayable,
  };
}

/**
 * Peak amplitude (0..1) per 1/PEAK_RATE s of the first audio stream, decoded by ffmpeg to mono
 * 8 kHz floats and reduced while streaming (no full decode in memory). Timestamps are relative
 * to the first video frame so the waveform lines up with the picture.
 */
export async function computePeaks(filePath: string, outFile: string, offset: number): Promise<void> {
  const bucket = PEAK_SAMPLE_RATE / PEAK_RATE;
  const peaks: number[] = [];
  let current = 0;
  let inBucket = 0;
  let leftover: Buffer = Buffer.alloc(0);
  // A positive offset means audio starts after the video: pad the front with silence.
  const padBuckets = Math.max(0, Math.round(offset * PEAK_RATE));
  for (let i = 0; i < padBuckets; i += 1) peaks.push(0);
  const skipSamples = Math.max(0, Math.round(-offset * PEAK_SAMPLE_RATE));
  let skipped = 0;
  const { done } = run(FFMPEG, ["-v", "error", "-i", filePath, "-map", "0:a:0", "-ac", "1", "-ar", String(PEAK_SAMPLE_RATE), "-f", "f32le", "pipe:1"], (chunk) => {
    const buffer = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = buffer.length - (buffer.length % 4);
    for (let i = 0; i < usable; i += 4) {
      if (skipped < skipSamples) {
        skipped += 1;
        continue;
      }
      const value = Math.abs(buffer.readFloatLE(i));
      if (value > current) current = value;
      inBucket += 1;
      if (inBucket >= bucket) {
        peaks.push(Math.min(1, current));
        current = 0;
        inBucket = 0;
      }
    }
    leftover = buffer.subarray(usable);
  });
  const result = await done;
  if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").pop() || "audio decode failed");
  if (inBucket > 0) peaks.push(Math.min(1, current));
  const out = Buffer.alloc(peaks.length * 4);
  peaks.forEach((p, i) => out.writeFloatLE(p, i * 4));
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outFile);
    stream.on("error", reject);
    stream.end(out, () => resolve());
  });
}

/** Parses ffmpeg `-progress` key=value output into seconds encoded. */
export function progressParser(onTime: (seconds: number) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (match) onTime(Number(match[1]) / 1e6);
    }
  };
}

/**
 * H.264 preview proxy for files Chrome can't decode (HEVC, ProRes, 10-bit...). Timestamps are
 * kept (passthrough) so preview times equal source times; export always uses the original.
 */
export function makeProxy(info: MediaInfo, outFile: string, onProgress: (p: number) => void): { child: ChildProcess; done: Promise<{ code: number; stderr: string }> } {
  const longEdge = 1280;
  const scale = (info.video?.width ?? 0) >= (info.video?.height ?? 0) ? `scale='min(${longEdge},iw)':-2` : `scale=-2:'min(${longEdge},ih)'`;
  const args = [
    "-v", "error", "-y", "-i", info.path,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", `${scale},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "15",
    "-c:a", "aac", "-b:a", "128k",
    "-fps_mode", "passthrough",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    outFile,
  ];
  return run(FFMPEG, args, progressParser((t) => onProgress(info.duration ? Math.min(1, t / info.duration) : 0)));
}
