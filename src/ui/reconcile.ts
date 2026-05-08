export type ReconcileChoice = "reload" | "keep";

export function promptReconcile(): Promise<ReconcileChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "viewer-reconcile-overlay";

    const card = document.createElement("div");
    card.className = "viewer-reconcile-card";
    const title = document.createElement("h3");
    title.textContent = "File changed on disk";
    const body = document.createElement("p");
    body.textContent = "Your unsaved edits and the new content cannot both be kept.";

    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "viewer-toolbar-btn";
    reload.textContent = "Reload from disk";

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "viewer-toolbar-btn";
    keep.textContent = "Keep my edits";

    const buttons = document.createElement("div");
    buttons.className = "viewer-reconcile-buttons";
    buttons.append(keep, reload);

    card.append(title, body, buttons);

    function close(choice: ReconcileChoice): void {
      document.body.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      resolve(choice);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") close("keep");
    }
    reload.addEventListener("click", () => close("reload"));
    keep.addEventListener("click", () => close("keep"));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close("keep");
    });
    document.addEventListener("keydown", onKey);

    overlay.append(card);
    document.body.append(overlay);
    keep.focus();
  });
}

export function showOrphanNotice(): void {
  showTransientNotice("This file is no longer on disk. Save As to choose a new location.", "viewer-orphan-notice", 8000);
}

export function showReloadedNotice(): void {
  showTransientNotice("Reloaded from disk", "viewer-reloaded-notice", 2000);
}

function showTransientNotice(text: string, className: string, durationMs: number): void {
  const note = document.createElement("div");
  note.className = className;
  note.textContent = text;
  document.body.append(note);
  setTimeout(() => note.remove(), durationMs);
}
