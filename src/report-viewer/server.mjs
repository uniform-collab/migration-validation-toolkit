/**
 * E2E report viewer — an interactive front end for what `tests/report*.md` says
 * in prose. Zero dependencies (Node's own http/fs), zero network access: it only
 * reads the artifacts a 6-tests run already produced.
 *
 *   migration-validate report-viewer [--port 8099] [--open] [--root <repo>]
 *   (a host pipeline may wrap this in its own launcher script)
 *
 * It joins the three reports and the on-disk datasets on `path` + `componentKey`
 * — the same pairing the compares use — so one component instance shows its
 * content score, its visual score, its two innerTexts and its three screenshots
 * side by side:
 *
 *   tests/report.json              content scores per page/element (+ regression diff)
 *   tests/report-screenshots.json  visual scores per page/component
 *   tests/report-components.json   per-component-type aggregate (content)
 *   <expected-dir>/                prod innerText, <slug>/<key>.txt
 *   <actual-dir>/                  stage innerText, <slug>/<key>.txt
 *   TEST_SCREENSHOT_DIR/prod/<slug>/<key>/<key>_prod.png                    (baseline)
 *   TEST_SCREENSHOT_DIR/runs/<runId>/{migrated,diff}/<slug>/<key>/...        (per run)
 *
 * Reports are re-read whenever their mtime changes, so a fresh run shows up on
 * reload — no restart. See the package README.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeText, pathToSlugDir } from "../lib/util.mjs";
import { lcsSpan } from "./lcs-span.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args + env
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
    args[a.slice(2)] = process.argv[++i];
  else args[a.slice(2)] = "1";
}

// The repo the reports live in. The viewer ships as a standalone package now, so
// there is no fixed path from this file to that repo: --root wins, else the cwd the
// caller launched from (the pipeline wrapper passes --root explicitly).
const ROOT = path.resolve(args.root || process.cwd());

/** Minimal .env reader: KEY=VALUE, full-line # comments only (values keep '#'). */
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq === -1) continue;
    out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  return out;
}

const env = readEnv(path.join(ROOT, ".env"));
const PORT = parseInt(args.port || env.TEST_REPORT_VIEWER_PORT || "8099", 10);
const REPORT_DIR = path.resolve(args["report-dir"] || path.join(ROOT, "tests"));
const SHOTS_DIR = (args.shots || env.TEST_SCREENSHOT_DIR || "").trim();
const PUBLIC_DIR = path.join(HERE, "public");
// Dataset overrides (see buildModel). Empty = derive from ROOT/REPORT_DIR.
const EXPECTED_DIR_ARG = (typeof args["expected-dir"] === "string" ? args["expected-dir"] : "").trim();
const ACTUAL_DIR_ARG = (typeof args["actual-dir"] === "string" ? args["actual-dir"] : "").trim();
// Which run's stage screenshots to show. Screenshots live outside git, one dir per
// run, so a report checked out from an older stage commit must resolve ITS run's
// images rather than the newest ones on disk. --run overrides; otherwise the run
// recorded in report-screenshots.json wins, then runs/latest.json, then the
// pre-per-run root layout.
const RUN_ARG = (typeof args.run === "string" ? args.run : "").trim();

const readJsonSafe = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
};
const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

// ------------------------------------------------------------------- model
const FILES = {
  content: path.join(REPORT_DIR, "report.json"),
  visual: path.join(REPORT_DIR, "report-screenshots.json"),
  components: path.join(REPORT_DIR, "report-components.json"),
};

let cache = { stamp: "", model: null };

function buildModel() {
  const stamp = Object.values(FILES).map(mtime).join("|");
  if (cache.stamp === stamp && cache.model) return cache.model;

  const content = readJsonSafe(FILES.content);
  const visual = readJsonSafe(FILES.visual);
  const components = readJsonSafe(FILES.components);
  SHOT_RUN = resolveShotRun(visual);

  // Both compares emit `pages` as an ARRAY of records carrying their own `path`
  // (tolerate a path-keyed object too, in case that ever changes).
  const listOf = (rep) =>
    Array.isArray(rep?.pages) ? rep.pages : Object.values(rep?.pages || {});
  const contentPages = listOf(content);
  const visualPages = listOf(visual);
  const indexBy = (list) => {
    const m = new Map();
    for (const rec of list) if (rec?.path != null) m.set(rec.path, rec);
    return m;
  };
  const contentByPath = indexBy(contentPages);
  const visualByPath = indexBy(visualPages);

  const mode = content?.mode || visual?.mode || "v2";
  // Where the two innerText datasets live. Both are caller-owned (the expected side is
  // committed with the project, the actual side is written per run), so --expected-dir /
  // --actual-dir are the supported way in; the defaults just keep the historical layout
  // working when the viewer is launched with only --root.
  const datasets = {
    expected: EXPECTED_DIR_ARG
      ? path.resolve(EXPECTED_DIR_ARG)
      : path.join(ROOT, "src/data/tests", "expected-v2"),
    actual: ACTUAL_DIR_ARG
      ? path.resolve(ACTUAL_DIR_ARG)
      : path.join(REPORT_DIR, "actual-v2"),
  };

  /** path -> merged page record */
  const pages = new Map();
  const page = (p) => {
    if (!pages.has(p)) {
      pages.set(p, {
        path: p,
        slug: pathToSlugDir(p),
        contentScore: null,
        visualScore: null,
        prodStatus: null,
        stageStatus: null,
        statusMismatch: false,
        elements: 0,
        contentDiffs: 0,
        contentZeros: 0,
        shots: 0,
        visualDiffs: 0,
        visualZeros: 0,
        worstContent: null,
        worstVisual: null,
      });
    }
    return pages.get(p);
  };

  for (const rec of contentPages) {
    const r = page(rec.path);
    r.contentScore = rec.score ?? null;
    r.prodStatus = rec.prodStatus ?? null;
    r.stageStatus = rec.stageStatus ?? null;
    r.statusMismatch = Boolean(rec.statusMismatch);
    for (const e of rec.elements || []) {
      r.elements++;
      if (e.score < 100) r.contentDiffs++;
      if (e.score === 0) r.contentZeros++;
      if (r.worstContent === null || e.score < r.worstContent)
        r.worstContent = e.score;
    }
  }
  // A visual component with a NON-NUMERIC score was deliberately not compared
  // (one-side-skipped, or compare-error = a harness fault). It is neither a diff
  // nor a zero, and it must not drag an average down as a 0 - skip it wholesale.
  const scored = (c) => typeof c.score === "number";
  for (const rec of visualPages) {
    const r = page(rec.path);
    r.visualScore = rec.score ?? null;
    for (const c of rec.components || []) {
      if (!scored(c)) {
        r.shotsNotCompared = (r.shotsNotCompared || 0) + 1;
        continue;
      }
      r.shots++;
      if (c.score < 100) r.visualDiffs++;
      if (c.score === 0) r.visualZeros++;
      if (r.worstVisual === null || c.score < r.worstVisual)
        r.worstVisual = c.score;
    }
  }

  // Per-component-type aggregate over BOTH dimensions. report-components.json
  // covers content only (and may be from a different run), so recompute here to
  // guarantee the two columns describe the same instance set the viewer shows.
  const byType = new Map();
  const type = (name) => {
    if (!byType.has(name)) {
      byType.set(name, {
        name,
        contentScores: [],
        visualScores: [],
        pages: new Set(),
        contentZeros: 0,
        visualZeros: 0,
        instances: 0,
      });
    }
    return byType.get(name);
  };
  for (const rec of contentPages) {
    for (const e of rec.elements || []) {
      const t = type(e.name || e.key);
      t.contentScores.push(e.score);
      t.pages.add(rec.path);
      t.instances++;
      if (e.score === 0) t.contentZeros++;
    }
  }
  for (const rec of visualPages) {
    for (const c of rec.components || []) {
      if (!scored(c)) continue;
      const t = type(c.name || c.key);
      t.visualScores.push(c.score);
      t.pages.add(rec.path);
      if (c.score === 0) t.visualZeros++;
    }
  }
  // Diff-severity tallies (the compares' own `tag` field) and the flat worst-first
  // instance list the overview links from — both need per-element data, which the
  // /api/overview payload deliberately does not ship.
  const tags = { content: {}, visual: {} };
  const instances = new Map();
  const instance = (p, key, name) => {
    const k = `${p}|${key}`;
    if (!instances.has(k))
      instances.set(k, {
        page: p,
        key,
        name,
        contentScore: null,
        visualScore: null,
        tag: null,
        visualTag: null,
      });
    return instances.get(k);
  };
  for (const rec of contentPages) {
    for (const e of rec.elements || []) {
      if (e.tag) tags.content[e.tag] = (tags.content[e.tag] || 0) + 1;
      const it = instance(rec.path, e.key || e.index, e.name || e.key);
      it.contentScore = e.score;
      it.tag = e.tag || null;
    }
  }
  for (const rec of visualPages) {
    for (const c of rec.components || []) {
      if (!scored(c)) continue;
      // Only tags of actual diffs: the compare also tags identical pairs
      // (`perfect-match`), which would otherwise dominate the severity chart.
      if (c.tag && c.score < 100) tags.visual[c.tag] = (tags.visual[c.tag] || 0) + 1;
      const it = instance(rec.path, c.key, c.name || c.key);
      it.visualScore = c.score;
      it.visualTag = c.tag || null;
    }
  }
  const worstOf = (i) => Math.min(i.contentScore ?? 101, i.visualScore ?? 101);
  const worstInstances = [...instances.values()]
    .filter((i) => worstOf(i) < 100)
    .sort((a, b) => worstOf(a) - worstOf(b))
    .slice(0, 60);

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const componentTypes = [...byType.values()]
    .map((t) => ({
      name: t.name,
      instances: t.instances || t.visualScores.length,
      pages: t.pages.size,
      contentAvg: mean(t.contentScores),
      visualAvg: mean(t.visualScores),
      contentScored: t.contentScores.length,
      visualScored: t.visualScores.length,
      contentDiffs: t.contentScores.filter((s) => s < 100).length,
      visualDiffs: t.visualScores.filter((s) => s < 100).length,
      contentZeros: t.contentZeros,
      visualZeros: t.visualZeros,
    }))
    .sort((a, b) => (a.contentAvg ?? 101) - (b.contentAvg ?? 101));

  const model = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    shotsDir: SHOTS_DIR || visual?.shotsDir || "",
    shotRun: SHOT_RUN,
    datasets,
    mode,
    prodUrl: content?.prodUrl || visual?.prodUrl || "",
    stageUrl: content?.stageUrl || visual?.stageUrl || "",
    content: content
      ? {
          generatedAt: content.generatedAt,
          overallScore: content.overallScore,
          pagesScored: content.pagesScored,
          elementsCompared: content.elementsCompared,
          elementsScoringZero: content.elementsScoringZero,
          statusMismatches: content.statusMismatches,
          excluded: content.excluded || [],
          prodNon200: content.prodNon200 || [],
          stageNon200: content.stageNon200 || [],
          noComponentPages: content.noComponentPages || [],
          noIndexPages: content.noIndexPages || [],
          comparison: content.comparison || null,
        }
      : null,
    visual: visual
      ? {
          generatedAt: visual.generatedAt,
          overallScore: visual.overallScore,
          pagesScored: visual.pagesScored,
          componentsCompared: visual.componentsCompared,
          componentsSeen: visual.componentsSeen ?? visual.componentsCompared,
          componentsNotCompared: visual.componentsNotCompared ?? 0,
          componentsSkippedOneSide: visual.componentsSkippedOneSide ?? 0,
          componentsCompareError: visual.componentsCompareError ?? 0,
          pagesPerfect: visual.pagesPerfect ?? null,
          componentsScoringZero: visual.componentsScoringZero,
          excluded: visual.excluded || [],
          noComponents: visual.noComponents || [],
          redirectMismatches: visual.redirectMismatches || [],
          comparison: visual.comparison || null,
        }
      : null,
    componentsReport: components
      ? { generatedAt: components.generatedAt, pagesScored: components.pagesScored }
      : null,
    pages: [...pages.values()].sort((a, b) => a.path.localeCompare(b.path)),
    componentTypes,
    tags,
    worstInstances,
    // Stripped from /api/overview; the page/component endpoints read it.
    raw: { content, visual, components, contentByPath, visualByPath },
  };

  cache = { stamp, model };
  return model;
}

// ------------------------------------------------------------- page detail
const PNG_SIDES = {
  prod: { side: "prod", suffix: "_prod" },
  migrated: { side: "migrated", suffix: "_migrated" },
  diff: { side: "diff", suffix: "_diff" },
};

/**
 * Directory holding one side's PNGs. prod/ is the shared baseline at the root;
 * migrated/ and diff/ belong to a run. `runId` is resolved once per model build
 * (buildModel -> resolveShotRun) and is null for the legacy root-level layout.
 */
function sideDir(side, runId) {
  if (side === "prod") return path.join(SHOTS_DIR, "prod");
  return runId ? path.join(SHOTS_DIR, "runs", runId, side) : path.join(SHOTS_DIR, side);
}

/** The run whose migrated/diff PNGs pair with the loaded report. */
function resolveShotRun(visualReport) {
  if (!SHOTS_DIR) return null;
  const hasShots = (id) =>
    fs.existsSync(path.join(SHOTS_DIR, "runs", id, "migrated", "manifest.json"));
  const latest = readJsonSafe(path.join(SHOTS_DIR, "runs", "latest.json"))?.runId;
  for (const id of [RUN_ARG, visualReport?.runId, latest]) {
    if (id && hasShots(id)) return id;
  }
  return null; // legacy <root>/migrated + <root>/diff
}

let SHOT_RUN = null;

function shotPath(side, slug, key) {
  const s = PNG_SIDES[side];
  if (!s || !SHOTS_DIR) return null;
  return path.join(sideDir(s.side, SHOT_RUN), slug, key, `${key}${s.suffix}.png`);
}

/** PNG width/height straight out of the IHDR header (no image library). */
function pngSize(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Ordered component list for a page — the UNION over every dataset that has one.
 * The content and screenshot captures can disagree (a component under the 30px
 * screenshot floor is content-only; one whose text was empty is shots-only), and
 * taking the first list alone left the other side's components unordered.
 */
function componentOrder(model, slug) {
  const merged = new Map();
  const dirs = [model.datasets.actual, model.datasets.expected];
  if (SHOTS_DIR)
    dirs.push(sideDir("migrated", SHOT_RUN), sideDir("prod", SHOT_RUN));
  for (const dir of dirs) {
    const doc = readJsonSafe(path.join(dir, slug, ".components.json"));
    for (const c of doc?.components || []) {
      const prev = merged.get(c.key);
      if (!prev) merged.set(c.key, { ...c });
      else if (prev.order == null || (c.order != null && c.order < prev.order))
        prev.order = c.order;
    }
  }
  return [...merged.values()].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
}

function pageDetail(model, pagePath) {
  const slug = pathToSlugDir(pagePath);
  const contentRec = model.raw.contentByPath.get(pagePath) || null;
  const visualRec = model.raw.visualByPath.get(pagePath) || null;

  const rows = new Map();
  const row = (key, name) => {
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        name: name || key,
        order: null,
        content: null,
        visual: null,
        text: null,
        images: {},
        files: {},
      });
    }
    const r = rows.get(key);
    if (name && (!r.name || r.name === key)) r.name = name;
    return r;
  };

  componentOrder(model, slug).forEach((c, i) => {
    const r = row(c.key, c.name);
    r.order = c.order ?? i;
  });
  for (const e of contentRec?.elements || []) {
    const r = row(e.key || e.index, e.name);
    r.content = {
      score: e.score,
      prodLen: e.prodLen,
      stageLen: e.stageLen,
      tag: e.tag || null,
      prodExcerpt: e.prodExcerpt ?? null,
      stageExcerpt: e.stageExcerpt ?? null,
    };
  }
  for (const c of visualRec?.components || []) {
    const r = row(c.key, c.name);
    r.visual = {
      score: c.score,
      mismatch: c.mismatch,
      tag: c.tag || null,
      height: c.height ?? null,
    };
  }

  for (const r of rows.values()) {
    // --- innerText, exactly as the scorer saw it (normalizeText) ------------
    const prodFile = path.join(model.datasets.expected, slug, `${r.key}.txt`);
    const stageFile = path.join(model.datasets.actual, slug, `${r.key}.txt`);
    const prodRaw = readTextFile(prodFile);
    const stageRaw = readTextFile(stageFile);
    r.files.prodTxt = prodFile;
    r.files.stageTxt = stageFile;
    if (prodRaw !== null || stageRaw !== null) {
      const prod = normalizeText(prodRaw ?? "");
      const stage = normalizeText(stageRaw ?? "");
      const span = lcsSpan(prod, stage);
      r.text = {
        prod,
        stage,
        prodRaw: prodRaw ?? null,
        stageRaw: stageRaw ?? null,
        hasProd: prodRaw !== null,
        hasStage: stageRaw !== null,
        // The scored region: 100 * span.length / max(len). Highlighting it is
        // what makes the number readable (one contiguous run, not a word diff).
        span,
        identical: prod === stage,
      };
    }

    // --- screenshots -------------------------------------------------------
    for (const side of Object.keys(PNG_SIDES)) {
      const file = shotPath(side, slug, r.key);
      r.files[`${side}Png`] = file;
      // Stale-diff guard: see componentDetail — a leftover diff PNG from an
      // earlier run outlives the difference it recorded.
      if (side === "diff" && r.visual && r.visual.score >= 100) continue;
      if (file && fs.existsSync(file)) {
        const size = pngSize(file);
        r.images[side] = {
          url: `/img?side=${side}&slug=${encodeURIComponent(
            slug
          )}&key=${encodeURIComponent(r.key)}`,
          w: size?.w ?? null,
          h: size?.h ?? null,
          bytes: fs.statSync(file).size,
        };
      }
    }
  }

  const ordered = [...rows.values()].sort(
    (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.key.localeCompare(b.key)
  );

  const base = (u, p) => (u ? u.replace(/\/+$/, "") + p : null);
  return {
    path: pagePath,
    slug,
    prodStatus: contentRec?.prodStatus ?? null,
    stageStatus: contentRec?.stageStatus ?? null,
    statusMismatch: Boolean(contentRec?.statusMismatch),
    contentScore: contentRec?.score ?? null,
    visualScore: visualRec?.score ?? null,
    prodHref: base(model.prodUrl, pagePath),
    stageHref: base(model.stageUrl, pagePath),
    rows: ordered,
  };
}

/** All instances of one component type, worst-first, for the component view. */
function componentDetail(model, name) {
  const out = [];
  const seen = new Map();
  for (const rec of model.raw.contentByPath.values()) {
    const p = rec.path;
    for (const e of rec.elements || []) {
      if ((e.name || e.key) !== name) continue;
      const k = `${p}|${e.key || e.index}`;
      seen.set(k, {
        page: p,
        key: e.key || e.index,
        contentScore: e.score,
        visualScore: null,
        tag: e.tag || null,
        prodLen: e.prodLen,
        stageLen: e.stageLen,
      });
    }
  }
  for (const rec of model.raw.visualByPath.values()) {
    const p = rec.path;
    for (const c of rec.components || []) {
      if ((c.name || c.key) !== name) continue;
      const k = `${p}|${c.key}`;
      const prev = seen.get(k) || {
        page: p,
        key: c.key,
        contentScore: null,
        visualScore: null,
        tag: null,
        prodLen: null,
        stageLen: null,
      };
      prev.visualScore = c.score;
      prev.mismatch = c.mismatch;
      prev.visualTag = c.tag || null;
      prev.height = c.height ?? null;
      const slug = pathToSlugDir(p);
      const diff = shotPath("diff", slug, c.key);
      // Only when this run actually produced a diff: 6400 writes a diff PNG for a
      // differing pair but does not DELETE a previous run's file when the pair
      // becomes identical, so a stale image would otherwise sit next to a 100.
      if (c.score < 100 && diff && fs.existsSync(diff)) {
        prev.diffImg = `/img?side=diff&slug=${encodeURIComponent(
          slug
        )}&key=${encodeURIComponent(c.key)}`;
      }
      seen.set(k, prev);
    }
  }
  for (const v of seen.values()) out.push(v);
  const worst = (r) => Math.min(r.contentScore ?? 101, r.visualScore ?? 101);
  out.sort((a, b) => worst(a) - worst(b));
  return { name, instances: out };
}

// -------------------------------------------------------------------- server
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendFile(res, file, { cache: cacheable = false } = {}) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const headers = {
    "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "content-length": fs.statSync(file).size,
    "cache-control": cacheable ? "public, max-age=31536000, immutable" : "no-store",
  };
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  const q = u.searchParams;

  try {
    if (u.pathname === "/api/overview") {
      const m = buildModel();
      const { raw, ...rest } = m;
      return sendJson(res, rest);
    }
    if (u.pathname === "/api/page") {
      const m = buildModel();
      const p = q.get("path");
      if (!p) return sendJson(res, { error: "path required" }, 400);
      return sendJson(res, pageDetail(m, p));
    }
    if (u.pathname === "/api/component") {
      const m = buildModel();
      const name = q.get("name");
      if (!name) return sendJson(res, { error: "name required" }, 400);
      return sendJson(res, componentDetail(m, name));
    }
    if (u.pathname === "/img") {
      buildModel(); // cheap (cached) — resolves SHOT_RUN before shotPath uses it
      const file = shotPath(q.get("side"), q.get("slug") || "", q.get("key") || "");
      // Confine every read to TEST_SCREENSHOT_DIR (slug/key come from the URL).
      const resolved = file ? path.resolve(file) : null;
      if (!resolved || !resolved.startsWith(path.resolve(SHOTS_DIR) + path.sep)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      return sendFile(res, resolved, { cache: true });
    }
    if (u.pathname === "/api/file") {
      // Raw dataset text (the un-normalized capture), for copy/inspect.
      const m = buildModel();
      const slug = q.get("slug") || "";
      const key = q.get("key") || "";
      const side = q.get("side") === "stage" ? "actual" : "expected";
      const file = path.resolve(path.join(m.datasets[side], slug, `${key}.txt`));
      const rootOk = path.resolve(m.datasets[side]) + path.sep;
      if (!file.startsWith(rootOk)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(readTextFile(file) ?? "");
      return;
    }

    // static
    const rel = u.pathname === "/" ? "index.html" : u.pathname.replace(/^\/+/, "");
    const file = path.resolve(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(path.resolve(PUBLIC_DIR))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    return sendFile(res, file);
  } catch (err) {
    console.error(err);
    return sendJson(res, { error: String(err?.stack || err) }, 500);
  }
});

server.listen(PORT, () => {
  const m = buildModel();
  console.log(`E2E report viewer  →  http://localhost:${PORT}`);
  console.log(`  root        ${ROOT}`);
  console.log(`  reports     ${REPORT_DIR}`);
  console.log(`  screenshots ${m.shotsDir || "(none - TEST_SCREENSHOT_DIR unset)"}`);
  if (m.shotsDir)
    console.log(`  shots run   ${m.shotRun || "(legacy root-level migrated/diff)"}`);
  console.log(
    `  content     ${
      m.content
        ? `${m.content.overallScore.toFixed(1)}% over ${m.content.pagesScored} pages (${m.content.generatedAt})`
        : "report.json missing"
    }`
  );
  console.log(
    `  visual      ${
      m.visual
        ? `${m.visual.overallScore.toFixed(1)}% over ${m.visual.pagesScored} pages (${m.visual.generatedAt})`
        : "report-screenshots.json missing"
    }`
  );
  if (args.open === "1") {
    // Only on explicit --open: never steal focus by default.
    spawn("cmd", ["/c", "start", "", `http://localhost:${PORT}`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
});
