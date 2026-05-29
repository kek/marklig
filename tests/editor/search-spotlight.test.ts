import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from "@codemirror/search";

import { createEditor, setMode } from "../../src/editor/editor";
import { readingKeymap, editKeymap } from "../../src/editor/keymaps";
import { SPOTLIGHT_ACTIVE_CLASS } from "../../src/editor/search-spotlight";

let host: HTMLElement;

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', { url: "http://localhost" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window as unknown as typeof globalThis.window;
  host = dom.window.document.getElementById("host")!;
});

describe("search spotlight", () => {
  it("does not mark the editor while the search panel is closed", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(false);
  });

  it("adds the spotlight class when the search panel opens", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    openSearchPanel(view);
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(true);
  });

  it("removes the spotlight class when the search panel closes", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    openSearchPanel(view);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(true);
    closeSearchPanel(view);
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(false);
  });

  it("engages in edit mode too (shared EditorView, mode-independent)", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    setMode(view, "edit", { decorations: [], keymap: editKeymap });
    openSearchPanel(view);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(true);
    closeSearchPanel(view);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(false);
  });

  it("re-applies cleanly across a reading keymap reconfigure", () => {
    const view = createEditor({ parent: host, source: "alpha beta alpha" });
    setMode(view, "reading", { decorations: [], keymap: readingKeymap });
    openSearchPanel(view);
    expect(view.dom.classList.contains(SPOTLIGHT_ACTIVE_CLASS)).toBe(true);
  });

  /* The spotlight dims non-matches by reaching styled child spans (Shiki
   * .cm-md-token-* / .cm-md-strong / .cm-md-link-text) with the broad
   * descendant selector `.cm-content :not(.cm-searchMatch)`. A match's own
   * styled children must be RESTORED to full contrast, not dimmed. Because both
   * rules use !important, the restore rule only wins if its specificity ties or
   * exceeds the dim rule AND it comes later in source order — see styles.css.
   *
   * CM's search highlighter produces the .cm-searchMatch spans via the view's
   * layout/measure cycle, which jsdom doesn't run, so we can't assert computed
   * color here. Instead we assert (a) the DOM class chain the restore selector
   * targets matches a match-inside-styled-span node, and (b) the specificity
   * contract in styles.css that makes the restore rule actually win. */
  describe("dim does not override styled children of a match", () => {
    // vitest runs with cwd at the project root; the jsdom env rewrites
    // import.meta.url to an http URL, so resolve from cwd instead.
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

    // Crude class-level specificity: count class/attr/pseudo-class tokens.
    // Sufficient here because all four selectors are class-only (no ids/elements).
    const classSpecificity = (selector: string): number =>
      (selector.match(/\.[a-zA-Z_-][\w-]*|\[[^\]]*\]|:(?!not\()[\w-]+/g) ?? []).length;

    it("restore selector targets the match span and its descendant spans", () => {
      // Mirror the real DOM CodeMirror builds when a query matches text inside a
      // styled inline span: a .cm-searchMatch wrapping (or wrapped by) the
      // construct span that sets its own color.
      const editor = host.ownerDocument.createElement("div");
      editor.className = "cm-editor cm-search-spotlight";
      const content = host.ownerDocument.createElement("div");
      content.className = "cm-content";
      content.innerHTML =
        '<span class="cm-searchMatch"><span class="cm-md-strong">bold</span></span>';
      editor.appendChild(content);
      host.appendChild(editor);

      const restoreChain =
        ".cm-editor.cm-search-spotlight .cm-content .cm-searchMatch, " +
        ".cm-editor.cm-search-spotlight .cm-content .cm-searchMatch *";

      // The match span itself and its styled child are both reached by the
      // restore selector (so they get --fg), not stranded under the dim rule.
      expect(editor.querySelectorAll(restoreChain).length).toBe(2);
      const child = content.querySelector(".cm-md-strong")!;
      expect(child.matches(".cm-editor.cm-search-spotlight .cm-content .cm-searchMatch *")).toBe(
        true,
      );
    });

    it("keeps the restore rule winning over the dim rule (specificity + source order)", () => {
      const dimSelector = ".cm-editor.cm-search-spotlight .cm-content :not(.cm-searchMatch)";
      const restoreSelector = ".cm-editor.cm-search-spotlight .cm-content .cm-searchMatch *";

      const dimIndex = css.indexOf(dimSelector);
      const restoreIndex = css.indexOf(restoreSelector);

      // Both selectors are still present (guards against a refactor dropping the
      // .cm-content segment that ties the specificity).
      expect(dimIndex).toBeGreaterThan(-1);
      expect(restoreIndex).toBeGreaterThan(-1);

      // Restore must tie or exceed the dim rule's specificity...
      expect(classSpecificity(restoreSelector)).toBeGreaterThanOrEqual(
        classSpecificity(dimSelector),
      );
      // ...and, on a tie, win by coming later in source order.
      expect(restoreIndex).toBeGreaterThan(dimIndex);
    });
  });
});
