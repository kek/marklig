//! Wire-format conversion from `SourceDiagnostic` to a JSON-shaped
//! `Diag` the frontend can attach to gutter marks.
//!
//! `Source::lines()` carries the byte → (line, column) conversion. We
//! translate every diagnostic relative to the *entry* source; cross-file
//! diagnostics keep `range = {0,0,0,0}` and surface their file path in `file`
//! (Phase D's editor decorator only consumes entry-file diags for v1).

use ::typst::diag::{Severity as TypstSev, SourceDiagnostic};
use ::typst::ecow::EcoVec;
use ::typst::syntax::Source;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Serialize, Clone, Debug)]
pub struct Diag {
    /// "error" or "warning".
    pub severity: &'static str,
    pub message: String,
    pub range: Range,
    pub file: Option<String>,
}

pub fn to_wire(diags: &EcoVec<SourceDiagnostic>, main: &Source) -> Vec<Diag> {
    diags.iter().map(|d| to_one(d, main)).collect()
}

fn to_one(d: &SourceDiagnostic, main: &Source) -> Diag {
    let severity = match d.severity {
        TypstSev::Error => "error",
        TypstSev::Warning => "warning",
    };

    // A span only carries (line, column) information if we can resolve it
    // through the source it points into. We only have the *main* source on
    // hand here, so cross-file spans yield a degenerate zero-range.
    let (range, file) = if let Some(id) = d.span.id() {
        if id == main.id() {
            let r = main.range(d.span).unwrap_or(0..0);
            (
                Range {
                    start: byte_to_pos(main, r.start),
                    end: byte_to_pos(main, r.end),
                },
                None,
            )
        } else {
            (zero_range(), Some(id.vpath().as_rootless_path().display().to_string()))
        }
    } else {
        (zero_range(), None)
    };

    Diag {
        severity,
        message: d.message.to_string(),
        range,
        file,
    }
}

fn byte_to_pos(source: &Source, byte: usize) -> Position {
    let lines = source.lines();
    let line = lines.byte_to_line(byte).unwrap_or(0) as u32;
    let column = lines.byte_to_column(byte).unwrap_or(0) as u32;
    Position { line, column }
}

fn zero_range() -> Range {
    Range {
        start: Position { line: 0, column: 0 },
        end: Position { line: 0, column: 0 },
    }
}
