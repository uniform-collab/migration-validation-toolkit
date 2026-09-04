import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/** Tiny --key value / --flag argv parser (last occurrence wins). */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

export function requireArg(args, name) {
  const v = args[name];
  if (v === undefined || v === true || String(v).trim() === "") {
    console.error(`Missing required argument: --${name}`);
    process.exit(1);
  }
  return String(v).trim();
}

/**
 * URL path -> dataset folder (path structure preserved as nested directories,
 * illegal filename chars percent-encoded per segment). Root "/" -> "index".
 * Same rule as the old system's encodeURLToFolder.
 */
export function pathToSlugDir(pathname) {
  const illegal = /[<>:"\\|?*\0]/g;
  if (!pathname || pathname === "/") return "index";
  return pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((seg) =>
      seg.replace(illegal, (ch) => `%${ch.charCodeAt(0).toString(16)}`)
    )
    .join("/");
}

/**
 * Placeholder that replaces every media-asset URL before comparison.
 *
 * Wherever an asset URL ends up in the compared text, prod and stage address the
 * SAME asset with structurally unrelated URLs, so the two can never match and
 * every such occurrence is a guaranteed false negative.
 *
 *   prod (Sitecore)   : /-/media/files/public-policy/cha_meb_flyer.pdf
 *   stage (Uniform)   : https://canary-files.uniform.global/p/<id>-cha_meb_flyer.pdf
 *   stage (gated)     : /_protected-media/<per-render token>/<id>-cha_meb_flyer.pdf
 *   stage (local edge): http://127.0.0.1:<port>/media/files.uniform.global/p/<id>-cha_meb_flyer.pdf
 *
 * Collapsing all of them to one placeholder keeps the surrounding link TEXT
 * scored (a missing or renamed document still diffs) while dropping the
 * un-comparable target. Currently ~612 prod links / ~543 stage links.
 *
 * Deliberately NOT masked: `/uniform_asset/<guid>` placeholders. Those mean the
 * asset was never resolved to a real URL (the broken-rich-text-images failure
 * class) — a genuine migration defect that must keep showing up as a diff.
 */
export const ASSET_LINK_PLACEHOLDER = "asset-links-are-hidden-in-e2e";

// Four shapes, each optionally host-prefixed because cross-origin links keep their
// absolute form. The target stops at whitespace or `)` so the markdown wrapper
// `[text](…)` survives intact.
//
//  1. uniform-local-edge's media proxy: `/media/<asset host>/…`. The asset host is a
//     PATH SEGMENT here, not the URL host - the URL host is 127.0.0.1 on a RANDOM port,
//     which is also why this MUST be masked: the port changes every run, so an unmasked
//     link diffs against itself between two stage captures, never mind against prod.
//  2. Uniform asset hosts directly (`https://canary-files.uniform.global/…`, incl.
//     protocol-relative). Both `img.` and `files.` - `files.` is the common one
//     (documents), and matching only `img.` left every PDF link unmasked.
//  3. Sitecore media paths (`/-/media/…`, `/-/jssmedia/…`).
//  4. The frontend's role-gated media proxy (`/_protected-media/…`).
const ASSET_LINK_URL = new RegExp(
  [
    // 1. local-edge proxy - the `/media/` prefix is what proves it is the media route,
    //    so the upstream host segment is matched loosely.
    String.raw`(?:(?:https?:)?//[^\s)/]+)?/media/[^\s)/]*uniform\.global/[^\s)]*`,
    // 2. Uniform asset hosts
    String.raw`(?:https?:)?//[^\s)/]*(?:img|files)\.uniform\.global/[^\s)]*`,
    // 3 + 4. Sitecore media paths and the gated proxy
    //    Sitecore emits `-/media/…` PAGE-RELATIVE, so prod serves
    //    `/education/events/-/media/files/x.pdf` - those leading segments are the PAGE, not the
    //    asset. Without consuming them the mask leaves `/education/events` in front of the
    //    placeholder while the stage side (an absolute asset URL) masks whole, and the same file
    //    collapses to two different strings.
    String.raw`(?:(?:https?:)?//[^\s)/]+)?(?:/[^\s)/]+)*?/(?:-/(?:jss?)?media|_protected-media)/[^\s)]*`,
  ].join("|"),
  "gi"
);

/**
 * Whitespace-insensitive normalization used for all comparisons, with
 * un-comparable media-asset URLs masked (see ASSET_LINK_PLACEHOLDER).
 *
 * Masking lives HERE, at comparison time, rather than in the in-page capture:
 * `expected/` is a frozen one-time dataset, so a capture-side rewrite would
 * only ever mask the stage side. This way both sides collapse identically and
 * the datasets keep the real URLs on disk for debugging.
 *
 * It also trims whitespace out of the LINK ANNOTATION's own brackets. The capture
 * inserts `[` before the anchor's first child and `](target)` after its last, so any
 * whitespace the markup keeps inside the <a> lands INSIDE the brackets: one side emits
 * `[ Read more ](/x)` and the other `[Read more](/x)` for the same link. That is a
 * difference in the annotation, not in the content, and it is common enough to matter
 * (9335 of 26864 prod links vs 7254 of 26586 stage ones on the CHA dataset).
 */
export function normalizeText(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/\[ ?([^\]]*?) ?\]\(/g, "[$1](")
    .replace(ASSET_LINK_URL, ASSET_LINK_PLACEHOLDER)
    .trim();
}

export function readJson(file) {
  // Strip a UTF-8 BOM: some of these files are written by Windows PowerShell,
  // whose Set-Content -Encoding utf8 emits one, and JSON.parse rejects it.
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Read a V2 page dir's keyed components: the ordered list from .components.json
 * plus a key→text map (from <componentKey>.txt). Returns { order, texts }.
 */
export function readComponentDataset(pageDir) {
  const order = [];
  const texts = new Map();
  const manifest = path.join(pageDir, ".components.json");
  if (!fs.existsSync(manifest)) return { order, texts };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch {
    return { order, texts };
  }
  for (const c of doc.components || []) {
    const file = path.join(pageDir, `${c.key}.txt`);
    order.push({ key: c.key, name: c.name });
    texts.set(c.key, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  }
  return { order, texts };
}

/**
 * Load the previous report JSON — used both for the regression diff and for the
 * "previously-failed pages" (failed-only) quick-validation mode. From
 * `explicitPath` if given, else the last git commit that changed
 * `<repoRoot>/tests/<reportName>` (the prior run's compare-stage commit — the
 * current run has not committed its own yet). `reportDir` is `<repoRoot>/tests`.
 * Returns `{ report, source }` or `null` (no previous report / no git).
 */
export function loadPreviousReport(reportDir, explicitPath, reportName = "report.json") {
  if (explicitPath) {
    try {
      return { report: readJson(explicitPath), source: explicitPath };
    } catch {
      return null;
    }
  }
  const repoRoot = path.resolve(reportDir, "..");
  const rel = path
    .relative(repoRoot, path.join(reportDir, reportName))
    .split(path.sep)
    .join("/");
  try {
    const commit = execFileSync(
      "git",
      ["-C", repoRoot, "log", "-1", "--format=%H", "--", rel],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (!commit) return null;
    const json = execFileSync("git", ["-C", repoRoot, "show", `${commit}:${rel}`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { report: JSON.parse(json), source: `git ${commit.slice(0, 11)}` };
  } catch {
    return null;
  }
}

/**
 * Builds the page-path exclusion matcher from a comma-separated TEST_EXCLUDE_PATHS
 * spec. An entry is either an exact path ("/search") or a `*` glob, where `*` stands
 * for any run of characters INCLUDING `/` — the same shape as siphon's
 * SIPHON_PAGESTOEXCLUDE, so the two lists can be written the same way.
 *
 * The glob form is what lets the comparison drop whole classes of URL that the
 * migration deliberately never produces. The dominant one is `*​/data/*`: Sitecore
 * serves every datasource item that has a layout (accordion items, list grids, …) as
 * a real page, and the prod mirror therefore captures them, but SIPHON_PAGESTOEXCLUDE
 * keeps them out of the canvas on purpose — so the migrated site 404s them BY DESIGN.
 * Scoring them as broken pages buried the real signal (441 of 1782 pages, 2026-08-25).
 *
 * Exposes `.has()` rather than a bare function so every existing call site — and
 * failedPagePaths' `new Set()` default — keeps working unchanged.
 */
/**
 * The mirror image of makePathExcluder: an ALLOWLIST. Same entry syntax (exact path or
 * `*` glob), but an EMPTY spec means "everything is in scope" rather than "nothing is",
 * so the flag is opt-in and omitting it changes no behaviour.
 *
 * Why both exist. Exclude answers "the migration deliberately never produces this URL";
 * include answers "the migrated frontend does not cover this page YET". The second is the
 * normal state of a migration in progress - a frontend rendering 1 of 4416 pages would
 * otherwise score ~0% and bury every real diff under 4415 missing ones. Listing the
 * negative space is not an option there; listing the positive space is.
 *
 * The two are independent: a page must be included AND not excluded. An allowlisted page
 * that is also excluded stays out - the exclusion states something about the MIGRATION,
 * which outranks a statement about frontend coverage.
 */
export function makePathIncluder(spec) {
  const patterns = (typeof spec === "string" ? spec.split(",") : Array.isArray(spec) ? spec : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!patterns.length) return { active: false, has: () => true, size: 0 };
  const matcher = makePathExcluder(patterns);
  return { active: true, has: (p) => matcher.has(p), size: patterns.length };
}

export function makePathExcluder(spec) {
  const patterns = (typeof spec === "string" ? spec.split(",") : Array.isArray(spec) ? spec : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const exact = new Set(patterns.filter((p) => !p.includes("*")));
  const globs = patterns
    .filter((p) => p.includes("*"))
    .map((p) => new RegExp("^" + p.split("*").map(escapeRegExp).join(".*") + "$"));
  return {
    has: (p) => exact.has(p) || globs.some((rx) => rx.test(p)),
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The set of page paths that FAILED (page score < 100) in a previous
 * report.json — the "previously-failed pages" that the failed-only mode
 * re-captures and re-scores for quick validation. A page score < 100 covers
 * content diffs, stage-non-200 pages and status-parity mismatches (all scored
 * < 100 by compare.mjs). Any path in `excludePaths` is left out.
 */
export function failedPagePaths(report, excludePaths = new Set()) {
  const set = new Set();
  for (const p of (report && report.pages) || []) {
    if (typeof p.score === "number" && p.score < 100 && !excludePaths.has(p.path)) {
      set.add(p.path);
    }
  }
  return set;
}

const DIFF_CONTEXT_WORDS = 12;
const EXCERPT_MAX_CHARS = 600;

function expandRangeWithWordContext(str, coreStart, coreEnd, words) {
  let s = coreStart;
  for (let w = 0; w < words && s > 0; w++) {
    while (s > 0 && /\s/.test(str[s - 1])) s--;
    if (s === 0) break;
    while (s > 0 && /\S/.test(str[s - 1])) s--;
  }
  let e = coreEnd;
  for (let w = 0; w < words && e < str.length; w++) {
    while (e < str.length && /\s/.test(str[e])) e++;
    if (e >= str.length) break;
    while (e < str.length && /\S/.test(str[e])) e++;
  }
  return { start: s, end: e };
}

function buildExcerpt(str, coreStart, coreEnd) {
  const { start, end } = expandRangeWithWordContext(
    str,
    coreStart,
    coreEnd,
    DIFF_CONTEXT_WORDS
  );
  let out = str.slice(start, Math.min(end, start + EXCERPT_MAX_CHARS));
  if (start > 0) out = `(...) ${out}`;
  if (end < str.length || end - start > EXCERPT_MAX_CHARS) out = `${out} (...)`;
  return out;
}

/**
 * Diff-focused excerpts of two normalized texts: the shared prefix/suffix is
 * trimmed, keeping a few words of context on each side of the differing span.
 */
export function diffExcerpts(a, b) {
  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(a.length - prefix, b.length - prefix);
  while (
    suffix < maxSuffix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    prod: buildExcerpt(a, prefix, a.length - suffix),
    stage: buildExcerpt(b, prefix, b.length - suffix),
  };
}
