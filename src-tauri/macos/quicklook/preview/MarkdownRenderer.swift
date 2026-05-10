// A focused Markdown→HTML renderer for the Quick Look preview.
//
// Why hand-rolled? The Quick Look extension is a sandboxed .appex with a
// hand-built bundle layout (no SwiftPM, no Xcode workspace), so pulling in
// swift-markdown / Down / cmark would require a much heavier build pipeline.
// What we render in Quick Look only needs to look right for first-glance
// reading: ATX headings, paragraphs, GFM tables, fenced code, inline emphasis,
// links, ordered/unordered lists, blockquotes, horizontal rules. Math /
// Mermaid are intentionally deferred (REQUIREMENTS §11) and rendered as
// fenced source.
//
// SAFETY: every user-supplied string is HTML-escaped; we never emit raw HTML
// from the source document. Link URLs are filtered to a safe scheme allowlist
// (http, https, mailto, tel, plus relative paths). This satisfies the
// "sanitize any HTML rendered into a WKWebView" requirement without bringing
// in DOMPurify on the Swift side — escape-on-emit is strictly stronger than
// allowlist-after-the-fact for a renderer we control end-to-end.

import Foundation

enum MarkdownRenderer {

    static func renderToHTML(_ source: String) -> String {
        let body = renderBody(source)
        let title = "Markdown preview"
        return """
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(htmlEscape(title))</title>
        <style>\(Stylesheet.css)</style>
        </head>
        <body>
        \(body)
        </body>
        </html>
        """
    }

    // MARK: - Block rendering

    private static func renderBody(_ source: String) -> String {
        // Normalise line endings.
        let normalised = source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalised.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        var out = ""
        var i = 0
        while i < lines.count {
            let line = lines[i]

            // Fenced code block: ``` or ~~~
            if let fence = fenceMatch(line) {
                let lang = fence.lang
                var collected: [String] = []
                i += 1
                while i < lines.count {
                    if let close = fenceMatch(lines[i]),
                       close.marker == fence.marker,
                       close.length >= fence.length,
                       close.lang.isEmpty {
                        i += 1
                        break
                    }
                    collected.append(lines[i])
                    i += 1
                }
                let code = collected.joined(separator: "\n")
                let langClass = lang.isEmpty ? "" : " class=\"language-\(htmlEscape(lang))\""
                _ = lang  // silence unused-mutation warning when lang.isEmpty
                out += "<pre><code\(langClass)>\(htmlEscape(code))</code></pre>\n"
                continue
            }

            // Blank line.
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                i += 1
                continue
            }

            // ATX heading.
            if let heading = atxHeading(line) {
                out += "<h\(heading.level)>\(renderInline(heading.text))</h\(heading.level)>\n"
                i += 1
                continue
            }

            // Horizontal rule (--- *** ___).
            if isHorizontalRule(line) {
                out += "<hr>\n"
                i += 1
                continue
            }

            // Blockquote: collect consecutive lines starting with `> `.
            if line.hasPrefix(">") {
                var quoted: [String] = []
                while i < lines.count, lines[i].hasPrefix(">") {
                    var inner = String(lines[i].dropFirst())
                    if inner.hasPrefix(" ") { inner.removeFirst() }
                    quoted.append(inner)
                    i += 1
                }
                let inner = renderBody(quoted.joined(separator: "\n"))
                out += "<blockquote>\n\(inner)</blockquote>\n"
                continue
            }

            // GFM table: header line + separator line, then body rows.
            if isTableHeader(lines, at: i) {
                let (html, consumed) = renderTable(lines, startingAt: i)
                out += html
                i += consumed
                continue
            }

            // Lists (ordered or unordered): collect contiguous list lines.
            if let kind = listMarker(line) {
                let (html, consumed) = renderList(lines, startingAt: i, kind: kind)
                out += html
                i += consumed
                continue
            }

            // Setext H1/H2: line followed by === / ---
            if i + 1 < lines.count {
                let next = lines[i + 1]
                if isSetextUnderline(next, char: "=") {
                    out += "<h1>\(renderInline(line))</h1>\n"
                    i += 2
                    continue
                }
                if isSetextUnderline(next, char: "-") {
                    out += "<h2>\(renderInline(line))</h2>\n"
                    i += 2
                    continue
                }
            }

            // Paragraph: gather until blank line / new block.
            var paragraph: [String] = [line]
            i += 1
            while i < lines.count {
                let l = lines[i]
                if l.trimmingCharacters(in: .whitespaces).isEmpty { break }
                if atxHeading(l) != nil || fenceMatch(l) != nil
                    || isHorizontalRule(l) || l.hasPrefix(">")
                    || listMarker(l) != nil || isTableHeader(lines, at: i) {
                    break
                }
                paragraph.append(l)
                i += 1
            }
            out += "<p>\(renderInline(paragraph.joined(separator: "\n")))</p>\n"
        }
        return out
    }

    // MARK: - Block helpers

    private struct Fence { let marker: Character; let length: Int; let lang: String }

    private static func fenceMatch(_ line: String) -> Fence? {
        let trimmed = line.drop(while: { $0 == " " })
        guard let first = trimmed.first, first == "`" || first == "~" else { return nil }
        var count = 0
        var idx = trimmed.startIndex
        while idx < trimmed.endIndex && trimmed[idx] == first {
            count += 1
            idx = trimmed.index(after: idx)
        }
        guard count >= 3 else { return nil }
        let lang = trimmed[idx...].trimmingCharacters(in: .whitespaces)
        return Fence(marker: first, length: count, lang: lang)
    }

    private struct Heading { let level: Int; let text: String }

    private static func atxHeading(_ line: String) -> Heading? {
        let trimmed = line.drop(while: { $0 == " " })
        var level = 0
        var idx = trimmed.startIndex
        while idx < trimmed.endIndex && trimmed[idx] == "#" && level < 6 {
            level += 1
            idx = trimmed.index(after: idx)
        }
        guard level >= 1, level <= 6 else { return nil }
        guard idx == trimmed.endIndex || trimmed[idx] == " " else { return nil }
        let rest = trimmed[idx...].trimmingCharacters(in: .whitespaces)
        // Strip optional trailing #s.
        var text = rest
        while text.hasSuffix("#") { text.removeLast() }
        return Heading(level: level, text: text.trimmingCharacters(in: .whitespaces))
    }

    private static func isHorizontalRule(_ line: String) -> Bool {
        let stripped = line.replacingOccurrences(of: " ", with: "")
        guard stripped.count >= 3 else { return false }
        return stripped.allSatisfy { $0 == "-" } ||
               stripped.allSatisfy { $0 == "*" } ||
               stripped.allSatisfy { $0 == "_" }
    }

    private static func isSetextUnderline(_ line: String, char: Character) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count >= 2 && trimmed.allSatisfy { $0 == char }
    }

    private enum ListKind { case unordered; case ordered }

    private static func listMarker(_ line: String) -> ListKind? {
        let trimmed = line.drop(while: { $0 == " " })
        guard let first = trimmed.first else { return nil }
        if first == "-" || first == "*" || first == "+" {
            let next = trimmed.index(after: trimmed.startIndex)
            if next < trimmed.endIndex && trimmed[next] == " " { return .unordered }
        }
        // Ordered list: digits followed by `. ` or `) `.
        var idx = trimmed.startIndex
        var hasDigit = false
        while idx < trimmed.endIndex && trimmed[idx].isASCII && trimmed[idx].isNumber {
            hasDigit = true
            idx = trimmed.index(after: idx)
        }
        if hasDigit && idx < trimmed.endIndex {
            let mark = trimmed[idx]
            let after = trimmed.index(after: idx)
            if (mark == "." || mark == ")") && after < trimmed.endIndex && trimmed[after] == " " {
                return .ordered
            }
        }
        return nil
    }

    private static func renderList(_ lines: [String], startingAt start: Int, kind: ListKind) -> (String, Int) {
        var i = start
        var items: [String] = []
        var current: [String] = []

        while i < lines.count {
            let line = lines[i]
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                // Blank line breaks loose item; continue if next line is another item or indented continuation.
                if i + 1 < lines.count {
                    let next = lines[i + 1]
                    if listMarker(next) == kind || next.hasPrefix("    ") || next.hasPrefix("\t") {
                        current.append("")
                        i += 1
                        continue
                    }
                }
                break
            }
            if let m = listMarker(line), m == kind {
                if !current.isEmpty {
                    items.append(current.joined(separator: "\n"))
                    current = []
                }
                current.append(stripListMarker(line))
                i += 1
                continue
            }
            // Continuation line: must be indented, OR a paragraph continuation of the current item.
            if !current.isEmpty {
                if line.hasPrefix("    ") {
                    current.append(String(line.dropFirst(4)))
                } else if line.hasPrefix("\t") {
                    current.append(String(line.dropFirst(1)))
                } else {
                    current.append(line)
                }
                i += 1
                continue
            }
            break
        }
        if !current.isEmpty {
            items.append(current.joined(separator: "\n"))
        }

        let tag = kind == .ordered ? "ol" : "ul"
        var out = "<\(tag)>\n"
        for item in items {
            // If the item contains a blank line we treat it as loose and render
            // its body as a block; otherwise render inline.
            if item.contains("\n\n") {
                out += "<li>\(renderBody(item))</li>\n"
            } else {
                out += "<li>\(renderInline(item))</li>\n"
            }
        }
        out += "</\(tag)>\n"
        return (out, i - start)
    }

    private static func stripListMarker(_ line: String) -> String {
        var s = Substring(line)
        while s.first == " " { s = s.dropFirst() }
        if let first = s.first, first == "-" || first == "*" || first == "+" {
            s = s.dropFirst()
            if s.first == " " { s = s.dropFirst() }
            return String(s)
        }
        // Ordered list digits.
        while s.first?.isNumber == true { s = s.dropFirst() }
        if s.first == "." || s.first == ")" { s = s.dropFirst() }
        if s.first == " " { s = s.dropFirst() }
        return String(s)
    }

    // MARK: - GFM tables

    private static func isTableHeader(_ lines: [String], at i: Int) -> Bool {
        guard i + 1 < lines.count else { return false }
        let header = lines[i]
        let sep = lines[i + 1]
        guard header.contains("|") && sep.contains("|") else { return false }
        // Separator must be made of `-`, `:`, `|`, and spaces, with at least one `-`.
        let allowed = Set<Character>("-:| \t".map { $0 })
        guard sep.allSatisfy({ allowed.contains($0) }) && sep.contains("-") else { return false }
        return true
    }

    private static func renderTable(_ lines: [String], startingAt start: Int) -> (String, Int) {
        let headerCells = splitTableRow(lines[start])
        let aligns = splitTableRow(lines[start + 1]).map { spec -> String in
            let s = spec.trimmingCharacters(in: .whitespaces)
            let l = s.hasPrefix(":")
            let r = s.hasSuffix(":")
            switch (l, r) {
            case (true, true):  return "center"
            case (false, true): return "right"
            case (true, false): return "left"
            default:            return ""
            }
        }
        var i = start + 2
        var rows: [[String]] = []
        while i < lines.count {
            let line = lines[i]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { break }
            if !line.contains("|") { break }
            rows.append(splitTableRow(line))
            i += 1
        }

        var out = "<table>\n<thead>\n<tr>"
        for (idx, cell) in headerCells.enumerated() {
            let align = idx < aligns.count ? aligns[idx] : ""
            let style = align.isEmpty ? "" : " style=\"text-align: \(align)\""
            out += "<th\(style)>\(renderInline(cell.trimmingCharacters(in: .whitespaces)))</th>"
        }
        out += "</tr>\n</thead>\n<tbody>\n"
        for row in rows {
            out += "<tr>"
            for (idx, cell) in row.enumerated() {
                let align = idx < aligns.count ? aligns[idx] : ""
                let style = align.isEmpty ? "" : " style=\"text-align: \(align)\""
                out += "<td\(style)>\(renderInline(cell.trimmingCharacters(in: .whitespaces)))</td>"
            }
            out += "</tr>\n"
        }
        out += "</tbody>\n</table>\n"
        return (out, i - start)
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var trimmed = line
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        // Split on unescaped `|`.
        var cells: [String] = []
        var current = ""
        var iter = trimmed.makeIterator()
        var prev: Character? = nil
        while let c = iter.next() {
            if c == "|" && prev != "\\" {
                cells.append(current)
                current = ""
            } else {
                current.append(c)
            }
            prev = c
        }
        cells.append(current)
        return cells
    }

    // MARK: - Inline rendering

    static func renderInline(_ text: String) -> String {
        // Order matters: code spans first (their content shouldn't be re-parsed),
        // then images, then links, then bold/italic, then autolinks, finally
        // hard breaks. We tokenise into a list of segments where each segment
        // is either "raw" (already-HTML-safe) or "text" (still needs escaping).

        struct Segment { var html: String }
        var segments: [Segment] = []

        // 1) Extract code spans `...`.
        let pieces = splitOnCodeSpans(text)
        var afterCode: [(String, Bool /* isCode */)] = []
        for p in pieces { afterCode.append(p) }

        for (chunk, isCode) in afterCode {
            if isCode {
                segments.append(Segment(html: "<code>\(htmlEscape(chunk))</code>"))
                continue
            }
            // 2) Run inline replacements on non-code chunks.
            segments.append(Segment(html: applyInlineReplacements(chunk)))
        }
        return segments.map(\.html).joined()
    }

    /// Split on backtick code spans. Returns chunks tagged with `isCode`.
    private static func splitOnCodeSpans(_ text: String) -> [(String, Bool)] {
        var out: [(String, Bool)] = []
        var i = text.startIndex
        while i < text.endIndex {
            if text[i] == "`" {
                // Count opening backticks.
                var openCount = 0
                var j = i
                while j < text.endIndex && text[j] == "`" {
                    openCount += 1
                    j = text.index(after: j)
                }
                // Find matching close run of the same length.
                var k = j
                var closeStart: String.Index? = nil
                while k < text.endIndex {
                    if text[k] == "`" {
                        var run = 0
                        var m = k
                        while m < text.endIndex && text[m] == "`" {
                            run += 1
                            m = text.index(after: m)
                        }
                        if run == openCount {
                            closeStart = k
                            break
                        }
                        k = m
                    } else {
                        k = text.index(after: k)
                    }
                }
                if let cs = closeStart {
                    let content = String(text[j..<cs])
                    out.append((content, true))
                    i = text.index(cs, offsetBy: openCount)
                    continue
                } else {
                    // Unmatched: emit as literal.
                    out.append((String(repeating: "`", count: openCount), false))
                    i = j
                    continue
                }
            }
            // Run until next backtick.
            var j = i
            while j < text.endIndex && text[j] != "`" {
                j = text.index(after: j)
            }
            out.append((String(text[i..<j]), false))
            i = j
        }
        return out
    }

    private static func applyInlineReplacements(_ s: String) -> String {
        // Pre-escape the raw input. Anything we then emit during inline
        // replacements (`<a>`, `<strong>`, `<img>`, etc.) is appended to a
        // string whose user-supplied portions can no longer contain `<` /
        // `>` / `&` / `"` — strictly safer than trying to allowlist tags
        // after the fact.
        //
        // Markdown's link, image, emphasis, and code regexes don't depend
        // on `<` / `>`, so they keep working on escaped input. The only
        // construct that does is autolinks (`<https://…>`), and those are
        // matched here against the escaped form `&lt;…&gt;`.
        var t = s
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")

        // Images: ![alt](url). Process before links so the leading `!` doesn't fall through.
        // NB: capture groups already contain HTML-escaped text, so we don't
        // re-escape them — but URLs still go through sanitizeURL to enforce
        // the scheme allowlist.
        t = replaceWithRegex(t, pattern: #"!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)"#) { groups in
            let alt = groups[1]
            let url = sanitizeURL(unescape(groups[2]))
            let title = groups[3].isEmpty ? "" : " title=\"\(groups[3])\""
            return "<img src=\"\(url)\" alt=\"\(alt)\"\(title)>"
        }

        // Links: [text](url "title")
        t = replaceWithRegex(t, pattern: #"\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)"#) { groups in
            // groups[1] is already escaped — apply emphasis but not escaping again.
            let inner = applyEmphasisOnly(groups[1])
            let url = sanitizeURL(unescape(groups[2]))
            let title = groups[3].isEmpty ? "" : " title=\"\(groups[3])\""
            return "<a href=\"\(url)\"\(title)>\(inner)</a>"
        }

        // Emphasis (bold / italic / strike). Same regexes; capture groups are
        // already HTML-escaped so we just wrap them.
        t = applyEmphasisOnly(t)

        // Autolinks: <https://...> — angle brackets are escaped by now.
        t = replaceWithRegex(t, pattern: #"&lt;((?:https?|mailto):[^&\s]+)&gt;"#) { g in
            let url = sanitizeURL(unescape(g[1]))
            return "<a href=\"\(url)\">\(g[1])</a>"
        }

        // Hard line breaks: two trailing spaces + newline → <br>.
        t = t.replacingOccurrences(of: "  \n", with: "<br>\n")

        return t
    }

    /// Emphasis-only pass that assumes input is already HTML-escaped and
    /// just wraps emphasis runs in `<strong>` / `<em>` / `<del>`.
    private static func applyEmphasisOnly(_ input: String) -> String {
        var t = input
        // Bold + italic: ***text***
        t = replaceWithRegex(t, pattern: #"\*\*\*([^\*]+?)\*\*\*"#) { g in
            "<strong><em>\(g[1])</em></strong>"
        }
        // Bold: **text** or __text__
        t = replaceWithRegex(t, pattern: #"\*\*([^\*]+?)\*\*"#) { g in "<strong>\(g[1])</strong>" }
        t = replaceWithRegex(t, pattern: #"__([^_]+?)__"#) { g in "<strong>\(g[1])</strong>" }
        // Italic: *text* or _text_
        t = replaceWithRegex(t, pattern: #"(?<![\*\w])\*([^\*\n]+?)\*(?!\*)"#) { g in "<em>\(g[1])</em>" }
        t = replaceWithRegex(t, pattern: #"(?<![_\w])_([^_\n]+?)_(?!_)"#) { g in "<em>\(g[1])</em>" }
        // Strikethrough: ~~text~~
        t = replaceWithRegex(t, pattern: #"~~([^~]+?)~~"#) { g in "<del>\(g[1])</del>" }
        return t
    }

    /// Reverse of htmlEscape — used when we need to feed an attribute value
    /// (which was escaped during the pre-pass) back to a sanitiser like
    /// sanitizeURL that operates on raw scheme strings.
    private static func unescape(_ s: String) -> String {
        return s
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    /// Regex helper that runs a replacement closure receiving capture groups.
    /// Group 0 is the whole match; missing groups return empty string.
    private static func replaceWithRegex(
        _ input: String,
        pattern: String,
        _ replace: ([String]) -> String
    ) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern, options: []) else {
            return input
        }
        let ns = input as NSString
        var result = ""
        var cursor = 0
        let matches = re.matches(in: input, options: [], range: NSRange(location: 0, length: ns.length))
        for m in matches {
            if m.range.location > cursor {
                result += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            }
            var groups: [String] = []
            for g in 0..<m.numberOfRanges {
                let r = m.range(at: g)
                if r.location == NSNotFound { groups.append("") }
                else { groups.append(ns.substring(with: r)) }
            }
            result += replace(groups)
            cursor = m.range.location + m.range.length
        }
        if cursor < ns.length {
            result += ns.substring(with: NSRange(location: cursor, length: ns.length - cursor))
        }
        return result
    }

    // (Earlier versions of this file had an `escapeStrayAngles` post-pass
    // that allowlisted a known set of emitted tags and escaped everything
    // else. It was replaced by an upfront full-string HTML escape in
    // `applyInlineReplacements`, which is strictly safer.)

    // MARK: - Escaping & URL sanitisation

    static func htmlEscape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for c in s {
            switch c {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(c)
            }
        }
        return out
    }

    /// Restrict link / image URLs to a small allowlist of safe schemes. Anything
    /// else collapses to `#` so a malicious doc can't smuggle `javascript:` URLs
    /// into the WKWebView.
    private static func sanitizeURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return "#" }

        // Relative paths and same-document anchors are always OK.
        if trimmed.hasPrefix("#") || trimmed.hasPrefix("/")
            || trimmed.hasPrefix("./") || trimmed.hasPrefix("../") {
            return htmlEscape(trimmed)
        }

        // No colon? Treat as relative.
        guard let colon = trimmed.firstIndex(of: ":") else {
            return htmlEscape(trimmed)
        }

        let scheme = trimmed[..<colon].lowercased()
        let allowed: Set<String> = ["http", "https", "mailto", "tel"]
        if allowed.contains(scheme) {
            return htmlEscape(trimmed)
        }
        return "#"
    }
}
