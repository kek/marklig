import { describe, it, expect, beforeEach } from "vitest";
import { mountPreviewSplitter } from "../../src/ui/preview-splitter";

describe("preview splitter", () => {
  let parent: HTMLElement;
  beforeEach(() => {
    parent = document.createElement("div");
    Object.defineProperty(parent, "clientWidth", { value: 1000, configurable: true });
    document.body.append(parent);
  });

  it("emits onResize with a clamped fraction during drag", () => {
    const fractions: number[] = [];
    const handle = mountPreviewSplitter({
      parent,
      container: parent,
      onResize: (f) => fractions.push(f),
    });
    handle.element.dispatchEvent(new MouseEvent("mousedown", { clientX: 600, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 400 }));
    // 1 - (400 / 1000) = 0.6
    expect(fractions.at(-1)).toBeCloseTo(0.6, 2);
  });
});
