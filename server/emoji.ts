/**
 * Apple emoji images. The map (emoji code points → image name) comes from emoji-datasource
 * (iamcal/emoji-data), which also ships every Apple image at 64 px offline. 64 px is soft at
 * caption sizes (a 56 px caption on a 1080-wide frame draws emoji at ~63 px, bigger captions go
 * well past it), so the server first tries a 160 px Apple set from a public CDN and caches every
 * image it gets in data/emoji-160/. Offline or missing → the bundled 64 px image.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DIRS, EMOJI_DATA_DIR } from "./paths.ts";

const CDN_160 = "https://dataabinash.github.io/emoji/apple/png/160/emojis/";
const KEY_RE = /^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface EmojiEntry {
  unified: string;
  non_qualified?: string | null;
  image: string;
  has_img_apple?: boolean;
  skin_variations?: Record<string, { unified: string; non_qualified?: string | null; image: string; has_img_apple?: boolean }>;
}

let mapCache: Record<string, string> | null = null;

/** { "1f629": "1f629", "2764": "2764-fe0f", ... } keys = lower-case code points joined by "-". */
export function emojiMap(): Record<string, string> {
  if (mapCache) return mapCache;
  const list = JSON.parse(readFileSync(path.join(EMOJI_DATA_DIR, "emoji.json"), "utf8")) as EmojiEntry[];
  const map: Record<string, string> = {};
  const add = (unified: string | null | undefined, image: string) => {
    if (unified) map[unified.toLowerCase()] = image.replace(/\.png$/, "");
  };
  for (const entry of list) {
    if (entry.has_img_apple !== false) {
      add(entry.unified, entry.image);
      add(entry.non_qualified, entry.image);
    }
    for (const variation of Object.values(entry.skin_variations ?? {})) {
      if (variation.has_img_apple === false) continue;
      add(variation.unified, variation.image);
      add(variation.non_qualified, variation.image);
    }
  }
  mapCache = map;
  return map;
}

const missing160 = new Set<string>();
const inflight = new Map<string, Promise<Buffer | null>>();

async function fetch160(key: string): Promise<Buffer | null> {
  const file = path.join(DIRS.emoji, `${key}.png`);
  if (existsSync(file)) return readFile(file);
  if (missing160.has(key) || existsSync(`${file}.missing`)) return null;
  try {
    const response = await fetch(`${CDN_160}${key}.png`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) {
      if (response.status === 404) await writeFile(`${file}.missing`, "").catch(() => undefined);
      missing160.add(key);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    await writeFile(file, buffer).catch(() => undefined);
    return buffer;
  } catch {
    // Offline: try again next time the app starts.
    missing160.add(key);
    return null;
  }
}

/** PNG bytes for an image key, 160 px when available, else the bundled 64 px one. */
export async function emojiImage(key: string): Promise<{ data: Buffer; size: 160 | 64 } | null> {
  if (!KEY_RE.test(key)) return null;
  let job = inflight.get(key);
  if (!job) {
    job = fetch160(key);
    inflight.set(key, job);
    void job.finally(() => inflight.delete(key));
  }
  const big = await job;
  if (big) return { data: big, size: 160 };
  const small = path.join(EMOJI_DATA_DIR, "img", "apple", "64", `${key}.png`);
  if (existsSync(small)) return { data: await readFile(small), size: 64 };
  return null;
}
