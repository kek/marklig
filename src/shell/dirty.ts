import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface DirtyTracker {
  isDirty(): boolean;
  /** Mark the buffer clean at the current document content (call after save). */
  reset(): void;
  /** Subscribe to dirty-state changes. Listener fires immediately with current state. */
  subscribe(listener: (dirty: boolean) => void): () => void;
}

export function createDirtyTracker(view: EditorView): DirtyTracker {
  // Track a 'baseline length' rather than the full saved string. Two
  // documents with the same content might still differ by single chars
  // we can't detect without comparing — but for the dirty bit we only
  // need a fast O(1) signal that 'something changed since save'.
  // After save (reset), we capture (length, fingerprint); subsequent
  // doc-change transactions flip dirty=true. Reverting via undo back to
  // the saved state restores fingerprint match → dirty=false again.
  const fingerprint = (): { len: number; hash: number } => {
    const s = view.state.doc.toString();
    // FNV-1a is good enough for change detection — collisions don't matter
    // here because length pre-check eliminates most false-equals.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return { len: s.length, hash: h };
  };

  let saved = fingerprint();
  let dirty = false;
  const listeners = new Set<(dirty: boolean) => void>();

  const recompute = (): void => {
    const cur = fingerprint();
    const nowDirty = cur.len !== saved.len || cur.hash !== saved.hash;
    if (nowDirty !== dirty) {
      dirty = nowDirty;
      for (const l of listeners) l(dirty);
    }
  };

  // Recompute on every transaction that changed the document. CM6's
  // updateListener fires once per transaction with a precomputed docChanged
  // flag — the previous rAF-poll re-stringified the entire doc 60×/sec
  // even when nothing happened. Installed via a Compartment so we can
  // attach to an existing EditorView without touching its construction.
  const compartment = new Compartment();
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      compartment.of(
        EditorView.updateListener.of((u) => {
          if (u.docChanged) recompute();
        }),
      ),
    ),
  });

  return {
    isDirty: () => dirty,
    reset() {
      saved = fingerprint();
      const wasDirty = dirty;
      dirty = false;
      if (wasDirty) for (const l of listeners) l(false);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(dirty);
      return () => { listeners.delete(listener); };
    },
  };
}
