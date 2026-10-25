/**
 * Properties of the selected caption(s), Figma style. With several captions selected, the
 * fields show the first one and every change applies to all of them. The edited style also
 * becomes the style of the next new caption.
 */
import { RiAlignCenter, RiAlignLeft, RiAlignRight, RiItalic, RiDeleteBinLine } from "@remixicon/react";
import * as React from "react";

import { deleteSelection } from "../app/actions";
import { STYLE_PRESETS, FONT_CHOICES } from "../state/defaults";
import { useEditor } from "../state/store";
import type { Caption, CaptionStyle, VideoClip } from "../state/types";
import { EmojiBar } from "../monitor/EmojiBar";
import { formatTimecode, frameDuration, snapToFrame } from "../model/time";
import { clipEnd, nextCaptionStart, previousCaptionEnd } from "../model/edit";
import { ColorField, IconButton, NumberField, Segmented, SelectField, Switch, TimeField, Kbd, cx, stopKeys } from "../ui/controls";
import { rgba } from "../caption/render";

type StyleRecipe = (style: CaptionStyle) => void;

function useCaptionEditor() {
  const selection = useEditor((s) => s.selection);
  const captions = useEditor((s) => s.project.captions);
  const selected = React.useMemo(() => captions.filter((c) => selection.includes(c.id)), [captions, selection]);
  const ids = React.useMemo(() => new Set(selected.map((c) => c.id)), [selected]);
  const updateStyle = (recipe: StyleRecipe, key: string) => {
    let last: CaptionStyle | null = null;
    useEditor.getState().update((draft) => {
      for (const caption of draft.captions) {
        if (!ids.has(caption.id)) continue;
        recipe(caption.style);
        last = caption.style;
      }
    }, key);
    if (last) useEditor.getState().set({ lastStyle: structuredClone(last) });
  };
  const updateCaption = (recipe: (caption: Caption) => void, key?: string) => {
    useEditor.getState().update((draft) => {
      for (const caption of draft.captions) if (ids.has(caption.id)) recipe(caption);
    }, key);
  };
  return { selected, updateStyle, updateCaption };
}

function Section({ title, enabled, onToggle, hint, children }: { title: string; enabled?: boolean; onToggle?: (on: boolean) => void; hint?: React.ReactNode; children: React.ReactNode }) {
  const off = enabled === false;
  return (
    <section className={cx("section", off && "section--off")}>
      <div className="section__head">
        <span className="section__title">{title}</span>
        {hint ? <span className="section__hint">{hint}</span> : null}
        {onToggle ? <Switch on={!off} onChange={onToggle} label={`${title} on/off`} /> : null}
      </div>
      <div className="section__body">{children}</div>
    </section>
  );
}

function Presets({ apply }: { apply: (style: CaptionStyle) => void }) {
  return (
    <div className="presets">
      {STYLE_PRESETS.map((preset) => {
        const s = preset.style;
        return (
          <button key={preset.id} type="button" className="preset" title={`Apply "${preset.name}"`} onClick={() => apply(s)}>
            <span
              className="preset__sample"
              style={{
                fontFamily: `"${s.fontFamily}", sans-serif`,
                fontWeight: s.fontWeight,
                color: s.color,
                background: s.box.enabled ? rgba(s.box.color, s.box.opacity) : "transparent",
                WebkitTextStroke: s.stroke.enabled ? `1px ${s.stroke.color}` : undefined,
                textShadow: s.shadow.enabled ? `0 1px 3px ${rgba(s.shadow.color, s.shadow.opacity)}` : undefined,
                textTransform: s.uppercase ? "uppercase" : undefined,
              }}
            >
              {preset.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CaptionProperties() {
  const { selected, updateStyle, updateCaption } = useCaptionEditor();
  const rate = useEditor((s) => s.project.sequence);
  const project = useEditor((s) => s.project);
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const caption = selected[0];
  const style = caption.style;
  const multi = selected.length > 1;
  const session = React.useRef(0);
  const font = FONT_CHOICES.find((f) => f.family === style.fontFamily);
  const weights = font?.weights ?? [100, 200, 300, 400, 500, 600, 700, 800, 900];
  const frameW = rate?.width ?? 1080;
  const frameH = rate?.height ?? 1920;
  const frame = frameDuration(rate);

  const setText = (text: string) => updateCaption((c) => void (c.text = text), `g:props-text:${caption.id}:${session.current}`);
  const insertEmoji = (emoji: string) => {
    const element = textRef.current;
    const start = element?.selectionStart ?? caption.text.length;
    const end = element?.selectionEnd ?? caption.text.length;
    setText(caption.text.slice(0, start) + emoji + caption.text.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  return (
    <div className="props">
      <Section title={multi ? `${selected.length} captions` : "Text"} hint={multi ? "Changes apply to all" : undefined}>
        {multi ? null : (
          <>
            <textarea
              ref={textRef}
              className="text-input"
              value={caption.text}
              placeholder="Caption text"
              onFocus={() => (session.current += 1)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={stopKeys}
            />
            <EmojiBar onPick={insertEmoji} />
          </>
        )}
      </Section>

      <Section title="Style presets">
        <Presets apply={(preset) => updateStyle((s) => Object.assign(s, structuredClone(preset)), "preset")} />
      </Section>

      <Section title="Typography">
        <SelectField
          label="Font"
          value={style.fontFamily}
          options={[...FONT_CHOICES.map((f) => ({ value: f.family, label: f.label })), ...(font ? [] : [{ value: style.fontFamily, label: style.fontFamily }])]}
          onChange={(family) =>
            updateStyle((s) => {
              s.fontFamily = family;
              const available = FONT_CHOICES.find((f) => f.family === family)?.weights;
              if (available && !available.includes(s.fontWeight)) s.fontWeight = available.reduce((best, w) => (Math.abs(w - s.fontWeight) < Math.abs(best - s.fontWeight) ? w : best), available[0]);
            }, "font")
          }
        />
        <div className="row">
          <SelectField label="Weight" value={style.fontWeight} options={weights.map((w) => ({ value: w, label: WEIGHT_NAMES[w] ?? String(w) }))} onChange={(w) => updateStyle((s) => void (s.fontWeight = w), "weight")} />
          <NumberField label="Size" value={style.fontSize} min={4} max={600} onChange={(v, key) => updateStyle((s) => void (s.fontSize = v), key)} title="Font size (px on a 1080-wide frame)" />
        </div>
        <div className="row">
          <NumberField label="Line" value={style.lineHeight} min={0.6} max={4} step={0.01} decimals={2} onChange={(v, key) => updateStyle((s) => void (s.lineHeight = v), key)} title="Line height (× font size)" />
          <NumberField label="Letter" value={style.letterSpacing} min={-50} max={200} step={0.5} decimals={1} onChange={(v, key) => updateStyle((s) => void (s.letterSpacing = v), key)} title="Letter spacing (px)" />
        </div>
        <div className="row">
          <Segmented
            label="Alignment"
            value={style.align}
            onChange={(align) => updateStyle((s) => void (s.align = align), "align")}
            options={[
              { value: "left", label: <RiAlignLeft size={15} />, title: "Align left" },
              { value: "center", label: <RiAlignCenter size={15} />, title: "Align centre" },
              { value: "right", label: <RiAlignRight size={15} />, title: "Align right" },
            ]}
          />
          <div className="segmented">
            <button type="button" className={cx("segmented__item", style.italic && "segmented__item--on")} title="Italic" onClick={() => updateStyle((s) => void (s.italic = !s.italic), "italic")}>
              <RiItalic size={15} />
            </button>
            <button type="button" className={cx("segmented__item", style.uppercase && "segmented__item--on")} title="All caps" onClick={() => updateStyle((s) => void (s.uppercase = !s.uppercase), "caps")}>
              AA
            </button>
          </div>
        </div>
        <div className="row row--color">
          <ColorField label="Text colour" value={style.color} onChange={(v, key) => updateStyle((s) => void (s.color = v), key)} />
          <NumberField label="%" value={Math.round(style.opacity * 100)} min={0} max={100} onChange={(v, key) => updateStyle((s) => void (s.opacity = v / 100), key)} title="Text opacity" />
        </div>
      </Section>

      <Section title="Background" enabled={style.box.enabled} onToggle={(on) => updateStyle((s) => void (s.box.enabled = on), "box-on")}>
        <Segmented
          label="Box shape"
          value={style.box.mode}
          onChange={(mode) => updateStyle((s) => void (s.box.mode = mode), "box-mode")}
          options={[
            { value: "line", label: "Per line (TikTok)", title: "One box per line, joined" },
            { value: "block", label: "One block", title: "One box around all lines" },
          ]}
        />
        <div className="row row--color">
          <ColorField label="Box colour" value={style.box.color} onChange={(v, key) => updateStyle((s) => void (s.box.color = v), key)} />
          <NumberField label="%" value={Math.round(style.box.opacity * 100)} min={0} max={100} onChange={(v, key) => updateStyle((s) => void (s.box.opacity = v / 100), key)} title="Box opacity" />
        </div>
        <div className="row row--3">
          <NumberField label="X" value={style.box.padX} min={0} max={400} onChange={(v, key) => updateStyle((s) => void (s.box.padX = v), key)} title="Horizontal padding" />
          <NumberField label="Y" value={style.box.padY} min={0} max={400} onChange={(v, key) => updateStyle((s) => void (s.box.padY = v), key)} title="Vertical padding (top and bottom of the box)" />
          <NumberField label="R" value={style.box.radius} min={0} max={400} onChange={(v, key) => updateStyle((s) => void (s.box.radius = v), key)} title="Corner radius" />
        </div>
      </Section>

      <Section title="Stroke" enabled={style.stroke.enabled} onToggle={(on) => updateStyle((s) => void (s.stroke.enabled = on), "stroke-on")}>
        <div className="row row--color">
          <ColorField label="Stroke colour" value={style.stroke.color} onChange={(v, key) => updateStyle((s) => void (s.stroke.color = v), key)} />
          <NumberField label="W" value={style.stroke.width} min={0} max={100} step={0.5} decimals={1} onChange={(v, key) => updateStyle((s) => void (s.stroke.width = v), key)} title="Stroke width (outside the letters)" />
        </div>
      </Section>

      <Section title="Shadow" enabled={style.shadow.enabled} onToggle={(on) => updateStyle((s) => void (s.shadow.enabled = on), "shadow-on")}>
        <div className="row row--color">
          <ColorField label="Shadow colour" value={style.shadow.color} onChange={(v, key) => updateStyle((s) => void (s.shadow.color = v), key)} />
          <NumberField label="%" value={Math.round(style.shadow.opacity * 100)} min={0} max={100} onChange={(v, key) => updateStyle((s) => void (s.shadow.opacity = v / 100), key)} title="Shadow opacity" />
        </div>
        <div className="row row--3">
          <NumberField label="B" value={style.shadow.blur} min={0} max={400} onChange={(v, key) => updateStyle((s) => void (s.shadow.blur = v), key)} title="Blur" />
          <NumberField label="X" value={style.shadow.x} min={-400} max={400} onChange={(v, key) => updateStyle((s) => void (s.shadow.x = v), key)} title="Offset X" />
          <NumberField label="Y" value={style.shadow.y} min={-400} max={400} onChange={(v, key) => updateStyle((s) => void (s.shadow.y = v), key)} title="Offset Y" />
        </div>
      </Section>

      <Section title="Position" hint={`${frameW}×${frameH}`}>
        <div className="row">
          <NumberField label="X" value={Math.round(caption.x * frameW)} onChange={(v, key) => updateCaption((c) => void (c.x = v / frameW), key)} title="Centre X (px)" mixed={multi} />
          <NumberField label="Y" value={Math.round(caption.y * frameH)} onChange={(v, key) => updateCaption((c) => void (c.y = v / frameH), key)} title="Centre Y (px)" mixed={multi} />
        </div>
        <div className="row">
          <NumberField label="Wrap" value={Math.round(style.maxWidth * 100)} min={5} max={100} suffix="%" onChange={(v, key) => updateStyle((s) => void (s.maxWidth = v / 100), key)} title="Wrap width (% of the frame width)" />
          <div className="segmented">
            <button type="button" className="segmented__item" title="Centre horizontally" onClick={() => updateCaption((c) => void (c.x = 0.5), "centre-x")}>
              ↔
            </button>
            <button type="button" className="segmented__item" title="Centre vertically" onClick={() => updateCaption((c) => void (c.y = 0.5), "centre-y")}>
              ↕
            </button>
            <button type="button" className="segmented__item" title="Top third (like the reference)" onClick={() => updateCaption((c) => void (c.y = 0.2), "top")}>
              ⤒
            </button>
          </div>
        </div>
      </Section>

      <Section title="Timing" hint={multi ? undefined : formatTimecode(caption.end - caption.start, rate)}>
        {multi ? (
          <span className="section__hint">Select one caption to edit its times.</span>
        ) : (
          <div className="row">
            <TimeField
              label="In"
              value={caption.start}
              rate={rate}
              onChange={(t) => {
                const value = Math.min(caption.end - frame, Math.max(previousCaptionEnd(project, caption.track, caption.start, caption.id), snapToFrame(t, rate)));
                updateCaption((c) => void (c.start = value));
              }}
            />
            <TimeField
              label="Out"
              value={caption.end}
              rate={rate}
              onChange={(t) => {
                const value = Math.max(caption.start + frame, Math.min(nextCaptionStart(project, caption.track, caption.end - 1e-6, caption.id), snapToFrame(t, rate)));
                updateCaption((c) => void (c.end = value));
              }}
            />
          </div>
        )}
      </Section>
      <div className="section">
        <button type="button" className="btn btn--ghost btn--danger btn--block" onClick={() => deleteSelection(false)}>
          <RiDeleteBinLine size={15} /> Delete {multi ? `${selected.length} captions` : "caption"}
        </button>
      </div>
    </div>
  );
}

const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" };

function ClipProperties({ clip }: { clip: VideoClip }) {
  const rate = useEditor((s) => s.project.sequence);
  const media = useEditor((s) => s.project.media.find((m) => m.id === clip.mediaId));
  return (
    <div className="props">
      <Section title="Video clip" hint={media?.name}>
        <dl className="dialog__facts">
          <dt>Timeline</dt>
          <dd>
            {formatTimecode(clip.start, rate)} → {formatTimecode(clipEnd(clip), rate)}
          </dd>
          <dt>Source in</dt>
          <dd>{formatTimecode(clip.srcIn, rate)}</dd>
          <dt>Source out</dt>
          <dd>{formatTimecode(clip.srcOut, rate)}</dd>
          <dt>Duration</dt>
          <dd>{(clip.srcOut - clip.srcIn).toFixed(3)} s</dd>
        </dl>
      </Section>
      <Section title="Edit">
        <span className="section__hint">
          Drag the edges to trim, <Kbd>C</Kbd> razor to cut, <Kbd>Del</Kbd> leaves a gap, <Kbd>Shift</Kbd>+<Kbd>Del</Kbd> closes it (ripple delete; captions follow).
        </span>
        <IconButton label="Delete clip" onClick={() => deleteSelection(false)}>
          <RiDeleteBinLine size={16} />
        </IconButton>
      </Section>
    </div>
  );
}

function EmptyProperties() {
  const hasSequence = useEditor((s) => !!s.project.sequence);
  return (
    <div className="props__empty">
      <h3>{hasSequence ? "Nothing selected" : "Start with a video"}</h3>
      <p>{hasSequence ? "Select a caption to style it, or press T and click the monitor to add one." : "Import a 9:16 video (any size works). Captions are drawn on top and burned in on export."}</p>
      <div className="props__keys">
        <Kbd>V</Kbd> <span>Select / move / trim</span>
        <Kbd>T</Kbd> <span>Text: click the monitor to add a caption</span>
        <Kbd>C</Kbd> <span>Razor: cut clips and captions</span>
        <Kbd>Space</Kbd> <span>Play / pause (J K L shuttle)</span>
        <Kbd>← →</Kbd> <span>One frame (Shift: 5)</span>
        <Kbd>↑ ↓</Kbd> <span>Previous / next edit</span>
        <Kbd>Ctrl K</Kbd> <span>Cut everything at the playhead</span>
        <Kbd>Alt</Kbd> <span>+ scroll: zoom the timeline</span>
        <Kbd>Ctrl Z</Kbd> <span>Undo (Ctrl+Shift+Z redo)</span>
        <Kbd>Ctrl M</Kbd> <span>Export</span>
      </div>
    </div>
  );
}

export function Properties() {
  const selection = useEditor((s) => s.selection);
  const hasCaption = useEditor((s) => s.project.captions.some((c) => s.selection.includes(c.id)));
  const clip = useEditor((s) => (s.selection.length === 1 ? s.project.clips.find((c) => c.id === s.selection[0]) : undefined));
  return (
    <div className="panel panel--properties">
      <div className="panel__tabs">
        <span className="panel__tab panel__tab--active">Properties</span>
      </div>
      <div className="panel__body">{hasCaption ? <CaptionProperties key={selection.join(",")} /> : clip ? <ClipProperties clip={clip} /> : <EmptyProperties />}</div>
    </div>
  );
}
