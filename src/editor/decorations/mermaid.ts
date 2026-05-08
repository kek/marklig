import { Decoration, WidgetType } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import { sanitizeSvg } from "../../export/sanitize";

interface MermaidEntry {
  status: "ok" | "error";
  /** Rendered SVG markup, or the error message. */
  payload: string;
}

class MermaidCache {
  private map = new Map<string, MermaidEntry>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();

  get(source: string): MermaidEntry | undefined {
    return this.map.get(source);
  }

  set(source: string, entry: MermaidEntry): void {
    this.map.set(source, entry);
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  request(source: string): void {
    if (this.map.has(source) || this.inflight.has(source)) return;
    this.inflight.add(source);
    void renderMermaid(source).then((entry) => {
      this.inflight.delete(source);
      this.set(source, entry);
    });
  }
}

let idSeq = 0;

async function renderMermaid(source: string): Promise<MermaidEntry> {
  try {
    const mod = await import("mermaid");
    const mermaid = mod.default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    const id = `mermaid-${++idSeq}`;
    const { svg } = await mermaid.render(id, source);
    return { status: "ok", payload: svg };
  } catch (err) {
    return { status: "error", payload: String(err instanceof Error ? err.message : err) };
  }
}

export const mermaidCache = new MermaidCache();

/** State effect dispatched when a mermaid render lands in the cache. */
export const mermaidCacheEffect = StateEffect.define<void>();

class MermaidWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-mermaid";
    const entry = mermaidCache.get(this.source);
    if (!entry) {
      wrap.classList.add("cm-md-mermaid-loading");
      wrap.textContent = "Rendering diagram…";
      mermaidCache.request(this.source);
      return wrap;
    }
    if (entry.status === "ok") {
      wrap.innerHTML = sanitizeSvg(entry.payload);
    } else {
      wrap.classList.add("cm-md-mermaid-error");
      const msg = document.createElement("div");
      msg.className = "cm-md-mermaid-error-message";
      msg.textContent = entry.payload;
      const pre = document.createElement("pre");
      pre.className = "cm-md-mermaid-source";
      pre.textContent = this.source;
      wrap.append(msg, pre);
    }
    return wrap;
  }
  override eq(other: MermaidWidget): boolean { return other.source === this.source; }
}

export const mermaidProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const lang = (t.info || "").trim().toLowerCase();
    if (lang !== "mermaid") continue;

    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    ranges.push(
      Decoration.replace({ widget: new MermaidWidget(t.content), block: true })
        .range(blockStart, blockEnd),
    );
  }

  return Decoration.set(ranges, true);
};
