// Inline fuzzy matcher for the Cmd-P file palette. Scores a candidate string
// by whether the query's characters appear in order, boosting:
//   - contiguous runs (cluster of matched chars next to each other),
//   - matches that start at the candidate's basename (after the last
//     path separator) — VS Code-style quick-open prioritises filename hits.
//
// No dependency on the codebase's filesystem helpers; works on plain strings
// so unit tests can exercise the edge cases without touching disk.

export interface FuzzyMatch {
  score: number;
  /** Indices into `candidate` of the matched characters, ascending. Empty
   * when query is empty (matches all). */
  positions: number[];
}

/** Score a candidate against a query. Returns null when at least one query
 * character can't be matched in order. An empty query matches everything
 * with score 0 and no highlight positions. Case-insensitive. */
export function scoreMatch(candidate: string, query: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (candidate.length === 0) return null;

  const cand = candidate.toLowerCase();
  const q = query.toLowerCase();
  // Greedy left-to-right scan. Adequate for short relative paths; a full
  // dynamic-programming "best" match isn't worth the cost here.
  const positions: number[] = [];
  let qi = 0;
  for (let i = 0; i < cand.length && qi < q.length; i++) {
    if (cand[i] === q[qi]) {
      positions.push(i);
      qi++;
    }
  }
  if (qi < q.length) return null;

  // Score model:
  //   +10 per matched char (base)
  //   +8 extra per contiguous-run continuation
  //   +20 if first matched char is the start of the basename
  //   +5 if first matched char is index 0 of the whole candidate
  //   -1 per "gap" position before the first match (penalises matches deep
  //      in the middle of long paths)
  const basenameStart = lastSeparator(candidate) + 1;

  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    score += 10;
    if (k > 0 && positions[k] === positions[k - 1] + 1) score += 8;
  }
  if (positions[0] === basenameStart) score += 20;
  if (positions[0] === 0) score += 5;
  score -= Math.min(positions[0], 20);

  return { score, positions };
}

/** Index after the last `/` or `\` in `s`, or -1 (so callers can do
 * `lastSeparator(s) + 1` to get the basename start). */
function lastSeparator(s: string): number {
  let idx = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 47 /* / */ || c === 92 /* \\ */) idx = i;
  }
  return idx;
}

/** Build DOM nodes that visually highlight the matched positions inside
 * `text`. Returns an array of Node (Text + <span class="viewer-fuzzy-match">)
 * suitable for `append()` — no innerHTML. Positions must be sorted ascending
 * and within `text`'s bounds (the scorer guarantees this). */
export function buildHighlightedSpans(
  text: string,
  positions: number[],
): Node[] {
  const nodes: Node[] = [];
  if (positions.length === 0) {
    nodes.push(document.createTextNode(text));
    return nodes;
  }
  let cursor = 0;
  let i = 0;
  while (i < positions.length) {
    // Collapse a contiguous run of matched indices into a single highlight
    // span — saves DOM and reads better when several chars hit in a row.
    let runEnd = i;
    while (
      runEnd + 1 < positions.length &&
      positions[runEnd + 1] === positions[runEnd] + 1
    ) {
      runEnd++;
    }
    const runStart = positions[i];
    const runStop = positions[runEnd] + 1; // exclusive
    if (runStart > cursor) {
      nodes.push(document.createTextNode(text.slice(cursor, runStart)));
    }
    const span = document.createElement("span");
    span.className = "viewer-fuzzy-match";
    span.textContent = text.slice(runStart, runStop);
    nodes.push(span);
    cursor = runStop;
    i = runEnd + 1;
  }
  if (cursor < text.length) {
    nodes.push(document.createTextNode(text.slice(cursor)));
  }
  return nodes;
}
