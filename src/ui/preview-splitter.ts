export interface MountPreviewSplitterOptions {
  parent: HTMLElement;
  /** Element whose width is used to compute the fraction (the app shell). */
  container: HTMLElement;
  /** Read the current pane fraction (0..1, from-right). Used to nudge with
   * keyboard arrows. */
  getFraction(): number;
  onResize(fraction: number): void;
}

export interface PreviewSplitterHandle {
  element: HTMLElement;
  destroy(): void;
}

/** Step (as a fraction of container width) applied per arrow-key press.
 * Shift-arrow steps 5× as much, matching the convention used by HTML range
 * inputs. */
const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

export function mountPreviewSplitter(opts: MountPreviewSplitterOptions): PreviewSplitterHandle {
  const el = document.createElement("div");
  el.className = "preview-splitter";
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", "vertical");
  el.tabIndex = 0;
  opts.parent.append(el);

  let dragging = false;

  function onMove(e: MouseEvent): void {
    if (!dragging) return;
    const rect = opts.container.getBoundingClientRect();
    const containerWidth = rect.width || opts.container.clientWidth || 1;
    // Fraction is measured from the right: how much of the total width is to
    // the right of the splitter cursor position.
    // When getBoundingClientRect() returns zeros (jsdom), rect.left = 0, so
    // fromRight = containerWidth - e.clientX gives the right-side fraction.
    const left = rect.left || 0;
    const fromRight = containerWidth - (e.clientX - left);
    const fraction = fromRight / containerWidth;
    opts.onResize(fraction);
  }

  function onUp(): void {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("preview-splitter-dragging");
  }

  function onDown(_e: MouseEvent): void {
    dragging = true;
    document.body.classList.add("preview-splitter-dragging");
  }

  // Keyboard handling: ArrowLeft/Right nudge the pane fraction. Fraction is
  // measured from-right, so ArrowLeft (move splitter leftward) grows the
  // pane (larger fraction) and ArrowRight shrinks it. Home/End jump to the
  // clamped extremes (the setter on the consumer side clamps to its allowed
  // range, so any large value here lands at the bound).
  function onKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const current = opts.getFraction();
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = current + step;
    else if (e.key === "ArrowRight") next = current - step;
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = 0;
    if (next === null) return;
    e.preventDefault();
    opts.onResize(next);
  }

  el.addEventListener("mousedown", onDown);
  el.addEventListener("keydown", onKey);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  return {
    element: el,
    destroy() {
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.remove();
    },
  };
}
