import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Cross-window focus (issue #100 / #137) lives entirely on the frontend:
// `routeToFolder` picks the window that owns a folder and calls
// `WebviewWindow.getByLabel(label).setFocus()` (plus unminimize). Those are
// Tauri core:window commands, and every command is denied unless the active
// capability explicitly grants its permission. `core:window:default` does NOT
// include set_focus / unminimize / is_minimized, so without these three the
// focus call throws "set_focus not allowed by ACL" and is swallowed — the app
// foregrounds but the owning window never raises. Guard the grant so a trimmed
// capability can't silently re-break `md .` re-opening an existing folder.
describe("desktop capability grants window-focus permissions", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const capPath = join(__dirname, "../../src-tauri/capabilities/default.json");
  const cap = JSON.parse(readFileSync(capPath, "utf8")) as {
    permissions: string[];
  };

  for (const perm of [
    "core:window:allow-set-focus",
    "core:window:allow-unminimize",
    "core:window:allow-is-minimized",
  ]) {
    it(`includes ${perm}`, () => {
      expect(cap.permissions).toContain(perm);
    });
  }
});
