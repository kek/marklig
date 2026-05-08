import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
// @ts-expect-error -- no type declarations
import taskLists from "markdown-it-task-lists";
// @ts-expect-error -- no type declarations
import footnote from "markdown-it-footnote";
// @ts-expect-error -- no type declarations
import deflist from "markdown-it-deflist";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
})
  .use(taskLists, { enabled: false, label: false })
  .use(footnote)
  .use(deflist);

export type MdToken = Token;

export function parseMarkdown(source: string): MdToken[] {
  if (source.length === 0) return [];
  return md.parse(source, {});
}

export function renderHtml(source: string): string {
  return md.render(source);
}
