/**
 * Small Figma-style inputs. Number fields commit on Enter/blur, step with ↑/↓ (Shift ×10), and
 * scrub when you drag their label. Every field passes a coalesce key so a scrub or a run of
 * arrow presses is one undo step. Key presses in inputs never reach the editor shortcuts.
 */
import * as React from "react";

import { formatTimecode, parseTimecode, type Rate } from "../model/time";

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/** Keeps typing in fields away from the global shortcuts (Space, V, Delete...). */
export function stopKeys(event: React.KeyboardEvent): void {
  if (event.key !== "Escape") event.stopPropagation();
}

export function IconButton({ label, shortcut, on, small, disabled, onClick, children }: { label: string; shortcut?: string; on?: boolean; small?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={cx("icon-btn", on && "icon-btn--on", small && "icon-btn--small")} title={shortcut ? `${label} (${shortcut})` : label} aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

function format(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return "";
  return String(Number(value.toFixed(decimals)));
}

export function NumberField({
  label,
  value,
  onChange,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  decimals = 0,
  suffix,
  title,
  mixed,
}: {
  label: React.ReactNode;
  value: number;
  /** `key` groups a gesture into one undo step. */
  onChange: (value: number, key: string) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  suffix?: string;
  title?: string;
  mixed?: boolean;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const gesture = React.useRef(0);
  const clamp = (v: number) => Math.min(max, Math.max(min, Number(v.toFixed(decimals + 2))));
  const commit = (text: string) => {
    setDraft(null);
    // Small maths in fields: "54*1.5", "20+4".
    const cleaned = text.replace(/[^0-9+\-*/.() ]/g, "");
    let next = Number.NaN;
    try {
      if (/^[0-9+\-*/.() ]+$/.test(cleaned)) next = Number(Function(`"use strict";return (${cleaned})`)());
    } catch {
      next = Number.NaN;
    }
    if (Number.isFinite(next)) onChange(clamp(next), `field:${String(label)}:${++gesture.current}`);
  };
  const startScrub = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startValue = value;
    const key = `g:scrub:${String(label)}:${++gesture.current}`;
    const move = (e: PointerEvent) => {
      const factor = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      onChange(clamp(startValue + Math.round((e.clientX - startX) / 2) * step * factor), key);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  return (
    <label className="field" title={title}>
      <span className="field__label field__label--scrub" onPointerDown={startScrub}>
        {label}
      </span>
      <input
        className="field__input"
        inputMode="decimal"
        value={draft ?? (mixed ? "" : format(value, decimals))}
        placeholder={mixed ? "Mixed" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          stopKeys(e);
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            setDraft(null);
            onChange(clamp(value + delta), `field:${String(label)}:arrows`);
          }
        }}
      />
      {suffix ? <span className="field__suffix">{suffix}</span> : null}
    </label>
  );
}

export function ColorField({ value, onChange, label }: { value: string; onChange: (value: string, key: string) => void; label: string }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const gesture = React.useRef(0);
  const commit = (text: string) => {
    setDraft(null);
    let hex = text.trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split("").map((c) => c + c).join("");
    if (/^[0-9a-f]{6}$/i.test(hex)) onChange(`#${hex.toLowerCase()}`, `color:${label}:${++gesture.current}`);
  };
  return (
    <label className="field field--color" title={label}>
      <span className="field__swatch" style={{ background: value }}>
        <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value, `g:picker:${label}`)} onClick={() => gesture.current++} />
      </span>
      <input
        className="field__input"
        value={draft ?? value.replace(/^#/, "").toUpperCase()}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          stopKeys(e);
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function SelectField<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <label className="field field--select" title={label}>
      <select
        aria-label={label}
        value={String(value)}
        onKeyDown={stopKeys}
        onChange={(e) => {
          const found = options.find((o) => String(o.value) === e.target.value);
          if (found) onChange(found.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: React.ReactNode; title: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title} className={cx("segmented__item", value === o.value && "segmented__item--on")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} className={cx("switch", on && "switch--on")} onClick={() => onChange(!on)} />;
}

/** Timecode input: accepts 00:00:01:15, 1.5, 45f. */
export function TimeField({ label, value, rate, onChange, min = 0 }: { label: string; value: number; rate: Rate | null; onChange: (value: number) => void; min?: number }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = (text: string) => {
    setDraft(null);
    const parsed = parseTimecode(text, rate);
    if (parsed !== null) onChange(Math.max(min, parsed));
  };
  return (
    <label className="field" title={`${label} (timecode, seconds or frames like 12f)`}>
      <span className="field__label">{label}</span>
      <input
        className="field__input"
        value={draft ?? formatTimecode(value, rate)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          stopKeys(e);
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

export function MagnetIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 3v8a6 6 0 0 0 12 0V3" />
      <path d="M6 7h3M15 7h3" />
      <path d="M9 3v8a3 3 0 0 0 6 0V3" />
    </svg>
  );
}
