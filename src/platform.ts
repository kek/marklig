import { isTauri } from "@tauri-apps/api/core";

// Runtime platform classification. The mobile branch ports the renderer
// to Android via Tauri Mobile (v2 mobile companion, step 1); subsequent
// steps add the SAF file shell. Until step 2 wires `@tauri-apps/plugin-os`,
// we user-agent-sniff — sufficient to fork bootstrap. `npm run dev`
// (plain Vite, no Tauri) returns false so the desktop bootstrap path
// remains testable in a browser.
export function isMobile(): boolean {
  if (!isTauri()) return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("android");
}
