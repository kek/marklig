// Settings → Pairings pane. Lists paired phones, lets the user unpair,
// surfaces per-phone synced-folder lists. Wired into the preferences
// modal as an additional section so users discover it where the rest of
// the settings live.

import { t } from "../i18n/strings";
import {
  listPairings,
  unpair,
  folderSyncDisable,
  type PairingMeta,
} from "../shell/pairings";
import { openPairingModal } from "./pairing-modal";

function formatAgo(unix: number): string {
  if (unix <= 0) return "never";
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (delta < 60) return `${delta}s ago`;
  const m = Math.floor(delta / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString();
}

export async function buildPairingsSection(): Promise<HTMLElement> {
  const section = document.createElement("section");
  section.className = "viewer-prefs-section viewer-prefs-section--pairings";

  const heading = document.createElement("h4");
  heading.textContent = t("pairings.pane.title");
  section.appendChild(heading);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "pairings-pane__add";
  addBtn.textContent = t("pairing.modal.title");
  addBtn.addEventListener("click", () => {
    void openPairingModal().then(() => renderList(listContainer));
  });
  section.appendChild(addBtn);

  const listContainer = document.createElement("div");
  listContainer.className = "pairings-pane__list";
  section.appendChild(listContainer);

  await renderList(listContainer);
  return section;
}

async function renderList(container: HTMLElement): Promise<void> {
  container.innerHTML = "";
  let pairings: PairingMeta[];
  try {
    pairings = await listPairings();
  } catch (err) {
    const errBox = document.createElement("p");
    errBox.className = "pairings-pane__error";
    errBox.textContent = String(err);
    container.appendChild(errBox);
    return;
  }
  if (pairings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "pairings-pane__empty";
    empty.textContent = t("pairings.pane.empty");
    container.appendChild(empty);
    return;
  }
  for (const p of pairings) {
    container.appendChild(renderPairing(p, container));
  }
}

function renderPairing(p: PairingMeta, container: HTMLElement): HTMLElement {
  const card = document.createElement("div");
  card.className = "pairings-pane__card";

  const name = document.createElement("div");
  name.className = "pairings-pane__name";
  name.textContent = p.friendly_name || p.pair_id_hex.slice(0, 8);
  card.appendChild(name);

  const dates = document.createElement("div");
  dates.className = "pairings-pane__dates";
  dates.textContent =
    t("pairings.pane.paired").replace("{when}", formatDate(p.paired_at_unix)) +
    " · " +
    t("pairings.pane.last_seen").replace(
      "{ago}",
      formatAgo(p.last_seen_at_unix),
    );
  card.appendChild(dates);

  const fingerprint = document.createElement("code");
  fingerprint.className = "pairings-pane__fingerprint";
  fingerprint.textContent = p.verification_fingerprint;
  card.appendChild(fingerprint);

  const foldersHeader = document.createElement("div");
  foldersHeader.className = "pairings-pane__folders-header";
  foldersHeader.textContent = t("pairings.pane.synced_folders");
  card.appendChild(foldersHeader);

  if (p.synced_folders.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pairings-pane__no-folders";
    empty.textContent = t("pairings.pane.no_synced_folders");
    card.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "pairings-pane__folders-list";
    for (const folder of p.synced_folders) {
      const item = document.createElement("li");
      item.className = "pairings-pane__folder-item";

      const path = document.createElement("span");
      path.className = "pairings-pane__folder-path";
      path.textContent = folder;
      item.appendChild(path);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pairings-pane__folder-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${folder}`);
      remove.addEventListener("click", async () => {
        await folderSyncDisable(p.pair_id_hex, folder);
        await renderList(container);
      });
      item.appendChild(remove);

      list.appendChild(item);
    }
    card.appendChild(list);
  }

  const actions = document.createElement("div");
  actions.className = "pairings-pane__actions";

  const unpairBtn = document.createElement("button");
  unpairBtn.type = "button";
  unpairBtn.className = "pairings-pane__unpair";
  unpairBtn.textContent = t("pairings.pane.unpair");
  unpairBtn.addEventListener("click", async () => {
    const confirmed = window.confirm(
      t("pairings.pane.unpair_confirm").replace(
        "{name}",
        p.friendly_name || p.pair_id_hex.slice(0, 8),
      ),
    );
    if (!confirmed) return;
    await unpair(p.pair_id_hex);
    await renderList(container);
  });
  actions.appendChild(unpairBtn);

  card.appendChild(actions);
  return card;
}
