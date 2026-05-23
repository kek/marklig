import { StreamLanguage, LanguageSupport } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

interface TypstState {
  inString: false | '"' | "'";
  inBlockComment: boolean;
}

// Minimal Typst lexer for v1 source highlighting. Recognises:
//   - // line comments and /* block comments */
//   - "double-quoted" strings (with \-escapes)
//   - keywords prefixed with `#` (e.g. #let, #set, #show, #import, #if, ...)
//   - generic #identifier references
//   - @namespace/name package references
//   - = / == / === headings at line start
//   - *bold* and _emph_ inline runs
//   - integer / decimal numbers
//
// All other characters fall through with no token, which leaves them
// rendered with the default theme color. This is intentionally simple —
// Phase F may swap in a richer Lezer grammar later.
const typstStreamLanguage = StreamLanguage.define<TypstState>({
  name: "typst",
  startState: () => ({ inString: false, inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match(/^.*?\*\//)) {
        state.inBlockComment = false;
        return "comment";
      }
      stream.skipToEnd();
      return "comment";
    }
    if (state.inString) {
      if (stream.match(/^\\./)) return "string";
      const quote = state.inString;
      if (stream.match(quote)) {
        state.inString = false;
        return "string";
      }
      stream.next();
      return "string";
    }
    if (stream.match(/^\/\*/)) {
      state.inBlockComment = true;
      return "comment";
    }
    if (stream.match(/^\/\/.*/)) return "comment";
    if (stream.match(/^"/)) {
      state.inString = '"';
      return "string";
    }
    if (
      stream.match(
        /^#(let|set|show|import|include|if|else|while|for|return|break|continue|in|none|auto|true|false)\b/,
      )
    ) {
      return "keyword";
    }
    if (stream.match(/^#[a-zA-Z_][a-zA-Z0-9_-]*/)) return "variableName";
    if (stream.match(/^@[a-zA-Z_][a-zA-Z0-9_/.-]*/)) return "string";
    if (stream.sol() && stream.match(/^=+\s/)) return "heading";
    if (stream.match(/^\*[^*\n]+\*/)) return "strong";
    if (stream.match(/^_[^_\n]+_/)) return "emphasis";
    if (stream.match(/^[0-9]+(\.[0-9]+)?/)) return "number";
    stream.next();
    return null;
  },
  tokenTable: {
    keyword: t.keyword,
    string: t.string,
    comment: t.comment,
    variableName: t.variableName,
    number: t.number,
    heading: t.heading,
    strong: t.strong,
    emphasis: t.emphasis,
  },
});

export function typstLanguageExtension(): LanguageSupport {
  return new LanguageSupport(typstStreamLanguage);
}
