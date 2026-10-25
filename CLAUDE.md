# Caption Pro: project guide for Claude sessions

Read README.md for what the app does, how to run it and how export works. This file holds the
decisions, the rules to keep, the gotchas found while building it, and what's still unverified.
Update it when a decision changes.

## Who it's for
Zar (ArcadeWrld) makes 9:16 product videos in Premiere Pro on Windows, which can't render colour
emoji. Caption Pro adds TikTok-style captions with Apple emoji to finished exports. First use:
the kids endoscope ad ("The problem 😩" / "Vs…" / "The solution 😎" in white rounded boxes).
Zar is an experienced web developer, so keep technical notes short.

## Decisions (with reasons)

| Decision | Why |
|---|---|
| Vite + React 19 + zustand + TypeScript, API as Vite middleware (`server/api.ts`) | One process (`npm start`), same stack as DeskCam Studio / DepthCam. |
| **Native ffmpeg** (ffmpeg-static 6.1) on the local server, not ffmpeg.wasm | 5–50× faster, real x264 presets, reads the original in place and writes next to it. |
| Captions rendered by **one canvas renderer** for monitor and export; export = PNG per caption state + ffconcat + one overlay | WYSIWYG, Apple emoji exactly as shown, the video stream untouched apart from the overlay; audio copied. |
| Apple emoji: `emoji-datasource-apple` (map + 64 px offline) + 160 px mirror cached in `data/emoji-160/` | 64 px is soft at caption sizes; the mirror uses the same file names. |
| Emoji detection with `/\p{RGI_Emoji}/v` | Whole ZWJ/skin-tone/flag/keycap sequences, no library. |
| Sizes in "reference px" (on a 1080-wide frame) | A style looks the same at 720p, 1080p and 4K. |
| Caption position = centre of the text block (0..1) | Lines grow evenly when text wraps. |
| TikTok boxes = line bands (fontSize × lineHeight) + padX, padY at group ends, one union outline rounded with `arcTo` per corner | Inner corners get inverted fillets for free; radii capped at half the neighbouring edges. |
| Timeline on two canvases (base + playhead overlay), view in its own store | Playback redraws only the tiny overlay; drawing cost depends on width, not clip length. |
| Waveform: server decodes once (ffmpeg → 8 kHz mono → 100 peaks/s, cached in `data/peaks/`), client max-pyramid | Any zoom reads ~2 values per pixel column. |
| Media read in place by path (Windows dialogs via PowerShell); drag-and-drop copies to `data/uploads/` | Browsers don't expose paths. |
| UI styled only with the style guide tokens (`src/styles/tokens.css` = `Caption Pro style guide/variables.css`), dark theme | Zar's TwoKit export. |
| No timeline ripple-by-default, no audio scrubbing, no video thumbnails | Scope: a caption tool, not a full NLE. |

## Rules to keep
1. Never `setState` per frame: the playhead lives in `usePlayback`; canvases subscribe outside React.
2. Every gesture is one undo step: `update(recipe, "g:<gesture-id>")` (keys starting `g:` always coalesce).
3. Anything that changes caption looks must go through `layoutCaption` + `drawLayout` (export uses the same).
4. Selectors must return stable values (no `new Set()` inside a zustand selector: React loops).
5. Edits snap to the sequence frame grid (`snapToFrame`); items are at least one frame long.
6. Keep `npm test`, `npm run test:export` and `tools/ui-check.mjs` green; run the UI check against a
   **separate copy and port** (it autosaves).

## Gotchas found (don't rediscover)
- **ffconcat + PNG**: each image is opened by image2 at its default 25 fps time base, so caption
  times round to 1/25 s (a caption started a frame early at 60 fps). Fixed with
  `option framerate 1000000` per entry.
- **overlay keeps going after the main video ends** while the second input has frames (it repeated
  the last frame for 1 s). Fixed: `shortest=1` + a 3600 s blank tail on the caption track.
- **Hot reload re-ran the autosave restore** (App's effects re-run) and could roll back the
  newest edits; `hydrate()` now runs once per page (`hydrated` lives in the store).
- **Two tabs share one autosave** and overwrite each other: `app/tabs.ts` warns via BroadcastChannel.
- **Dragging a caption onto the empty top track** added a row, which shifted all rows under the
  pointer (the caption kept climbing). Rows are frozen during a move gesture.
- ffmpeg's `drawbox` doesn't write alpha (test fixtures use `geq` for opaque boxes).
- `-display_rotation 90` is counter-clockwise: ffprobe reports 270° clockwise.
- Old ffprobe (4.0 from ffprobe-static) gives rotation as a `rotate` tag *or* display-matrix side
  data; both are read.
- Chrome plays H.264 `.mov` only when served as `video/mp4`.
- Editing `server/*.ts` restarts Vite and **reloads every open page** (undo history is lost). Avoid
  it while Zar is working in the app.

## Not verified yet (be honest about these)
- The Windows file dialogs (Import, Save, Open, Export › Browse) were not clicked through by
  Claude: they need a person at the desktop. Paths typed or pasted were tested.
- Real-time playback smoothness on Zar's machine (the browser pane throttles when hidden).
- HDR (PQ/HLG) sources: captions are converted with the BT.2020 matrix but not tone-mapped.
- Multiple different source videos on one timeline: export scales/pads them (planned and
  unit-tested, not exported end to end).
- 160 px emoji mirror availability long term (falls back to 64 px offline).

## Ideas / next
- Word-by-word "karaoke" captions from a transcript (Whisper), caption animations (pop-in).
- Thumbnails on the video clip, audio scrubbing.
- Stream-copy the untouched GOPs outside caption spans (smart render) for faster exports.
