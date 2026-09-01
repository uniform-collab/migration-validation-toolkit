/**
 * Longest common substring length via a suffix automaton over the shorter
 * string, then a single walk of the longer one — O(n+m) time, O(n) states.
 * (The naive DP is O(n*m) and far too slow for ~10k element pairs.)
 */
export function longestCommonSubstringLength(a, b) {
  if (!a.length || !b.length) return 0;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];

  const maxStates = 2 * s.length + 5;
  const len = new Int32Array(maxStates);
  const link = new Int32Array(maxStates).fill(-1);
  /** @type {(Map<string, number>|null)[]} */
  const next = new Array(maxStates).fill(null);
  let size = 1;
  let last = 0;

  const extend = (c) => {
    const cur = size++;
    len[cur] = len[last] + 1;
    link[cur] = -1;
    let p = last;
    while (p !== -1 && !(next[p] && next[p].has(c))) {
      if (!next[p]) next[p] = new Map();
      next[p].set(c, cur);
      p = link[p];
    }
    if (p === -1) {
      link[cur] = 0;
    } else {
      const q = next[p].get(c);
      if (len[p] + 1 === len[q]) {
        link[cur] = q;
      } else {
        const clone = size++;
        len[clone] = len[p] + 1;
        link[clone] = link[q];
        next[clone] = next[q] ? new Map(next[q]) : new Map();
        while (p !== -1 && next[p] && next[p].get(c) === q) {
          next[p].set(c, clone);
          p = link[p];
        }
        link[q] = clone;
        link[cur] = clone;
      }
    }
    last = cur;
  };

  // Iterate UTF-16 units (s[i]) rather than code points so the LCS length is
  // measured in the same unit as String.length used in the score denominator.
  for (let i = 0; i < s.length; i++) extend(s[i]);

  let v = 0;
  let l = 0;
  let best = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    while (v !== 0 && !(next[v] && next[v].has(ch))) {
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
    if (l > best) best = l;
  }
  return best;
}

/**
 * Element score per the agreed formula:
 *   100 * LCS(prod, stage).length / max(prod.length, stage.length)
 * Inputs must already be normalized. Both empty -> 100, one empty -> 0.
 */
export function elementScore(prodNormalized, stageNormalized) {
  const maxLen = Math.max(prodNormalized.length, stageNormalized.length);
  if (maxLen === 0) return 100;
  return (
    (100 * longestCommonSubstringLength(prodNormalized, stageNormalized)) /
    maxLen
  );
}
