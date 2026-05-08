import { EditorView } from "@codemirror/view";

export interface DirtyTracker {
  isDirty(): boolean;
  /** Mark the buffer clean at the current document content (call after save). */
  reset(): void;
  /** Subscribe to dirty-state changes. Listener fires immediately with current state. */
  subscribe(listener: (dirty: boolean) => void): () => void;
}

export function createDirtyTracker(view: EditorView): DirtyTracker {
  let savedDoc = view.state.doc.toString();
  let dirty = false;
  const listeners = new Set<(dirty: boolean) => void>();

  const recompute = (): void => {
    const nowDirty = view.state.doc.toString() !== savedDoc;
    if (nowDirty !== dirty) {
      dirty = nowDirty;
      for (const l of listeners) l(dirty);
    }
  };

  // Listen to every CodeMirror update; recompute when the doc changes.
  // EditorView.updateListener is a facet — we add it as an extension at the
  // editor level. To avoid coupling tightly to editor.ts construction, we
  // use the ViewPlugin-equivalent pattern here: dispatch a no-op effect
  // that wires our listener via state-effect on next update.
  //
  // Simplest correct approach: poll on each animation frame. Cheap and
  // doesn't require touching editor.ts.
  let raf = 0;
  const tick = (): void => {
    recompute();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    isDirty: () => dirty,
    reset() {
      savedDoc = view.state.doc.toString();
      const wasDirty = dirty;
      dirty = false;
      if (wasDirty) for (const l of listeners) l(false);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(dirty);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          cancelAnimationFrame(raf);
        }
      };
    },
  };
}
