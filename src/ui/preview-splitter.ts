export interface MountPreviewSplitterOptions {
  parent: HTMLElement;
  /** Element whose width is used to compute the fraction (the app shell). */
  container: HTMLElement;
  onResize(fraction: number): void;
}

export interface PreviewSplitterHandle {
  element: HTMLElement;
  destroy(): void;
}

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

  el.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  return {
    element: el,
    destroy() {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.remove();
    },
  };
}
