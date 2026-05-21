import { describe, it, expect, beforeEach } from "vitest";
import { mountPreviewPane } from "../../src/ui/preview-pane";

describe("preview pane", () => {
  let parent: HTMLElement;
  beforeEach(() => {
    parent = document.createElement("div");
    document.body.append(parent);
  });

  it("mounts hidden by default and shows on setVisible(true)", () => {
    const handle = mountPreviewPane({ parent });
    expect(handle.element.hidden).toBe(true);
    handle.setVisible(true);
    expect(handle.element.hidden).toBe(false);
  });

  it("setContent inserts sanitized HTML into the body", () => {
    const handle = mountPreviewPane({ parent });
    handle.setContent("<h1>Hi</h1><script>alert(1)</script>");
    expect(handle.element.querySelector("h1")?.textContent).toBe("Hi");
    expect(handle.element.querySelector("script")).toBeNull();
  });

  it("setStatus updates the header line", () => {
    const handle = mountPreviewPane({ parent });
    handle.setStatus("Compiling…");
    expect(handle.element.textContent).toContain("Compiling…");
  });
});
