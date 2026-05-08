import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message } from "@tauri-apps/plugin-dialog";

export interface CloseHandlerOptions {
  isDirty: () => boolean;
  save: () => Promise<void>;
}

/**
 * Wires a close-requested handler that prompts before discarding unsaved changes.
 * Returns an unsubscribe function.
 */
export async function installCloseHandler(opts: CloseHandlerOptions): Promise<() => void> {
  const win = getCurrentWindow();
  const stop = await win.onCloseRequested(async (event) => {
    if (!opts.isDirty()) return;
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
