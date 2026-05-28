import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { searchPanelOpen } from "@codemirror/search";

/** Class toggled on `.cm-editor` while the search panel is open. CSS in
 * styles.css keys the spotlight (dim non-matches, light up matches) off it,
 * so it must be added/removed in lock-step with panel open/close. */
export const SPOTLIGHT_ACTIVE_CLASS = "cm-search-spotlight";

/** Reflect `searchPanelOpen(state)` onto a class on the editor DOM. We don't
 * watch the panel's DOM mount/unmount directly — the state field is the
 * canonical source of truth and an update listener fires on every transition
 * that opens or closes it (including Esc, the panel's close button, and a
 * programmatic `closeSearchPanel`). Reverting is therefore automatic: when the
 * panel closes the listener removes the class and the dim/highlight CSS no
 * longer matches anything. Works identically in reading and edit mode because
 * the extension lives outside the mode compartments. */
const spotlightToggle = EditorView.updateListener.of((update) => {
  const wasOpen = searchPanelOpen(update.startState);
  const isOpen = searchPanelOpen(update.state);
  if (wasOpen === isOpen) return;
  update.view.dom.classList.toggle(SPOTLIGHT_ACTIVE_CLASS, isOpen);
});

/** Spotlight effect for Cmd-F search: while the `@codemirror/search` panel is
 * open, matches stay at full contrast and the surrounding document is dimmed,
 * with the active match (`.cm-searchMatch-selected`) styled distinctly. The
 * highlight/dim visuals themselves live in styles.css (so they can use the
 * theme custom properties); this extension only wires the panel-open state to
 * a class the CSS keys off. Built entirely on `@codemirror/search` — no
 * parallel match-finding mechanism. */
export function searchSpotlight(): Extension {
  return [spotlightToggle];
}
