import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface DirtyTracker {
  isDirty(): boolean;
  /** Mark the buffer clean at the current document content (call after save). */
  reset(): void;
  /** Mark the buffer dirty against an arbitrary baseline string (e.g. the
   * on-disk contents). Used by crash-recovery: the buffer holds the recovered
   * dump while disk still has the older saved state, so the user lands in a
   * window with their unsaved edits + dirty dot — the same state as
   * "I edited this file and crashed before save". */
  markDirtyAgainst(baseline: string): void;
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
  const fingerprintOf = (s: string): { len: number; hash: number } => {
    // FNV-1a is good enough for change detection — collisions don't matter
    // here because length pre-check eliminates most false-equals.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return { len: s.length, hash: h };
  };
  const fingerprint = (): { len: number; hash: number } =>
    fingerprintOf(view.state.doc.toString());

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
    markDirtyAgainst(baseline) {
      saved = fingerprintOf(baseline);
      // The buffer holds something other than `baseline`; recompute checks
      // current-vs-saved and flips the dirty bit + notifies listeners.
      recompute();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(dirty);
      return () => { listeners.delete(listener); };
    },
  };
}
