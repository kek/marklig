// Small modal harness used by preferences and shortcuts. Standardizes:
//
//   - role="dialog" + aria-modal + aria-labelledby for screen readers
//   - focus trap: Tab cycles inside the card, never leaves it
//   - focus restore: closing returns focus to whatever held it before open
//   - single-instance: a second open() while one is up is a no-op
//
// Reconcile.ts has different ergonomics (two buttons, choice return) so it
// gets its own ARIA + focus trap inline rather than going through this seam.

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let titleSeq = 0;

export interface ModalOptions {
  /** Title text rendered as the modal heading and used for aria-labelledby. */
  title: string;
  /** Builder receives the empty <section>-style container; append content into it. */
  build: (body: HTMLElement) => void;
  /** Defaults to "Close". */
  closeLabel?: string;
}

/** Open a modal. Returns a promise that resolves when the modal closes
 * (Esc, overlay click, or Close button). No-op if any modal is already open. */
export function openModal(opts: ModalOptions): Promise<void> {
  if (document.querySelector(".viewer-prefs-overlay")) return Promise.resolve();

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const overlay = document.createElement("div");
    overlay.className = "viewer-prefs-overlay";

    const card = document.createElement("div");
    card.className = "viewer-prefs-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const titleId = `viewer-modal-title-${++titleSeq}`;
    card.setAttribute("aria-labelledby", titleId);

    const heading = document.createElement("h3");
    heading.id = titleId;
    heading.textContent = opts.title;
    card.append(heading);

    const body = document.createElement("div");
    opts.build(body);
    card.append(body);

    const footer = document.createElement("div");
    footer.className = "viewer-prefs-footer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "viewer-toolbar-btn";
    close.textContent = opts.closeLabel ?? "Close";
    footer.append(close);
    card.append(footer);

    function focusables(): HTMLElement[] {
      return Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    }

    function dismiss(): void {
      document.body.removeChild(overlay);
      document.removeEventListener("keydown", onKey, true);
      previouslyFocused?.focus?.();
      resolve();
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    close.addEventListener("click", dismiss);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) dismiss();
    });
    // useCapture=true so Escape always wins, even if some focused control's
    // keydown handler would otherwise consume it.
    document.addEventListener("keydown", onKey, true);

    overlay.append(card);
    document.body.append(overlay);

    // Focus the first interactive element so screen readers announce the
    // dialog and keyboard nav starts inside.
    const items = focusables();
    (items[0] ?? close).focus();
  });
}
