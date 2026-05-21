import { sanitizeHtml } from "../export/sanitize";

export interface MountPreviewPaneOptions {
  parent: HTMLElement;
}

export interface PreviewPaneHandle {
  element: HTMLElement;
  setVisible(visible: boolean): void;
  setContent(rawHtml: string): void;
  setRawSvg(svg: string): void; // used by Typst in Phase D
  setStatus(text: string | null): void;
  isVisible(): boolean;
  destroy(): void;
}

export function mountPreviewPane(opts: MountPreviewPaneOptions): PreviewPaneHandle {
  const root = document.createElement("aside");
  root.className = "preview-pane";
  root.hidden = true;
  root.setAttribute("aria-label", "Preview");

  const header = document.createElement("div");
  header.className = "preview-pane-header";
  const status = document.createElement("span");
  status.className = "preview-pane-status";
  header.append(status);

  const body = document.createElement("div");
  body.className = "preview-pane-body";
  // Make the pane body keyboard-focusable so Cmd-+/-/0 routing can detect
  // when the user is "in" the pane (vs. the editor). tabindex=0 keeps it
  // in the natural tab order; tabindex=-1 would require explicit focus().
  body.tabIndex = 0;

  root.append(header, body);
  opts.parent.append(root);

  return {
    element: root,
    setVisible(v) { root.hidden = !v; },
    isVisible() { return !root.hidden; },
    setContent(rawHtml) {
      body.innerHTML = sanitizeHtml(rawHtml);
    },
    setRawSvg(svg) {
      // Sanitization happens via sanitizeSvg at the caller (Typst path).
      body.innerHTML = svg;
    },
    setStatus(text) {
      status.textContent = text ?? "";
    },
    destroy() {
      root.remove();
    },
  };
}
