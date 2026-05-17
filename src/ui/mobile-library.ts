// Mobile library home. Three surfaces:
// 1. Paired desktops — listed at the top if any pairings exist.
// 2. Recents — share-sheet-opened files (persisted via mobile-recents).
// 3. Empty CTA — when both sections are empty, invite the user to share
//    a file or pair with a desktop.

import { t } from "../i18n/strings";
import type { MobileRecent } from "../shell/mobile-recents";
import type { MobilePairing } from "../shell/mobile-pairings";

export interface MobileLibraryHandlers {
  onOpenRecent: (uri: string) => void;
  onPairTap: () => void;
  onPairedDesktopTap: (pairing: MobilePairing) => void;
}

export function mountMobileLibrary(
  root: HTMLElement,
  recents: MobileRecent[],
  pairings: MobilePairing[],
  handlers: MobileLibraryHandlers,
): void {
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "mobile-library";

  const title = document.createElement("h1");
  title.className = "mobile-library__title";
  title.textContent = t("mobile.library.title");
  wrap.appendChild(title);

  const hasAnything = recents.length > 0 || pairings.length > 0;

  if (pairings.length > 0) {
    const heading = document.createElement("h2");
    heading.className = "mobile-library__section";
    heading.textContent = t("mobile.library.paired_desktops");
    wrap.appendChild(heading);

    const list = document.createElement("ul");
    list.className = "mobile-library__list";
    for (const p of pairings) {
      list.appendChild(renderPairingRow(p, handlers));
    }
    wrap.appendChild(list);
  }

  if (recents.length > 0) {
    const heading = document.createElement("h2");
    heading.className = "mobile-library__section";
    heading.textContent = t("mobile.library.recents");
    wrap.appendChild(heading);

    const list = document.createElement("ul");
    list.className = "mobile-library__list";
    for (const r of recents) {
      list.appendChild(renderRecentRow(r, handlers));
    }
    wrap.appendChild(list);
  }

  if (!hasAnything) {
    const empty = document.createElement("p");
    empty.className = "mobile-library__empty";
    empty.textContent = t("mobile.library.empty");
    wrap.appendChild(empty);
  }

  // "Pair with a desktop" CTA: shown in empty state as a prominent
  // button, and as a small secondary button when there's already a
  // pairings list (so users can add another desktop).
  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = hasAnything
    ? "mobile-library__pair-cta mobile-library__pair-cta--secondary"
    : "mobile-library__pair-cta";
  cta.textContent = t("mobile.library.pair_cta");
  cta.addEventListener("click", () => handlers.onPairTap());
  wrap.appendChild(cta);

  root.appendChild(wrap);
}

function renderRecentRow(
  r: MobileRecent,
  handlers: MobileLibraryHandlers,
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "mobile-library__item";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mobile-library__item-btn";
  btn.addEventListener("click", () => handlers.onOpenRecent(r.uri));

  const name = document.createElement("span");
  name.className = "mobile-library__item-name";
  name.textContent = r.displayName;

  const when = document.createElement("span");
  when.className = "mobile-library__item-when";
  when.textContent = formatRelative(r.lastOpenedMs);

  btn.appendChild(name);
  btn.appendChild(when);
  li.appendChild(btn);
  return li;
}

function renderPairingRow(
  p: MobilePairing,
  handlers: MobileLibraryHandlers,
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "mobile-library__item mobile-library__item--paired";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mobile-library__item-btn";
  btn.addEventListener("click", () => handlers.onPairedDesktopTap(p));

  const name = document.createElement("span");
  name.className = "mobile-library__item-name";
  name.textContent = p.friendly_name || p.pair_id_hex.slice(0, 12);

  const fp = document.createElement("span");
  fp.className = "mobile-library__item-when";
  fp.textContent = p.verification_fingerprint;

  btn.appendChild(name);
  btn.appendChild(fp);
  li.appendChild(btn);
  return li;
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return "in the future";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
