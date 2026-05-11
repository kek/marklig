import { Decoration, WidgetType } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";
import { computeLineStarts } from "./index";
import { sanitizeSvg } from "../../export/sanitize";

interface GraphvizEntry {
  status: "ok" | "error";
  /** Rendered SVG markup, or the error message. */
  payload: string;
}

class GraphvizCache {
  private map = new Map<string, GraphvizEntry>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();

  get(source: string): GraphvizEntry | undefined {
    return this.map.get(source);
  }

  set(source: string, entry: GraphvizEntry): void {
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
    void renderGraphviz(source).then((entry) => {
      this.inflight.delete(source);
      this.set(source, entry);
    });
  }
}

async function renderGraphviz(source: string): Promise<GraphvizEntry> {
  try {
    // Dynamic import keeps the wasm bundle in its own chunk; nothing pays the
    // cost until a doc actually contains a graphviz fence.
    const mod = await import("@viz-js/viz");
    const viz = await mod.instance();
    const svg = viz.renderString(source, { format: "svg" });
    return { status: "ok", payload: svg };
  } catch (err) {
    return { status: "error", payload: String(err instanceof Error ? err.message : err) };
  }
}

export const graphvizCache = new GraphvizCache();

/** State effect dispatched when a graphviz render lands in the cache. */
export const graphvizCacheEffect = StateEffect.define<void>();

class GraphvizWidget extends WidgetType {
  readonly entry: GraphvizEntry | undefined;
  constructor(readonly source: string) {
    super();
    // Mirror MermaidWidget: capture the cache state at construction time so
    // widget equality distinguishes a loading widget from a loaded-result
    // widget for the same source. Without this CM6's eq check would return
    // true on cache fill and the "Rendering…" DOM would stay on screen.
    this.entry = graphvizCache.get(source);
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-graphviz";
    const entry = this.entry;
    if (!entry) {
      wrap.classList.add("cm-md-graphviz-loading");
      wrap.textContent = "Rendering diagram…";
      graphvizCache.request(this.source);
      return wrap;
    }
    if (entry.status === "ok") {
      // Graphviz can emit foreignObject-wrapped HTML labels (the `<<table>…>`
      // syntax). Run through sanitizeSvg, which keeps SVG + HTML profiles.
      wrap.innerHTML = sanitizeSvg(entry.payload);
    } else {
      wrap.classList.add("cm-md-graphviz-error");
      const msg = document.createElement("div");
      msg.className = "cm-md-graphviz-error-message";
      msg.textContent = entry.payload;
      const pre = document.createElement("pre");
      pre.className = "cm-md-graphviz-source";
      pre.textContent = this.source;
      wrap.append(msg, pre);
    }
    return wrap;
  }
  override eq(other: GraphvizWidget): boolean {
    return other.source === this.source && other.entry === this.entry;
  }
}

/** Fence info strings that should be rendered with Graphviz. The DOT language
 * is what `digraph`/`graph` blocks are written in; both `dot` and `graphviz`
 * are conventional fence tags. */
const GRAPHVIZ_LANGS = new Set(["dot", "graphviz"]);

export const graphvizProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "fence" || !t.map) continue;
    const lang = (t.info || "").trim().toLowerCase();
    if (!GRAPHVIZ_LANGS.has(lang)) continue;

    const blockStart = lineStarts[t.map[0]];
    const blockEnd = lineStarts[t.map[1]] ?? source.length;
    ranges.push(
      Decoration.replace({ widget: new GraphvizWidget(t.content), block: true })
        .range(blockStart, blockEnd),
    );
  }

  return Decoration.set(ranges, true);
};
