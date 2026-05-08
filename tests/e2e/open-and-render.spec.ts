import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let viteProc: ChildProcess | undefined;
const APP_URL = "http://localhost:1420";

test.beforeAll(async () => {
  viteProc = spawn("npm", ["run", "dev"], {
    cwd: resolve(__dirname, "..", ".."),
    stdio: "inherit",
    detached: true,
  });
  // Wait for vite to be reachable.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(APP_URL);
      if (r.ok) break;
    } catch {}
    await sleep(500);
  }
});

test.afterAll(async () => {
  if (viteProc?.pid) {
    try {
      process.kill(-viteProc.pid);
    } catch {
      // ignore — vite may have already exited
    }
  }
});

test("renders headings and code from a sample doc", async ({ page }) => {
  // Stub the Tauri invoke for read_text_file by intercepting the page load.
  await page.addInitScript(() => {
    const sample = `# Sample Document\n\nA paragraph with **bold**, *italic*, and \`code\`.\n\n## Lists\n\n- a\n- b\n\n## Code\n\n\`\`\`js\nconst x = 42;\n\`\`\`\n`;
    // Mock @tauri-apps/api/core invoke before main.ts runs.
    // transformCallback and unregisterCallback are needed by Channel (used in event listeners).
    let cbId = 0;
    const callbacks: Record<number, (msg: unknown) => void> = {};
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === "read_text_file") return sample;
        if (cmd === "plugin:cli|argv") return [];
        if (cmd === "plugin:dialog|open") return "/virtual/sample.md";
        return null;
      },
      transformCallback: (cb: (msg: unknown) => void, once = false) => {
        const id = ++cbId;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        callbacks[id] = once ? (msg: unknown) => { delete callbacks[id]; cb(msg); } : cb;
        return id;
      },
      unregisterCallback: (id: number) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete callbacks[id];
      },
    };
  });

  await page.goto(APP_URL);

  // The heading should be visible with H1 typography (font-size 28px from theme).
  const h1 = page.locator(".cm-md-heading-1");
  await expect(h1).toBeVisible();

  // A list line is present.
  await expect(page.locator(".cm-md-list-bullet").first()).toBeVisible();

  // The code body text is present in the editor — the fence open/close lines are
  // elided in reading mode (cm-md-reading-elide-line), but the body text is always visible.
  await expect(page.locator(".cm-line").filter({ hasText: "const x = 42;" })).toBeVisible();
});
