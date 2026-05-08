// Inlined export stylesheet — a self-contained reading-mode rendering that
// doesn't depend on CodeMirror or any of the source-side decoration classes.
// Mirrors the typography and palette of the in-app reading mode but targets
// the simpler tag-and-class output that markdown-it emits.

export function exportStylesheet(): string {
  return `
:root {
  --bg: #fdfdfa; --fg: #1a1a1a; --muted: #888;
  --rule: #e5e2d8; --code-bg: #efece4;
  --link: #2c5d8a; --accent: #b03060;
  --serif: "Iowan Old Style", "Charter", Georgia, serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15161a; --fg: #e6e3da; --muted: #888;
    --rule: #2a2c33; --code-bg: #20232b;
    --link: #7fb3e8; --accent: #f08bb6;
  }
}
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
body {
  font-family: var(--serif); font-size: 16px; line-height: 1.65;
  max-width: 720px; margin: 0 auto; padding: 32px 48px;
}
h1, h2, h3, h4, h5, h6 { font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 28px; line-height: 1.3;  margin: 18px 0 8px; }
h2 { font-size: 22px; line-height: 1.3;  margin: 16px 0 6px; }
h3 { font-size: 18px; line-height: 1.35; margin: 14px 0 6px; }
h4 { font-size: 16px; line-height: 1.4;  margin: 12px 0 4px; }
h5 { font-size: 15px; line-height: 1.4;  color: var(--muted); }
h6 { font-size: 14px; line-height: 1.4;  color: var(--muted); }
p, ul, ol, blockquote, pre, table { margin: 12px 0; }
a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
strong { font-weight: 700; }
em { font-style: italic; }
code {
  font-family: var(--mono); font-size: 0.9em;
  background: var(--code-bg); padding: 1px 5px; border-radius: 3px;
}
pre {
  font-family: var(--mono); font-size: 0.9em;
  background: var(--code-bg); padding: 12px 14px; border-radius: 4px;
  overflow-x: auto;
}
pre code { background: transparent; padding: 0; }
blockquote {
  border-left: 3px solid var(--rule); padding-left: 12px;
  color: var(--muted); font-style: italic;
}
table { border-collapse: collapse; }
th, td { border-bottom: 1px solid var(--rule); padding: 6px 12px; text-align: left; }
th { font-weight: 700; }
tbody tr:nth-child(even) { background: rgba(0,0,0,0.025); }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid var(--rule); margin: 24px 0; }
.katex-display { margin: 14px 0; text-align: center; overflow-x: auto; }
@media print {
  body { max-width: none; padding: 0; background: #fff; color: #000; }
  a { color: inherit; text-decoration: underline; }
  pre, code, blockquote { page-break-inside: avoid; }
  h1, h2, h3 { page-break-after: avoid; }
}
`;
}
