import { invoke } from "@tauri-apps/api/core";

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  /** Null when the diagnostic refers to the entry file; non-null for
   * diagnostics in imports / sibling files. v1 only surfaces entry-file
   * diagnostics in the editor. */
  file: string | null;
}

export interface CompileResult {
  pages: string[];
  diagnostics: Diagnostic[];
  elapsed_ms: number;
  /** Absolute paths of every local file this compile read — the entry file
   * plus its imports, transitively, plus `read()` / `image()` assets. Watch
   * these to know when the render has gone stale. Package files are excluded.
   * Collected from what the compiler actually resolved, not by parsing import
   * statements, so a file the entry document never names is still in here. */
  dependencies: string[];
}

export interface TypstDriver {
  /** Open (or re-open) a session backed by `path` as the entry file.
   *  If the driver already holds a session it is closed first. */
  open(path: string): Promise<void>;
  /** Compile `source` against the current session and return pages + diagnostics.
   *  Rejects if no session is open. */
  compile(source: string): Promise<CompileResult>;
  /** Close the underlying session. No-op if already closed. */
  close(): Promise<void>;
  /** Returns the active session id, or null if closed. */
  sessionId(): string | null;
}

export function createTypstDriver(): TypstDriver {
  let sessionId: string | null = null;
  return {
    async open(path: string): Promise<void> {
      if (sessionId !== null) {
        const prev = sessionId;
        sessionId = null;
        try {
          await invoke("typst_close", { sessionId: prev });
        } catch {
          // Best-effort — even if close fails the session is logically gone.
        }
      }
      sessionId = await invoke<string>("typst_open", { path });
    },
    async compile(source: string): Promise<CompileResult> {
      if (sessionId === null) throw new Error("no session");
      return await invoke<CompileResult>("typst_compile", { sessionId, source });
    },
    async close(): Promise<void> {
      if (sessionId === null) return;
      const id = sessionId;
      sessionId = null;
      try {
        await invoke("typst_close", { sessionId: id });
      } catch {
        // Already gone on the Rust side — fine.
      }
    },
    sessionId() {
      return sessionId;
    },
  };
}
