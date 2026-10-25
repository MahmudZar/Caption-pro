/** Quick emoji row with Apple images (Windows' own picker shows Segoe ones; the caption won't). */
import * as React from "react";

import { emojiMapReady, imageKeyFor, loadEmojiMap, onEmojiChange } from "../caption/emoji";

const QUICK = ["😩", "😎", "🤯", "😍", "😂", "🥹", "😭", "🔥", "✨", "👀", "👇", "👉", "✅", "❌", "💯", "⚡", "🎁", "🛒", "📦", "❤️"];

export function EmojiBar({ onPick }: { onPick: (emoji: string) => void }) {
  const [ready, setReady] = React.useState(emojiMapReady());
  React.useEffect(() => {
    void loadEmojiMap();
    return onEmojiChange(() => setReady(emojiMapReady()));
  }, []);
  return (
    <div className="emoji-bar" role="toolbar" aria-label="Insert emoji">
      {QUICK.map((emoji) => {
        const key = ready ? imageKeyFor(emoji) : null;
        return (
          <button key={emoji} type="button" className="emoji-bar__item" title={`Insert ${emoji}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(emoji)}>
            {key ? <img src={`/api/emoji/${key}.png`} alt={emoji} draggable={false} /> : emoji}
          </button>
        );
      })}
    </div>
  );
}
