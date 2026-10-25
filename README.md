# Caption Pro

A local caption editor for short vertical videos (TikTok, Reels, Facebook). Import a finished
export, add TikTok-style captions with **Apple (iOS) emoji**, and export an MP4 at the source's
resolution, frame rate and audio with the captions burned in. Premiere Pro on Windows can't
render colour emoji, so this fills that gap.

```bash
npm install        # once (Node 22+; downloads a bundled ffmpeg + ffprobe)
npm start          # http://localhost:5190, opens the browser
```

Use Chrome or Edge. Everything runs on this machine. The only network use is downloading Apple
emoji images once (cached in `data/emoji-160/`).

## Workflow

1. **Import**: *Import video…* opens a Windows file dialog, and the file is read in place
   (no copy). You can also paste a path (Explorer: Shift+right-click › *Copy as path*) or drop a
   file on the window (a dropped file is copied to `data/uploads/`, because browsers don't
   expose file paths). The first video sets the sequence size and frame rate, and lands on the
   timeline.
2. **Add captions**: press **T** and click the monitor where the caption goes, then type. The
   Apple emoji row (or Win + .) adds emoji. **Esc** or **Ctrl+Enter** finishes. **N** adds a
   caption at the playhead. A new caption takes the style of the last one you edited.
3. **Style** the selected caption(s) in Properties: presets (White box = TikTok classic), font,
   weight, size, line height, letter spacing, alignment, italic, all caps, colour + opacity,
   background (per line like TikTok, or one block; colour, opacity, padding X/Y, radius),
   stroke, shadow (colour, opacity, blur, offset), position and wrap width, in/out times. On the
   monitor, drag a caption to move it (it snaps to the centre lines; Alt turns snapping off,
   Shift locks the axis). Drag the side handles to change the wrap width, the corners to scale.
4. **Edit the timing** on the timeline: drag captions or clips to move them (between tracks
   too), drag edges to trim, **C** razor to cut, **Delete** removes, **Shift+Delete** removes
   and closes the gap. **Alt+drag** duplicates.
5. **Export** (**Ctrl+M**): pick the file and quality. The default is
   `<source name> captions.mp4` next to the source, never overwriting it.

Projects autosave (`data/projects/autosave.json`) and reopen where you left off. **Ctrl+S**
saves a `.captionpro` file anywhere. It's JSON that points at the video by path. If the video
moved, the Project panel shows it as *Offline* with a *Relink* button.

## Shortcuts (Premiere style)

| Keys | Action |
|---|---|
| V / C / T | Select · Razor · Type tool |
| Space | Play / pause |
| J / K / L | Shuttle back / stop / forward (press again: 2×, 4×, 8×) |
| ← / → (Shift) | One frame (five frames) |
| ↑ / ↓ | Previous / next edit point |
| Home / End | Start / end |
| Ctrl+K | Cut every track at the playhead |
| Delete · Shift+Delete | Delete · ripple delete |
| Ctrl+C / X / V / D | Copy, cut, paste at the playhead, duplicate captions |
| Ctrl+A | Select all |
| Enter | Edit the selected caption's text |
| Ctrl+Z · Ctrl+Shift+Z / Ctrl+Y | Undo · redo (every edit and every drag is one step) |
| S | Snapping on/off |
| Alt + wheel · wheel · Shift + wheel | Zoom the timeline at the pointer · pan through time · scroll tracks |
| = / - / \ | Zoom in / out / fit |
| Ctrl+I · Ctrl+O · Ctrl+S (Shift: save as) · Ctrl+Alt+N | Import · open · save · new project |
| Ctrl+M | Export |

## How export works

```
browser: same caption renderer as the monitor ──► one transparent PNG per distinct caption state
server:  ffconcat list (PNG + duration per span) ──► one caption video stream ──► ffmpeg overlay
```

1. The timeline is cut into spans wherever the set of visible captions changes. Each distinct
   span is drawn once, full frame at the source size, by the **same canvas code the monitor
   uses**, after every font and Apple emoji image has loaded. What you see is what you export.
2. The server writes an `ffconcat` list (each PNG with its duration, microsecond timestamps,
   boundaries moved half a frame early so rounding can never make a caption start a frame late)
   and runs a native ffmpeg:
   - **Overlay mode** (one untouched clip): captions are laid over the original video stream,
     `-fps_mode passthrough` keeps every frame's original timestamp (so VFR stays VFR), and the
     **audio is copied bit for bit** (AAC/MP3/AC-3/ALAC; anything else becomes AAC 320 kb/s).
   - **Edit mode** (cuts, gaps, moved clips): trim + concat filter graph, black frames for gaps,
     audio re-encoded to AAC 320 kb/s / 48 kHz (needed after cuts).
   - **Copy mode** (no captions, nothing changed): pure remux, video bit-identical.
3. Video is H.264 High, yuv420p (what TikTok/Reels expect): *Visually lossless* = x264 CRF 14
   slow (default), *High* = CRF 17, *Smaller* = CRF 21. Colour tags are kept, and the PNGs are
   converted with the video's own matrix (BT.709 for untagged HD), so a white box stays exactly
   white and colours keep their hue. Phone rotation is applied, and non-square pixels are
   squared.
4. The output is written to a hidden temp file, renamed when finished, then probed. The dialog
   shows the real resolution, frame rate, length and audio of the result.

**Why native ffmpeg and not ffmpeg.wasm:** wasm builds run roughly 5–50× slower than native
(single-threaded unless the page is cross-origin isolated) and have no fast x264 presets, and a
16 s 1080×1920 clip at CRF 14 already takes ~40 s natively on this laptop. A local Node server
is also needed anyway to read the original file in place and write next to it. The bundled
binaries are `ffmpeg-static` (ffmpeg 6.1) and `ffprobe-static`. Set `FFMPEG_PATH` /
`FFPROBE_PATH` to use your own builds.

## Apple emoji

Text is split into runs with the Unicode `RGI_Emoji` property (regex `v` flag), so ZWJ
sequences (👩🏽‍💻, 👨‍👩‍👧), skin tones, flags (🇰🇪), keycaps and tag flags stay whole. Each emoji
maps to an Apple image through `emoji-datasource-apple` (iamcal/emoji-data, Emoji 16, 64 px
images bundled for offline use). Since 64 px is soft at caption sizes, the server first fetches
a **160 px** Apple image from a public mirror (the one behind the `emoji-store` package) and
caches it in `data/emoji-160/`. The same images draw the monitor, the timeline labels, the emoji
picker and the export. Characters typed as text (© without the emoji selector) stay text. An
emoji Apple has no image for is reported in the export dialog.

Apple's emoji artwork is © Apple and not licensed for commercial use (the emoji-data README says
so). Many accounts post iOS-emoji captions anyway. Decide for your ads with that in mind.

## Edge cases covered

- **Text:** very long words break between letters (never inside an emoji). An emoji-only word
  stays with the word before it, so 😩 never sits alone at the start of a line. Explicit line
  breaks and blank lines split the box into separate groups. Whitespace-only captions export
  nothing. Captions on the same track can't overlap, and new or pasted captions find a free
  track.
- **Editing:** trims stop at one frame (no zero-length items). Cuts at a clip edge do nothing
  and leave no empty undo step. Video trims stop at the source's ends. Ripple delete shortens
  captions that ran across the removed part and drops those entirely inside it (with a notice).
  A new caption left empty disappears without an undo step. Undo/redo covers every edit, and a
  whole drag or slider scrub is one step.
- **Video:** 24, 25, 29.97 (30000/1001), 30, 50, 59.94, 60 fps and odd rates. Variable frame
  rate keeps every original timestamp. Any aspect ratio, rotated phone videos (exported
  upright), and non-square pixels. No audio: no waveform, no audio track. Videos Chrome can't
  play (HEVC, ProRes, 10-bit, MKV/AVI/TS) get an H.264 preview proxy, while export still reads
  the original. Media starting after 0 s and audio offset against video are handled.
- **Projects:** autosave and restore, `.captionpro` save/open, a sanitiser for every loaded file,
  relink for moved media, a warning when the app is open in two tabs (they'd share one
  autosave), and a guard while exporting.

## Tests

```bash
npm test             # unit: layout/wrapping, emoji runs, TikTok outline, edits, ffmpeg plans
npm run test:export  # real ffmpeg: 24 / 29.97 / 60 fps, VFR, 16:9, rotated, edited, copy
node --experimental-websocket tools/ui-check.mjs http://localhost:<port> "<video path>"
                     # real mouse/keyboard in headless Chrome: run against a separate copy,
                     # it edits and autosaves like a user
```

`test:export` checks frame counts, every frame timestamp against the source, audio presence
and that the caption appears on exactly the first and last intended frames.

## Layout of the code

```
server/   api.ts (routes, media registry, export jobs), ffmpeg.ts (probe, peaks, proxies),
          plan.ts (ffmpeg arguments, pure + tested), emoji.ts (map + 160/64 px images),
          dialogs.ts (Windows file dialogs via PowerShell), paths.ts
shared/   types.ts (MediaInfo, ExportPlan…)
src/
  caption/   emoji.ts (runs, image cache), layout.ts (wrap + place), outline.ts (TikTok boxes),
             render.ts (canvas drawing), fonts.ts (bundled fonts, load tracking)
  model/     edit.ts (split, delete/ripple, tracks…), time.ts (frame grid, timecode)
  state/     store.ts (zustand + undo; playhead, view and toasts in their own stores),
             types.ts, defaults.ts (presets, fonts), sanitize.ts
  playback/  engine.ts (video elements ↔ timeline time, seamless cuts, J/K/L)
  monitor/   Monitor.tsx (video, caption canvas, selection/handles, in-place text editor)
  timeline/  Timeline.tsx (gestures), draw.ts (two canvas layers), geometry.ts, waveform.ts
  panels/    Properties.tsx, ProjectPanel.tsx
  export/    exporter.ts (spans → PNGs → job), ExportDialog.tsx
  app/       App.tsx (layout, splitters), actions.ts, shortcuts.ts, media.ts, project.ts, api.ts
tools/    export.e2e.test.ts, ui-check.mjs
data/     created at runtime (media registry, peaks, proxies, emoji cache, autosave, jobs)
```
