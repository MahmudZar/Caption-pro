/**
 * Apple emoji everywhere: caption text is split into text runs and emoji runs, and every emoji
 * run is drawn as an Apple image (never the system's Segoe emoji).
 *
 * Detection uses the RGI_Emoji Unicode property (regex `v` flag). It matches whole emoji as one
 * unit, including ZWJ sequences (👩🏽‍💻, 👨‍👩‍👧), skin tones, flags (🇰🇪), keycaps (1️⃣) and tag sequences
 * (🏴󠁧󠁢󠁳󠁣󠁴󠁿). Text-style characters like © or ™ typed without the emoji selector stay text.
 */

const EMOJI_RE = /\p{RGI_Emoji}/gv;

export type Run = { kind: "text"; text: string } | { kind: "emoji"; text: string };

export function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  let last = 0;
  for (const match of text.matchAll(EMOJI_RE)) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ kind: "text", text: text.slice(last, index) });
    runs.push({ kind: "emoji", text: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({ kind: "text", text: text.slice(last) });
  return runs;
}

export function hasEmoji(text: string): boolean {
  EMOJI_RE.lastIndex = 0;
  return new RegExp(EMOJI_RE.source, "v").test(text);
}

/** "😩" → "1f629", "❤️‍🔥" → "2764-fe0f-200d-1f525". */
export function codePointKey(emoji: string): string {
  return [...emoji].map((char) => char.codePointAt(0)!.toString(16)).join("-");
}

let emojiMap: Record<string, string> | null = null;
let mapPromise: Promise<void> | null = null;

export function loadEmojiMap(): Promise<void> {
  mapPromise ??= fetch("/api/emoji/map")
    .then((response) => response.json() as Promise<Record<string, string>>)
    .then((map) => {
      emojiMap = map;
      notify();
    })
    .catch((error: unknown) => {
      mapPromise = null;
      console.warn("Emoji map failed to load", error);
    });
  return mapPromise;
}

export function emojiMapReady(): boolean {
  return emojiMap !== null;
}

/** Image name for an emoji, or null when Apple has no image for it (drawn as text then). */
export function imageKeyFor(emoji: string): string | null {
  if (!emojiMap) return null;
  const key = codePointKey(emoji);
  return emojiMap[key] ?? emojiMap[key.replace(/-fe0f/g, "")] ?? emojiMap[`${key}-fe0f`] ?? null;
}

// ---------------- image cache ----------------

type Entry = { state: "loading" | "ready" | "error"; bitmap: ImageBitmap | null; promise: Promise<void> };
const images = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Called when an emoji image or the map finishes loading (redraw). */
export function onEmojiChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emojiVersion(): number {
  return version;
}

function load(key: string): Entry {
  let entry = images.get(key);
  if (entry) return entry;
  const created: Entry = {
    state: "loading",
    bitmap: null,
    promise: fetch(`/api/emoji/${key}.png`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
      })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        created.bitmap = bitmap;
        created.state = "ready";
        notify();
      })
      .catch(() => {
        created.state = "error";
        notify();
      }),
  };
  entry = created;
  images.set(key, entry);
  return entry;
}

/** The loaded image, or null while it loads (a redraw follows via onEmojiChange). */
export function emojiImage(key: string): ImageBitmap | null {
  const entry = load(key);
  return entry.state === "ready" ? entry.bitmap : null;
}

export function emojiFailed(key: string): boolean {
  return images.get(key)?.state === "error";
}

/** Waits until every emoji in the texts has loaded (export must never miss one). */
export async function preloadEmoji(texts: string[]): Promise<void> {
  await loadEmojiMap();
  const keys = new Set<string>();
  for (const text of texts) {
    for (const run of splitRuns(text)) {
      if (run.kind !== "emoji") continue;
      const key = imageKeyFor(run.text);
      if (key) keys.add(key);
    }
  }
  await Promise.all([...keys].map((key) => load(key).promise));
}

/** Tests: provide the emoji map without the server. */
export function setEmojiMapForTests(map: Record<string, string>): void {
  emojiMap = map;
}
