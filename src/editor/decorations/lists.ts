import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

import type { DecorationProducer } from "./index";

export const listsProducer: DecorationProducer = ({ source, tokens }) => {
  const ranges: Range<Decoration>[] = [];
  const lineStarts = computeLineStarts(source);
  let listKind: "bullet" | "ordered" | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "bullet_list_open") listKind = "bullet";
    else if (t.type === "ordered_list_open") listKind = "ordered";
    else if (t.type === "bullet_list_close" || t.type === "ordered_list_close")
      listKind = null;
    else if (t.type === "list_item_open" && t.map && listKind) {
      const lineIndex = t.map[0];
      const lineStart = lineStarts[lineIndex];
      const lineEnd = lineStarts[lineIndex + 1] ?? source.length;
      const lineText = source.slice(lineStart, lineEnd);
      const taskMatch = /^\s*[-*+]\s+\[([ xX])\]/.exec(lineText);
      let className = `cm-md-list cm-md-list-${listKind}`;
      if (taskMatch) {
        className = `cm-md-list cm-md-list-task${
          taskMatch[1].toLowerCase() === "x" ? " cm-md-list-task-done" : ""
        }`;
      }
      ranges.push(Decoration.line({ class: className }).range(lineStart));
    }
  }

  return Decoration.set(ranges, true);
};

function computeLineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++)
    if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}
