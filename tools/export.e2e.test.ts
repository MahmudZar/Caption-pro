/**
 * End-to-end export checks against real ffmpeg (npm run test:export, ~1 minute).
 * Synthetic sources cover the frame-rate and container edge cases; a white caption box is laid
 * over a solid blue picture so a pixel read tells exactly which frames got the caption.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probe, run } from "../server/ffmpeg";
import { FFMPEG, FFPROBE } from "../server/paths";
import { buildExport, captionConcat, hasCaptions } from "../server/plan";
import type { ExportPlan, MediaInfo } from "../shared/types";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "data", "e2e");

async function ff(args: string[]): Promise<void> {
  const { code, stderr } = await run(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args]).done;
  if (code !== 0) throw new Error(stderr);
}

async function output(bin: string, args: string[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const { code, stderr } = await run(bin, args, (c) => chunks.push(c)).done;
  if (code !== 0) throw new Error(stderr);
  return Buffer.concat(chunks);
}

/** Mean luma of a 4×4 block at (x, y) in output frame number `n`. */
async function luma(file: string, n: number, x: number, y: number): Promise<number> {
  const raw = await output(FFMPEG, ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n}),crop=4:4:${x}:${y},format=gray`, "-frames:v", "1", "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"]);
  return raw.reduce((sum, v) => sum + v, 0) / raw.length;
}

async function frameTimes(file: string): Promise<number[]> {
  const text = (await output(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file])).toString();
  return text
    .split(/\r?\n/)
    .map((l) => Number.parseFloat(l))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

interface Source {
  name: string;
  file: string;
  info: MediaInfo;
}

async function makeSource(name: string, opts: { w: number; h: number; rate: string; seconds: number; audio: boolean; vfr?: boolean; rotate?: number }): Promise<Source> {
  const file = path.join(DIR, `${name}.mp4`);
  const video = `color=c=0x2040a0:s=${opts.w}x${opts.h}:r=${opts.rate}:d=${opts.seconds}`;
  const args = ["-f", "lavfi", "-i", video];
  if (opts.audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${opts.seconds}`);
  if (opts.vfr) {
    // First second at 30 fps, then 15 fps: a real variable-frame-rate file.
    args.push("-vf", "setpts='if(lt(N,30),N/30,1+(N-30)/15)/TB'", "-fps_mode", "vfr");
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "12");
  if (opts.audio) args.push("-c:a", "aac", "-shortest");
  args.push(opts.rotate ? path.join(DIR, `${name}-plain.mp4`) : file);
  await ff(args);
  if (opts.rotate) await ff(["-display_rotation", String(opts.rotate), "-i", path.join(DIR, `${name}-plain.mp4`), "-c", "copy", file]);
  return { name, file, info: await probe(file) };
}

/** Transparent frame + one with an opaque white box in the middle. */
async function captionImages(w: number, h: number, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await ff(["-f", "lavfi", "-i", `color=c=black@0.0:s=${w}x${h},format=rgba`, "-frames:v", "1", path.join(dir, "blank.png")]);
  // drawbox doesn't write alpha: build the box with geq so it is opaque on a transparent frame.
  const inside = "between(X,W/4,3*W/4)*between(Y,H/4,3*H/4)";
  await ff(["-f", "lavfi", "-i", `color=c=black:s=${w}x${h},format=rgba`, "-vf", `geq=r='255':g='255':b='255':a='if(${inside},255,0)'`, "-frames:v", "1", path.join(dir, "0.png")]);
}

async function exportWith(source: Source, plan: Omit<ExportPlan, "width" | "height" | "fpsNum" | "fpsDen" | "quality" | "output">, name: string) {
  const v = source.info.video!;
  const dir = path.join(DIR, `${name}-job`);
  await captionImages(v.width, v.height, dir);
  const full: ExportPlan = { ...plan, output: path.join(DIR, `${name}-out.mp4`), width: v.width, height: v.height, fpsNum: v.fpsNum, fpsDen: v.fpsDen, quality: "high" };
  const list = hasCaptions(full) ? path.join(dir, "captions.ffconcat") : null;
  if (list) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(list, captionConcat(full, (i) => path.join(dir, i === null ? "blank.png" : `${i}.png`)));
  }
  const built = buildExport(full, new Map([["m", source.info]]), list);
  const { code, stderr } = await run(FFMPEG, built.args).done;
  if (code !== 0) throw new Error(stderr);
  return { built, out: full.output, result: await probe(full.output) };
}

const sources: Record<string, Source> = {};

beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const specs: Array<[string, Parameters<typeof makeSource>[1]]> = [
    ["fps24", { w: 360, h: 640, rate: "24", seconds: 3, audio: true }],
    ["fps2997", { w: 360, h: 640, rate: "30000/1001", seconds: 3, audio: true }],
    ["fps60-silent", { w: 360, h: 640, rate: "60", seconds: 2, audio: false }],
    ["vfr", { w: 360, h: 640, rate: "30", seconds: 3, audio: true, vfr: true }],
    ["wide", { w: 640, h: 360, rate: "25", seconds: 2, audio: true }],
    ["rotated", { w: 640, h: 360, rate: "30", seconds: 2, audio: false, rotate: 90 }],
  ];
  await Promise.all(specs.map(async ([name, spec]) => (sources[name] = await makeSource(name, spec))));
}, 120_000);

afterAll(() => {
  if (!process.env.KEEP_E2E) rmSync(DIR, { recursive: true, force: true });
});

/** Caption on frames [first, last] of a constant-rate source. */
function captionOnFrames(info: MediaInfo, first: number, last: number) {
  const v = info.video!;
  const frame = v.fpsDen / v.fpsNum;
  const start = first * frame;
  const end = (last + 1) * frame;
  return {
    clips: [{ mediaId: "m", start: 0, srcIn: 0, srcOut: v.duration }],
    segments: [
      { start: 0, end: start, image: null },
      { start, end, image: 0 },
      { start: end, end: v.duration, image: null },
    ],
  };
}

describe.each(["fps24", "fps2997", "fps60-silent", "wide"])("constant frame rate: %s", (name) => {
  it("keeps size, frame count, timing and audio; caption on exactly the right frames", async () => {
    const source = sources[name];
    const v = source.info.video!;
    const { built, out, result } = await exportWith(source, captionOnFrames(source.info, 10, 20), name);
    expect(built.mode).toBe("overlay");
    expect(result.video!.width).toBe(v.width);
    expect(result.video!.height).toBe(v.height);
    expect(result.video!.fpsNum / result.video!.fpsDen).toBeCloseTo(v.fpsNum / v.fpsDen, 3);
    const times = await frameTimes(out);
    const sourceTimes = await frameTimes(source.file);
    expect(times.length).toBe(sourceTimes.length);
    times.forEach((t, i) => expect(Math.abs(t - sourceTimes[i])).toBeLessThan(0.001));
    expect(!!result.audio).toBe(!!source.info.audio);
    if (source.info.audio) expect(result.audio!.codec).toBe("aac");
    const cx = v.width / 2;
    const cy = v.height / 2;
    expect(await luma(out, 9, cx, cy)).toBeLessThan(120);
    expect(await luma(out, 10, cx, cy)).toBeGreaterThan(200);
    expect(await luma(out, 20, cx, cy)).toBeGreaterThan(200);
    expect(await luma(out, 21, cx, cy)).toBeLessThan(120);
  }, 60_000);
});

describe("variable frame rate", () => {
  it("keeps every original timestamp and places captions by time", async () => {
    const source = sources.vfr;
    expect(source.info.video!.vfr).toBe(true);
    // Caption from 1.2 s to 2.0 s: in the 15 fps part, frames at 1.2 (n=33) .. 1.9333 (n=44).
    const plan = {
      clips: [{ mediaId: "m", start: 0, srcIn: 0, srcOut: source.info.video!.duration }],
      segments: [
        { start: 0, end: 1.2, image: null },
        { start: 1.2, end: 2.0, image: 0 },
        { start: 2.0, end: source.info.video!.duration, image: null },
      ],
    };
    const { out } = await exportWith(source, plan, "vfr");
    const times = await frameTimes(out);
    const sourceTimes = await frameTimes(source.file);
    expect(times.length).toBe(sourceTimes.length);
    times.forEach((t, i) => expect(Math.abs(t - sourceTimes[i])).toBeLessThan(0.002));
    const index = (t: number) => times.findIndex((x) => Math.abs(x - t) < 0.002);
    expect(await luma(out, index(1.2) - 1, 180, 320)).toBeLessThan(120);
    expect(await luma(out, index(1.2), 180, 320)).toBeGreaterThan(200);
    expect(await luma(out, index(2.0) - 1, 180, 320)).toBeGreaterThan(200);
    expect(await luma(out, index(2.0), 180, 320)).toBeLessThan(120);
  }, 60_000);
});

describe("rotated phone video", () => {
  it("exports upright at the display size", async () => {
    const source = sources.rotated;
    // -display_rotation 90 is counter-clockwise: 270° clockwise.
    expect([90, 270]).toContain(source.info.video!.rotation);
    expect([source.info.video!.width, source.info.video!.height]).toEqual([360, 640]);
    const { result } = await exportWith(source, captionOnFrames(source.info, 5, 10), "rotated");
    expect([result.video!.width, result.video!.height]).toEqual([360, 640]);
    expect(result.video!.rotation).toBe(0);
  }, 60_000);
});

describe("edited timeline", () => {
  it("cuts, closes and opens gaps with audio kept in sync", async () => {
    const source = sources.fps24;
    const frame = 1 / 24;
    // 0–1 s of source, a 0.5 s black gap, then source 2–3 s. Caption on the second part.
    const plan = {
      clips: [
        { mediaId: "m", start: 0, srcIn: 0, srcOut: 1 },
        { mediaId: "m", start: 1.5, srcIn: 2, srcOut: 3 },
      ],
      segments: [
        { start: 0, end: 1.5, image: null },
        { start: 1.5, end: 2.5, image: 0 },
      ],
    };
    const { built, out, result } = await exportWith(source, plan, "edited");
    expect(built.mode).toBe("edit");
    expect(result.duration).toBeGreaterThan(2.5 - 2 * frame);
    expect(result.duration).toBeLessThan(2.5 + 3 * frame);
    expect(result.audio?.codec).toBe("aac");
    const times = await frameTimes(out);
    expect(times.length).toBeGreaterThanOrEqual(59);
    expect(times.length).toBeLessThanOrEqual(61);
    const at = (t: number) => times.findIndex((x) => x >= t - 0.001);
    expect(await luma(out, at(0.5), 180, 320)).toBeLessThan(120); // blue, no caption
    expect(await luma(out, at(1.2), 180, 320)).toBeLessThan(30); // black gap
    expect(await luma(out, at(1.5), 180, 320)).toBeGreaterThan(200); // caption on
  }, 60_000);

  it("stream-copies when there is nothing to burn in", async () => {
    const source = sources.fps2997;
    const { built, result } = await exportWith(source, { clips: [{ mediaId: "m", start: 0, srcIn: 0, srcOut: source.info.video!.duration }], segments: [{ start: 0, end: source.info.video!.duration, image: null }] }, "copy");
    expect(built.mode).toBe("copy");
    expect(result.video!.frames).toBe(source.info.video!.frames);
  }, 60_000);
});
