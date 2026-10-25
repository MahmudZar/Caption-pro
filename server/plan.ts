/**
 * Turns an ExportPlan into ffmpeg arguments. Pure (no I/O) so it can be unit-tested.
 *
 * Three modes:
 * - "copy":    one untouched clip and no captions → remux, the video stream is bit-identical.
 * - "overlay": one untouched clip + captions → the caption track is laid over the original
 *              stream, the audio is copied as is, timestamps pass through (VFR stays VFR).
 * - "edit":    cuts, gaps, moved or multiple clips → trim/concat filter graph, audio re-encoded.
 *
 * Captions arrive as an ffconcat list of full-frame transparent PNGs (one per span where the
 * visible set of captions changes; blank spans share one empty PNG), which becomes a single
 * secondary video stream for one overlay filter.
 */
import type { AudioInfo, ExportPlan, MediaInfo, VideoInfo } from "../shared/types.ts";

export type ExportMode = "copy" | "overlay" | "edit";

export interface BuiltExport {
  mode: ExportMode;
  args: string[];
  duration: number;
  /** Human summary for the export dialog. */
  notes: string[];
}

const EPS = 1e-6;

/** Audio codecs the MP4 muxer takes as they are. */
const MP4_AUDIO_COPY = new Set(["aac", "mp3", "ac3", "eac3", "alac"]);

export const QUALITY: Record<ExportPlan["quality"], { crf: number; preset: string; label: string }> = {
  lossless: { crf: 14, preset: "slow", label: "Visually lossless (x264 CRF 14, slow)" },
  high: { crf: 17, preset: "medium", label: "High (x264 CRF 17)" },
  small: { crf: 21, preset: "medium", label: "Smaller file (x264 CRF 21)" },
};

/** Numbers in filter graphs: fixed decimals, no exponent notation. */
export function n(value: number): string {
  const fixed = value.toFixed(6);
  return fixed.replace(/\.?0+$/, "") || "0";
}

export interface ColorSetup {
  matrix: "bt709" | "bt601" | "bt2020";
  space: string;
  primaries: string;
  transfer: string;
  range: "tv" | "pc";
}

/**
 * Colour handling. Untagged HD video is treated as BT.709 (what players assume); untagged SD as
 * BT.601. The caption PNGs (sRGB) are converted with the same matrix so a white box stays the
 * exact white of the video and coloured text keeps its hue.
 */
export function colorSetup(video: VideoInfo): ColorSetup {
  const hd = video.width >= 1280 || video.height >= 1280 || (video.width >= 720 && video.height >= 720);
  const space = video.colorSpace ?? (hd ? "bt709" : "smpte170m");
  const matrix = space === "bt709" ? "bt709" : space.startsWith("bt2020") ? "bt2020" : "bt601";
  const primaries = video.colorPrimaries ?? (matrix === "bt709" ? "bt709" : matrix === "bt2020" ? "bt2020" : "smpte170m");
  const transfer = video.colorTransfer ?? (matrix === "bt709" ? "bt709" : matrix === "bt2020" ? "bt709" : "smpte170m");
  // yuvj formats get converted to limited range by format=yuv420p; a full-range tag on plain yuv420p is kept.
  const range = video.colorRange === "pc" && !video.pixFmt.startsWith("yuvj") ? "pc" : "tv";
  return { matrix, space, primaries, transfer, range };
}

function audioCopyable(audio: AudioInfo | null): boolean {
  return !!audio && MP4_AUDIO_COPY.has(audio.codec);
}

/** mp4 track timescale that represents every frame of the rate exactly. */
export function timescaleFor(fpsNum: number, fpsDen: number): number {
  if (fpsDen === 1 && 90000 % fpsNum === 0) return 90000;
  return fpsNum;
}

function clipEnd(clip: ExportPlan["clips"][number]): number {
  return clip.start + (clip.srcOut - clip.srcIn);
}

export function timelineDuration(plan: Pick<ExportPlan, "clips">): number {
  return plan.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

/** One clip that is the whole source at time 0 at the sequence size: no re-timing needed. */
export function isIdentity(plan: ExportPlan, media: Map<string, MediaInfo>): boolean {
  if (plan.clips.length !== 1) return false;
  const clip = plan.clips[0];
  const info = media.get(clip.mediaId);
  const video = info?.video;
  if (!video) return false;
  const frame = (video.fpsDen / video.fpsNum) || 1 / 30;
  return (
    Math.abs(clip.start) < EPS &&
    clip.srcIn < frame / 2 &&
    clip.srcOut >= video.duration - frame / 2 &&
    video.width === plan.width &&
    video.height === plan.height
  );
}

function encoderArgs(plan: ExportPlan, color: ColorSetup): string[] {
  const q = QUALITY[plan.quality];
  return [
    "-c:v", "libx264", "-preset", q.preset, "-crf", String(q.crf), "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-colorspace", color.space, "-color_primaries", color.primaries, "-color_trc", color.transfer, "-color_range", color.range,
  ];
}

function captionChain(inputIndex: number, offset: number, color: ColorSetup): string {
  return (
    `[${inputIndex}:v]format=rgba,setpts=PTS+${n(offset)}/TB,` +
    `scale=out_color_matrix=${color.matrix}:out_range=${color.range === "pc" ? "full" : "limited"},format=yuva420p[cap]`
  );
}

export function buildExport(plan: ExportPlan, media: Map<string, MediaInfo>, captionList: string | null): BuiltExport {
  const clips = [...plan.clips].filter((c) => c.srcOut - c.srcIn > EPS).sort((a, b) => a.start - b.start);
  if (!clips.length) throw new Error("The timeline has no video to export.");
  for (const clip of clips) {
    if (!media.get(clip.mediaId)?.video) throw new Error("A clip on the timeline points to media that is missing or has no video.");
  }
  if (plan.width % 2 || plan.height % 2) throw new Error("H.264 needs an even frame size.");
  const sorted = { ...plan, clips };
  const duration = timelineDuration(sorted);
  const first = media.get(clips[0].mediaId)!;
  const color = colorSetup(first.video!);
  const notes: string[] = [];
  const common = ["-hide_banner", "-y", "-nostdin"];
  const tail = ["-movflags", "+faststart", "-max_muxing_queue_size", "4096", "-progress", "pipe:1", "-nostats", plan.output];

  if (isIdentity(sorted, media)) {
    const video = first.video!;
    const audioArgs = first.audio ? ["-map", "0:a:0", ...(audioCopyable(first.audio) ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "320k"])] : [];
    if (first.audio) notes.push(audioCopyable(first.audio) ? `Audio copied untouched (${first.audio.codec}).` : `Audio re-encoded to AAC 320 kb/s (${first.audio.codec} doesn't fit MP4).`);
    else notes.push("No audio track.");
    if (!captionList) {
      notes.unshift("No captions: video stream copied bit for bit.");
      return { mode: "copy", duration, notes, args: [...common, "-i", first.path, "-map", "0:v:0", "-c:v", "copy", ...audioArgs, "-map_metadata", "0", ...tail] };
    }
    const base: string[] = [];
    if (Math.abs(video.sar - 1) > 0.001) base.push(`scale=${plan.width}:${plan.height}`, "setsar=1");
    base.push("format=yuv420p");
    const graph = [
      captionChain(1, video.startTime, color),
      `[0:v]${base.join(",")}[base]`,
      "[base][cap]overlay=eof_action=repeat:format=yuv420:shortest=1[v]",
    ].join(";");
    notes.unshift(`Captions burned into the original stream; ${QUALITY[plan.quality].label}.`);
    if (video.vfr) notes.push("Variable frame rate kept: every frame keeps its original timestamp.");
    return {
      mode: "overlay",
      duration,
      notes,
      args: [
        ...common,
        "-i", first.path,
        "-f", "concat", "-safe", "0", "-i", captionList,
        "-filter_complex", graph,
        "-map", "[v]", ...audioArgs,
        ...encoderArgs(plan, color),
        "-fps_mode", "passthrough",
        "-video_track_timescale", String(timescaleFor(video.fpsNum, video.fpsDen)),
        "-map_metadata", "0",
        ...tail,
      ],
    };
  }

  // ---- Edited timeline: trim + concat ----
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  for (const clip of clips) {
    if (!inputIndex.has(clip.mediaId)) {
      inputIndex.set(clip.mediaId, inputs.length);
      inputs.push(clip.mediaId);
    }
  }
  const withAudio = clips.some((clip) => !!media.get(clip.mediaId)?.audio);
  const fps = `${plan.fpsNum}/${plan.fpsDen}`;
  const W = plan.width;
  const H = plan.height;
  const graph: string[] = [];

  // Each input stream can feed the graph once: split it for every clip that uses it.
  const uses = new Map<string, number>();
  for (const clip of clips) uses.set(clip.mediaId, (uses.get(clip.mediaId) ?? 0) + 1);
  const used = new Map<string, number>();
  for (const id of inputs) {
    const i = inputIndex.get(id)!;
    const info = media.get(id)!;
    const count = uses.get(id)!;
    const start = info.video!.startTime;
    const vOut = Array.from({ length: count }, (_, k) => `[m${i}v${k}]`).join("");
    graph.push(`[${i}:v]setpts=PTS-${n(start)}/TB,${count > 1 ? `split=${count}` : "null"}${vOut}`);
    if (withAudio && info.audio) {
      const aOut = Array.from({ length: count }, (_, k) => `[m${i}a${k}]`).join("");
      graph.push(`[${i}:a:0]asetpts=PTS-${n(start)}/TB,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${count > 1 ? `asplit=${count}` : "anull"}${aOut}`);
    }
  }

  const fit = (info: MediaInfo): string => {
    const v = info.video!;
    const parts: string[] = [];
    if (Math.abs(v.sar - 1) > 0.001) parts.push(`scale=${v.width}:${v.height}`, "setsar=1");
    if (v.width !== W || v.height !== H) parts.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`);
    parts.push("setsar=1", "format=yuv420p");
    return parts.join(",");
  };

  const concatPads: string[] = [];
  let cursor = 0;
  let segment = 0;
  const pushGap = (length: number) => {
    const s = segment++;
    graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${n(length)},format=yuv420p,setsar=1[sv${s}]`);
    concatPads.push(`[sv${s}]`);
    if (withAudio) {
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=end=${n(length)},aformat=sample_fmts=fltp:channel_layouts=stereo[sa${s}]`);
      concatPads.push(`[sa${s}]`);
    }
  };
  for (const clip of clips) {
    const start = Math.max(clip.start, cursor);
    if (start - cursor > EPS) pushGap(start - cursor);
    // Overlapping clips (shouldn't happen) lose their hidden head.
    const srcIn = clip.srcIn + (start - clip.start);
    const length = clip.srcOut - srcIn;
    if (length <= EPS) continue;
    const info = media.get(clip.mediaId)!;
    const i = inputIndex.get(clip.mediaId)!;
    const k = used.get(clip.mediaId) ?? 0;
    used.set(clip.mediaId, k + 1);
    const s = segment++;
    graph.push(`[m${i}v${k}]trim=start=${n(srcIn)}:end=${n(clip.srcOut)},setpts=PTS-STARTPTS,${fit(info)}[sv${s}]`);
    concatPads.push(`[sv${s}]`);
    if (withAudio) {
      if (info.audio) {
        graph.push(
          `[m${i}a${k}]atrim=start=${n(srcIn)}:end=${n(clip.srcOut)},asetpts=PTS-${n(srcIn)}/TB,` +
            `aresample=48000:async=1:first_pts=0,apad=whole_dur=${n(length)},atrim=end=${n(length)}[sa${s}]`,
        );
      } else {
        graph.push(`anullsrc=r=48000:cl=stereo,atrim=end=${n(length)},aformat=sample_fmts=fltp:channel_layouts=stereo[sa${s}]`);
      }
      concatPads.push(`[sa${s}]`);
    }
    cursor = start + length;
  }
  // Clips that were split but never used (all their uses got skipped) would leave dangling pads.
  for (const id of inputs) {
    const i = inputIndex.get(id)!;
    const info = media.get(id)!;
    for (let k = used.get(id) ?? 0; k < uses.get(id)!; k += 1) {
      graph.push(`[m${i}v${k}]nullsink`);
      if (withAudio && info.audio) graph.push(`[m${i}a${k}]anullsink`);
    }
  }
  const outV = captionList ? "[vcat]" : "[v]";
  graph.push(`${concatPads.join("")}concat=n=${segment}:v=1:a=${withAudio ? 1 : 0}${outV}${withAudio ? "[a]" : ""}`);
  const captionInput = inputs.length;
  if (captionList) {
    graph.push(captionChain(captionInput, 0, color));
    graph.push("[vcat][cap]overlay=eof_action=repeat:format=yuv420:shortest=1[v]");
  }

  notes.push(captionList ? `Edited timeline re-cut and captions burned in; ${QUALITY[plan.quality].label}.` : `Edited timeline re-cut; ${QUALITY[plan.quality].label}.`);
  notes.push(withAudio ? "Audio re-encoded to AAC 320 kb/s, 48 kHz (needed after cuts)." : "No audio track.");
  const args = [
    ...common,
    ...inputs.flatMap((id) => ["-i", media.get(id)!.path]),
    ...(captionList ? ["-f", "concat", "-safe", "0", "-i", captionList] : []),
    "-filter_complex", graph.join(";"),
    "-map", "[v]",
    ...(withAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "320k", "-ar", "48000"] : []),
    ...encoderArgs(plan, color),
    "-fps_mode", "passthrough",
    "-video_track_timescale", String(timescaleFor(plan.fpsNum, plan.fpsDen)),
    "-t", n(duration),
    ...tail,
  ];
  return { mode: "edit", duration, notes, args };
}

/**
 * ffconcat list for the caption track. Boundaries move half a frame earlier so float rounding
 * can never push a caption one frame late: a frame at exactly the caption start always gets it.
 */
export function captionConcat(plan: ExportPlan, imagePath: (index: number | null) => string): string {
  const frame = plan.fpsDen / plan.fpsNum;
  const shift = (t: number) => (t <= EPS ? 0 : Math.max(0, t - frame / 2));
  const lines = ["ffconcat version 1.0"];
  const segments = [...plan.segments].sort((a, b) => a.start - b.start);
  for (const seg of segments) {
    const from = shift(seg.start);
    const to = shift(seg.end);
    if (to - from <= EPS) continue;
    lines.push(`file ${quote(imagePath(seg.image))}`, IMAGE_TIMEBASE, `duration ${n(to - from)}`);
  }
  // A long blank tail: the overlay runs with shortest=1, so the caption track must always outlast
  // the video (otherwise the overlay keeps repeating the last video frame while caption frames
  // remain). The concat demuxer ignores the last entry's duration, hence the repeated entry.
  const blank = quote(imagePath(null));
  lines.push(`file ${blank}`, IMAGE_TIMEBASE, "duration 3600", `file ${blank}`, IMAGE_TIMEBASE);
  return `${lines.join("\n")}\n`;
}

/**
 * Each PNG is opened by the image2 demuxer, whose default 25 fps time base would round caption
 * times to 1/25 s (a caption could start a frame early at 50/60 fps). A 1 MHz rate gives the
 * caption track microsecond timestamps.
 */
const IMAGE_TIMEBASE = "option framerate 1000000";

function quote(file: string): string {
  return `'${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

export function hasCaptions(plan: ExportPlan): boolean {
  return plan.segments.some((s) => s.image !== null && s.end - s.start > EPS);
}
