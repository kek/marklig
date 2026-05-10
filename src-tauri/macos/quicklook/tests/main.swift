// Swift smoke test for MarkdownRenderer. Runs a handful of fixtures through
// the renderer and asserts the output contains the expected tags / escaped
// characters. Exits 0 on success and prints a diff on failure.
//
// Run:
//   scripts/test-quicklook.sh

import Foundation

func expect(_ html: String, contains needle: String, file: StaticString = #file, line: UInt = #line) {
    if !html.contains(needle) {
        print("FAIL: expected output to contain `\(needle)`")
        print("--- output ---")
        print(html)
        print("--- end ---")
        exit(1)
    }
}

func expect(_ html: String, notContains needle: String, file: StaticString = #file, line: UInt = #line) {
    if html.contains(needle) {
        print("FAIL: expected output NOT to contain `\(needle)`")
        print("--- output ---")
        print(html)
        print("--- end ---")
        exit(1)
    }
}

// 1) Headings, bold, italic, inline code, links.
let h = MarkdownRenderer.renderToHTML("""
# Title

A paragraph with **bold**, *italic*, and `code`. See [Apple](https://apple.com).
""")
expect(h, contains: "<h1>Title</h1>")
expect(h, contains: "<strong>bold</strong>")
expect(h, contains: "<em>italic</em>")
expect(h, contains: "<code>code</code>")
expect(h, contains: "<a href=\"https://apple.com\">Apple</a>")

// 2) Fenced code block — content must be escaped, language class set.
let code = MarkdownRenderer.renderToHTML("""
```swift
let x = "<script>"
```
""")
expect(code, contains: "<pre><code class=\"language-swift\">")
expect(code, contains: "&lt;script&gt;")
expect(code, notContains: "<script>")

// 3) Lists — unordered.
let ul = MarkdownRenderer.renderToHTML("""
- one
- two
- three
""")
expect(ul, contains: "<ul>")
expect(ul, contains: "<li>one</li>")
expect(ul, contains: "<li>three</li>")

// 4) Lists — ordered.
let ol = MarkdownRenderer.renderToHTML("""
1. first
2. second
""")
expect(ol, contains: "<ol>")
expect(ol, contains: "<li>first</li>")

// 5) GFM table.
let table = MarkdownRenderer.renderToHTML("""
| A | B |
|---|---|
| 1 | 2 |
""")
expect(table, contains: "<table>")
expect(table, contains: "<th>A</th>")
expect(table, contains: "<td>1</td>")

// 6) Blockquote.
let bq = MarkdownRenderer.renderToHTML("""
> a quote
> with two lines
""")
expect(bq, contains: "<blockquote>")
expect(bq, contains: "a quote")

// 7) Horizontal rule.
let hr = MarkdownRenderer.renderToHTML("""
foo

---

bar
""")
expect(hr, contains: "<hr>")

// 8) Sanitisation — no JS-ish links, no raw HTML.
let evil = MarkdownRenderer.renderToHTML("""
[click](javascript:alert(1))

<script>alert(2)</script>

<img src=x onerror=alert(3)>
""")
expect(evil, contains: "href=\"#\"")            // javascript: collapsed
expect(evil, notContains: "<script>")           // raw script tag escaped
expect(evil, notContains: "<img src=x")        // raw img tag escaped
expect(evil, contains: "&lt;img src=x onerror=alert(3)&gt;") // shown as literal text

// 9) Image with relative path stays.
let img = MarkdownRenderer.renderToHTML("![alt](./pic.png)")
expect(img, contains: "<img src=\"./pic.png\" alt=\"alt\">")

// 10) Setext headings.
let setext = MarkdownRenderer.renderToHTML("""
Big Title
=========

Subtitle
--------
""")
expect(setext, contains: "<h1>Big Title</h1>")
expect(setext, contains: "<h2>Subtitle</h2>")

print("OK: all renderer fixtures passed.")
