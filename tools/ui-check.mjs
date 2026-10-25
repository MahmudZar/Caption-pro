// Headless UI check with real mouse/keyboard input (Chrome DevTools protocol).
//   node --experimental-websocket tools/ui-check.mjs http://localhost:5191 "<video path>"
// Run it against a separate copy/port: it edits the project and autosaves like a user would.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, videoPath] = process.argv.slice(2);
const W = 1600;
const H = 950;
setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 180_000);
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const port = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cp-ui-"))}`, `--window-size=${W},${H}`, "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") pageErrors.push(m.params.args?.map((a) => a.value ?? a.description).join(" "));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => new Promise((r) => {
  const i = ++id;
  pending.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expression) => {
  const res = await send("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
};
const MOD = { alt: 1, ctrl: 2, shift: 8 };
const mods = (list = []) => list.reduce((sum, m) => sum + MOD[m], 0);
const mouse = (type, x, y, opts = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: opts.button ?? "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: opts.clickCount ?? 1, modifiers: mods(opts.mods) });
async function drag(x0, y0, x1, y1, opts = {}) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, modifiers: mods(opts.mods) });
  await mouse("mousePressed", x0, y0, opts);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, button: "left", buttons: 1, modifiers: mods(opts.mods) });
    await sleep(16);
  }
  await mouse("mouseReleased", x1, y1, opts);
  await sleep(80);
}
async function click(x, y, opts = {}) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: mods(opts.mods) });
  await mouse("mousePressed", x, y, opts);
  await mouse("mouseReleased", x, y, opts);
  await sleep(80);
}
const KEYS = { Escape: 27, Delete: 46, Backspace: 8, ArrowLeft: 37, ArrowRight: 39, " ": 32 };
async function key(k, list = []) {
  const code = KEYS[k] ?? k.toUpperCase().charCodeAt(0);
  const text = k.length === 1 && !list.includes("ctrl") ? k : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, windowsVirtualKeyCode: code, modifiers: mods(list), text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, windowsVirtualKeyCode: code, modifiers: mods(list) });
  await sleep(60);
}
async function wheel(x, y, deltaY, list = []) {
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: mods(list) });
  await sleep(80);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
};

await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });
await sleep(4000);

const PRE = `
const { useEditor, usePlayback, useView } = await import('/src/state/store.ts');
const geometry = await import('/src/timeline/geometry.ts');
const edit = await import('/src/model/edit.ts');
const S = () => useEditor.getState();
const lanes = document.querySelector('.timeline__lanes').getBoundingClientRect();
const view = useView.getState();
const rows = geometry.computeRows(lanes.height, geometry.visibleCaptionTracks(S().project), view.scrollY).rows;
const X = (t) => lanes.left + (t - view.scroll) * view.zoom;
const rowY = (kind, track = -1) => { const r = rows.find((r) => r.kind === kind && (kind !== 'caption' || r.track === track)); return lanes.top + r.y + r.h / 2; };
`;
const q = (body) => ev(`${PRE}\n${body}`);

try {
  // Import.
  await ev(`const m = await import('/src/app/media.ts'); await m.importByPath(${JSON.stringify(videoPath)}); return true;`);
  await sleep(1500);
  const imported = await q(`return { clips: S().project.clips.length, seq: S().project.sequence };`);
  check("import puts the video on the timeline and sets the sequence", imported.clips === 1 && imported.seq?.width === 1080, imported);

  // Caption via the Type tool on the monitor.
  await key("t");
  const frame = await ev(`const r = document.querySelector('.monitor__frame').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.2 };`);
  await click(frame.x, frame.y);
  await send("Input.insertText", { text: "The problem 😩" });
  await sleep(100);
  await key("Escape");
  const typed = await q(`return S().project.captions.map((c) => ({ text: c.text, start: c.start, end: c.end, track: c.track }));`);
  check("type tool adds a caption and typing edits it in place", typed.length === 1 && typed[0].text === "The problem 😩", typed);

  // Empty caption: created then abandoned leaves no caption and no undo step.
  const pastBefore = await q(`return S().past.length;`);
  await click(frame.x, frame.y + 300);
  await key("Escape");
  const abandoned = await q(`return { n: S().project.captions.length, past: S().past.length };`);
  check("an abandoned empty caption disappears without an undo step", abandoned.n === 1 && abandoned.past === pastBefore, { pastBefore, ...abandoned });
  await key("v");

  // Move a caption in the timeline.
  let pos = await q(`const c = S().project.captions[0]; return { x: X((c.start + c.end) / 2), y: rowY('caption', 0), start: c.start, end: c.end, zoom: view.zoom };`);
  await drag(pos.x, pos.y, pos.x + 1.5 * pos.zoom, pos.y);
  const moved = await q(`const c = S().project.captions[0]; return { start: c.start, end: c.end };`);
  check("dragging a caption moves it in time (frame-snapped)", Math.abs(moved.start - (pos.start + 1.5)) < 0.05 && Math.abs(moved.end - moved.start - (pos.end - pos.start)) < 1e-6, { before: pos, moved });

  // Trim its right edge.
  pos = await q(`const c = S().project.captions[0]; return { x: X(c.end) - 2, y: rowY('caption', 0), end: c.end, zoom: view.zoom };`);
  await drag(pos.x, pos.y, pos.x + 1 * pos.zoom, pos.y);
  const trimmed = await q(`const c = S().project.captions[0]; return { start: c.start, end: c.end };`);
  check("dragging the right edge trims the caption", Math.abs(trimmed.end - (pos.end + 1)) < 0.05, { before: pos.end, trimmed });

  // Trim to zero: the left edge dragged far past the right edge keeps one frame.
  pos = await q(`const c = S().project.captions[0]; return { x: X(c.start) + 2, y: rowY('caption', 0), end: c.end, zoom: view.zoom };`);
  await drag(pos.x, pos.y, pos.x + 20 * pos.zoom, pos.y);
  const tiny = await q(`const c = S().project.captions[0]; return { start: c.start, end: c.end, frame: 1 / 30 };`);
  check("trimming past the other edge keeps one frame", Math.abs(tiny.end - tiny.start - 1 / 30) < 1e-4 && Math.abs(tiny.end - pos.end) < 1e-6, tiny);
  await key("z", ["ctrl"]);

  // Drag to the track above.
  pos = await q(`const c = S().project.captions[0]; return { x: X((c.start + c.end) / 2), y: rowY('caption', 0), y1: rowY('caption', 1) };`);
  await drag(pos.x, pos.y, pos.x, pos.y1);
  const up = await q(`return S().project.captions[0].track;`);
  check("dragging up moves the caption to C2", up === 1, up);

  // Razor on the video at 5 s, then at the new edge (no-op).
  await key("c");
  pos = await q(`return { x: X(5), y: rowY('video') };`);
  await click(pos.x, pos.y);
  const cut = await q(`return S().project.clips.map((c) => ({ start: c.start, srcIn: c.srcIn, srcOut: c.srcOut }));`);
  check("razor click splits the video clip at the click", cut.length === 2 && Math.abs(cut[1].start - 5) < 0.04 && Math.abs(cut[1].srcIn - cut[1].start) < 1e-6, cut);
  const pastCut = await q(`return S().past.length;`);
  pos = await q(`return { x: X(S().project.clips[1].start), y: rowY('video') };`);
  await click(pos.x, pos.y);
  const edge = await q(`return { clips: S().project.clips.length, past: S().past.length };`);
  check("razor on a clip edge does nothing (no undo step)", edge.clips === 2 && edge.past === pastCut, edge);

  // Ctrl+K at the playhead cuts every track.
  await q(`const c = S().project.captions[0]; usePlayback.getState().setTime(c.start + 2 / 30); return true;`);
  await key("k", ["ctrl"]);
  const allCut = await q(`return { captions: S().project.captions.length, clips: S().project.clips.length };`);
  check("Ctrl+K cuts the caption and the video under the playhead", allCut.captions === 2 && allCut.clips === 3, allCut);

  // Alt+wheel zoom keeps the time under the pointer.
  await key("v");
  pos = await q(`return { x: lanes.left + 300, y: rowY('video'), t: (300) / view.zoom + view.scroll, zoom: view.zoom };`);
  await wheel(pos.x, pos.y, -300, ["alt"]);
  const zoomed = await q(`return { zoom: view.zoom, t: (300) / view.zoom + view.scroll };`);
  check("Alt+wheel zooms in around the pointer", zoomed.zoom > pos.zoom * 1.5 && Math.abs(zoomed.t - pos.t) < 0.01, { before: pos, zoomed });
  await wheel(pos.x, pos.y, 400);
  const panned = await q(`return view.scroll;`);
  check("the wheel pans through time", panned > 0, panned);
  await key("\\");

  // Ripple delete the middle video piece.
  const before = await q(`return S().project.clips.map((c) => [c.start, edit.clipEnd(c)]);`);
  pos = await q(`const c = S().project.clips[1]; return { x: X((c.start + edit.clipEnd(c)) / 2), y: rowY('video') };`);
  await click(pos.x, pos.y);
  await key("Delete", ["shift"]);
  const rippled = await q(`return S().project.clips.map((c) => [c.start, edit.clipEnd(c)]);`);
  check("Shift+Delete ripple-deletes and closes the gap", rippled.length === 2 && Math.abs(rippled[1][0] - rippled[0][1]) < 1e-6, { before, rippled });

  // Undo everything, then redo everything.
  const steps = await q(`return S().past.length;`);
  for (let i = 0; i < steps; i++) await key("z", ["ctrl"]);
  const undone = await q(`return { clips: S().project.clips.length, captions: S().project.captions.length, past: S().past.length };`);
  check("undo walks back to the start", undone.clips === 0 && undone.captions === 0 && undone.past === 0, { steps, undone });
  for (let i = 0; i < steps; i++) await key("z", ["ctrl", "shift"]);
  const redone = await q(`return S().project.clips.map((c) => [c.start, edit.clipEnd(c)]);`);
  check("redo restores every step", JSON.stringify(redone) === JSON.stringify(rippled), redone);

  // Save / reopen round trip.
  const file = join(tmpdir(), `cp-ui-${Date.now()}.captionpro`).replace(/\\/g, "\\\\");
  const roundTrip = await q(`
    const { api } = await import('/src/app/api.ts');
    const { sanitizeProject } = await import('/src/state/sanitize.ts');
    await api.saveProject("${file}", S().project);
    const back = await api.readProject("${file}");
    return JSON.stringify(sanitizeProject(back.project)) === JSON.stringify(sanitizeProject(S().project));`);
  check("save and reopen give the same project", roundTrip, roundTrip);

  // EXPORT=<file.mp4>: the three reference captions plus a long wrapped one, exported for a look.
  if (process.env.EXPORT) {
    const out = process.env.EXPORT.replace(/\\/g, "\\\\");
    const done = await q(`
      const actions = await import('/src/app/actions.ts');
      const { startExport } = await import('/src/export/exporter.ts');
      S().replaceProject({ ...S().project, captions: [] });
      const add = (time, text, end, y = 0.2, track = 0) => { actions.createCaption({ time, text, y, track }); actions.finishEditing(); const id = S().selection[0]; S().update((d) => { const c = d.captions.find((x) => x.id === id); c.end = end; }); };
      add(0, 'The problem 😩', 5.5);
      add(5.5, 'Vs…', 7);
      add(7, 'The solution 😎', 16);
      add(1, 'Long words like Supercalifragilisticexpialidocious wrap, emoji stay with their word 🏊‍♀️ 👩🏽‍💻 🇰🇪', 4, 0.62, 1);
      usePlayback.getState().setTime(2);
      const result = await startExport(S().project, "${out}", 'high', () => {}).done;
      return { phase: result.phase, message: result.message, warnings: result.warnings, mode: result.status?.mode, frames: result.status?.result?.video?.frames };`);
    check("export of the reference captions", done.phase === "done", done);
  }
  check("no page errors", pageErrors.length === 0, pageErrors);
  if (process.env.SHOT) {
    const { writeFileSync } = await import("node:fs");
    await sleep(500);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, "base64"));
  }
} catch (error) {
  check("driver crashed", false, String(error));
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  ${JSON.stringify(r.detail)}`}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
ws.close();
proc.kill();
process.exit(results.every((r) => r.ok) ? 0 : 1);
