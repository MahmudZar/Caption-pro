/**
 * Every tab on this server autosaves to the same file, so two open tabs would keep overwriting
 * each other's work. Tabs announce themselves on a BroadcastChannel and warn when they meet.
 */
import { toast } from "../state/store";

const id = Math.random().toString(36).slice(2);
let warned = false;

export function watchOtherTabs(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel("caption-pro");
  const warn = () => {
    if (warned) return;
    warned = true;
    toast.error("Caption Pro is open in another tab or window too. Both autosave to the same place: keep only one open, or edits will overwrite each other.");
  };
  channel.onmessage = (event: MessageEvent<{ type: string; from: string }>) => {
    if (event.data?.from === id) return;
    if (event.data?.type === "hello") channel.postMessage({ type: "here", from: id });
    warn();
  };
  channel.postMessage({ type: "hello", from: id });
  return () => channel.close();
}
