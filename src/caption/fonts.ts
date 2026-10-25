/**
 * Caption fonts are bundled (fontsource) so a caption looks the same on any machine. Canvas
 * text doesn't trigger web font loading by itself, so fonts are loaded explicitly and every
 * finished load bumps an epoch that invalidates cached layouts and redraws.
 */
import "@fontsource-variable/tiktok-sans/wght.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/montserrat/wght.css";
import "@fontsource-variable/montserrat/wght-italic.css";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "@fontsource/poppins/900.css";
import "@fontsource/bebas-neue/400.css";

import type { CaptionStyle } from "../state/types";

import { emojiVersion, onEmojiChange } from "./emoji";
import { clearMeasureCache, fontString } from "./layout";

let fontVersion = 0;
const listeners = new Set<() => void>();

function bump(): void {
  fontVersion += 1;
  clearMeasureCache();
  for (const listener of listeners) listener();
}

if (typeof document !== "undefined") document.fonts.addEventListener("loadingdone", bump);

/** Changes whenever a font or emoji asset finishes loading. */
export function renderEpoch(): number {
  return fontVersion * 100_000 + emojiVersion();
}

export function onRenderAssetsChange(listener: () => void): () => void {
  listeners.add(listener);
  const off = onEmojiChange(listener);
  return () => {
    listeners.delete(listener);
    off();
  };
}

const requested = new Set<string>();

/** Starts loading the fonts a style needs (no-op when already loaded). */
export function requestFont(style: Pick<CaptionStyle, "fontFamily" | "fontWeight" | "italic">, text = "Ag"): void {
  const font = fontString({ ...(style as CaptionStyle) }, 40);
  const key = `${font}|${text.length > 0 ? "t" : ""}`;
  if (requested.has(key) && document.fonts.check(font, text)) return;
  requested.add(key);
  document.fonts.load(font, text).then(
    (faces) => {
      if (faces.length) bump();
    },
    () => undefined,
  );
}

/** Resolves when every font the captions use is ready (before export). */
export async function ensureFonts(styles: Array<{ style: CaptionStyle; text: string }>): Promise<void> {
  await Promise.all(styles.map(({ style, text }) => document.fonts.load(fontString(style, 40), text || "Ag").catch(() => [])));
  await document.fonts.ready;
  bump();
}
