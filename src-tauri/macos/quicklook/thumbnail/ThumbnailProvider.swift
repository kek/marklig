// Quick Look thumbnail provider for .md files.
//
// Renders a stylised "MD" badge with the document's first heading (if any)
// peeking out below it. The badge intentionally matches Viewer's reading
// palette so a folder of markdown files reads as a coherent set in Finder.

import Cocoa
import QuickLookThumbnailing

final class ThumbnailProvider: QLThumbnailProvider {

    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        let size = request.maximumSize
        let scale = request.scale

        // Try to extract a first heading or first non-empty line for flavour.
        let snippet = (try? extractSnippet(at: request.fileURL)) ?? ""

        let reply = QLThumbnailReply(contextSize: size) { [snippet] context in
            ThumbnailProvider.draw(in: context, size: size, snippet: snippet)
            return true
        }
        _ = scale  // intentionally unused — QLThumbnailReply handles scaling.
        handler(reply, nil)
    }

    private func extractSnippet(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: 4096) ?? Data()
        let s = String(data: data, encoding: .utf8) ?? ""
        for raw in s.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            // Strip leading ATX hashes for a cleaner badge subtitle.
            var stripped = Substring(line)
            while stripped.first == "#" { stripped = stripped.dropFirst() }
            return String(stripped).trimmingCharacters(in: .whitespaces)
        }
        return ""
    }

    private static func draw(in ctx: CGContext, size: CGSize, snippet: String) {
        // Thumbnails render against Finder's chrome at all times of day —
        // keep the page palette light so it reads well in either appearance.
        let bg = CGColor(red: 0.992, green: 0.992, blue: 0.980, alpha: 1)
        let fg = CGColor(red: 0.102, green: 0.102, blue: 0.102, alpha: 1)
        let accent = CGColor(red: 0.690, green: 0.188, blue: 0.376, alpha: 1) // --accent

        // Page background.
        ctx.setFillColor(bg)
        ctx.fill(CGRect(origin: .zero, size: size))

        // Subtle drop-shadow page outline.
        ctx.setStrokeColor(CGColor(red: 0.85, green: 0.83, blue: 0.78, alpha: 1))
        ctx.setLineWidth(max(1, size.width / 128))
        ctx.stroke(CGRect(x: 0.5, y: 0.5, width: size.width - 1, height: size.height - 1))

        // "MD" badge in top-left corner.
        let badgeSide = min(size.width, size.height) * 0.42
        let badgeRect = CGRect(
            x: size.width * 0.08,
            y: size.height - badgeSide - size.width * 0.08,
            width: badgeSide,
            height: badgeSide * 0.72
        )
        ctx.setFillColor(accent)
        let badgePath = CGPath(
            roundedRect: badgeRect,
            cornerWidth: badgeSide * 0.08,
            cornerHeight: badgeSide * 0.08,
            transform: nil
        )
        ctx.addPath(badgePath)
        ctx.fillPath()

        // Centre "MD" text inside the badge.
        let badgeFontSize = badgeRect.height * 0.55
        let badgeAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: badgeFontSize, weight: .bold),
            .foregroundColor: NSColor.white,
            .kern: badgeFontSize * 0.05,
        ]
        let badgeStr = NSAttributedString(string: "MD", attributes: badgeAttrs)
        let badgeStrSize = badgeStr.size()
        let badgeTextOrigin = CGPoint(
            x: badgeRect.midX - badgeStrSize.width / 2,
            y: badgeRect.midY - badgeStrSize.height / 2
        )
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        badgeStr.draw(at: badgeTextOrigin)
        NSGraphicsContext.restoreGraphicsState()

        // Snippet (first heading) in serif below the badge.
        let snippetMaxWidth = size.width * 0.84
        let snippetFontSize = max(8, size.height * 0.055)
        let serif = NSFont(name: "Iowan Old Style", size: snippetFontSize)
            ?? NSFont(name: "Charter", size: snippetFontSize)
            ?? NSFont(name: "Georgia", size: snippetFontSize)
            ?? NSFont.systemFont(ofSize: snippetFontSize)
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byTruncatingTail
        para.maximumLineHeight = snippetFontSize * 1.35
        para.alignment = .left
        let snippetAttrs: [NSAttributedString.Key: Any] = [
            .font: serif,
            .foregroundColor: NSColor(cgColor: fg) ?? .labelColor,
            .paragraphStyle: para,
        ]
        let trimmed = snippet.isEmpty ? "Markdown" : snippet
        let snippetStr = NSAttributedString(string: trimmed, attributes: snippetAttrs)
        let snippetRect = CGRect(
            x: size.width * 0.08,
            y: badgeRect.minY - snippetFontSize * 2.4,
            width: snippetMaxWidth,
            height: snippetFontSize * 2.0
        )
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        snippetStr.draw(with: snippetRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        NSGraphicsContext.restoreGraphicsState()

        // A few faint horizontal "lines of text" hinting at body content.
        ctx.setFillColor(CGColor(red: 0.85, green: 0.83, blue: 0.78, alpha: 1))
        let lineHeight = max(1, size.height * 0.018)
        let lineGap = lineHeight * 2.4
        var y = snippetRect.minY - lineGap
        let lineWidths: [CGFloat] = [0.7, 0.85, 0.6, 0.78, 0.5]
        for w in lineWidths {
            if y < size.height * 0.06 { break }
            let r = CGRect(
                x: size.width * 0.08,
                y: y,
                width: snippetMaxWidth * w,
                height: lineHeight
            )
            ctx.fill(r)
            y -= lineGap
        }
    }
}
