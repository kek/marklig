import { defineConfig } from "vite";
import { resolve } from "node:path";

// Vite config for the marketing website (GitHub Pages deploy target).
// The website imports the same decoration producers + editor module the
// desktop app uses; see src/website/bootstrap.ts.
//
// The alias swaps src/shell/store.ts (Tauri-backed) for the
// localStorage-backed peer in src/website/store-web.ts. This lets
// shell/settings.ts and src/ui/sidebar/toc.ts work unmodified in a
// browser without @tauri-apps/plugin-store.
export default defineConfig({
  root: "website",
  base: "/marklig/",
  resolve: {
    alias: {
      // Both the bare path and any imports through ../shell/store resolve
      // to the website peer.
      [resolve(__dirname, "src/shell/store.ts")]: resolve(__dirname, "src/website/store-web.ts"),
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    emptyOutDir: true,
  },
});
