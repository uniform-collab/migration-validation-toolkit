/**
 * Score the stage (actual) dataset against the prod (expected) dataset and
 * write tests/report.md + tests/report.json.
 *
 *   node compare.mjs --expected <dir> --actual <dir> --report-dir <dir>
 *                    [--fail-under N] [--exclude /a,/b] [--include /a,/b]
 *                    [--prev-report <path>]
 *
 * Regression diff vs the previous report:
 *   The previous report.json is found automatically in git history (the last
 *   commit that changed <repo>/tests/report.json — i.e. the prior run's 6300
 *   stage commit), or read from --prev-report <path> if given. The new report
 *   then reports, relative to it: which element diffs are NEW / GONE, and how
 *   the page-score buckets moved (100% / 50–100 / 0–50). First-ever run (no
 *   previous report) simply omits the section.
 *
 * Scoring (see the package README):
 *   element score = 100 * LCS / max(len)   (whitespace-normalized)
 *   pairing       = order-preserving sequence alignment (Needleman-Wunsch
 *                   maximizing total score, gap = 0), NOT naive index pairing:
 *                   one missing/inserted element must cost exactly one gap
 *                   instead of cascading a mismatch onto every later index
 *   page score    = length-weighted mean of element scores, each weighed by
 *                   max(prodLen, stageLen) — so a page's score tracks the
 *                   fraction of its TEXT that matches, not of its elements; an
 *                   unmatched element scores 0 and weighs its present side's
 *                   length (stage non-200 => 0, except 404 - see below)
 *   status parity = a prod-non-200 page whose stage status differs (e.g. prod
 *                   404 -> stage 200) scores 0; matching pages reported only
 *   stage 404     = a page prod serves and the stage answers 404 is NOT scored:
 *                   it is a page the migration does not have, a coverage gap, and
 *                   is counted in `pagesAvailable` / `pagesInScope` instead
 *   overall       = mean of page scores across prod-200 pages + parity misses
 *   --exclude     = comma-separated paths deliberately not migrated; reported
 *                   separately, not scored
 *   --link-target-rewrite = comma-separated `pattern=>replacement` regex rules applied to the
 *                   TARGET of every link annotation, on BOTH sides. For an expected side captured
 *                   from an httrack mirror: `\.html$=>`
 *   --include     = comma-separated ALLOWLIST of paths the migrated frontend
 *                   covers so far; everything else is out of scope entirely
 *                   (not scored, not reported as a diff). Empty = whole site
 *   --exclude-components = comma-separated rendering NAMES dropped from the
 *                   scored element list on BOTH sides. Capture has a flag of
 *                   the same name that keeps them out of the dataset; this one
 *                   works on a dataset that already holds them, which is what a
 *                   FROZEN expected dataset needs — re-capturing it to stop
 *                   scoring one component would re-base the freeze and make the
 *                   new report incomparable with every earlier one. The report
 *                   names what it dropped rather than dropping it silently.
 *   --accepted    = a file of accepted differences (lib/accepted.mjs): an element
 *                   whose page, componentKey and the text of BOTH sides match an
 *                   entry scores 100 and is listed under "Accepted"; any change to
 *                   either side scores it again and reports the entry as stale.
 *                   Every diff carries `prodPrint` / `stagePrint` in report.json,
 *                   which is what `migration-validate accept` writes entries from.
 */
import fs from "fs";
import path from "path";
import { elementScore } from "./lib/lcs.mjs";
import { parseExcludedComponents } from "./lib/index-json.mjs";
import { fingerprint, loadAccepted, findAccepted, staleAccepted } from "./lib/accepted.mjs";
import {
  parseArgs,
  requireArg,
  pathToSlugDir,
  normalizeText,
  rewriteLinkTarget,
  readJson,
  writeJson,
  readComponentDataset,
  diffExcerpts,
  loadPreviousReport,
  failedPagePaths,
  makePathExcluder,
  makePathIncluder,
  pageAvailability,
  formatAvailability,
  parseLinkTargetRewrites,
  setLinkTargetRewrites,
} from "./lib/util.mjs";

const args = parseArgs(process.argv.slice(2));
const expectedDir = requireArg(args, "expected");
const actualDir = requireArg(args, "actual");
const reportDir = requireArg(args, "report-dir");
let failUnder = args["fail-under"] ? parseFloat(args["fail-under"]) : null;
const prevReportArg = typeof args["prev-report"] === "string" ? args["prev-report"] : null;
const onlyFailed = Boolean(args["only-failed"]);
// V2 pairs elements by stable componentKey (from index.json); V1 by DOM order.
// Exact paths and `*` globs (e.g. `*/data/*`) — see makePathExcluder.
const excludePaths = makePathExcluder(args["exclude"]);
// Allowlist for a frontend that does not cover the whole site yet. Same syntax as
// --exclude; empty = everything is in scope, so omitting it changes nothing.
const includePaths = makePathIncluder(args["include"]);
// Regex rewrites applied to every link annotation TARGET on both sides - see parseLinkTargetRewrites.
// The case it exists for is an expected side captured from an httrack mirror, which saves hrefs with
// an extension the live site does not serve.
setLinkTargetRewrites(parseLinkTargetRewrites(args["link-target-rewrite"]));
// Rendering names not to score, on both sides. See the header: this is the frozen-dataset
// counterpart of capture's --exclude-components, and it is reported rather than silent.
const excludeComponents = parseExcludedComponents(args["exclude-components"]);
// Accepted differences - see lib/accepted.mjs and the header.
const accepted = loadAccepted(args["accepted"]);
const isExcludedComponent = (name) =>
  excludeComponents.size > 0 && excludeComponents.has(String(name ?? "").trim().toLowerCase());

const expected = readJson(path.join(expectedDir, "manifest.json"));
const actual = readJson(path.join(actualDir, "manifest.json"));

// The previous report drives both the regression diff and (in --only-failed
// mode) the set of pages to score. Loaded once here and reused below.
const prev = loadPreviousReport(reportDir, prevReportArg);

// Failed-only quick validation: score just the pages that failed last time
// (page score < 100), the same set 6200 re-captured. Empty/missing previous
// report => score the full set (never silently score nothing). failUnder is
// disabled in this mode — the subset is deliberately the worst pages, so its
// mean is not comparable to the full-run gate.
let failedSet = null;
if (onlyFailed) {
  if (prev && Array.isArray(prev.report.pages)) {
    const s = failedPagePaths(prev.report, excludePaths);
    if (s.size > 0) {
      failedSet = s;
      console.log(`--only-failed: scoring ${s.size} previously-failed pages (from ${prev.source}).`);
    } else {
      console.warn("--only-failed: previous report has no failed pages — scoring the full set.");
    }
  } else {
    console.warn("--only-failed: no previous report found — scoring the full set.");
  }
  if (failedSet && failUnder !== null) {
    console.warn(`--only-failed: ignoring --fail-under=${failUnder} (a failed-only subset is not comparable to the full-run gate).`);
    failUnder = null;
  }
}
const inScope = (p) => (!failedSet || failedSet.has(p)) && includePaths.has(p);
if (includePaths.active) {
  const n = Object.keys(expected.pages).filter((p) => includePaths.has(p)).length;
  console.log(
    `--include: ${includePaths.size} pattern(s) in scope — scoring ${n} of ${Object.keys(expected.pages).length} captured pages.`
  );
}

const SEPARATOR =
  "========   ⬆️⬆️⬆️ PROD ⬆️⬆️⬆️   ===//===   ⬇️⬇️⬇️ STAGE ⬇️⬇️⬇️   ========";

// Page score = length-weighted mean of element scores: each element weighs by
// max(prodLen, stageLen), so a long element that diverges costs more than a
// short one, and a page's score tracks the fraction of its TEXT that matches
// rather than the fraction of its elements. Unmatched elements (a gap on one
// side) score 0 and weigh by their present side's length. Page with no text on
// either side => 100.
function weightedScore(elements) {
  let num = 0;
  let den = 0;
  for (const e of elements) {
    const w = Math.max(e.prodLen || 0, e.stageLen || 0);
    num += e.score * w;
    den += w;
  }
  return den ? num / den : 100;
}

// Which page-score bucket a score falls in: exactly-100 / 50–99.9 / 0–49.9.
function scoreBucket(score) {
  if (score >= 100) return "full";
  if (score >= 50) return "mid";
  return "low";
}
function bucketCounts(pgs) {
  const c = { full: 0, mid: 0, low: 0 };
  for (const p of pgs) c[scoreBucket(p.score)]++;
  return c;
}

// A diff (element with score < 100) is identified by page + element index —
// the natural join key for "same slot on the same page" across two reports.
function diffKey(page, index) {
  return `${page} ${index}`;
}

// Collect the sub-100 element diffs out of a report.json's pages[] (the shape
// both the current run and a loaded previous report share).
function collectDiffs(reportPages) {
  const out = [];
  for (const p of reportPages || []) {
    for (const e of p.elements || []) {
      if (e.score < 100)
        out.push({ page: p.path, index: e.index, score: e.score, tag: e.tag, name: e.name, key: e.key });
    }
  }
  return out;
}

/**
 * V2 element list for one page: pair expected vs actual components by stable
 * componentKey (order-independent), preserving expected order, then appending
 * actual-only ("extra-on-stage") components. `index` is the componentKey and
 * `name` the rendering.
 */
function scoreV2Page(slug, pagePath) {
  const exp = readComponentDataset(path.join(expectedDir, slug));
  const act = readComponentDataset(path.join(actualDir, slug));
  const elements = [];
  // The --exclude-components pairs, scored only for the "without exclusions" figure
  // (rawOverallScore) - never listed, never part of the page score.
  const excludedElements = [];
  const seen = new Set();
  const pushExcluded = (prodText, stageText, tag) => {
    const p = normalizeText(prodText ?? "");
    const s = normalizeText(stageText ?? "");
    const score = tag ? 0 : p === s ? 100 : elementScore(p, s);
    excludedElements.push({ score, prodLen: p.length, stageLen: s.length });
  };
  const pushPair = (key, name, prodText, stageText, tag) => {
    const p = normalizeText(prodText ?? "");
    const s = normalizeText(stageText ?? "");
    const score = tag ? 0 : p === s ? 100 : elementScore(p, s);
    const el = { index: key, key, name, score, prodLen: p.length, stageLen: s.length };
    if (tag) el.tag = tag;
    if (score < 100) {
      const { prod, stage } = diffExcerpts(p, s);
      el.prodExcerpt = p ? prod : "(missing on prod)";
      el.stageExcerpt = s ? stage : "(missing on stage)";
      // The diff's identity for --accepted: the exact text of each side, as compared.
      el.prodPrint = fingerprint(p);
      el.stagePrint = fingerprint(s);
      const hit = findAccepted(accepted, pagePath, key, el.prodPrint, el.stagePrint);
      if (hit) {
        el.rawScore = score;
        el.score = 100;
        el.accepted = hit.reason || "accepted";
      }
    }
    elements.push(el);
  };
  for (const { key, name } of exp.order) {
    seen.add(key);
    const push = isExcludedComponent(name) ? (k, n, ...rest) => pushExcluded(...rest) : pushPair;
    if (act.texts.has(key)) push(key, name, exp.texts.get(key), act.texts.get(key), null);
    // The stage capture's index.json places this rendering nowhere any more: the expected text was
    // frozen with a selector a later locator change withdrew. Still a 0 - it may be a real component
    // the locator now misses - but named apart, so the cure (re-capture the page, or fix the
    // locator) is not looked for in the migrated site.
    else if (act.unselected.has(key)) {
      push(key, name, exp.texts.get(key), "", "selector-withdrawn");
      const el = elements[elements.length - 1];
      if (el?.key === key) el.locatedBy = act.unselected.get(key);
    }
    else push(key, name, exp.texts.get(key), "", "missing-on-stage");
  }
  for (const { key, name } of act.order) {
    if (seen.has(key)) continue;
    if (isExcludedComponent(name)) pushExcluded("", act.texts.get(key), "extra-on-stage");
    else pushPair(key, name, "", act.texts.get(key), "extra-on-stage");
  }
  return { elements, excludedElements };
}

// A page's score as if nothing were excluded: accepted diffs at their real score and
// the --exclude-components pairs counted in. Feeds rawOverallScore only.
function rawPageScore(elements, excludedElements) {
  return weightedScore([
    ...elements.map((e) => (e.accepted ? { ...e, score: e.rawScore } : e)),
    ...excludedElements,
  ]);
}

// Human label for an element diff: the rendering name behind its stable
// componentKey. Used by the main diff list and the regression diff.
function componentLabel(d) {
  return `${d.name || d.key || d.index}${d.tag ? ` (${d.tag})` : ""}`;
}

const fmt = (n) => (Math.floor(n * 10) / 10).toFixed(1);

// Prod non-200 pages must act the same on stage: 6200 status-probes each of
// them, and a different stage status (e.g. prod 404 -> stage 200) is a scored
// failure. stageStatus === null means the actual dataset predates the parity
// probe (stale capture) — reported, not scored.
//
// A REDIRECT is judged by its kind and its target, not by its exact code. 301/308 are both
// "moved permanently" and 302/303/307 all "found elsewhere" - frameworks do not all let a page
// pick the code (Next.js answers a permanent redirect with 308, a legacy IIS site with 301), and
// for a GET the pairs behave the same. What must agree is the Location, compared after the same
// --link-target-rewrite rules the component text gets. A redirect captured before capture.mjs
// recorded locations has none on one side; the kind alone decides then.
const REDIRECT_KIND = { 301: "permanent", 308: "permanent", 302: "temporary", 303: "temporary", 307: "temporary" };
const redirectTarget = (location) => rewriteLinkTarget(location).replace(/(.)\/+$/, "$1");
function statusParity(expectedRec, actualRec) {
  if (expectedRec.status === actualRec.status && !REDIRECT_KIND[expectedRec.status]) return true;
  const kind = REDIRECT_KIND[expectedRec.status];
  if (!kind || kind !== REDIRECT_KIND[actualRec.status]) return false;
  if (!expectedRec.location || !actualRec.location) return true;
  return redirectTarget(expectedRec.location) === redirectTarget(actualRec.location);
}
const prodNon200 = Object.entries(expected.pages)
  .filter(([p, rec]) => rec.status !== 200 && !excludePaths.has(p) && inScope(p))
  .map(([p, rec]) => {
    const actualRec = actual.pages[p];
    return {
      path: p,
      status: rec.status,
      location: rec.location,
      error: rec.error,
      stageStatus: actualRec ? actualRec.status : null,
      stageLocation: actualRec ? actualRec.location : undefined,
      stageError: actualRec ? actualRec.error : undefined,
      mismatch: actualRec ? !statusParity(rec, actualRec) : false,
    };
  });
// Coverage: in-scope pages prod serves vs those the stage does not 404. A stage 404
// leaves the score (see the header) — this counter is where it shows instead.
const availability = pageAvailability(
  expected.pages,
  actual.pages,
  (p) => !excludePaths.has(p) && inScope(p)
);
const notFoundOnStage = new Set(availability.notFound);
// A parity miss the stage answers 404 is the same coverage gap (prod 301 -> stage
// 404 is a page the migration does not have), so it is counted, not scored either.
const statusMismatches = prodNon200.filter((p) => p.mismatch && !notFoundOnStage.has(p.path));
const notProbed = prodNon200.filter((p) => p.stageStatus === null);

// Pages the stage could only render through the frontend's preview bypass (capture.mjs
// --preview-secret): members-only routes, whose captured content is NOT what an anonymous
// visitor sees. Surfaced because the mechanism is otherwise invisible — a page appearing
// here that prod serves publicly means the stage is protecting a route it should not.
const previewBypassed = Object.entries(actual.pages)
  .filter(([p, rec]) => rec && rec.previewBypass && !excludePaths.has(p) && inScope(p))
  .map(([p]) => p)
  .sort();

const excluded = Object.keys(expected.pages)
  .filter((p) => excludePaths.has(p))
  .sort();

const prod200Paths = Object.entries(expected.pages)
  .filter(([p, rec]) => rec.status === 200 && !excludePaths.has(p) && inScope(p))
  .map(([p]) => p)
  .sort();

const stageNon200 = [];
const noIndexPages = []; // V2 only: prod-200 pages with no index.json — reported, not scored
// V2 only: prod-200 pages that yielded no comparable component on EITHER side — everything they
// carry is either out of scope (TEST_EXCLUDE_COMPONENTS) or textless. weightedScore treats an empty
// element list as 100, which would let such a page claim perfect parity while nothing was actually
// compared, so they are reported and left out of the mean instead.
const noComponentPages = [];
const rawOnlyPageScores = []; // noComponentPages that only --exclude-components emptied
const pages = [];

for (const pagePath of prod200Paths) {
  const slug = pathToSlugDir(pagePath);
  const actualRec = actual.pages[pagePath] || { status: 0, error: "not captured" };

  // A page with no index.json can't be partitioned into components on either
  // side — report it, but keep it out of the scored set.
  if (expected.pages[pagePath] && expected.pages[pagePath].noIndex) {
    noIndexPages.push({ path: pagePath, stageStatus: actualRec.status });
    continue;
  }

  if (actualRec.status !== 200) {
    stageNon200.push({ path: pagePath, status: actualRec.status, error: actualRec.error });
    if (actualRec.status === 404) continue; // not on stage: counted in availability, not scored
    pages.push({
      path: pagePath,
      prodStatus: 200,
      stageStatus: actualRec.status,
      score: 0,
      elements: [],
    });
    continue;
  }

  const { elements, excludedElements } = scoreV2Page(slug, pagePath);

  if (elements.length === 0) {
    noComponentPages.push({ path: pagePath });
    // A page whose every component is excluded is still a page without exclusions.
    if (excludedElements.length) rawOnlyPageScores.push(rawPageScore([], excludedElements));
    continue;
  }

  pages.push({
    path: pagePath,
    prodStatus: 200,
    stageStatus: 200,
    score: weightedScore(elements),
    rawScore: rawPageScore(elements, excludedElements),
    elements,
  });
}

// Parity mismatches join the scored set at 0 (they drag the overall mean and
// the TEST_FAIL_UNDER gate); matching pages are reported but not scored.
for (const p of statusMismatches) {
  pages.push({
    path: p.path,
    prodStatus: p.status,
    stageStatus: p.stageStatus,
    statusMismatch: true,
    score: 0,
    elements: [],
  });
}

const overall = pages.length
  ? pages.reduce((sum, p) => sum + p.score, 0) / pages.length
  : 0;
// The overall score with the score-level exclusions undone: accepted diffs at their real
// score, --exclude-components scored in. Scope (--include / --exclude paths) and the stage
// 404s stay out - they decide WHICH pages a report is about, not how a page scores.
const rawPageScores = [...pages.map((p) => p.rawScore ?? p.score), ...rawOnlyPageScores];
const rawOverall = rawPageScores.length ? rawPageScores.reduce((a, b) => a + b, 0) / rawPageScores.length : 0;
const totalElements = pages.reduce((n, p) => n + p.elements.length, 0);
const diffElements = pages.flatMap((p) =>
  p.elements.filter((e) => e.score < 100).map((e) => ({ page: p.path, ...e }))
);
// Total-loss elements: nothing matched at all (incl. missing-on-stage /
// extra-on-stage). Reported alongside the diff count — a diff at 0 is a
// different kind of problem from a diff at 98.
const zeroElements = diffElements.filter((e) => e.score <= 0).length;
const acceptedElements = pages.flatMap((p) => p.elements.filter((e) => e.accepted).map((e) => ({ page: p.path, ...e })));
const { stale: acceptedStale, outOfScope: acceptedOutOfScope } = staleAccepted(accepted, pages.map((p) => p.path));
const withdrawnElements = pages.flatMap((p) =>
  p.elements.filter((e) => e.tag === "selector-withdrawn").map((e) => ({ page: p.path, key: e.key, name: e.name, locatedBy: e.locatedBy }))
);

// ---------- regression diff vs the previous report ----------
// (`prev` was loaded above, before the failed-only page-set restriction.)
let comparison = null;
if (prev && Array.isArray(prev.report.pages)) {
  const curDiffs = collectDiffs(pages);
  // In failed-only mode only the failed subset was scored this run, so restrict
  // the previous diffs to that subset too — otherwise every un-rerun page's old
  // diffs would show up as falsely "gone".
  const prevDiffs = collectDiffs(prev.report.pages).filter((d) => inScope(d.page));
  const curByKey = new Map(curDiffs.map((d) => [diffKey(d.page, d.index), d]));
  const prevByKey = new Map(prevDiffs.map((d) => [diffKey(d.page, d.index), d]));

  const newDiffs = curDiffs
    .filter((d) => !prevByKey.has(diffKey(d.page, d.index)))
    .sort((a, b) => a.score - b.score);
  const goneDiffs = prevDiffs
    .filter((d) => !curByKey.has(diffKey(d.page, d.index)))
    .sort((a, b) => a.score - b.score);

  const curBuckets = bucketCounts(pages);
  // Failed-only: compare like-for-like — bucket the previous run over the same
  // subset of pages that were re-scored this run.
  const prevBuckets = bucketCounts(prev.report.pages.filter((p) => inScope(p.path)));

  comparison = {
    source: prev.source,
    prevGeneratedAt: prev.report.generatedAt || null,
    prevOverall: typeof prev.report.overallScore === "number" ? prev.report.overallScore : null,
    curOverall: overall,
    prevDiffCount: prevDiffs.length,
    curDiffCount: curDiffs.length,
    newDiffs,
    goneDiffs,
    buckets: {
      full: { prev: prevBuckets.full, cur: curBuckets.full },
      mid: { prev: prevBuckets.mid, cur: curBuckets.mid },
      low: { prev: prevBuckets.low, cur: curBuckets.low },
    },
  };
}

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const signedF = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));

// ---------- report.md ----------
const lines = [];
lines.push(`# E2E content comparison — ${new Date().toISOString()}`);
lines.push("");
lines.push(`- Prod (expected): ${expected.baseUrl} — captured ${expected.generatedAt}${expected.partial ? " ⚠️ PARTIAL (--limit)" : ""}`);
lines.push(`- Stage (actual): ${actual.baseUrl} — captured ${actual.generatedAt}${actual.partial ? " ⚠️ PARTIAL (--limit)" : ""}`);
lines.push(`- Pages: ${Object.keys(expected.pages).length} in prod sitemap, ${pages.length} scored; ${prodNon200.length} prod-non-200 pages status-parity-checked${noIndexPages.length ? `; ${noIndexPages.length} prod-200 pages had no index.json (not scored)` : ""}${noComponentPages.length ? `; ${noComponentPages.length} prod-200 pages had no comparable component (not scored)` : ""}`);
if (excludeComponents.size) {
  lines.push(`- Components not scored (\`--exclude-components\`): ${[...excludeComponents].join(", ")} — dropped from BOTH sides, on every page.`);
}
if (previewBypassed.length) {
  lines.push(`- ${previewBypassed.length} protected page(s) were opened with the preview bypass (\`is_visual_testing\`) — their content is the members-only view, not the anonymous one.`);
}
if (failedSet) {
  lines.push(`- ⚠️ **FAILED-ONLY subset** (${failedSet.size} pages that failed in ${prev.source}) — the overall score below is over these worst pages only, NOT the full site; re-run without \`--only-failed\` for the real score.`);
}
lines.push("");
lines.push(`## Overall score${failedSet ? " (failed-only subset)" : ""}: ${fmt(overall)}%`);
lines.push("");
if (accepted.file || excludeComponents.size) {
  lines.push(`${fmt(rawOverall)}% (without exclusions: accepted differences at their real score, \`--exclude-components\` scored)`);
  lines.push("");
}
lines.push(`## Pages on stage (not 404): ${formatAvailability(availability)}`);
lines.push("");
lines.push(`${totalElements} element pairs compared, ${diffElements.length} differ (${zeroElements} score 0), ${stageNon200.filter((p) => p.status !== 404).length} pages broken on stage, ${availability.notFound.length} not on stage (404, not scored), ${statusMismatches.length} status-parity mismatches.`);
lines.push("");

// Regression diff vs the previous report (git history / --prev-report).
if (comparison) {
  const c = comparison;
  const b = c.buckets;
  // Element-score lookups (all elements, not just diffs) so each diff can
  // report the OTHER report's score for the same slot. Absent slot => 100.
  const curScoreByKey = new Map();
  for (const p of pages) for (const e of p.elements || []) curScoreByKey.set(diffKey(p.path, e.index), e.score);
  const prevScoreByKey = new Map();
  for (const p of prev.report.pages || []) for (const e of p.elements || []) prevScoreByKey.set(diffKey(p.path, e.index), e.score);
  // Page-score lookups so each grouped page can show its own score (and how it
  // moved) above the per-component lines. Absent page => 100 (no diffs there).
  const curPageScoreByPath = new Map(pages.map((p) => [p.path, p.score]));
  const prevPageScoreByPath = new Map((prev.report.pages || []).map((p) => [p.path, p.score]));
  const pageScore = (map, page) => (map.has(page) ? map.get(page) : 100);
  // Group a flat diff list by page, sorted worst-current-page-score first
  // (tiebreak: worst component diff), each page's components worst first.
  const groupDiffsByPage = (diffs) => {
    const byPage = new Map();
    for (const d of diffs) {
      if (!byPage.has(d.page)) byPage.set(d.page, []);
      byPage.get(d.page).push(d);
    }
    const groups = [];
    for (const [page, items] of byPage) {
      items.sort((a, b) => a.score - b.score);
      groups.push({ page, items });
    }
    groups.sort(
      (a, b) =>
        pageScore(curPageScoreByPath, a.page) - pageScore(curPageScoreByPath, b.page) ||
        a.items[0].score - b.items[0].score
    );
    return groups;
  };
  lines.push(`## Change since previous report (${c.source}${c.prevGeneratedAt ? ` — ${c.prevGeneratedAt}` : ""})`);
  lines.push("");
  if (c.prevOverall !== null) {
    lines.push(`Overall score: ${fmt(c.prevOverall)}% → ${fmt(c.curOverall)}% (${signedF(c.curOverall - c.prevOverall)})`);
    lines.push("");
  }
  lines.push("| page bucket | previous | current | Δ |");
  lines.push("|---|---|---|---|");
  lines.push(`| 100% | ${b.full.prev} | ${b.full.cur} | ${signed(b.full.cur - b.full.prev)} |`);
  lines.push(`| 50–100% (partial) | ${b.mid.prev} | ${b.mid.cur} | ${signed(b.mid.cur - b.mid.prev)} |`);
  lines.push(`| 0–50% (broken) | ${b.low.prev} | ${b.low.cur} | ${signed(b.low.cur - b.low.prev)} |`);
  lines.push("");
  lines.push(`Element diffs: ${c.prevDiffCount} → ${c.curDiffCount} (${signed(c.curDiffCount - c.prevDiffCount)}) — **${c.newDiffs.length} new**, **${c.goneDiffs.length} gone**.`);
  lines.push("");

  lines.push(`### New diffs (${c.newDiffs.length}) — new issues/regressions (vs previous report)`);
  lines.push("");
  if (c.newDiffs.length) {
    for (const g of groupDiffsByPage(c.newDiffs)) {
      const cur = pageScore(curPageScoreByPath, g.page);
      const was = pageScore(prevPageScoreByPath, g.page);
      lines.push(`- ${g.page} — page score ${fmt(cur)} (was ${fmt(was)})`);
      for (const d of g.items) {
        const name = componentLabel(d);
        const k = diffKey(d.page, d.index);
        const wasEl = prevScoreByKey.has(k) ? Math.floor(prevScoreByKey.get(k)) : 100;
        lines.push(`    - ${name} - score ${Math.floor(d.score)} (was ${wasEl})`);
      }
    }
  } else {
    lines.push("None.");
  }
  lines.push("");

  lines.push(`### Gone diffs (${c.goneDiffs.length}) — fixed / no longer differing (vs previous report)`);
  lines.push("");
  if (c.goneDiffs.length) {
    for (const g of groupDiffsByPage(c.goneDiffs)) {
      const cur = pageScore(curPageScoreByPath, g.page);
      const was = pageScore(prevPageScoreByPath, g.page);
      lines.push(`- ${g.page} — page score ${fmt(cur)} (was ${fmt(was)})`);
      for (const d of g.items) {
        const name = componentLabel(d);
        const k = diffKey(d.page, d.index);
        const now = curScoreByKey.has(k) ? Math.floor(curScoreByKey.get(k)) : 100;
        lines.push(`    - ${name} - score ${now} (was ${Math.floor(d.score)})`);
      }
    }
  } else {
    lines.push("None.");
  }
  lines.push("");
} else {
  lines.push("## Change since previous report");
  lines.push("");
  lines.push("_No previous report found in git history — this is the baseline._");
  lines.push("");
}

if (excluded.length) {
  lines.push(`## Excluded pages (${excluded.length}) — deliberately not migrated, not scored`);
  lines.push("");
  for (const p of excluded) lines.push(`- ${p}`);
  lines.push("");
}

if (noComponentPages.length) {
  lines.push(`## No comparable components (${noComponentPages.length}) — nothing in scope rendered text on either side, not scored`);
  lines.push("");
  for (const p of noComponentPages) lines.push(`- ${p.path}`);
  lines.push("");
}

if (noIndexPages.length) {
  lines.push(`## No index.json (${noIndexPages.length}) — V2 could not partition these into components, not scored`);
  lines.push("");
  for (const p of noIndexPages) lines.push(`- ${p.path}`);
  lines.push("");
}

lines.push(`## Prod pages not returning 200 (${prodNon200.length}) — stage must return the same status (${statusMismatches.length} mismatches${notProbed.length ? `, ${notProbed.length} not probed` : ""})`);
lines.push("");
if (prodNon200.length) {
  lines.push("| prod | stage | parity | path |");
  lines.push("|---|---|---|---|");
  for (const p of prodNon200) {
    const prodCell = p.error ? `error: ${p.error}` : p.location ? `${p.status} → ${p.location}` : p.status;
    const stageCell =
      p.stageStatus === null
        ? "—"
        : p.stageError
          ? `error: ${p.stageError}`
          : p.stageLocation
            ? `${p.stageStatus} → ${p.stageLocation}`
            : p.stageStatus;
    const parity =
      p.stageStatus === null
        ? "not probed (stale actual dataset)"
        : p.mismatch && notFoundOnStage.has(p.path)
          ? "❌ not on stage (counted in Pages, not scored)"
          : p.mismatch
          ? "❌ scored 0"
          : "✅";
    lines.push(`| ${prodCell} | ${stageCell} | ${parity} | ${p.path} |`);
  }
} else {
  lines.push("None.");
}
lines.push("");

lines.push(`## Stage pages not returning 200 (${stageNon200.length}) — these score 0, except a 404 (not on stage, not scored)`);
lines.push("");
if (stageNon200.length) {
  lines.push("| status | path |");
  lines.push("|---|---|");
  for (const p of stageNon200) {
    lines.push(`| ${p.error ? `error: ${p.error}` : p.status} | ${p.path} |`);
  }
} else {
  lines.push("None.");
}
lines.push("");

if (accepted.file) {
  lines.push(`## Accepted differences (${acceptedElements.length}) — scored 100, listed in ${path.basename(accepted.file)}`);
  lines.push("");
  const byReason = new Map();
  for (const e of acceptedElements) byReason.set(e.accepted, (byReason.get(e.accepted) || 0) + 1);
  if (byReason.size) {
    lines.push("| diffs | reason |");
    lines.push("|---|---|");
    for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${n} | ${reason} |`);
  } else {
    lines.push("None matched.");
  }
  lines.push("");
  if (acceptedStale.length) {
    lines.push(`### Stale accepted entries (${acceptedStale.length}) — the diff changed or is gone; scored again if still differing`);
    lines.push("");
    for (const e of acceptedStale) lines.push(`- ${e.page} - ${e.name || e.key} - ${e.reason || ""}`);
    lines.push("");
  }
  if (acceptedOutOfScope) {
    lines.push(`${acceptedOutOfScope} more accepted entr${acceptedOutOfScope === 1 ? "y is" : "ies are"} for pages this report does not compare (not checked here).`);
    lines.push("");
  }
}

if (withdrawnElements.length) {
  lines.push(`## Selector withdrawn since the expected capture (${withdrawnElements.length}) — scored 0`);
  lines.push("");
  lines.push("The frozen expected dataset holds these elements, but the index.json the stage was captured with places them nowhere on the legacy page any more (a locator change after the expected capture). Nothing on the stage can match them. If the old selector was a wrong guess, re-capture the page's expected copy; if the component is real on the legacy page, the locator lost it - fix the locator.");
  lines.push("");
  lines.push("| page | component | locator says |");
  lines.push("|---|---|---|");
  for (const e of withdrawnElements) lines.push(`| ${e.page} | ${e.name || e.key} | ${e.locatedBy || "no selector"} |`);
  lines.push("");
}

lines.push(`## Per-page scores (worst first)`);
lines.push("");
lines.push("| score | elements | diffs | page |");
lines.push("|---|---|---|---|");
for (const p of [...pages].sort((a, b) => a.score - b.score)) {
  const diffs = p.elements.filter((e) => e.score < 100).length;
  const note = p.statusMismatch
    ? ` (status parity: prod ${p.prodStatus || "error"}, stage ${p.stageStatus || "error"})`
    : p.stageStatus !== 200
      ? ` (stage status ${p.stageStatus || "error"})`
      : "";
  lines.push(`| ${fmt(p.score)} | ${p.elements.length} | ${diffs} | ${p.path}${note} |`);
}
lines.push("");

lines.push(`## Element diffs (score < 100): ${diffElements.length} (${zeroElements} score 0)`);
lines.push("");
for (const d of [...diffElements].sort((a, b) => a.score - b.score)) {
  const name = componentLabel(d, { stageIndexHint: true });
  lines.push(`${d.page} - ${name} - score ${Math.floor(d.score)}`);
  lines.push("");
  lines.push("```");
  lines.push(d.prodExcerpt || "(missing on prod)");
  lines.push(SEPARATOR);
  lines.push(d.stageExcerpt || "(missing on stage)");
  lines.push("```");
  lines.push("");
}

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, "report.md"), lines.join("\n"), "utf8");

writeJson(path.join(reportDir, "report.json"), {
  generatedAt: new Date().toISOString(),
  mode: "v2",
  prodUrl: expected.baseUrl,
  stageUrl: actual.baseUrl,
  overallScore: overall,
  // overallScore without the accepted differences and --exclude-components (see rawOverall);
  // only when the run had either.
  rawOverallScore: accepted.file || excludeComponents.size ? rawOverall : undefined,
  failedOnly: failedSet ? { count: failedSet.size, source: prev.source } : undefined,
  pagesScored: pages.length,
  // Coverage: in-scope pages prod serves, and how many of them the stage does not 404.
  // The 404s are left out of overallScore and listed in notFoundOnStage.
  pagesInScope: availability.inScope,
  pagesAvailable: availability.available,
  pagesByLocale: availability.byLocale,
  notFoundOnStage: availability.notFound,
  elementsCompared: totalElements,
  elementsScoringZero: zeroElements,
  selectorWithdrawn: withdrawnElements,
  excluded,
  excludedComponents: [...excludeComponents],
  noIndexPages,
  noComponentPages,
  prodNon200,
  stageNon200,
  statusMismatches: statusMismatches.length,
  previewBypassed: previewBypassed.length,
  accepted: accepted.file
    ? { file: accepted.file, entries: accepted.byKey.size, matched: acceptedElements.length, stale: acceptedStale, outOfScope: acceptedOutOfScope }
    : undefined,
  comparison,
  pages,
});

// ---------- component-scoped report ----------
// Same scored elements as report.md, but regrouped by rendering NAME instead of
// by page: Table 1 = each component's average score (+ how many instances scored
// 0 and how many scored 100, of N); Table 2 = per component, only the pages where it DIFFERS, with the
// diff-trimmed actual (stage) / expected (prod) excerpts. -> report-components.md/.json
{
  // For a component present on only ONE side, the full text is noise — trim the
  // present side to the first N words (--missing-words, default 8; 0 = keep all).
  const missingWords = (() => {
    const v = parseInt(args["missing-words"], 10);
    return Number.isFinite(v) ? v : 8;
  })();
  const firstWords = (text, n) => {
    if (!n || n <= 0) return text;
    const words = String(text).trim().split(/\s+/);
    return words.length <= n ? text : words.slice(0, n).join(" ") + " (…)";
  };
  const byComponent = new Map(); // name -> [{ page, score, tag, actual, expected }]
  for (const p of pages) {
    for (const e of p.elements || []) {
      const name = e.name || e.key || String(e.index);
      if (!byComponent.has(name)) byComponent.set(name, []);
      byComponent.get(name).push({
        page: p.path,
        score: e.score,
        tag: e.tag || null,
        actual: e.stageExcerpt ?? null, // stage side = "actual"
        expected: e.prodExcerpt ?? null, // prod side = "expected"
      });
    }
  }
  const comps = [...byComponent.entries()]
    .map(([name, occ]) => {
      const total = occ.length;
      const perfect = occ.filter((o) => o.score >= 100).length;
      // Worst case: nothing of the expected text survived (incl. missing-on-stage /
      // extra-on-stage, which score 0 by construction) — the total-loss instances,
      // reported next to `perfect` so both ends of the distribution are visible.
      const zero = occ.filter((o) => o.score <= 0).length;
      const avg = total ? occ.reduce((n, o) => n + o.score, 0) / total : 100;
      const diffs = occ.filter((o) => o.score < 100).sort((a, b) => a.score - b.score);
      return { name, total, perfect, zero, avg, diffs };
    })
    .sort((a, b) => a.avg - b.avg || b.total - a.total); // worst avg first

  const cl = [];
  cl.push(`# E2E content comparison — by component — ${new Date().toISOString()}`);
  cl.push("");
  cl.push(`- Mode: V2 (selector-driven, index.json)`);
  cl.push(`- Prod (expected): ${expected.baseUrl} · Stage (actual): ${actual.baseUrl}`);
  cl.push(`- ${comps.length} components across ${pages.length} scored pages`);
  cl.push("");
  cl.push(`## Component average scores (worst first)`);
  cl.push("");
  cl.push("| component | avg score | worst (0) | perfect (100) | differing |");
  cl.push("|---|---|---|---|---|");
  for (const c of comps) {
    cl.push(`| ${c.name} | ${fmt(c.avg)} | ${c.zero}/${c.total} | ${c.perfect}/${c.total} | ${c.total - c.perfect} |`);
  }
  cl.push("");
  cl.push(`## Differing pages by component (worst first)`);
  cl.push("");
  const withDiffs = comps.filter((c) => c.diffs.length);
  if (!withDiffs.length) cl.push("None — every component matches on every page. 🎉");
  for (const c of withDiffs) {
    cl.push(`### ${c.name} — avg ${fmt(c.avg)} (${c.zero}/${c.total} worst-0, ${c.perfect}/${c.total} perfect, ${c.diffs.length} differ)`);
    cl.push("");
    for (const o of c.diffs) {
      const note = o.tag ? ` (${o.tag})` : "";
      let expected = o.expected ?? "(missing on prod)";
      let actual = o.actual ?? "(missing on stage)";
      // Component present on only one side: trim the present side to N words.
      if (o.tag === "missing-on-stage" || o.tag === "selector-withdrawn") expected = firstWords(expected, missingWords);
      else if (o.tag === "extra-on-stage") actual = firstWords(actual, missingWords);
      cl.push(`${o.page} — score ${Math.floor(o.score)}${note}`);
      cl.push("```");
      cl.push(expected);
      cl.push(SEPARATOR);
      cl.push(actual);
      cl.push("```");
      cl.push("");
    }
  }

  fs.writeFileSync(path.join(reportDir, "report-components.md"), cl.join("\n"), "utf8");
  writeJson(path.join(reportDir, "report-components.json"), {
    generatedAt: new Date().toISOString(),
    mode: "v2",
    prodUrl: expected.baseUrl,
    stageUrl: actual.baseUrl,
    pagesScored: pages.length,
    components: comps.map((c) => ({
      name: c.name,
      avgScore: c.avg,
      zero: c.zero,
      perfect: c.perfect,
      total: c.total,
      differing: c.diffs,
    })),
  });
  console.log(
    `Component report: ${path.join(reportDir, "report-components.md")} (${comps.length} components, ${withDiffs.length} with diffs)`
  );
}

// ---------- stdout summary (lands in the z_stdout stage log) ----------
console.log(`Overall score${failedSet ? " (FAILED-ONLY subset)" : ""}: ${fmt(overall)}% over ${pages.length} pages (${totalElements} element pairs, ${diffElements.length} diffs, ${zeroElements} scoring 0)`);
console.log(`Pages on stage (not 404): ${formatAvailability(availability)}`);
console.log(`Prod non-200: ${prodNon200.length}; stage non-200: ${stageNon200.length}; status-parity mismatches: ${statusMismatches.length}${notProbed.length ? ` (${notProbed.length} not probed)` : ""}`);
if (comparison) {
  const c = comparison;
  const b = c.buckets;
  console.log(
    `vs previous (${c.source})${c.prevOverall !== null ? `: ${fmt(c.prevOverall)}% → ${fmt(c.curOverall)}% (${signedF(c.curOverall - c.prevOverall)})` : ""}`
  );
  console.log(
    `  pages 100%: ${b.full.prev} → ${b.full.cur} (${signed(b.full.cur - b.full.prev)});` +
      ` 50–100%: ${b.mid.prev} → ${b.mid.cur} (${signed(b.mid.cur - b.mid.prev)});` +
      ` 0–50%: ${b.low.prev} → ${b.low.cur} (${signed(b.low.cur - b.low.prev)})`
  );
  console.log(`  element diffs: ${c.newDiffs.length} new, ${c.goneDiffs.length} gone (${c.prevDiffCount} → ${c.curDiffCount})`);
} else {
  console.log("vs previous: no previous report found (baseline).");
}
const worst = [...pages].sort((a, b) => a.score - b.score).slice(0, 10);
for (const p of worst) {
  if (p.score < 100) console.log(`  worst: ${fmt(p.score)}%  ${p.path}`);
}
console.log(`Report: ${path.join(reportDir, "report.md")}`);

if (failUnder !== null && Number.isFinite(failUnder) && overall < failUnder) {
  console.error(`Overall score ${fmt(overall)}% is below TEST_FAIL_UNDER=${failUnder} — failing.`);
  process.exit(1);
}
