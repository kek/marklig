// Mobile library home — vanilla DOM, no framework, matches the desktop
// codebase's UI approach (see src/ui/toolbar.ts, src/ui/titlebar.ts).
//
// Two surfaces:
// 1. Empty state — invite the user to share a Markdown file or pair with
//    a desktop. The pair CTA is a v2.1 placeholder; tapping it shows a
//    transient "pairing arrives in v2.1" hint.
// 2. Recents list — render the persisted recents as tap-to-open rows.
//
// "Synced folders" from the spec §10 wireframe is intentionally absent
// in v2.0 — sync ships in steps 4–7 and there's nothing meaningful to
// show until then. When the empty state's CTA-card UX is built in v2.1,
// it'll move from this file's empty-state branch into a dedicated
// section that sits alongside Recents whether or not pairing exists.

import { t } from "../i18n/strings";
import type { MobileRecent } from "../shell/mobile-recents";

export interface MobileLibraryHandlers {
  onOpenRecent: (uri: string) => void;
  onPairTap: () => void;
}

export function mountMobileLibrary(
  root: HTMLElement,
  recents: MobileRecent[],
  handlers: MobileLibraryHandlers,
): void {
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "mobile-library";

  const title = document.createElement("h1");
  title.className = "mobile-library__title";
  title.textContent = t("mobile.library.title");
  wrap.appendChild(title);

  if (recents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "mobile-library__empty";
    empty.textContent = t("mobile.library.empty");
    wrap.appendChild(empty);

    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "mobile-library__pair-cta";
    cta.textContent = t("mobile.library.pair_cta");
    cta.addEventListener("click", () => handlers.onPairTap());
    wrap.appendChild(cta);
  } else {
    const section = document.createElement("h2");
    section.className = "mobile-library__section";
    section.textContent = t("mobile.library.recents");
    wrap.appendChild(section);

    const list = document.createElement("ul");
    list.className = "mobile-library__list";
    for (const r of recents) {
      list.appendChild(renderRecentRow(r, handlers));
    }
    wrap.appendChild(list);
  }

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
