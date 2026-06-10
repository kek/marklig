import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/platform", () => ({ isMobile: () => false }));
vi.mock("../../src/shell/mobile-pairings", () => ({
  syncNow: vi.fn(),
  listSyncedFiles: vi.fn(),
  syncedFolderLabels: vi.fn(),
  unpairMobile: vi.fn(),
}));
// The synced view imports event-name constants from mobile-sync-client, which
// transitively pulls in @tauri-apps/api/core. Mock it to just the constants so
// the test imports cleanly without a Tauri runtime.
vi.mock("../../src/shell/mobile-sync-client", () => ({
  LIVE_OP_EVENT: "sync:live-op",
  CAUGHT_UP_EVENT: "sync:caught-up",
}));

import { mountMobileSynced } from "../../src/ui/mobile-synced-view";
import {
  listSyncedFiles,
  syncedFolderLabels,
  type MobilePairing,
} from "../../src/shell/mobile-pairings";

const PAIR: MobilePairing = {
  pair_id_hex: "aa".repeat(16),
  friendly_name: "Desk",
  verification_fingerprint: "AA-BB",
  paired_at_unix: 0,
  last_seen_at_unix: 0,
};

function sf(folderIdHex: string, relpath: string) {
  return {
    pair_id_hex: PAIR.pair_id_hex,
    folder_id_hex: folderIdHex,
    relpath,
    abs_path: "/x/" + relpath,
    synced_at_unix: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "<div id='root'></div>";
});

function root() {
  return document.getElementById("root")!;
}

describe("drill-in browse", () => {
  it("single-folder pairing skips the projects level and lists the folder root", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "notes/a.md"), sf("f1", "top.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });

    const opened: any[] = [];
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: (file, path) => opened.push({ file, path }),
      onBack: () => {},
      onUnpaired: () => {},
    });
    // wait a microtask for the async refresh()
    await Promise.resolve();
    await Promise.resolve();

    const rows = root().querySelectorAll(".mobile-browse__row");
    const labels = [...rows].map((r) => r.textContent);
    // A directory row "notes" and a file row "top.md" at the root.
    expect(labels.some((t) => t?.includes("notes"))).toBe(true);
    expect(labels.some((t) => t?.includes("top.md"))).toBe(true);

    handle.teardown();
  });

  it("drilling into a folder shows its children, handleBack pops back up", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "notes/a.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: () => {},
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    const dirRow = [...root().querySelectorAll<HTMLElement>(".mobile-browse__row--dir")].find(
      (r) => r.textContent?.includes("notes"),
    )!;
    dirRow.querySelector<HTMLElement>("button")!.click();
    expect(root().textContent).toContain("a.md");

    // handleBack returns true (consumed) when not at the top level.
    expect(handle.handleBack()).toBe(true);
    expect(root().textContent).toContain("notes");
    handle.teardown();
  });

  it("tapping a file calls onOpenFile with the file and current path", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "top.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const opened: any[] = [];
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: (file, path) => opened.push({ file, path }),
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    const fileRow = [...root().querySelectorAll<HTMLElement>(".mobile-browse__row--file")].find(
      (r) => r.textContent?.includes("top.md"),
    )!;
    fileRow.querySelector<HTMLElement>("button")!.click();
    expect(opened).toHaveLength(1);
    expect(opened[0].file.relpath).toBe("top.md");
    expect(opened[0].path).toEqual({ folderIdHex: "f1", segments: [] });
    handle.teardown();
  });
});

describe("search overlay", () => {
  it("filters across folders and opens a result", async () => {
    (listSyncedFiles as any).mockResolvedValue([
      sf("f1", "notes/alpha.md"),
      sf("f2", "beta.md"),
    ]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes", f2: "Work" });
    const opened: any[] = [];
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: (file) => opened.push(file),
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    root().querySelector<HTMLElement>(".mobile-browse__search-btn")!.click();
    const input = root().querySelector<HTMLInputElement>(".mobile-search__input")!;
    input.value = "alpha";
    input.dispatchEvent(new Event("input"));

    const results = root().querySelectorAll(".mobile-search__result");
    expect(results).toHaveLength(1);
    (results[0] as HTMLElement).querySelector<HTMLElement>("button")!.click();
    expect(opened).toHaveLength(1);
    expect(opened[0].relpath).toBe("notes/alpha.md");
    handle.teardown();
  });
});

describe("live-op refresh", () => {
  it("rebuilds the tree and pops out of a directory that was deleted", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "notes/a.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: () => {},
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    // Drill into notes/.
    [...root().querySelectorAll<HTMLElement>(".mobile-browse__row--dir")]
      .find((r) => r.textContent?.includes("notes"))!
      .querySelector<HTMLElement>("button")!
      .click();
    expect(root().textContent).toContain("a.md");

    // A live op deletes notes/a.md — the only file. Next refresh has no files
    // in notes/, so the view must pop back to the (now empty) folder root.
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "top.md")]);
    window.dispatchEvent(
      new CustomEvent("sync:live-op", { detail: { pairIdHex: PAIR.pair_id_hex } }),
    );
    // Allow the async refresh() to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(root().textContent).toContain("top.md");
    handle.teardown();
  });
});

describe("search overlay + hardware back", () => {
  it("handleBack closes the overlay and returns true instead of exiting the view", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "a.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: () => {},
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    root().querySelector<HTMLElement>(".mobile-browse__search-btn")!.click();
    expect(root().querySelector(".mobile-search")).not.toBeNull();

    expect(handle.handleBack()).toBe(true);
    expect(root().querySelector(".mobile-search")).toBeNull();
    handle.teardown();
  });
});

describe("handleBack at top level", () => {
  it("returns false so the router falls back to onBack/library", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "a.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes" });
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: () => {},
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(handle.handleBack()).toBe(false);
    handle.teardown();
  });

  it("pops from a folder back to the projects level when >1 folder", async () => {
    (listSyncedFiles as any).mockResolvedValue([sf("f1", "a.md"), sf("f2", "b.md")]);
    (syncedFolderLabels as any).mockResolvedValue({ f1: "Notes", f2: "Work" });
    const handle = await mountMobileSynced(root(), PAIR, {
      onOpenFile: () => {},
      onBack: () => {},
      onUnpaired: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    // Two folders => projects level is shown (not skipped). Drill into one.
    [...root().querySelectorAll<HTMLElement>(".mobile-browse__row--dir")]
      .find((r) => r.textContent?.includes("Notes"))!
      .querySelector<HTMLElement>("button")!
      .click();
    expect(root().textContent).toContain("a.md");

    // handleBack consumes and returns to the projects level (both folders).
    expect(handle.handleBack()).toBe(true);
    const labels = [...root().querySelectorAll(".mobile-browse__row")].map(
      (r) => r.textContent,
    );
    expect(labels.some((t) => t?.includes("Notes"))).toBe(true);
    expect(labels.some((t) => t?.includes("Work"))).toBe(true);
    handle.teardown();
  });
});
