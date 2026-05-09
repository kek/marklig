import { t } from "../i18n/strings";

export type ReconcileChoice = "reload" | "keep";

export function promptReconcile(): Promise<ReconcileChoice> {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const overlay = document.createElement("div");
    overlay.className = "viewer-reconcile-overlay";

    const card = document.createElement("div");
    card.className = "viewer-reconcile-card";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "viewer-reconcile-title");
    card.setAttribute("aria-describedby", "viewer-reconcile-body");

    const title = document.createElement("h3");
    title.id = "viewer-reconcile-title";
    title.textContent = t("reconcile.title");
    const body = document.createElement("p");
    body.id = "viewer-reconcile-body";
    body.textContent = t("reconcile.body");

    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "viewer-toolbar-btn";
    reload.textContent = t("reconcile.reload");

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "viewer-toolbar-btn";
    keep.textContent = t("reconcile.keep");

    const buttons = document.createElement("div");
    buttons.className = "viewer-reconcile-buttons";
    buttons.append(keep, reload);

    card.append(title, body, buttons);

    function close(choice: ReconcileChoice): void {
      document.body.removeChild(overlay);
      document.removeEventListener("keydown", onKey, true);
      previouslyFocused?.focus?.();
      resolve(choice);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        close("keep");
        return;
      }
      // Two-button focus trap.
      if (e.key !== "Tab") return;
      const active = document.activeElement;
      if (e.shiftKey && active === keep) {
        e.preventDefault();
        reload.focus();
      } else if (!e.shiftKey && active === reload) {
        e.preventDefault();
        keep.focus();
      }
    }
    reload.addEventListener("click", () => close("reload"));
    keep.addEventListener("click", () => close("keep"));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close("keep");
    });
    document.addEventListener("keydown", onKey, true);

    overlay.append(card);
    document.body.append(overlay);
    keep.focus();
  });
}

export function showOrphanNotice(): void {
  showTransientNotice(t("notice.orphan"), "viewer-orphan-notice", 8000);
}

export function showReloadedNotice(): void {
  showTransientNotice(t("notice.reloaded"), "viewer-reloaded-notice", 2000);
}

function showTransientNotice(text: string, className: string, durationMs: number): void {
  const note = document.createElement("div");
  note.className = className;
  note.textContent = text;
  document.body.append(note);
  setTimeout(() => note.remove(), durationMs);
}
