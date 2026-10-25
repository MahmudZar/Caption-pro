import { describe, expect, it } from "vitest";

import { captionSpans } from "../export/exporter";
import { TIKTOK_BOX, createProject } from "../state/defaults";
import type { Caption, Project, VideoClip } from "../state/types";

import { captionSlotFree, clipEnd, closeGapAt, deleteItems, editPoints, freeCaptionTrack, splitAt } from "./edit";
import { formatTimecode, parseTimecode, snapToFrame } from "./time";

const rate30 = { fpsNum: 30, fpsDen: 1 };
const ntsc = { fpsNum: 30000, fpsDen: 1001 };

function caption(id: string, start: number, end: number, track = 0, text = id): Caption {
  return { id, kind: "caption", track, start, end, text, x: 0.5, y: 0.2, style: structuredClone(TIKTOK_BOX) };
}

function clip(id: string, start: number, srcIn: number, srcOut: number): VideoClip {
  return { id, kind: "video", mediaId: "m", start, srcIn, srcOut };
}

function project(clips: VideoClip[], captions: Caption[]): Project {
  return { ...createProject(), sequence: { width: 1080, height: 1920, ...rate30 }, clips, captions };
}

describe("time", () => {
  it("formats and parses timecode at 29.97", () => {
    const t = snapToFrame(10.5, ntsc);
    expect(parseTimecode(formatTimecode(t, ntsc), ntsc)).toBeCloseTo(t, 6);
    expect(parseTimecode("45f", rate30)).toBeCloseTo(1.5);
    expect(parseTimecode("2.5", rate30)).toBe(2.5);
    expect(parseTimecode("nonsense", rate30)).toBe(null);
  });
});

describe("split", () => {
  it("cuts video and captions at the playhead, keeping source times", () => {
    const p = project([clip("v", 0, 0, 10)], [caption("a", 1, 4)]);
    const created = splitAt(p, 2, null, rate30);
    expect(created.length).toBe(2);
    const [left, right] = [...p.clips].sort((a, b) => a.start - b.start);
    expect(clipEnd(left)).toBe(2);
    expect(right.srcIn).toBe(2);
    expect(p.captions.map((c) => [c.start, c.end]).sort()).toEqual([
      [1, 2],
      [2, 4],
    ]);
  });
  it("does nothing at clip edges or inside the first/last frame", () => {
    const p = project([clip("v", 0, 0, 10)], [caption("a", 1, 4)]);
    expect(splitAt(p, 0, null, rate30)).toEqual([]);
    expect(splitAt(p, 10, null, rate30)).toEqual([]);
    // At the caption's edge only the video (which runs through) gets cut.
    expect(splitAt(p, 1, null, rate30).length).toBe(1);
    expect(p.clips.length).toBe(2);
    expect(p.captions.length).toBe(1);
    expect(splitAt(p, 4 - 1 / 60, new Set(["a"]), rate30)).toEqual([]);
  });
  it("razor on one item leaves others alone", () => {
    const p = project([clip("v", 0, 0, 10)], [caption("a", 1, 4)]);
    splitAt(p, 2, new Set(["a"]), rate30);
    expect(p.clips.length).toBe(1);
    expect(p.captions.length).toBe(2);
  });
});

describe("delete", () => {
  it("ripple delete of video closes the gap and shortens or drops captions", () => {
    const p = project([clip("v1", 0, 0, 2), clip("v2", 2, 2, 4), clip("v3", 4, 4, 6)], [caption("inside", 2.5, 3), caption("across", 1, 3), caption("after", 5, 5.5)]);
    const dropped = deleteItems(p, new Set(["v2"]), true, rate30);
    expect(dropped).toBe(1);
    expect(p.clips.map((c) => c.start)).toEqual([0, 2]);
    const across = p.captions.find((c) => c.id === "across")!;
    expect([across.start, across.end]).toEqual([1, 2]);
    const after = p.captions.find((c) => c.id === "after")!;
    expect([after.start, after.end]).toEqual([3, 3.5]);
  });
  it("plain delete leaves a gap; closeGapAt closes it", () => {
    const p = project([clip("v1", 0, 0, 2), clip("v2", 2, 2, 4)], [caption("late", 3, 3.5)]);
    deleteItems(p, new Set(["v1"]), false);
    expect(p.clips[0].start).toBe(2);
    expect(closeGapAt(p, 1)).toBe(true);
    expect(p.clips[0].start).toBe(0);
    expect(p.captions[0].start).toBe(1);
  });
  it("ripple delete of a caption closes its own track only", () => {
    const p = project([clip("v", 0, 0, 10)], [caption("a", 0, 1), caption("b", 1, 2), caption("other", 1.5, 2, 1)]);
    deleteItems(p, new Set(["a"]), true);
    expect(p.captions.find((c) => c.id === "b")!.start).toBe(0);
    expect(p.captions.find((c) => c.id === "other")!.start).toBe(1.5);
    expect(p.clips[0].start).toBe(0);
  });
});

describe("tracks", () => {
  it("finds a free track for overlapping captions", () => {
    const p = project([], [caption("a", 0, 2), caption("b", 0, 2, 1)]);
    expect(captionSlotFree(p, 0, 1, 3, new Set())).toBe(false);
    expect(freeCaptionTrack(p, 1, 3)).toBe(2);
    expect(freeCaptionTrack(p, 2, 3)).toBe(0); // touching is fine
  });
  it("lists edit points", () => {
    const p = project([clip("v", 0, 0, 3)], [caption("a", 1, 2)]);
    expect(editPoints(p)).toEqual([0, 1, 2, 3]);
  });
});

describe("caption spans (export)", () => {
  it("splits the timeline where the visible set changes and merges equal spans", () => {
    const spans = captionSpans([caption("a", 0, 2), caption("b", 1, 3, 1), caption("c", 3, 4)], 5);
    expect(spans.map((s) => [s.start, s.end, s.captions.map((c) => c.id).join("+")])).toEqual([
      [0, 1, "a"],
      [1, 2, "a+b"],
      [2, 3, "b"],
      [3, 4, "c"],
      [4, 5, ""],
    ]);
  });
  it("cuts captions at the end of the video and skips empty text", () => {
    const spans = captionSpans([caption("a", 4, 8), caption("blank", 0, 1, 0, "  ")], 5);
    expect(spans.map((s) => [s.start, s.end, s.captions.length])).toEqual([
      [0, 4, 0],
      [4, 5, 1],
    ]);
  });
});
