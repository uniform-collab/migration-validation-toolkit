/**
 * Longest-common-substring WITH POSITIONS.
 *
 * `lib/lcs.mjs` (the scorer) returns only the LENGTH of the LCS, because that is
 * all the score needs: `100 * LCS / max(len)`. The viewer needs the same run's
 * OFFSETS so it can highlight, in both texts, the exact contiguous region the
 * score credited — which is what makes a number like "77.3" legible (the score
 * is a single run, so one early mismatch can cost far more than it looks).
 *
 * Deliberately a separate copy rather than an edit to `lib/lcs.mjs`: that file
 * is the verified scoring path and must keep its exact behaviour.
 *
 * Suffix automaton of `a` (linear), then walk `b` tracking the current match
 * length — same algorithm as the scorer, plus the end offset of the best run.
 */

/** @returns {{length:number, aStart:number, bStart:number}} */
export function lcsSpan(a, b) {
  if (!a || !b) return { length: 0, aStart: -1, bStart: -1 };

  // --- suffix automaton over `a` -------------------------------------------
  const next = [new Map()];
  const link = [-1];
  const len = [0];
  let last = 0;
  for (const ch of a) {
    const cur = next.length;
    next.push(new Map());
    len.push(len[last] + 1);
    link.push(-1);
    let p = last;
    while (p !== -1 && !next[p].has(ch)) {
      next[p].set(ch, cur);
      p = link[p];
    }
    if (p === -1) {
      link[cur] = 0;
    } else {
      const q = next[p].get(ch);
      if (len[p] + 1 === len[q]) {
        link[cur] = q;
      } else {
        const clone = next.length;
        next.push(new Map(next[q]));
        len.push(len[p] + 1);
        link.push(link[q]);
        while (p !== -1 && next[p].get(ch) === q) {
          next[p].set(ch, clone);
          p = link[p];
        }
        link[q] = clone;
        link[cur] = clone;
      }
    }
    last = cur;
  }

  // --- walk `b`, remembering where the best run ended ----------------------
  let v = 0;
  let l = 0;
  let best = 0;
  let bestEnd = -1;
  for (let i = 0; i < b.length; i++) {
    const ch = b[i];
    while (v && !next[v].has(ch)) {
      v = link[v];
      l = len[v];
    }
    if (next[v] && next[v].has(ch)) {
      v = next[v].get(ch);
      l++;
    } else {
      v = 0;
      l = 0;
    }
    if (l > best) {
      best = l;
      bestEnd = i;
    }
  }
  if (!best) return { length: 0, aStart: -1, bStart: -1 };

  const bStart = bestEnd - best + 1;
  const run = b.slice(bStart, bestEnd + 1);
  return { length: best, aStart: a.indexOf(run), bStart };
}
