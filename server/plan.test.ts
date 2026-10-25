import { describe, expect, it } from "vitest";

import type { ExportPlan, MediaInfo } from "../shared/types.ts";

import { buildExport, captionConcat, colorSetup, isIdentity, timescaleFor } from "./plan.ts";

function media(patch: Partial<MediaInfo["video"]> = {}, audio: MediaInfo["audio"] = { codec: "aac", sampleRate: 48000, channels: 2, bitRate: 317000, startTime: 0 }): MediaInfo {
  return {
    path: "C:/v/source.mp4",
    name: "source.mp4",
    size: 1,
    mtimeMs: 1,
    container: "mov,mp4",
    duration: 16.633333,
    browserPlayable: true,
    audio,
    video: {
      codec: "h264",
      width: 1080,
      height: 1920,
      codedWidth: 1080,
      codedHeight: 1920,
      rotation: 0,
      sar: 1,
      fpsNum: 30,
      fpsDen: 1,
      avgFps: 30,
      vfr: false,
      pixFmt: "yuv420p",
      colorSpace: null,
      colorPrimaries: null,
      colorTransfer: null,
      colorRange: "tv",
      bitRate: 19e6,
      startTime: 0,
      duration: 16.633333,
      frames: 499,
      ...patch,
    },
  };
}

function plan(patch: Partial<ExportPlan> = {}): ExportPlan {
  return {
    output: "C:/v/out.mp4",
    width: 1080,
    height: 1920,
    fpsNum: 30,
    fpsDen: 1,
    clips: [{ mediaId: "m", start: 0, srcIn: 0, srcOut: 16.633333 }],
    segments: [
      { start: 0, end: 2, image: 0 },
      { start: 2, end: 16.633333, image: null },
    ],
    quality: "lossless",
    ...patch,
  };
}

const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

describe("export plan", () => {
  it("copies the stream when nothing changes and there are no captions", () => {
    const built = buildExport(plan(), new Map([["m", media()]]), null);
    expect(built.mode).toBe("copy");
    expect(built.args).toContain("copy");
    expect(built.args.join(" ")).toContain("-c:a copy");
  });
  it("overlays captions on the untouched stream and copies AAC audio", () => {
    const built = buildExport(plan(), new Map([["m", media()]]), "C:/job/captions.ffconcat");
    expect(built.mode).toBe("overlay");
    const graph = graphOf(built.args);
    expect(graph).toContain("overlay=eof_action=repeat");
    expect(graph).toContain("out_color_matrix=bt709");
    expect(built.args.join(" ")).toContain("-c:a copy");
    expect(built.args.join(" ")).toContain("-fps_mode passthrough");
    expect(built.args.join(" ")).toContain("-crf 14");
  });
  it("re-times captions when the video starts after 0", () => {
    const built = buildExport(plan(), new Map([["m", media({ startTime: 0.5 })]]), "x.ffconcat");
    expect(graphOf(built.args)).toContain("setpts=PTS+0.5/TB");
  });
  it("re-encodes non-MP4 audio (PCM) instead of copying", () => {
    const built = buildExport(plan(), new Map([["m", media({}, { codec: "pcm_s16le", sampleRate: 48000, channels: 2, bitRate: null, startTime: 0 })]]), "x.ffconcat");
    expect(built.args.join(" ")).toContain("-c:a aac");
  });
  it("leaves audio out when the source has none", () => {
    const built = buildExport(plan(), new Map([["m", media({}, null)]]), "x.ffconcat");
    expect(built.args).not.toContain("0:a:0");
  });
  it("builds a trim/concat graph with a black gap for an edited timeline", () => {
    const p = plan({
      clips: [
        { mediaId: "m", start: 0, srcIn: 0, srcOut: 5 },
        { mediaId: "m", start: 6, srcIn: 8, srcOut: 12 },
      ],
    });
    expect(isIdentity(p, new Map([["m", media()]]))).toBe(false);
    const built = buildExport(p, new Map([["m", media()]]), "x.ffconcat");
    expect(built.mode).toBe("edit");
    const graph = graphOf(built.args);
    expect(graph).toContain("split=2");
    expect(graph).toContain("trim=start=8:end=12");
    expect(graph).toContain("color=c=black:s=1080x1920:r=30/1:d=1");
    expect(graph).toContain("concat=n=3:v=1:a=1");
    expect(built.duration).toBe(10);
    expect(built.args.join(" ")).toContain("-c:a aac");
  });
  it("edited timeline without audio has no audio pads", () => {
    const p = plan({ clips: [{ mediaId: "m", start: 0, srcIn: 1, srcOut: 3 }] });
    const graph = graphOf(buildExport(p, new Map([["m", media({}, null)]]), null).args);
    expect(graph).toContain("concat=n=1:v=1:a=0");
    expect(graph).not.toContain("anullsrc");
  });
  it("refuses odd sizes and empty timelines", () => {
    expect(() => buildExport(plan({ width: 1081 }), new Map([["m", media({ width: 1081 })]]), null)).toThrow();
    expect(() => buildExport(plan({ clips: [] }), new Map(), null)).toThrow();
  });
  it("treats untagged HD as BT.709 and SD as BT.601", () => {
    expect(colorSetup(media().video!).matrix).toBe("bt709");
    expect(colorSetup(media({ width: 640, height: 480 }).video!).matrix).toBe("bt601");
    expect(colorSetup(media({ colorSpace: "bt470bg" }).video!).matrix).toBe("bt601");
  });
  it("picks a timescale that holds every frame exactly", () => {
    expect(timescaleFor(30, 1)).toBe(90000);
    expect(timescaleFor(24000, 1001)).toBe(24000);
    expect(timescaleFor(30000, 1001)).toBe(30000);
  });
});

describe("caption track list", () => {
  it("moves boundaries half a frame early and ends on a blank", () => {
    const text = captionConcat(plan(), (i) => (i === null ? "C:/job/blank.png" : `C:/job/${i}.png`));
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("ffconcat version 1.0");
    expect(lines[1]).toBe("file 'C:/job/0.png'");
    expect(lines[2]).toBe("option framerate 1000000");
    expect(lines[3]).toBe(`duration ${(2 - 1 / 60).toFixed(6).replace(/0+$/, "")}`);
    expect(lines.slice(-2)).toEqual(["file 'C:/job/blank.png'", "option framerate 1000000"]);
  });
});
