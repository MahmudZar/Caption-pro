/**
 * Local API, mounted into the Vite dev server as middleware (one process: `npm start`).
 * Media is read in place from its original path; nothing leaves this machine except emoji image
 * downloads (see emoji.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { ExportPlan, ExportStatus, MediaInfo, MediaRecord, MediaStatus } from "../shared/types.ts";

import { openFileDialog, revealInExplorer, saveFileDialog } from "./dialogs.ts";
import { emojiImage, emojiMap } from "./emoji.ts";
import { computePeaks, makeProxy, probe, progressParser, run } from "./ffmpeg.ts";
import { DATA, DIRS, FFMPEG, FFPROBE } from "./paths.ts";
import { buildExport, captionConcat, hasCaptions } from "./plan.ts";

type Next = (error?: unknown) => void;

const VIDEO_FILTER = "Videos|*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.mts;*.m2ts;*.ts|All files|*.*";
const PROJECT_FILTER = "Caption Pro project|*.captionpro|All files|*.*";
const REGISTRY_FILE = path.join(DATA, "media.json");
const AUTOSAVE_FILE = path.join(DIRS.projects, "autosave.json");

// ---------------- media registry ----------------

const media = new Map<string, MediaInfo>();
const status = new Map<string, MediaStatus>();

try {
  const saved = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Record<string, MediaInfo>;
  for (const [id, info] of Object.entries(saved)) media.set(id, info);
} catch {
  // First run.
}

function saveRegistry(): void {
  void writeFile(REGISTRY_FILE, JSON.stringify(Object.fromEntries(media), null, 1)).catch(() => undefined);
}

/** Same file, same size and date → same id; a re-exported file gets a new id (fresh peaks). */
function mediaId(info: Pick<MediaInfo, "path" | "size" | "mtimeMs">): string {
  return createHash("sha1").update(`${path.resolve(info.path).toLowerCase()}|${info.size}|${Math.round(info.mtimeMs)}`).digest("hex").slice(0, 16);
}

let peakQueue: Promise<void> = Promise.resolve();

function startBackgroundJobs(id: string, info: MediaInfo): void {
  const current = status.get(id);
  if (current && current.peaks !== "error" && current.proxy !== "error") return;
  const entry: MediaStatus = { peaks: info.audio ? "pending" : "none", proxy: info.browserPlayable ? "none" : "pending", proxyProgress: 0 };
  status.set(id, entry);

  if (info.audio) {
    const file = path.join(DIRS.peaks, `${id}.f32`);
    if (existsSync(file)) entry.peaks = "ready";
    else {
      // One decode at a time: several long imports must not fight over the CPU.
      peakQueue = peakQueue.then(async () => {
        entry.peaks = "running";
        try {
          const offset = (info.audio?.startTime ?? 0) - (info.video?.startTime ?? 0);
          await computePeaks(info.path, file, offset);
          entry.peaks = "ready";
        } catch (error) {
          entry.peaks = "error";
          entry.error = String(error);
        }
      });
    }
  }
  if (!info.browserPlayable && info.video) {
    const file = path.join(DIRS.proxies, `${id}.mp4`);
    if (existsSync(file)) entry.proxy = "ready";
    else {
      entry.proxy = "running";
      const temp = `${file}.part.mp4`;
      const job = makeProxy(info, temp, (p) => (entry.proxyProgress = p));
      void job.done.then(async ({ code, stderr }) => {
        if (code === 0) {
          await rename(temp, file);
          entry.proxy = "ready";
          entry.proxyProgress = 1;
        } else {
          entry.proxy = "error";
          entry.error = stderr.trim().split("\n").pop();
          await unlink(temp).catch(() => undefined);
        }
      });
    }
  }
}

async function register(filePath: string): Promise<MediaRecord> {
  const resolved = path.resolve(filePath.trim().replace(/^"(.*)"$/, "$1"));
  if (!existsSync(resolved)) throw new HttpError(404, `File not found: ${resolved}`);
  const fileStat = await stat(resolved);
  const id = mediaId({ path: resolved, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
  let info = media.get(id);
  if (!info) {
    info = await probe(resolved);
    if (!info.video) throw new HttpError(422, "This file has no video track.");
    if (info.video.width < 2 || info.video.height < 2) throw new HttpError(422, "Couldn't read the video size.");
    media.set(id, info);
    saveRegistry();
  }
  startBackgroundJobs(id, info);
  return { id, info };
}

// ---------------- export jobs ----------------

interface Job {
  status: ExportStatus;
  dir: string;
  kill?: () => void;
  startedAt: number;
}
const jobs = new Map<string, Job>();

async function startExport(job: Job, plan: ExportPlan): Promise<void> {
  const used = new Map<string, MediaInfo>();
  for (const clip of plan.clips) {
    const info = media.get(clip.mediaId);
    if (!info) throw new HttpError(409, "A clip's media isn't loaded. Re-import it and try again.");
    if (!existsSync(info.path)) throw new HttpError(409, `Source file is missing: ${info.path}`);
    used.set(clip.mediaId, info);
  }
  let output = path.resolve(plan.output);
  if (!/\.mp4$/i.test(output)) output += ".mp4";
  if (!existsSync(path.dirname(output))) throw new HttpError(400, `Folder doesn't exist: ${path.dirname(output)}`);
  for (const info of used.values()) {
    if (path.resolve(info.path).toLowerCase() === output.toLowerCase()) throw new HttpError(400, "The export would overwrite its own source video. Pick another name.");
  }
  const temp = path.join(path.dirname(output), `.${path.basename(output, ".mp4")}.captionpro-${job.status.id.slice(0, 6)}.mp4`);
  const captionList = hasCaptions(plan) ? path.join(job.dir, "captions.ffconcat") : null;
  if (captionList) {
    const imagePath = (index: number | null) => path.join(job.dir, index === null ? "blank.png" : `${index}.png`);
    for (const seg of plan.segments) {
      if (!existsSync(imagePath(seg.image))) throw new HttpError(400, `Caption image ${seg.image ?? "blank"} wasn't uploaded.`);
    }
    await writeFile(captionList, captionConcat(plan, imagePath));
  }
  const built = buildExport({ ...plan, output: temp }, used, captionList);
  await writeFile(path.join(job.dir, "command.txt"), [FFMPEG, ...built.args].map((a) => (/\s|;|\[/.test(a) ? `"${a}"` : a)).join(" "));
  job.status = { ...job.status, state: "encoding", mode: built.mode, progress: 0, log: built.notes.join("\n") };
  const proc = run(FFMPEG, built.args, progressParser((t) => (job.status.progress = built.duration ? Math.min(0.999, t / built.duration) : 0)));
  job.kill = () => proc.child.kill("SIGKILL");
  void proc.done.then(async ({ code, stderr }) => {
    job.kill = undefined;
    if (job.status.state === "cancelled") {
      await unlink(temp).catch(() => undefined);
      return;
    }
    if (code !== 0) {
      await unlink(temp).catch(() => undefined);
      await writeFile(path.join(job.dir, "ffmpeg.log"), stderr).catch(() => undefined);
      job.status = { ...job.status, state: "error", error: stderr.trim().split("\n").slice(-6).join("\n") || `ffmpeg exited with ${code}` };
      return;
    }
    try {
      await rm(output, { force: true });
      await rename(temp, output);
      const result = await probe(output);
      job.status = { ...job.status, state: "done", progress: 1, output, result, elapsed: (Date.now() - job.startedAt) / 1000 };
      await rm(job.dir, { recursive: true, force: true });
    } catch (error) {
      job.status = { ...job.status, state: "error", error: String(error) };
    }
  });
}

// ---------------- HTTP helpers ----------------

class HttpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString("utf8") || "{}") as T;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/mp4", // Chrome plays H.264 MOV only when it's labelled MP4.
  ".webm": "video/webm",
  ".mkv": "video/webm",
};

async function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
  const { size } = await stat(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    await pipeline(createReadStream(filePath, { start, end }), res).catch(() => undefined);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
  await pipeline(createReadStream(filePath), res).catch(() => undefined);
}

function safeName(name: string): string {
  return path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120) || "video.mp4";
}

// ---------------- routes ----------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (!p.startsWith("/api/")) return false;
  let m: RegExpExecArray | null;

  if (p === "/api/health") {
    send(res, 200, { ffmpeg: FFMPEG, ffprobe: FFPROBE, platform: process.platform });
    return true;
  }

  // Media
  if (p === "/api/media/register" && method === "POST") {
    const { path: filePath } = await readJson<{ path: string }>(req);
    if (!filePath) throw new HttpError(400, "No path");
    send(res, 200, await register(filePath));
    return true;
  }
  if (p === "/api/media/upload" && method === "POST") {
    // Drag-and-drop gives the browser a File without a path: keep a copy in data/uploads.
    const name = safeName(url.searchParams.get("name") ?? "video.mp4");
    const target = path.join(DIRS.uploads, `${Date.now()}-${name}`);
    await pipeline(req, createWriteStream(target));
    send(res, 200, await register(target));
    return true;
  }
  if ((m = /^\/api\/media\/([0-9a-f]{16})\/(file|status|peaks)$/.exec(p))) {
    const id = m[1];
    const info = media.get(id);
    if (!info) throw new HttpError(404, "Unknown media");
    if (m[2] === "status") {
      startBackgroundJobs(id, info);
      send(res, 200, status.get(id));
      return true;
    }
    if (m[2] === "peaks") {
      const file = path.join(DIRS.peaks, `${id}.f32`);
      if (!existsSync(file)) throw new HttpError(404, "Peaks not ready");
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length, "Cache-Control": "max-age=31536000, immutable" });
      res.end(data);
      return true;
    }
    const proxy = path.join(DIRS.proxies, `${id}.mp4`);
    const file = url.searchParams.get("proxy") === "1" && existsSync(proxy) ? proxy : info.path;
    if (!existsSync(file)) throw new HttpError(404, "File is missing");
    await serveFile(req, res, file);
    return true;
  }

  // Emoji
  if (p === "/api/emoji/map") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "max-age=3600" });
    res.end(JSON.stringify(emojiMap()));
    return true;
  }
  if ((m = /^\/api\/emoji\/([0-9a-f-]+)\.png$/.exec(p))) {
    const image = await emojiImage(m[1]);
    if (!image) throw new HttpError(404, "No Apple image for this emoji");
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": image.data.length, "Cache-Control": image.size === 160 ? "max-age=31536000, immutable" : "no-cache", "X-Emoji-Size": String(image.size) });
    res.end(image.data);
    return true;
  }

  // Dialogs
  if (p === "/api/dialog/open-media" && method === "POST") {
    const { initialDir } = await readJson<{ initialDir?: string }>(req);
    send(res, 200, { path: await openFileDialog({ title: "Import video", filter: VIDEO_FILTER, initialDir }) });
    return true;
  }
  if (p === "/api/dialog/open-project" && method === "POST") {
    send(res, 200, { path: await openFileDialog({ title: "Open Caption Pro project", filter: PROJECT_FILTER }) });
    return true;
  }
  if (p === "/api/dialog/save-project" && method === "POST") {
    const { fileName, initialDir } = await readJson<{ fileName: string; initialDir?: string }>(req);
    send(res, 200, { path: await saveFileDialog({ title: "Save project", filter: PROJECT_FILTER, fileName: safeName(fileName), initialDir, defaultExt: "captionpro" }) });
    return true;
  }
  if (p === "/api/dialog/save-export" && method === "POST") {
    const { fileName, initialDir } = await readJson<{ fileName: string; initialDir?: string }>(req);
    send(res, 200, { path: await saveFileDialog({ title: "Export video", filter: "MP4 video|*.mp4", fileName: safeName(fileName), initialDir, defaultExt: "mp4" }) });
    return true;
  }
  if (p === "/api/reveal" && method === "POST") {
    const { path: target } = await readJson<{ path: string }>(req);
    if (target && existsSync(target)) revealInExplorer(path.resolve(target));
    send(res, 200, { ok: true });
    return true;
  }
  if (p === "/api/exists" && method === "POST") {
    const { path: target } = await readJson<{ path: string }>(req);
    send(res, 200, { exists: !!target && existsSync(path.resolve(target)) });
    return true;
  }

  // Projects
  if (p === "/api/autosave") {
    if (method === "PUT") {
      await writeFile(AUTOSAVE_FILE, await readBody(req));
      send(res, 200, { ok: true });
    } else if (existsSync(AUTOSAVE_FILE)) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(await readFile(AUTOSAVE_FILE));
    } else send(res, 200, null);
    return true;
  }
  if (p === "/api/project/save" && method === "POST") {
    const { path: target, project } = await readJson<{ path: string; project: unknown }>(req);
    let file = path.resolve(target);
    if (!/\.captionpro$/i.test(file)) file += ".captionpro";
    if (!existsSync(path.dirname(file))) throw new HttpError(400, `Folder doesn't exist: ${path.dirname(file)}`);
    // Write then rename, so a crash mid-save never leaves half a project.
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(project, null, 1));
    await rename(temp, file);
    send(res, 200, { path: file });
    return true;
  }
  if (p === "/api/project/read" && method === "POST") {
    const { path: target } = await readJson<{ path: string }>(req);
    const file = path.resolve(target);
    if (!existsSync(file)) throw new HttpError(404, `Project not found: ${file}`);
    const text = await readFile(file, "utf8");
    try {
      send(res, 200, { path: file, project: JSON.parse(text) });
    } catch {
      throw new HttpError(422, "That file isn't a Caption Pro project.");
    }
    return true;
  }

  // Export
  if (p === "/api/export/jobs" && method === "POST") {
    const id = randomUUID();
    const dir = path.join(DIRS.jobs, id);
    await mkdir(dir, { recursive: true });
    jobs.set(id, { status: { id, state: "waiting", progress: 0 }, dir, startedAt: Date.now() });
    send(res, 200, { id });
    return true;
  }
  if ((m = /^\/api\/export\/jobs\/([0-9a-f-]{36})(?:\/(images\/(\d+|blank)|start|cancel))?$/.exec(p))) {
    const job = jobs.get(m[1]);
    if (!job) throw new HttpError(404, "Unknown export job");
    if (m[2]?.startsWith("images/") && method === "PUT") {
      await pipeline(req, createWriteStream(path.join(job.dir, `${m[3]}.png`)));
      send(res, 200, { ok: true });
      return true;
    }
    if (m[2] === "start" && method === "POST") {
      const { plan } = await readJson<{ plan: ExportPlan }>(req);
      job.startedAt = Date.now();
      await startExport(job, plan);
      send(res, 200, job.status);
      return true;
    }
    if (m[2] === "cancel" && method === "POST") {
      job.status = { ...job.status, state: "cancelled" };
      job.kill?.();
      await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
      send(res, 200, job.status);
      return true;
    }
    send(res, 200, job.status);
    return true;
  }

  throw new HttpError(404, `No route ${method} ${p}`);
}

export function captionProApi() {
  return {
    name: "caption-pro-api",
    configureServer(server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: Next) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        handle(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch((error: unknown) => {
            const code = error instanceof HttpError ? error.code : 500;
            const message = error instanceof Error ? error.message : String(error);
            if (code === 500) console.error("[caption-pro]", error);
            if (!res.headersSent) send(res, code, { error: message });
            else res.end();
          });
      });
    },
  };
}
