import { beforeAll, describe, expect, it } from "vitest";

import { TIKTOK_BOX } from "../state/defaults";
import type { CaptionStyle } from "../state/types";

import { codePointKey, imageKeyFor, setEmojiMapForTests, splitRuns } from "./emoji";
import { EMOJI_SCALE, layoutCaption, type Measurer } from "./layout";
import { cornerRadii, stackedOutline } from "./outline";

/** Every grapheme is 0.5 × font size wide; metrics are fixed. */
const measurer: Measurer = {
  width(text, font) {
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length * px * 0.5;
  },
  metrics(font) {
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]);
    return { ascent: px * 0.9, descent: px * 0.25 };
  },
};

beforeAll(() => {
  setEmojiMapForTests({
    "1f629": "1f629",
    "1f60e": "1f60e",
    "1f1f0-1f1ea": "1f1f0-1f1ea",
    "1f469-1f3fd-200d-1f4bb": "1f469-1f3fd-200d-1f4bb",
    "2764-fe0f": "2764-fe0f",
    "2764": "2764-fe0f",
  });
});

const style = (patch: Partial<CaptionStyle> = {}): CaptionStyle => ({ ...structuredClone(TIKTOK_BOX), ...patch });

describe("emoji runs", () => {
  it("keeps ZWJ sequences, skin tones and flags whole", () => {
    const runs = splitRuns("Hi 👩🏽‍💻 from 🇰🇪!");
    expect(runs.map((r) => r.kind)).toEqual(["text", "emoji", "text", "emoji", "text"]);
    expect(runs[1].text).toBe("👩🏽‍💻");
    expect(codePointKey(runs[1].text)).toBe("1f469-1f3fd-200d-1f4bb");
    expect(imageKeyFor("🇰🇪")).toBe("1f1f0-1f1ea");
  });
  it("keeps text-style characters as text and maps emoji-style ones", () => {
    expect(splitRuns("❤").every((r) => r.kind === "text")).toBe(true);
    expect(imageKeyFor("❤️")).toBe("2764-fe0f");
  });
});

describe("layout", () => {
  it("wraps at the max width and centres each line", () => {
    // 1080 frame → unit 1, font 54 → glyph 27 px; max width 0.5 → 540 px = 20 glyphs.
    const layout = layoutCaption({ text: "The problem with tiny cameras is real", x: 0.5, y: 0.5, style: style({ maxWidth: 0.5 }) }, 1080, 1920, measurer);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(line.width).toBeLessThanOrEqual(540 + 1e-6);
      expect(line.x + line.width / 2).toBeCloseTo(540);
    }
  });
  it("breaks a word longer than the line between graphemes", () => {
    const layout = layoutCaption({ text: "Supercalifragilisticexpialidocious", x: 0.5, y: 0.5, style: style({ maxWidth: 0.25 }) }, 1080, 1920, measurer);
    expect(layout.lines.length).toBe(4); // 34 letters, 10 per line
    expect(layout.lines.map((l) => l.tokens.map((t) => t.text).join("")).join("")).toBe("Supercalifragilisticexpialidocious");
  });
  it("never leaves an emoji alone at the start of a line", () => {
    // "The problem" = 11 glyphs = 297 px; the emoji is 54 × 1.26 ≈ 68 px; max 330 px.
    const layout = layoutCaption({ text: "The problem 😩", x: 0.5, y: 0.5, style: style({ maxWidth: 330 / 1080 }) }, 1080, 1920, measurer);
    const last = layout.lines[layout.lines.length - 1];
    expect(last.tokens.some((t) => t.kind === "text" && t.text.trim().length > 0)).toBe(true);
    expect(last.tokens.some((t) => t.kind === "emoji")).toBe(true);
  });
  it("sizes emoji tokens and keeps them atomic", () => {
    const layout = layoutCaption({ text: "The solution 😎", x: 0.5, y: 0.2, style: style() }, 1080, 1920, measurer);
    const emoji = layout.lines.flatMap((l) => l.tokens).find((t) => t.kind === "emoji")!;
    expect(emoji.key).toBe("1f60e");
    expect(emoji.width).toBeCloseTo(54 * EMOJI_SCALE);
  });
  it("one box per line in TikTok mode, touching vertically, padded at the ends", () => {
    const s = style({ maxWidth: 0.3 });
    const layout = layoutCaption({ text: "one two three four five six", x: 0.5, y: 0.5, style: s }, 1080, 1920, measurer);
    expect(layout.boxes.length).toBe(layout.lines.length);
    for (let i = 0; i < layout.boxes.length - 1; i += 1) expect(layout.boxes[i].y + layout.boxes[i].h).toBeCloseTo(layout.boxes[i + 1].y);
    expect(layout.boxes[0].y).toBeCloseTo(layout.lines[0].top - s.box.padY);
    expect(layout.boxGroups.length).toBe(1);
  });
  it("splits box groups at blank lines and handles empty text", () => {
    const layout = layoutCaption({ text: "Vs…\n\nNext", x: 0.5, y: 0.5, style: style() }, 1080, 1920, measurer);
    expect(layout.lines.length).toBe(3);
    expect(layout.boxGroups.length).toBe(2);
    const empty = layoutCaption({ text: "   ", x: 0.5, y: 0.5, style: style() }, 1080, 1920, measurer);
    expect(empty.lines.length).toBe(0);
    expect(empty.boxes.length).toBe(0);
  });
  it("scales with the frame width (reference px)", () => {
    const small = layoutCaption({ text: "Hello", x: 0.5, y: 0.5, style: style() }, 720, 1280, measurer);
    const big = layoutCaption({ text: "Hello", x: 0.5, y: 0.5, style: style() }, 2160, 3840, measurer);
    expect(big.fontPx / small.fontPx).toBeCloseTo(3);
  });
});

describe("TikTok outline", () => {
  it("traces stacked boxes as one polygon with inner and outer corners", () => {
    const points = stackedOutline([
      { x: 100, y: 0, w: 200, h: 50 },
      { x: 50, y: 50, w: 300, h: 50 },
      { x: 150, y: 100, w: 100, h: 50 },
    ]);
    // 3 different widths, centred: 12 corners.
    expect(points.length).toBe(12);
    expect(points[0]).toEqual({ x: 100, y: 0 });
  });
  it("merges equal-width lines into straight edges", () => {
    const points = stackedOutline([
      { x: 0, y: 0, w: 100, h: 40 },
      { x: 0, y: 40, w: 100, h: 40 },
    ]);
    expect(points.length).toBe(4);
  });
  it("caps radii at half the neighbouring edges (tiny steps stay tiny)", () => {
    const points = stackedOutline([
      { x: 0, y: 0, w: 100, h: 40 },
      { x: -2, y: 40, w: 104, h: 40 },
    ]);
    const radii = cornerRadii(points, 20);
    expect(Math.min(...radii)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.max(...radii)).toBeLessThanOrEqual(20);
  });
});
