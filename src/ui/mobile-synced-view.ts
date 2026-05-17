// Per-paired-desktop view on the phone. Lists synced files, exposes a
// "Sync now" button. Tap a file to open it.

import { t } from "../i18n/strings";
import {
  type MobilePairing,
  type SyncedFile,
  syncNow,
  listSyncedFiles,
  syncedFolderLabels,
} from "../shell/mobile-pairings";

export interface MobileSyncedHandlers {
  onOpenFile: (file: SyncedFile) => void;
  onBack: () => void;
}

export async function mountMobileSynced(
  root: HTMLElement,
  pairing: MobilePairing,
  handlers: MobileSyncedHandlers,
): Promise<void> {
  root.innerHTML = "";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "mobile-document__back";
  backBtn.textContent = "← " + t("mobile.library.back");
  backBtn.addEventListener("click", () => handlers.onBack());
  root.appendChild(backBtn);

  const wrap = document.createElement("div");
  wrap.className = "mobile-library";

  const title = document.createElement("h1");
  title.className = "mobile-library__title";
  title.textContent = pairing.friendly_name || pairing.pair_id_hex.slice(0, 12);
  wrap.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "mobile-library__empty";
  sub.style.opacity = "0.55";
  sub.style.fontSize = "0.8rem";
  sub.style.fontFamily = "var(--font-mono, ui-monospace, monospace)";
  sub.textContent = pairing.verification_fingerprint;
  wrap.appendChild(sub);

  const syncBtn = document.createElement("button");
  syncBtn.type = "button";
  syncBtn.className = "mobile-library__pair-cta";
  syncBtn.textContent = t("mobile.synced.sync_now");
  wrap.appendChild(syncBtn);

  const status = document.createElement("p");
  status.className = "mobile-library__empty";
  status.style.minHeight = "1.4em";
  wrap.appendChild(status);

  const list = document.createElement("ul");
  list.className = "mobile-library__list";
  wrap.appendChild(list);

  root.appendChild(wrap);

  const refresh = async () => {
    const files = await listSyncedFiles(pairing.pair_id_hex);
    const labels = await syncedFolderLabels(pairing.pair_id_hex);
    list.innerHTML = "";
    if (files.length === 0) {
      status.textContent = t("mobile.synced.empty");
      return;
    }
    status.textContent = `${files.length} ${
      files.length === 1 ? "file" : "files"
    }`;
    // Group by folder for readability.
    const byFolder = new Map<string, SyncedFile[]>();
    for (const f of files) {
      const arr = byFolder.get(f.folder_id_hex) ?? [];
      arr.push(f);
      byFolder.set(f.folder_id_hex, arr);
    }
    for (const [folderId, items] of byFolder) {
      const header = document.createElement("h2");
      header.className = "mobile-library__section";
      header.textContent = labels[folderId] ?? folderId.slice(0, 8);
      list.appendChild(header);
      for (const file of items.sort((a, b) =>
        a.relpath.localeCompare(b.relpath),
      )) {
        const li = document.createElement("li");
        li.className = "mobile-library__item";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mobile-library__item-btn";
        btn.addEventListener("click", () => handlers.onOpenFile(file));

        const name = document.createElement("span");
        name.className = "mobile-library__item-name";
        name.textContent = file.relpath;
        const when = document.createElement("span");
        when.className = "mobile-library__item-when";
        when.textContent = formatRelative(file.synced_at_unix * 1000);

        btn.appendChild(name);
        btn.appendChild(when);
        li.appendChild(btn);
        list.appendChild(li);
      }
    }
  };

  syncBtn.addEventListener("click", async () => {
    const host =
      pairing.last_host ||
      window.prompt(t("mobile.synced.prompt_host"), "");
    if (!host) return;
    syncBtn.disabled = true;
    status.textContent = t("mobile.synced.syncing");
    try {
      const result = await syncNow(pairing.pair_id_hex, host);
      status.textContent = t("mobile.synced.synced_n").replace(
        "{n}",
        String(result.files),
      );
      await refresh();
    } catch (err) {
      status.textContent = t("mobile.synced.failed_prefix") + String(err);
    } finally {
      syncBtn.disabled = false;
    }
  });

  await refresh();
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
