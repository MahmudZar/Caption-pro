/**
 * Where Caption Pro keeps its files, and which ffmpeg/ffprobe it runs. Everything the app
 * creates lives in `data/` next to package.json (media registry, waveform peaks, emoji cache,
 * preview proxies, autosave, export scratch), so deleting that folder resets the app.
 */
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.join(ROOT, "data");

export const DIRS = {
  peaks: path.join(DATA, "peaks"),
  proxies: path.join(DATA, "proxies"),
  uploads: path.join(DATA, "uploads"),
  emoji: path.join(DATA, "emoji-160"),
  jobs: path.join(DATA, "export-jobs"),
  projects: path.join(DATA, "projects"),
};

for (const dir of Object.values(DIRS)) mkdirSync(dir, { recursive: true });

/** FFMPEG_PATH / FFPROBE_PATH override the bundled binaries (e.g. a newer full build). */
function resolveBinary(envName: string, fallback: () => string | null): string {
  const fromEnv = process.env[envName];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const bundled = fallback();
  if (bundled && existsSync(bundled)) return bundled;
  return envName === "FFMPEG_PATH" ? "ffmpeg" : "ffprobe";
}

export const FFMPEG = resolveBinary("FFMPEG_PATH", () => require("ffmpeg-static") as string | null);
export const FFPROBE = resolveBinary("FFPROBE_PATH", () => (require("ffprobe-static") as { path: string }).path);

export const EMOJI_DATA_DIR = path.dirname(require.resolve("emoji-datasource-apple/package.json"));
