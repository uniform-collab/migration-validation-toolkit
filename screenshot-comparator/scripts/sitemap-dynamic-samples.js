/**
 * Sample sitemap paths for Uniform-style dynamic routes: only keep the first N
 * URLs per pattern; all non-matching paths are kept.
 *
 * Patterns are path templates with `*` for a single segment, pipe-separated in env.
 * Example patterns (pipe-separated): news blog with three dynamic segments, or article slug.
 */

/** @param {string} p */
function normalizePath(p) {
  let s = p.trim();
  if (!s.startsWith("/")) s = `/${s}`;
  s = s.replace(/\/$/, "") || "/";
  return s;
}

/** @param {string} p */
function pathSegments(p) {
  return normalizePath(p).split("/").filter(Boolean);
}

// pathname concrete path; pattern same segment count with * for one dynamic segment each.
export function pathMatchesDynamicPattern(pathname, pattern) {
  const pathSegs = pathSegments(pathname);
  const patSegs = pathSegments(pattern);
  if (patSegs.length !== pathSegs.length) return false;
  for (let i = 0; i < patSegs.length; i++) {
    if (patSegs[i] === "*") continue;
    if (patSegs[i] !== pathSegs[i]) return false;
  }
  return true;
}

/**
 * @param {string | undefined} raw - pipe-separated patterns
 */
export function parseDynamicSamplePatterns(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split("|")
    .map((p) => normalizePath(p))
    .filter((p) => p !== "/" && p.length > 0);
}

/**
 * @param {string[]} paths - pathnames (with leading /)
 * @param {string[]} patterns - from parseDynamicSamplePatterns
 * @param {number} sampleCount - max URLs to keep per pattern (>= 1)
 * @returns {{ paths: string[], stats: { pattern: string; kept: number; skipped: number }[] }}
 */
export function applyDynamicUrlSampling(paths, patterns, sampleCount) {
  const n = Math.max(1, Math.floor(sampleCount) || 2);
  if (patterns.length === 0) {
    return { paths: [...paths], stats: [] };
  }

  const uniqueSorted = [...new Set(paths.map(normalizePath))].sort();
  const keptPerPattern = new Map(
    patterns.map((pat) => [pat, { kept: 0, skipped: 0 }]),
  );
  const out = [];

  for (const path of uniqueSorted) {
    let matchedPattern = null;
    for (const pat of patterns) {
      if (pathMatchesDynamicPattern(path, pat)) {
        matchedPattern = pat;
        break;
      }
    }

    if (!matchedPattern) {
      out.push(path);
      continue;
    }

    const st = keptPerPattern.get(matchedPattern);
    if (!st) continue;
    if (st.kept < n) {
      out.push(path);
      st.kept++;
    } else {
      st.skipped++;
    }
  }

  const stats = patterns.map((pat) => {
    const s = keptPerPattern.get(pat) || { kept: 0, skipped: 0 };
    return { pattern: pat, kept: s.kept, skipped: s.skipped };
  });

  return { paths: out, stats };
}
