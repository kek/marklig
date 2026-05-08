import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message } from "@tauri-apps/plugin-dialog";

export interface CloseHandlerOptions {
  isDirty: () => boolean;
  save: () => Promise<void>;
}

/**
 * Wires a close-requested handler that prompts before discarding unsaved changes.
 * Returns an unsubscribe function.
 *
 * When the buffer is clean we explicitly call win.destroy() so Tauri 2 always
 * sees a concrete decision rather than an unresolved async callback — some
 * Tauri 2 builds treat a resolved-but-decision-pending handler as a permanent
 * block.  When dirty we synchronously preventDefault() before any awaits so
 * the block is set before we go async.
 */
export async function installCloseHandler(opts: CloseHandlerOptions): Promise<() => void> {
  const win = getCurrentWindow();
  const stop = await win.onCloseRequested(async (event) => {
    if (!opts.isDirty()) {
      // Clean buffer — explicitly destroy so Tauri 2 sees a real decision.
      await win.destroy();
      return;
    }
    // Dirty buffer — block synchronously before any awaits, then prompt.
    event.preventDefault();
    const choice = await promptSaveDiscardCancel();
    if (choice === "cancel") return;
    if (choice === "save") {
      try {
        await opts.save();
      } catch (err) {
        await message(`Save failed: ${String(err)}`, { title: "Viewer", kind: "error" });
        return;
      }
    }
    await win.destroy();
  });
  return stop;
}

async function promptSaveDiscardCancel(): Promise<"save" | "discard" | "cancel"> {
  // Tauri's `ask` returns boolean; approximate three-way with two prompts.
  const wantSave = await ask("Save changes before closing?", {
    title: "Unsaved changes",
    okLabel: "Save",
    cancelLabel: "Don't save",
  });
  if (wantSave) return "save";
  const discardOk = await ask("Discard your unsaved changes?", {
    title: "Unsaved changes",
    okLabel: "Discard",
    cancelLabel: "Cancel close",
  });
  return discardOk ? "discard" : "cancel";
}
