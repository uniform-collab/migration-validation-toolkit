/**
 * Screenshot comparison (V2) — the visual counterpart of compare.mjs. Pairs the
 * prod baseline element screenshots against the stage ones by stable
 * componentKey (the folder name), pixel-diffs each pair, and writes
 * report-screenshots.md + report-screenshots.json.
 *
 *   node compare-screenshots.mjs --shots-dir <root> --report-dir tests
 *        [--run <runId>] [--fail-under N] [--strict] [--exclude /a,/b]
 *        [--include /a,/b]
 *
 * <root> holds the shared prod/ baseline plus one directory PER RUN,
 * runs/<runId>/{migrated,diff} (see capture.mjs / stage 6200) — screenshots live
 * outside git, so the run id is what keeps an older run's images from being
 * overwritten by the next one. --run selects which run to score (default: the run
 * named by runs/latest.json; a root-level migrated/ from before per-run storage is
 * still honoured as a fallback). Diff PNGs are written next to that run's migrated/;
 * the markdown/json reports go to --report-dir (tests/, committed as run evidence —
 * enables the git-based regression diff, same as compare.mjs).
 *
 * Scoring mirrors the content report so TEST_SCREENSHOT_FAIL_UNDER reads like
 * TEST_FAIL_UNDER: a per-component SCORE = 100 − mismatch% (100 = identical);
 * page score = height-weighted mean of its component scores; overall = mean of
 * page scores over scored pages. Advisory by default (exit 0 even below the
 * threshold) unless --strict is passed.
 *
 * Pixel diff uses pixelmatch + sharp (both prebuilt, no native canvas build) and
 * lives in lib/pixdiff.mjs, which is unit-tested. Short version: a size
 * disagreement within 2px is layout rounding and is not compared; beyond that it
 * is content and its non-blank part is counted. The old pad-the-shorter-image-
 * with-white rule both invented findings at the disputed edge AND hid real
 * content loss that happened to sit on white.
 *
 * Not every pair is scored. Three outcomes are "not compared" rather than a
 * zero, are excluded from the score and the regression diff, and are counted in
 * their own report sections:
 *   - `skipped-in-*`   the capture resolved the element but declined to shoot it;
 *                      the OTHER side captured it. `reason` says which: `zero-size`
 *                      / `below-min-height` are harness THRESHOLDS (nothing worth
 *                      photographing), `unstable-layout` means the page was still
 *                      relaying out and the shot would have been the right picture
 *                      at the wrong offset. Neither is a rendering difference.
 *   - `compare-error`  sharp/pixelmatch threw. Always a harness fault.
 * A component genuinely absent from one side (resolved nowhere, not skipped)
 * still scores 0 as `missing-in-migrated` / `extra-in-migrated`.
 */
import fs from "fs";
import path from "path";
import { imageMeta } from "./lib/img.mjs";
import { compareImages } from "./lib/pixdiff.mjs";
import {
  parseArgs,
  requireArg,
  readJson,
  writeJson,
  pathToSlugDir,
  loadPreviousReport,
  failedPagePaths,
  makePathExcluder,
  makePathIncluder,
} from "./lib/util.mjs";

const args = parseArgs(process.argv.slice(2));
const shotsDir = requireArg(args, "shots-dir");
const reportDir = requireArg(args, "report-dir");
const failUnder = args["fail-under"] ? parseFloat(args["fail-under"]) : null;
const strict = Boolean(args["strict"]);
const prevReportArg = typeof args["prev-report"] === "string" ? args["prev-report"] : null;
// Failed-only: 6200 captured migrated screenshots for only the pages that failed
// in the previous CONTENT report, so scope this compare to the same set (else
// every un-captured page reads as missing-in-migrated). Derived from the content
// report.json, the canonical gate that also drives capture.mjs --only-failed.
const onlyFailed = Boolean(args["only-failed"]);
// Exact paths and `*` globs (e.g. `*/data/*`) — see makePathExcluder.
const excludePaths = makePathExcluder(args["exclude"]);
// Frontend-coverage allowlist, same meaning as in compare.mjs. Empty = whole site.
const includePaths = makePathIncluder(args["include"]);

const prodDir = path.join(shotsDir, "prod");

/**
 * Locate the run whose stage screenshots we score. Preference order:
 *   1. --run <id>            the run 6400 was invoked for (normally this run)
 *   2. runs/latest.json      the last run that captured successfully
 *   3. <root>/migrated       pre-per-run layout, so an old tree still compares
 * A --run that carries no manifest falls through rather than failing: a
 * `-StartAt 6400` slice runs under a NEW attempt number while the screenshots on
 * disk still belong to the attempt that captured them.
 */
function resolveRun() {
  const runsRoot = path.join(shotsDir, "runs");
  const hasShots = (dir) => fs.existsSync(path.join(dir, "manifest.json"));
  const asRun = (id, why) => {
    const migrated = path.join(runsRoot, id, "migrated");
    return hasShots(migrated)
      ? { runId: id, migDir: migrated, diffDir: path.join(runsRoot, id, "diff"), why }
      : null;
  };
  const wanted = typeof args.run === "string" ? args.run.trim() : "";
  let latest = null;
  try {
    latest = readJson(path.join(runsRoot, "latest.json")).runId;
  } catch {}
  const picked =
    (wanted && asRun(wanted, "--run")) ||
    (latest && asRun(latest, "runs/latest.json")) ||
    (hasShots(path.join(shotsDir, "migrated"))
      ? {
          runId: null,
          migDir: path.join(shotsDir, "migrated"),
          diffDir: path.join(shotsDir, "diff"),
          why: "legacy root-level migrated/",
        }
      : null);
  if (!picked) {
    console.error(
      `No stage screenshots found under ${shotsDir} (looked for runs/${wanted || "<latest>"}/migrated, runs/latest.json and migrated/) — run 6200 with a screenshots/full capture mode first.`
    );
    process.exit(1);
  }
  if (wanted && picked.runId !== wanted) {
    console.warn(`Run "${wanted}" has no captured screenshots — scoring ${picked.runId || "the legacy set"} instead (${picked.why}).`);
  }
  return picked;
}

const run = resolveRun();
const migDir = run.migDir;
const diffDir = run.diffDir;
console.log(`Stage screenshots: ${migDir}${run.runId ? ` (run ${run.runId}, via ${run.why})` : " (legacy layout)"}`);

if (!fs.existsSync(path.join(prodDir, "manifest.json"))) {
  console.error(`No prod screenshot manifest at ${path.join(prodDir, "manifest.json")} — run 6150 first.`);
  process.exit(1);
}
const prodManifest = readJson(path.join(prodDir, "manifest.json"));
const migManifest = readJson(path.join(migDir, "manifest.json"));

const fmt = (n) => (n === null || n === undefined ? "—" : (Math.round(n * 10) / 10).toFixed(1));

/** A page dir's .components.json, or null. */
function componentsDoc(pageDir) {
  const file = path.join(pageDir, ".components.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** key → display name, from a page dir's .components.json. */
function componentNames(doc) {
  const map = new Map();
  for (const c of doc?.components || []) map.set(c.key, c.name);
  for (const c of doc?.skipped || []) map.set(c.key, c.name);
  return map;
}

/**
 * Keys the capture RESOLVED on this side but deliberately did not shoot, mapped to
 * WHY. Two different things end up here and the report must not conflate them:
 * `zero-size` / `below-min-height` are capture THRESHOLDS (the element is there,
 * it is just not worth a picture), while `unstable-layout` is the harness refusing
 * to publish a shot it could not take cleanly - the page was still relaying out, so
 * the image would have been the right picture at the wrong offset. Either way the
 * pair is not comparable, but only the second one points at a page to look at.
 *
 * Written by capture.mjs since the intersection-scoring change; a dataset captured
 * before it has no `skipped` array (old missing/extra behaviour for those keys), and
 * one captured before the stability gate has entries with no `reason`.
 */
function skippedReasons(doc) {
  const map = new Map();
  for (const c of doc?.skipped || []) {
    if (c.key) map.set(c.key, c.reason || "threshold");
  }
  return map;
}

/** Component subfolders under a page dir that contain the expected image. */
function listComponentKeys(pageDir, imgSuffix) {
  if (!fs.existsSync(pageDir)) return [];
  return fs
    .readdirSync(pageDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(pageDir, name, `${name}${imgSuffix}`)));
}

function diffTag(mismatch) {
  if (mismatch === null || mismatch === undefined) return "not-compared";
  if (mismatch === 0) return "perfect-match";
  if (mismatch <= 1) return "minor-diff";
  if (mismatch <= 5) return "medium-diff";
  if (mismatch <= 20) return "major-diff";
  return "critical-diff";
}

async function imageHeight(file) {
  try {
    return (await imageMeta(file)).height || 0;
  } catch {
    return 0;
  }
}

function stripDomain(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/$/, "") || "/";
  } catch {
    return url;
  }
}

/* ---------- score one page ---------- */
async function scorePage(pagePath) {
  const slug = pathToSlugDir(pagePath);
  const prodPageDir = path.join(prodDir, slug);
  const migPageDir = path.join(migDir, slug);
  const diffPageDir = path.join(diffDir, slug);

  const prodDoc = componentsDoc(prodPageDir);
  const migDoc = componentsDoc(migPageDir);
  const names = new Map([...componentNames(prodDoc), ...componentNames(migDoc)]);
  const prodSkipped = skippedReasons(prodDoc);
  const migSkipped = skippedReasons(migDoc);

  // Redirect parity: a page that redirects somewhere different on each side is
  // not the same page — score 0 (mirrors the content report's status parity).
  const prodRedirect = path.join(prodPageDir, "redirect.txt");
  const migRedirect = path.join(migPageDir, "redirect.txt");
  const prodFinal = fs.existsSync(prodRedirect) ? fs.readFileSync(prodRedirect, "utf8").trim() : null;
  const migFinal = fs.existsSync(migRedirect) ? fs.readFileSync(migRedirect, "utf8").trim() : null;
  if (prodFinal && migFinal && stripDomain(prodFinal) !== stripDomain(migFinal)) {
    return {
      path: pagePath,
      score: 0,
      redirectMismatch: true,
      prodFinalUrl: prodFinal,
      stageFinalUrl: migFinal,
      components: [],
    };
  }

  const prodKeys = listComponentKeys(prodPageDir, "_prod.png");
  const migKeys = listComponentKeys(migPageDir, "_migrated.png");
  const allKeys = [...new Set([...prodKeys, ...migKeys])];
  if (allKeys.length === 0) return null; // nothing captured either side — not scored

  const prodSet = new Set(prodKeys);
  const migSet = new Set(migKeys);

  const components = [];
  let weightedMismatch = 0;
  let totalHeight = 0;
  let comparedCount = 0;

  for (const key of allKeys) {
    const name = names.get(key) || key;
    const prodImg = path.join(prodPageDir, key, `${key}_prod.png`);
    const migImg = path.join(migPageDir, key, `${key}_migrated.png`);
    const diffImg = path.join(diffPageDir, key, `${key}_diff.png`);

    // One side has no image. A deliberate capture SKIP on the other side (the
    // element resolved but was zero-width / below --min-height) is a harness
    // threshold, not a rendering difference - score neither side. Absent for any
    // other reason still means the component is genuinely not there.
    if (prodSet.has(key) && !migSet.has(key)) {
      if (migSkipped.has(key)) {
        components.push({ key, name, mismatch: null, score: null, tag: "skipped-in-migrated", reason: migSkipped.get(key) });
        continue;
      }
      const height = await imageHeight(prodImg);
      weightedMismatch += 100 * height;
      totalHeight += height;
      comparedCount++;
      components.push({ key, name, mismatch: 100, score: 0, tag: "missing-in-migrated", height });
      continue;
    }
    if (!prodSet.has(key) && migSet.has(key)) {
      if (prodSkipped.has(key)) {
        components.push({ key, name, mismatch: null, score: null, tag: "skipped-in-prod", reason: prodSkipped.get(key) });
        continue;
      }
      const height = await imageHeight(migImg);
      weightedMismatch += 100 * height;
      totalHeight += height;
      comparedCount++;
      components.push({ key, name, mismatch: 100, score: 0, tag: "extra-in-migrated", height });
      continue;
    }

    try {
      const { mismatch, height, prodSize, migSize, diffWritten } = await compareImages(prodImg, migImg, diffImg);
      if (height > 0) {
        weightedMismatch += mismatch * height;
        totalHeight += height;
      }
      comparedCount++;
      components.push({
        key,
        name,
        mismatch: Math.round(mismatch * 100) / 100,
        score: Math.max(0, 100 - mismatch),
        tag: diffTag(mismatch),
        height,
        prodSize,
        migSize,
        diffImg: diffWritten ? path.relative(shotsDir, diffImg) : null,
      });
    } catch (err) {
      // A harness fault (sharp/pixelmatch threw), never a content verdict -
      // score null so it stays out of the page score, the diff list and the
      // regression comparison, and gets its own count in the report.
      components.push({
        key,
        name,
        mismatch: null,
        score: null,
        tag: "compare-error",
        error: String(err.message || err).slice(0, 200),
      });
    }
  }

  // Nothing comparable on this page (every component skipped on one side or
  // errored) - not scored, rather than a free 100.
  if (comparedCount === 0) return null;

  const score = totalHeight > 0 ? Math.max(0, 100 - weightedMismatch / totalHeight) : 100;
  return { path: pagePath, score, components };
}

/* ---------- regression diff vs previous report (git / --prev-report) ---------- */
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
function diffKey(page, key) {
  return `${page} ${key}`;
}
function collectDiffs(reportPages) {
  const out = [];
  for (const p of reportPages || []) {
    for (const c of p.components || []) {
      if ((c.score ?? 100) < 100)
        out.push({ page: p.path, key: c.key, name: c.name, score: c.score ?? 0 });
    }
  }
  return out;
}
/* ---------- run ---------- */
let failedSet = null;
if (onlyFailed) {
  const prevContent = loadPreviousReport(reportDir, prevReportArg, "report.json");
  const s = prevContent ? failedPagePaths(prevContent.report, excludePaths) : new Set();
  if (s.size > 0) {
    failedSet = s;
    console.log(`--only-failed: scoring ${s.size} previously-failed pages (from ${prevContent.source}).`);
  } else {
    console.warn("--only-failed: no failed pages in the previous content report — scoring the full set.");
  }
}
const candidatePaths = Object.entries(prodManifest.pages)
  .filter(
    ([p, rec]) =>
      rec.status === 200 && !rec.noIndex && (!failedSet || failedSet.has(p)) && includePaths.has(p)
  )
  .map(([p]) => p)
  .sort();

const excluded = [];
const noComponents = [];
const pages = [];
for (const pagePath of candidatePaths) {
  if (excludePaths.has(pagePath)) {
    excluded.push(pagePath);
    continue;
  }
  const scored = await scorePage(pagePath);
  if (scored === null) {
    noComponents.push(pagePath);
    continue;
  }
  pages.push(scored);
}

const overall = pages.length ? pages.reduce((n, p) => n + p.score, 0) / pages.length : 100;
const allDiffs = collectDiffs(pages);
const allComponents = pages.flatMap((p) => p.components.map((c) => ({ ...c, page: p.path })));
const totalComponents = allComponents.length;
// A component is COMPARED only when it produced a numeric score. The rest split
// into two buckets that are counted separately and never scored, so a harness
// gap can never masquerade as a content regression (or as a clean 100).
const comparedComponents = allComponents.filter((c) => typeof c.score === "number");
const compareErrors = allComponents.filter((c) => c.tag === "compare-error");
const skippedPairs = allComponents.filter((c) => c.tag === "skipped-in-migrated" || c.tag === "skipped-in-prod");
// A shot the harness refused to publish because the page moved through the raster.
// Broken out of the routine threshold skips: it is the one skip reason that means
// "this page could not be photographed", not "there was nothing worth photographing".
const unstablePairs = skippedPairs.filter((c) => c.reason === "unstable-layout");
// Total-loss components: nothing matched visually (incl. missing-in-migrated /
// extra-in-migrated). Reported next to the diff count — a 0 is a different kind
// of problem from a 98.
const zeroComponents = allDiffs.filter((d) => (d.score ?? 0) <= 0).length;
const perfectPages = pages.filter((p) => p.score >= 100).length;
const redirectMismatches = pages.filter((p) => p.redirectMismatch);

// Regression diff (previous report-screenshots.json, git history / --prev-report)
const prev = loadPreviousReport(reportDir, prevReportArg, "report-screenshots.json");
let comparison = null;
if (prev) {
  const inScope = (p) => (!failedSet || failedSet.has(p)) && includePaths.has(p);
  const prevPages = (prev.report.pages || []).filter((p) => inScope(p.path));
  const curDiffs = allDiffs;
  const prevDiffs = collectDiffs(prevPages);
  const curKeys = new Set(curDiffs.map((d) => diffKey(d.page, d.key)));
  const prevKeys = new Set(prevDiffs.map((d) => diffKey(d.page, d.key)));
  comparison = {
    source: prev.source,
    prevGeneratedAt: prev.report.generatedAt || null,
    prevOverall: typeof prev.report.overallScore === "number" ? prev.report.overallScore : null,
    curOverall: overall,
    buckets: {
      full: { prev: bucketCounts(prevPages).full, cur: bucketCounts(pages).full },
      mid: { prev: bucketCounts(prevPages).mid, cur: bucketCounts(pages).mid },
      low: { prev: bucketCounts(prevPages).low, cur: bucketCounts(pages).low },
    },
    prevDiffCount: prevDiffs.length,
    curDiffCount: curDiffs.length,
    newDiffs: curDiffs.filter((d) => !prevKeys.has(diffKey(d.page, d.key))),
    goneDiffs: prevDiffs.filter((d) => !curKeys.has(diffKey(d.page, d.key))),
  };
}

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const signedF = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));

/* ---------- report-screenshots.md ---------- */
const lines = [];
lines.push(`# E2E screenshot comparison — ${new Date().toISOString()}`);
lines.push("");
lines.push(`- Mode: V2 (selector-driven, index.json)`);
lines.push(`- Prod (baseline): ${prodManifest.baseUrl} — captured ${prodManifest.generatedAt}${prodManifest.partial ? " ⚠️ PARTIAL (--limit)" : ""}`);
lines.push(`- Stage (actual): ${migManifest.baseUrl} — captured ${migManifest.generatedAt}${migManifest.partial ? " ⚠️ PARTIAL (--limit)" : ""}`);
lines.push(`- Screenshots dir: ${shotsDir}`);
lines.push(`- Stage screenshots: ${migDir}${run.runId ? ` (run \`${run.runId}\`)` : ""}`);
lines.push(`- Pages: ${candidatePaths.length} prod-200 with components, ${pages.length} scored${noComponents.length ? `, ${noComponents.length} with no captured components (not scored)` : ""}${excluded.length ? `, ${excluded.length} excluded` : ""}`);
if (failedSet) {
  lines.push(`- ⚠️ **FAILED-ONLY subset** (${failedSet.size} pages that failed in the previous content report) — visual score below is over these pages only, not the full site.`);
}
lines.push("");
lines.push(`## Overall visual score${failedSet ? " (failed-only subset)" : ""}: ${fmt(overall)}%`);
lines.push("");
lines.push(
  `${comparedComponents.length} of ${totalComponents} component screenshots compared, ${allDiffs.length} differ (${zeroComponents} score 0), ${perfectPages} pages at 100%, ${redirectMismatches.length} redirect-parity mismatches.`
);
lines.push("");
lines.push(
  `Not compared: ${skippedPairs.length} one-side-skipped (${unstablePairs.length} unstable layout, rest below --min-height / zero-width) + ${compareErrors.length} compare-error (harness fault). Neither counts toward the score.`
);
if (failUnder !== null && Number.isFinite(failUnder)) {
  lines.push("");
  lines.push(`Threshold TEST_SCREENSHOT_FAIL_UNDER=${failUnder}% → **${overall < failUnder ? "BELOW ❌" : "OK ✅"}**${strict ? "" : " (advisory — does not fail the run)"}.`);
}
lines.push("");

if (comparison) {
  const c = comparison;
  const b = c.buckets;
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
  lines.push(`Component diffs: ${c.prevDiffCount} → ${c.curDiffCount} (${signed(c.curDiffCount - c.prevDiffCount)}) — **${c.newDiffs.length} new**, **${c.goneDiffs.length} gone**.`);
  lines.push("");
  lines.push(`### New diffs (${c.newDiffs.length}) — new visual regressions (vs previous report)`);
  lines.push("");
  if (c.newDiffs.length) {
    const byPage = new Map();
    for (const d of c.newDiffs) {
      if (!byPage.has(d.page)) byPage.set(d.page, []);
      byPage.get(d.page).push(d);
    }
    for (const [page, items] of byPage) {
      items.sort((a, b) => a.score - b.score);
      lines.push(`- ${page}`);
      for (const d of items) lines.push(`  - ${d.name} — score ${Math.floor(d.score)}`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("");
  lines.push(`### Gone diffs (${c.goneDiffs.length}) — fixed / no longer differing (vs previous report)`);
  lines.push("");
  if (c.goneDiffs.length) {
    const byPage = new Map();
    for (const d of c.goneDiffs) {
      if (!byPage.has(d.page)) byPage.set(d.page, []);
      byPage.get(d.page).push(d);
    }
    for (const [page, items] of byPage) {
      lines.push(`- ${page}`);
      for (const d of items) lines.push(`  - ${d.name}`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("");
} else {
  lines.push("## Change since previous report");
  lines.push("");
  lines.push("_No previous report-screenshots.json found in git history — this is the baseline._");
  lines.push("");
}

if (excluded.length) {
  lines.push(`## Excluded pages (${excluded.length}) — not scored`);
  lines.push("");
  for (const p of excluded) lines.push(`- ${p}`);
  lines.push("");
}

if (redirectMismatches.length) {
  lines.push(`## Redirect-parity mismatches (${redirectMismatches.length}) — scored 0`);
  lines.push("");
  lines.push("| prod → | stage → | path |");
  lines.push("|---|---|---|");
  for (const p of redirectMismatches) lines.push(`| ${p.prodFinalUrl} | ${p.stageFinalUrl} | ${p.path} |`);
  lines.push("");
}

if (compareErrors.length) {
  lines.push(`## Compare errors (${compareErrors.length}) — HARNESS FAULT, not scored`);
  lines.push("");
  lines.push("These pairs could not be diffed at all. Fix the harness — they are not content findings.");
  lines.push("");
  for (const c of compareErrors) lines.push(`- ${c.page} — ${c.name} — ${c.error}`);
  lines.push("");
}

if (skippedPairs.length) {
  lines.push(`## One-side-skipped (${skippedPairs.length}) — not compared`);
  lines.push("");
  lines.push(
    "The capture resolved the element on both sides but declined to shoot it on one, so the pair is left unscored rather than counted as a total loss. `zero-size` / `below-min-height` are capture thresholds and are routine. `unstable-layout` is not: the page was still relaying out, so a shot would have been the right picture at the wrong offset (see waitForLayoutStable) — those pages are worth a look."
  );
  lines.push("");
  for (const c of skippedPairs) lines.push(`- ${c.page} — ${c.name} (${c.tag}${c.reason ? `, ${c.reason}` : ""})`);
  lines.push("");
}

lines.push(`## Per-page visual scores (worst first)`);
lines.push("");
lines.push("| score | components | diffs | page |");
lines.push("|---|---|---|---|");
for (const p of [...pages].sort((a, b) => a.score - b.score)) {
  const diffs = p.components.filter((c) => (c.score ?? 100) < 100).length;
  const note = p.redirectMismatch ? " (redirect parity mismatch)" : "";
  lines.push(`| ${fmt(p.score)} | ${p.components.length} | ${diffs} | ${p.path}${note} |`);
}
lines.push("");

lines.push(`## Component diffs (score < 100): ${allDiffs.length} (${zeroComponents} score 0)`);
lines.push("");
const diffComps = [];
for (const p of pages) {
  for (const c of p.components) {
    if ((c.score ?? 100) < 100) diffComps.push({ ...c, page: p.path });
  }
}
for (const c of diffComps.sort((a, b) => a.score - b.score)) {
  const mm = c.mismatch === null || c.mismatch === undefined ? "n/a" : `${c.mismatch}%`;
  const diffPart = c.diffImg ? ` — diff: ${path.join(shotsDir, c.diffImg)}` : "";
  lines.push(`- ${c.page} — ${c.name} — score ${Math.floor(c.score)} (${mm}, ${c.tag})${diffPart}`);
}
lines.push("");

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, "report-screenshots.md"), lines.join("\n"), "utf8");

writeJson(path.join(reportDir, "report-screenshots.json"), {
  generatedAt: new Date().toISOString(),
  mode: "v2",
  prodUrl: prodManifest.baseUrl,
  stageUrl: migManifest.baseUrl,
  shotsDir,
  // Which run's stage screenshots these scores describe. The viewer resolves the
  // PNGs through it, so an older report keeps pointing at its own images.
  runId: run.runId,
  migratedDir: migDir,
  diffDir,
  overallScore: overall,
  failedOnly: failedSet ? { count: failedSet.size } : undefined,
  pagesScored: pages.length,
  pagesPerfect: perfectPages,
  // componentsCompared counts only pairs that produced a score; the two
  // not-compared buckets are reported alongside it, never folded into it.
  componentsCompared: comparedComponents.length,
  componentsSeen: totalComponents,
  componentsNotCompared: skippedPairs.length + compareErrors.length,
  componentsSkippedOneSide: skippedPairs.length,
  componentsCompareError: compareErrors.length,
  compareErrors: compareErrors.map((c) => ({ path: c.page, key: c.key, name: c.name, error: c.error })),
  skippedOneSide: skippedPairs.map((c) => ({ path: c.page, key: c.key, name: c.name, tag: c.tag, reason: c.reason || null })),
  componentsScoringZero: zeroComponents,
  excluded,
  noComponents,
  redirectMismatches: redirectMismatches.map((p) => ({ path: p.path, prodFinalUrl: p.prodFinalUrl, stageFinalUrl: p.stageFinalUrl })),
  comparison,
  pages,
});

/* ---------- stdout summary ---------- */
console.log(
  `Overall visual score: ${fmt(overall)}% over ${pages.length} pages (${comparedComponents.length}/${totalComponents} components compared, ${allDiffs.length} diffs, ${zeroComponents} scoring 0, ${perfectPages} pages at 100%)`
);
if (skippedPairs.length || compareErrors.length) {
  console.log(`  not compared: ${skippedPairs.length} one-side-skipped (${unstablePairs.length} unstable layout), ${compareErrors.length} compare-error${compareErrors.length ? " (harness fault — see the report)" : ""}`);
}
if (comparison) {
  const c = comparison;
  const b = c.buckets;
  console.log(`vs previous (${c.source})${c.prevOverall !== null ? `: ${fmt(c.prevOverall)}% → ${fmt(c.curOverall)}% (${signedF(c.curOverall - c.prevOverall)})` : ""}`);
  console.log(`  pages 100%: ${b.full.prev} → ${b.full.cur} (${signed(b.full.cur - b.full.prev)}); 50–100%: ${b.mid.prev} → ${b.mid.cur} (${signed(b.mid.cur - b.mid.prev)}); 0–50%: ${b.low.prev} → ${b.low.cur} (${signed(b.low.cur - b.low.prev)})`);
  console.log(`  component diffs: ${c.newDiffs.length} new, ${c.goneDiffs.length} gone (${c.prevDiffCount} → ${c.curDiffCount})`);
} else {
  console.log("vs previous: no previous report found (baseline).");
}
for (const p of [...pages].sort((a, b) => a.score - b.score).slice(0, 10)) {
  if (p.score < 100) console.log(`  worst: ${fmt(p.score)}%  ${p.path}`);
}
console.log(`Report: ${path.join(reportDir, "report-screenshots.md")}`);

if (failUnder !== null && Number.isFinite(failUnder) && overall < failUnder) {
  const msg = `Overall visual score ${fmt(overall)}% is below TEST_SCREENSHOT_FAIL_UNDER=${failUnder}`;
  if (strict) {
    console.error(`${msg} — failing (--strict).`);
    process.exit(1);
  }
  console.warn(`${msg} — advisory only, not failing the run.`);
}
process.exit(0);
