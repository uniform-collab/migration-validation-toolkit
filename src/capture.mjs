/**
 * Unified dataset capture: for every page of the prod sitemap (or the expected
 * manifest, stage side), record its HTTP status and — in ONE page visit — the
 * innerText of each component AND/OR a screenshot of each component, per
 * --capture-mode (content | screenshots | full). Capturing both in a single
 * navigation is the whole point: it avoids loading every page twice.
 *
 *   prod expected:  --base-url <prod>  --sitemap <url>  [--include /a,/b]
 *   stage actual:   --base-url <stage> --paths <expected/manifest.json> --stage
 *
 *   --header "Name: value"      extra request header, repeatable (WAF/CDN bypass)
 *   --capture-mode content      innerText only (images blocked; fast) [default]
 *   --capture-mode screenshots  element screenshots only (V2)
 *   --capture-mode full         both, from the same loaded page (V2)
 *
 * Content output under --out (V1: <slug>/NN.txt; V2: <slug>/<componentKey>.txt
 * + <slug>/.components.json), plus --out/manifest.json.
 * Screenshot output under --shots-out (<slug>/<componentKey>/<componentKey>_<side>.png
 * + <slug>/.components.json + redirect.txt), plus --shots-out/manifest.json.
 * Screenshots are V2-only.
 */
import fs from "fs";
import path from "path";
import http from "node:http";
import https from "node:https";
import { chromium } from "playwright";
import { collectComponentTexts } from "./lib/extract-selectors.mjs";
import {
  buildUrlToIndexMap,
  loadCaptureTargets,
  filterBodyOnly,
  normalizeSelector,
  parseRebaseRules,
  componentKey,
  assignComponentKeys,
  parseExcludedComponents,
  markExcludedComponents,
  normalizeUrlForLookup,
} from "./lib/index-json.mjs";
import {
  freezeAnimations,
  captureFullPage,
  removeOverlayElements,
  resolveAndTagTargets,
  captureResolvedTargets,
  parseOverlaySelectors,
  getSharp,
  attachNetworkQuiescer,
} from "./lib/screenshot.mjs";
import { ConcurrencyTuner, defaultMaxConcurrency } from "./lib/autotune.mjs";
import {
  parseArgs,
  requireArg,
  makePathIncluder,
  pathToSlugDir,
  normalizeText,
  readJson,
  writeJson,
  loadPreviousReport,
  failedPagePaths,
} from "./lib/util.mjs";

const args = parseArgs(process.argv.slice(2));
const baseUrl = requireArg(args, "base-url").replace(/\/+$/, "");

// Capture mode: what this pass produces.
const captureModeRaw = String(args["capture-mode"] || "content").toLowerCase();
const captureMode = ["content", "screenshots", "full"].includes(captureModeRaw)
  ? captureModeRaw
  : "content";
const doContent = captureMode === "content" || captureMode === "full";
const wantShots = captureMode === "screenshots" || captureMode === "full";
const doShots = wantShots;
if (!doContent && !doShots) {
  console.error(`Nothing to capture (capture-mode=${captureMode}).`);
  process.exit(1);
}

const outDir = doContent ? requireArg(args, "out") : (args["out"] ? String(args["out"]) : null);
const shotsOut = doShots ? requireArg(args, "shots-out") : null;
const isStage = Boolean(args["stage"]);
const shotSuffix = isStage ? "_migrated" : "_prod";

let urlIndexMap = null;
let rebaseRules = null;
let bodyOnly = true;
// Renderings deliberately out of scope (TEST_EXCLUDE_COMPONENTS): resolved and masked out of
// their ancestors, but never compared in their own right.
let excludedComponents = new Set();
{
  const presentationRoot = requireArg(args, "presentation-root");
  const itemRoot =
    typeof args["item-root"] === "string" && args["item-root"].trim()
      ? args["item-root"].trim()
      : undefined;
  rebaseRules = parseRebaseRules(args["rebase"]);
  bodyOnly = !(args["body-only"] === "false" || args["body-only"] === false);
  excludedComponents = parseExcludedComponents(args["exclude-components"]);
  // Frozen Sitecore item export (data/items/<lang>). Optional, but without it page URLs fall
  // back to slugified ItemPaths, which cannot reproduce Sitecore's bucket/whitespace rules and
  // silently leaves pages out of the comparison — see buildUrlToIndexMap.
  const itemsRootArg =
    typeof args["items-root"] === "string" && args["items-root"].trim()
      ? args["items-root"].trim()
      : undefined;
  // Several languages: `--presentation-root a|b|c` (one presentation dump per language, e.g.
  // data/html/en-GL,data/html/sv-SE) with `--items-root` naming each one's item export in the same
  // order (or ONE items root shared by all). Each pair is indexed on its own - a page's Slug carries
  // its locale (/sv-se/...), so the maps never collide - and merged into one page list, so a single
  // capture and a single report cover every language. One root behaves exactly as before.
  const presentationRoots = String(presentationRoot).split(",").map((x) => x.trim()).filter(Boolean);
  const itemsRoots = itemsRootArg ? itemsRootArg.split(",").map((x) => x.trim()).filter(Boolean) : [];
  if (itemsRoots.length > 1 && itemsRoots.length !== presentationRoots.length) {
    console.error(
      `--items-root names ${itemsRoots.length} roots for ${presentationRoots.length} --presentation-root(s); ` +
        "give one per presentation root, in the same order, or a single one."
    );
    process.exit(1);
  }
  urlIndexMap = new Map();
  presentationRoots.forEach((root, i) => {
    const itemsRoot = itemsRoots.length > 1 ? itemsRoots[i] : itemsRoots[0];
    const built = buildUrlToIndexMap(root, itemRoot, itemsRoot);
    let added = 0;
    for (const [url, file] of built.map) {
      if (!urlIndexMap.has(url)) {
        urlIndexMap.set(url, file);
        added++;
      }
    }
    const st = built.stats || {};
    console.log(
      `V2 selector mode: indexed ${built.files.length} index.json under ${root} ` +
        `(root ItemPath ${built.rootItemPath}); ${added} URLs; body-only=${bodyOnly}.`
    );
    console.log(
      itemsRoot
        ? `  URLs from item Slug: ${st.fromSlug || 0}, from ItemPath fallback: ${st.fromItemPath || 0}, ` +
            `unresolved: ${st.unresolved || 0}, duplicates: ${st.duplicates || 0} (items root ${itemsRoot}).`
        : `  WARNING: no --items-root given; all ${st.fromItemPath || 0} URLs derived from ItemPath. ` +
            `Pages whose Sitecore URL differs from their tree path will not be scored.`
    );
  });
  if (presentationRoots.length > 1) console.log(`V2 selector mode: ${urlIndexMap.size} URLs across ${presentationRoots.length} presentation roots.`);
}
console.log(`Capture mode: ${captureMode} (content=${doContent}, screenshots=${doShots})${isStage ? " [stage]" : ""}`);

// --concurrency auto: the pool is sized while the run is in flight (see lib/autotune.mjs),
// starting low and never above --concurrency-max (default: what the host's CPUs and memory hold).
const concurrencyArg = String(args["concurrency"] ?? "6").trim().toLowerCase();
const autoConcurrency = concurrencyArg === "auto";
const concurrencyMax = Math.max(1, parseInt(args["concurrency-max"] || "0", 10) || defaultMaxConcurrency());
// Where auto starts (default 4). A short capture - a few dozen pages - ends before the slow-start
// has climbed far, so a host known to hold more can start there instead of spending most of the
// run at 4-9 workers. Clamped to --concurrency-max.
const concurrencyStart = Math.max(1, parseInt(args["concurrency-start"] || "4", 10) || 4);
const concurrency = autoConcurrency
  ? Math.min(concurrencyStart, concurrencyMax)
  : Math.max(1, parseInt(concurrencyArg, 10) || 6);
const autotuneIntervalMs = Math.max(2, parseInt(args["autotune-interval"] || "15", 10) || 15) * 1000;
const limit = parseInt(args["limit"] || "0", 10) || 0;
// Allowlist of paths the migrated frontend covers so far (exact or `*` glob).
// Empty = the whole page list. See makePathIncluder.
const includePaths = makePathIncluder(args["include"]);
const resume = Boolean(args["resume"]);
// Quick-validation: capture only the pages that FAILED (page score < 100) in the
// previous content report.json, so a fix can be re-checked in seconds instead of
// re-crawling the whole sitemap. compare.mjs restricts scoring to the same set.
const onlyFailed = Boolean(args["only-failed"]);
// Disable the transient/zero-capture/exception retries (6200 passes this for a
// LOCAL stage: the dedicated e2e server is fast and deterministic, so retrying a
// genuinely-broken page just wastes time — especially in failed-only mode).
const noRetry = Boolean(args["no-retry"]);
const bypassSecret = typeof args["bypass-secret"] === "string" ? args["bypass-secret"].trim() : "";
// Members-only routes: the frontend (cha-website middleware) grants access to any request
// carrying `?secret=<UNIFORM_PREVIEW_SECRET>&is_visual_testing=true` — the same escape hatch
// Canvas/visual testing uses. With --preview-secret set, a page that answers 401/403/404/302
// to the anonymous crawl is re-probed once with those params, so protected pages can be
// captured instead of silently scoring as "not comparable". This does NOT enable Next draft
// mode (that needs the /api/preview cookie), so the content stays the PUBLISHED canvas.
// --preview-authenticated additionally passes `is_authenticated_editing_mode=true`, which
// makes the middleware attach a mock user (quirks.authenticated=true) — use it when the prod
// baseline for those pages was captured while signed in.
const previewSecret = typeof args["preview-secret"] === "string" ? args["preview-secret"].trim() : "";
const previewAuthenticated = Boolean(args["preview-authenticated"]);
const navTimeout = parseInt(args["timeout"] || "60000", 10) || 60000;

// Screenshot tuning (only used when doShots).
const minHeight = parseInt(args["min-height"] || "30", 10) || 30;
const maxHeight = parseInt(args["max-height"] || "9000", 10) || 9000;
// One whole-page JPEG per page, taken before the component shots, for a reviewer to see the
// page next to the other side's - never scored (see captureFullPage). On whenever shots are;
// `--full-page-shot false` turns it off. Clipped at --full-page-max-height px.
const fullPageShot = doShots && String(args["full-page-shot"] ?? "true").toLowerCase() !== "false";
const fullPageMaxHeight = Math.max(720, parseInt(args["full-page-max-height"] ?? "16000", 10) || 16000);
const fullPageQuality = Math.min(100, Math.max(1, parseInt(args["full-page-quality"] ?? "70", 10) || 70));
const overlaySelectors = parseOverlaySelectors(args["remove-before"]);
const scrollStepDelay = doShots ? 60 : 40;
// Network-idle gate for the shot pass. `networkidle` on goto only covers the
// navigation; the lazy-load scroll below fires a second wave of component data
// fetches after it, and scrolling an element into view for its own shot fires a
// third. Waiting for BOTH is what makes the visual score reproducible instead of
// carrying ~0.5pt of "did that grid finish loading" noise. Quiet window /
// ceiling are tunable because a slow canary needs a bigger ceiling than local
// edge does; 0 for either disables that gate.
const shotIdleQuiet = Math.max(0, parseInt(args["shot-idle-quiet"] ?? "300", 10) || 0);
const shotIdleMax = Math.max(0, parseInt(args["shot-idle-max"] ?? "8000", 10) || 0);
const shotCompIdleMax = Math.max(0, parseInt(args["shot-component-idle-max"] ?? "3000", 10) || 0);
// Layout-stability gate for the shot pass. The idle gate above waits for the
// NETWORK; this waits for the LAYOUT, which is a different question - a Suspense
// fallback collapsing or a font swapping moves the element without a single
// request. It matters because an element screenshot's clip is measured in one
// round-trip and rasterized in another, so a relayout in between yields the right
// picture at the wrong offset (see waitForLayoutStable in lib/screenshot.mjs).
// Poll interval doubles as the settle wait, so it is the per-shot cost when the
// page is already still; 0 disables the gate AND its post-shot verification.
const shotStablePoll = Math.max(0, parseInt(args["shot-stable-poll"] ?? "50", 10) || 0);
const shotStableMax = Math.max(0, parseInt(args["shot-stable-max"] ?? "2000", 10) || 0);
// Page-settled gate for the shot pass: once, after the network-idle gate and before the
// animation freeze, wait for the web fonts, for every image that is still loading, and then for
// the page height to stay put for --shot-settle-quiet ms. The per-element gate above only waits
// --shot-stable-max for ONE element, so a late font swap or an image without fixed dimensions
// that lands while the page is being shot moved elements under it ("unstable layout") - more
// often the busier the server, which made the concurrency tuner back off. One budget covers all
// three waits; 0 for --shot-settle-max disables the gate.
const shotSettleQuiet = Math.max(0, parseInt(args["shot-settle-quiet"] ?? "500", 10) || 0);
const shotSettleMax = Math.max(0, parseInt(args["shot-settle-max"] ?? "5000", 10) || 0);
// Capture mechanism. Stitching walks the element past the viewport a band at a time and
// composites the viewport rasters, instead of handing CDP one oversized clip - see
// captureStitched in lib/screenshot.mjs for why that path is worth avoiding. Output
// geometry is identical either way, so this can be turned off without re-capturing a
// baseline; 0 = use elementHandle.screenshot() as before.
const shotStitch = !(args["shot-stitch"] === "0" || args["shot-stitch"] === false);
let sharpMod = null;

// Header-only bypass on purpose: adding x-vercel-set-bypass-cookie makes Vercel
// answer 307 (cookie-set redirect), which the redirect-less status check would
// misread as non-200. The header alone used to pass every request; since 2026-10-16 Vercel
// may route it round vercel.com/sso-api first, which getStatus follows (see there).
//
// --header "Name: value" (repeatable) is the general form, for a site fronted by
// something other than Vercel. The canonical case is a WAF/CDN in front of the LEGACY
// site that answers a plain crawler with a challenge page: the site owner issues a
// bypass header and it goes here. This carries a credential the operator supplies; it
// is not a way around a protection. With no header configured the capture simply
// records whatever status the challenge returns and the run reports it.
//
// Applied on every path a request leaves by - the sitemap fetch, the redirect-less
// status probe, and the browser context. parseArgs is last-wins, so a repeatable flag
// has to be read off argv directly.
function parseExtraHeaders(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--header") continue;
    const raw = argv[i + 1];
    if (!raw || raw.startsWith("--")) continue;
    const sep = raw.indexOf(":");
    if (sep <= 0) {
      console.warn(`Ignoring --header "${raw}": expected "Name: value".`);
      continue;
    }
    out[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim();
    i++;
  }
  return out;
}

const extraHeaders = {
  ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
  ...parseExtraHeaders(process.argv.slice(2)),
};
if (Object.keys(extraHeaders).length) {
  // Names only - the values are secrets.
  console.log(`Extra request headers: ${Object.keys(extraHeaders).join(", ")}`);
}

/** Fetch sitemap XML (following <sitemapindex> one level) -> normalized paths. */
async function getSitemapPaths(sitemapUrl) {
  const fetchXml = async (url) => {
    const res = await fetch(url, { headers: extraHeaders });
    if (!res.ok) throw new Error(`Sitemap fetch failed (${res.status}) for ${url}`);
    return await res.text();
  };
  let xml = await fetchXml(sitemapUrl);
  let combined = xml;
  if (/<sitemapindex[\s>]/i.test(xml)) {
    const children = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
    const parts = [];
    for (const child of children) parts.push(await fetchXml(child));
    combined = parts.join("\n");
  }
  // Snapshot the sitemap next to whichever output(s) we're writing.
  for (const d of [outDir, shotsOut]) {
    if (d) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "sitemap.xml"), xml, "utf8");
    }
  }

  const locs = [...combined.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) =>
    m[1].trim().replace(/\/$/, "").replace(/\/home(?=\/|$)/, "/")
  );
  const paths = locs.map((u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  });
  const normalized = paths.map((p) => (p.startsWith("/") ? p : `/${p}`));
  if (!normalized.includes("/")) normalized.unshift("/");
  return [...new Set(normalized)].sort();
}

/**
 * Derive the page list from a static-mirror directory instead of a sitemap.
 *
 * D:\cha-prod-mirror is a static HTML copy that serves /<path> from
 * public/<path>/prod.html, and it holds 1782 pages while its checked-in sitemap.xml lists
 * only 601 (80 of which have no prod.html at all). The files on disk are the authority on
 * what the mirror can actually serve, so scanning for the marker file covers 1296 of the
 * canvas's 1664 pages where the sitemap covers 516.
 *
 * `marker` picks the mirror's layout, because the two tools that produce one disagree:
 *
 *   prod.html   ONE FILE PER DIRECTORY, the directory named after the URL
 *               (public/<path>/prod.html -> /<path>). The cha-prod-mirror shape.
 *   *.html      ANY FILE WITH THAT EXTENSION, which is httrack's shape: <path>.html is
 *               the page at /<path>, and <dir>/index.html is the page at /<dir>.
 *               D:\wsp\prod-mirror is this one.
 *
 * Only the extension is read out of a `*.ext` marker — it is not a general glob.
 */
function listPagesFromDir(rootDir, marker) {
  // "*.html" -> extension mode; anything else stays an exact file name.
  const extMatch = /^\*(\.[A-Za-z0-9]+)$/.exec(String(marker).trim());
  const ext = extMatch ? extMatch[1].toLowerCase() : null;
  const out = [];
  const stack = [{ dir: rootDir, rel: "" }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // "-" is the /-/media asset tree and "_next" the build output: thousands of
      // files, no pages. Skipping them keeps the walk to the page tree.
      if (e.isDirectory()) {
        if (e.name === "-" || e.name.startsWith("_")) continue;
        stack.push({ dir: path.join(dir, e.name), rel: `${rel}/${e.name}` });
      } else if (ext) {
        if (!e.name.toLowerCase().endsWith(ext)) continue;
        const stem = e.name.slice(0, -ext.length);
        // <dir>/index.html is the page AT <dir>; any other file is a page of its own.
        if (stem.toLowerCase() === "index") out.push(rel === "" ? "/" : rel);
        else out.push(`${rel}/${stem}`);
      } else if (e.name === marker) {
        out.push(rel === "" ? "/" : rel);
      }
    }
  }
  return [...new Set(out)].sort();
}

/**
 * `--page-rewrite "/en-gl/=>/en-GL/,/fr-gl/=>/fr-GL/"`: prefix rewrites applied to a page list
 * DERIVED from the legacy side (a mirror directory or a sitemap), never to `--paths`.
 *
 * The two sides can disagree on the spelling of a path they both serve. WSP's legacy URLs are
 * lowercased by a Sitecore link provider, so the httrack mirror's tree is `en-gl/`, while the
 * migrated frontend routes on the Uniform locale and answers `/en-GL/...`. One page list has to
 * address both, and it is the locale segment that has to give: rewriting it here means every
 * later stage — capture, manifest, compare, the report — carries ONE path per page.
 *
 * Comma-separated, `from=>to`, first matching rule wins, prefixes only. Comma because the CLI is
 * reached through a .cmd shim on Windows, where a `|` in an argument is a pipe.
 */
function parsePageRewrites(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rule) => {
      const i = rule.indexOf("=>");
      if (i < 0) {
        console.error(`Bad --page-rewrite rule (expected "from=>to"): ${rule}`);
        process.exit(1);
      }
      return { from: rule.slice(0, i).trim(), to: rule.slice(i + 2).trim() };
    })
    .filter((r) => r.from);
}

function applyPageRewrites(paths, rules) {
  if (!rules.length) return paths;
  let changed = 0;
  const out = paths.map((p) => {
    for (const r of rules) {
      if (p.startsWith(r.from)) {
        changed++;
        return r.to + p.slice(r.from.length);
      }
    }
    return p;
  });
  console.log(
    `Page rewrites: ${changed}/${paths.length} paths rewritten by ` +
      rules.map((r) => `${r.from}=>${r.to}`).join(", ")
  );
  return [...new Set(out)].sort();
}

async function getPathsToCapture() {
  const rewrites = parsePageRewrites(args["page-rewrite"]);
  if (args["pages-from-selectors"]) {
    // The selector index's own keys. It resolved every page's URL from the item export's Slug
    // (see buildUrlToIndexMap), which is Sitecore's own answer to "what is this page's URL".
    //
    // --pages-from-dir cannot do that: it names each page after the DIRECTORY it found, and a
    // presentation dump writes one directory per item, named after the item. Where a site derives
    // its URLs from display names instead - Sitecore's `useDisplayName` link provider - the two
    // disagree, and they disagree exactly where the item name is not English. Measured on WSP's
    // 780 project pages: 113 of them, e.g. the item `2025-ruimte-voor-de-rivier-2-0` whose Slug is
    // `/en-gl/projects/2025-room-for-the-river-2-0`. Every one produced a URL that exists on
    // neither side - 0 selector targets on the expected side, because the index is keyed by Slug,
    // and a 404 on the stage - so 14% of the page set was silently unscoreable.
    //
    // Keys are lowercased for lookup, so --page-rewrite is still what spells the locale the way
    // the stage serves it.
    const paths = applyPageRewrites([...urlIndexMap.keys()], rewrites);
    if (!paths.length) {
      console.error("The selector index resolved no page URLs - nothing to capture.");
      process.exit(1);
    }
    for (const d of [outDir, shotsOut]) {
      if (d) {
        fs.mkdirSync(d, { recursive: true });
        writeJson(path.join(d, "pages.json"), {
          source: "selector-index",
          presentationRoot: args["presentation-root"],
          itemsRoot: args["items-root"] ?? null,
          rewrites,
          count: paths.length,
          paths,
        });
      }
    }
    console.log(`Page list: ${paths.length} pages from the selector index (URLs from item Slug).`);
    return paths.map((p) => ({ path: p, prodStatus: null }));
  }
  if (args["pages-from-dir"]) {
    const dir = String(args["pages-from-dir"]);
    const marker = String(args["page-marker"] || "prod.html");
    const paths = applyPageRewrites(listPagesFromDir(dir, marker), rewrites);
    if (!paths.length) {
      console.error(`No "${marker}" files found under ${dir} — nothing to capture.`);
      process.exit(1);
    }
    // Snapshot the derived list next to the output, the same way --sitemap snapshots the XML,
    // so the dataset records which page set it was built from.
    for (const d of [outDir, shotsOut]) {
      if (d) {
        fs.mkdirSync(d, { recursive: true });
        writeJson(path.join(d, "pages.json"), {
          source: dir,
          marker,
          rewrites,
          count: paths.length,
          paths,
        });
      }
    }
    console.log(`Page list: ${paths.length} pages from ${marker} files under ${dir}.`);
    return paths.map((p) => ({ path: p, prodStatus: null }));
  }
  if (args["sitemap"]) {
    const paths = applyPageRewrites(await getSitemapPaths(String(args["sitemap"])), rewrites);
    return paths.map((p) => ({ path: p, prodStatus: null }));
  }
  if (args["paths"]) {
    const manifest = readJson(String(args["paths"]));
    return Object.entries(manifest.pages)
      .map(([p, rec]) => ({ path: p, prodStatus: rec.status }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  console.error(
    "Provide one of --pages-from-selectors, --sitemap <url>, " +
      "--pages-from-dir <static-mirror-dir>, or --paths <manifest.json>"
  );
  process.exit(1);
}

/**
 * Status probe for a *.localhost host, which Playwright's APIRequestContext cannot reach.
 *
 * Treating `<name>.localhost` as loopback (RFC 6761) is a CLIENT-side convention: curl and
 * Chromium do it, so the page capture itself works, but Node's resolver defers to the OS and
 * answers ENOTFOUND — which made every stage page probe as status 0 against a server that was
 * serving fine. This issues the request straight to loopback with the Host header preserved, and
 * skips certificate verification because portless fronts HTTPS with its own local CA.
 */
function probeLocalhostStatus(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        host: "127.0.0.1",
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        servername: u.hostname,
        headers: { ...extraHeaders, Host: u.hostname },
        rejectUnauthorized: false,
        timeout: navTimeout,
      },
      (res) => {
        res.resume();   // drain: we only want the status line (and a redirect's target)
        resolve({ status: res.statusCode, location: res.headers.location });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

const isLocalhostHost = (url) => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h.endsWith(".localhost");
  } catch {
    return false;
  }
};

/** Raw page status without following redirects (3xx counts as non-200). */
/**
 * Statuses that mean "ask again later", not "this is what the page is".
 *
 * The expected side is now the LIVE legacy site, and it throttles a browser-driven crawl:
 * a page load pulls CSS/JS/images, so the request rate is far above what a plain status
 * sweep produces and prod starts answering 429 to pages that are perfectly good 200s.
 * Writing that down would bake a phantom non-200 into the expected manifest, and every such
 * page would then be scored as a status-parity mismatch against a stage that serves it 200 —
 * silently, because a manifest full of 429s looks exactly like a manifest full of real 404s.
 * So these are retried with backoff on BOTH sides instead of being recorded.
 */
const THROTTLE_STATUSES = new Set([429, 503]);
const THROTTLE_MAX_ATTEMPTS = 5;

/** Counted so a dataset that is still poisoned after every retry cannot pass silently. */
let throttleExhausted = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Honour Retry-After when the server sends one, else exponential backoff (2s→30s). */
function throttleDelayMs(retryAfter, attempt) {
  const secs = Number(retryAfter);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60000);
  return Math.min(2000 * 2 ** (attempt - 1), 30000);
}

/**
 * A redirect's target in the shape both sides can be compared in: the path (+ query + hash) when
 * it stays on the page's own origin - the two sides of a comparison are different hosts, so an
 * absolute same-origin Location would never match - and the full URL when it leaves the site.
 */
function normalizeLocation(location, url) {
  if (!location) return undefined;
  try {
    const target = new URL(location, url);
    return target.origin === new URL(url).origin ? target.pathname + target.search + target.hash : target.href;
  } catch {
    return String(location);
  }
}

/** Same origin and path (a trailing slash aside) and query. */
function sameUrlIgnoringSlash(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const p = (u) => u.pathname.replace(/\/+$/, "") || "/";
    return x.origin === y.origin && p(x) === p(y) && x.search === y.search;
  } catch {
    return false;
  }
}

/** `{ status, location }` without following redirects; `location` only for a redirect. */
async function getStatus(request, url) {
  if (isLocalhostHost(url)) {
    const { status, location } = await probeLocalhostStatus(url);
    return { status, location: status >= 300 && status < 400 ? normalizeLocation(location, url) : undefined };
  }
  for (let attempt = 1; ; attempt++) {
    const res = await request.get(url, { maxRedirects: 0, timeout: navTimeout, failOnStatusCode: false });
    const status = res.status();
    const location = status >= 300 && status < 400 ? normalizeLocation(res.headers()["location"], url) : undefined;
    // Vercel's protection no longer always lets the bypass header straight through: since
    // 2026-10-16 a header-only request may be redirected to vercel.com/sso-api and on to the
    // vercel.com login - the header alone is NOT accepted there. What still works is the
    // documented cookie form: the same request with x-vercel-set-bypass-cookie answers 307 with a
    // bypass cookie and lands on the page. The cookie goes into this context's jar, which the
    // browser pages share, so it is set once and every later request passes. Read redirect-less,
    // every page of the protected deployment had looked like a 302 and none was captured (WSP
    // distributed e2e wsp-12 and wsp-14, 65 of 65 pages). It counts only if it ends on the URL
    // that was asked for; a wrong secret still ends on the login page and is recorded as the 302.
    if (bypassSecret && status >= 300 && status < 400 && /^https:\/\/vercel\.com\/sso-api\b/.test(String(res.headers()["location"] || ""))) {
      const via = await request.get(url, {
        maxRedirects: 5,
        timeout: navTimeout,
        failOnStatusCode: false,
        headers: { "x-vercel-protection-bypass": bypassSecret, "x-vercel-set-bypass-cookie": "true" },
      });
      if (sameUrlIgnoringSlash(via.url(), url)) return { status: via.status(), location: undefined };
    }
    if (!THROTTLE_STATUSES.has(status)) return { status, location };
    if (attempt >= THROTTLE_MAX_ATTEMPTS) {
      throttleExhausted++;
      console.warn(`  ${status} on ${url} - STILL throttled after ${attempt} attempts; recording it`);
      return { status, location };
    }
    const wait = throttleDelayMs(res.headers()["retry-after"], attempt);
    console.warn(`  ${status} on ${url} - throttled, waiting ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}

/** Statuses a route-protected page answers with; each is worth one preview-bypass re-probe. */
const PROTECTED_STATUSES = new Set([
  302, // redirect to the Okta login (protection with OAuth configured)
  401,
  403, // access-denied rewrite (signed in, wrong role)
  404, // not-found rewrite (protection without OAuth configured, e.g. the local e2e server)
]);

/** Same URL with the frontend's preview-bypass params appended. */
function withPreviewBypass(url) {
  const u = new URL(url);
  u.searchParams.set("secret", previewSecret);
  u.searchParams.set("is_visual_testing", "true");
  if (previewAuthenticated) u.searchParams.set("is_authenticated_editing_mode", "true");
  return u.toString();
}

/** Per-page marker path for a given output dir (enables --resume). */
function markerPath(dir, pagePath) {
  return path.join(dir, pathToSlugDir(pagePath), ".page.json");
}

/**
 * Shared-asset cache + in-place throttle retry for same-origin sub-resources.
 *
 * Prod sends `Cache-Control: no-cache, no-store` on everything, so the browser re-fetches the
 * SAME theme stylesheets and scripts on every one of the 1474 pages. That repeated load is what
 * provokes the throttling in the first place, and stylesheets were the most-throttled resource
 * kind by a wide margin. These assets are versioned in the URL (`?t=20251114T111259Z`), so a
 * URL identifies immutable bytes and can safely be served from memory for the rest of the run.
 *
 * Retrying is done HERE rather than by redoing the page, because a whole-page retry re-requests
 * every other sub-resource too — the cure feeding the disease. Retrying only the request that
 * actually failed keeps the extra load proportional to the failure.
 *
 * The main document is deliberately excluded: it already has a page-level retry, and fulfilling
 * a navigation from a replayed response is a much bigger behavioural change than doing so for
 * a stylesheet.
 */
const CACHEABLE_TYPES = new Set(["stylesheet", "script", "font"]);
const SUBRESOURCE_MAX_ATTEMPTS = 4;
const assetCache = new Map(); // url -> { body, status, headers }

async function continueSameOrigin(route, type) {
  const url = route.request().url();
  const sameOrigin = url.toLowerCase().startsWith(baseUrl.toLowerCase());
  // Third-party (OneTrust, GTM) and the main document go through untouched.
  if (!sameOrigin || type === "document") return await route.continue();

  const cacheable = CACHEABLE_TYPES.has(type);
  if (cacheable) {
    const hit = assetCache.get(url);
    if (hit) return await route.fulfill(hit).catch(() => {});
  }

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await route.fetch();
    } catch {
      // Interception itself failed — fall back to a plain continue rather than losing the request.
      return await route.continue().catch(() => {});
    }
    const status = res.status();
    if (THROTTLE_STATUSES.has(status) && attempt < SUBRESOURCE_MAX_ATTEMPTS) {
      await sleep(throttleDelayMs(res.headers()["retry-after"], attempt));
      continue;
    }
    let payload;
    try {
      // res.body() is DECODED, so replaying the original content-encoding/-length would
      // hand the browser bytes that contradict their own headers and the asset would fail
      // to parse. Drop them and let Playwright set the length.
      const headers = { ...res.headers() };
      delete headers["content-encoding"];
      delete headers["content-length"];
      delete headers["set-cookie"];
      payload = { status, headers, body: await res.body() };
    } catch {
      return await route.continue().catch(() => {});
    }
    if (cacheable && status === 200) assetCache.set(url, payload);
    return await route.fulfill(payload).catch(() => {});
  }
}

// `signals` collects load symptoms that leave no trace in the record itself (a navigation that
// timed out is scraped as-is), for the concurrency tuner. Never written to the dataset.
async function capturePage(context, pagePath, statusOnly, signals = {}) {
  let url = baseUrl + pagePath;
  const rec = { status: 0 };

  const probe = await getStatus(context.request, url);
  rec.status = probe.status;
  // A redirect is compared by where it goes, not only by its code (see compare.mjs).
  if (probe.location) rec.location = probe.location;

  // Route-protected page + a preview secret => re-probe once through the bypass and, if that
  // opens it, capture from the bypass URL. Skipped for statusOnly pages on purpose: those are
  // the prod-non-200 parity probes, where turning a matching 404 into a 200 would MANUFACTURE
  // a status mismatch. So this only ever unlocks a page prod itself served with 200 — i.e. it
  // does nothing until the prod baseline for protected pages is captured signed in.
  if (previewSecret && !statusOnly && PROTECTED_STATUSES.has(rec.status)) {
    const bypassUrl = withPreviewBypass(url);
    const bypassStatus = (await getStatus(context.request, bypassUrl)).status;
    if (bypassStatus === 200) {
      rec.status = bypassStatus;
      rec.previewBypass = true;
      url = bypassUrl;
    }
  }

  if (statusOnly || rec.status !== 200) return rec;

  const page = await context.newPage();
  // A throttled SUB-RESOURCE corrupts the capture without failing it. Observed on live prod:
  // a 429'd stylesheet means `text-transform: uppercase` never applies, so innerText reads
  // "Put Kids First" instead of "PUT KIDS FIRST" — the document is still 200 and the elements
  // are still found, so the page looks captured, but comparison is case-sensitive and it would
  // score ~0 against a stage that renders it styled. Same class of damage for a 429'd image on
  // the screenshot side. Watch same-origin render-affecting responses and redo the page if any
  // of them was throttled.
  const renderTypes = new Set(["document", "stylesheet", "script", ...(doShots ? ["image", "font"] : [])]);
  let throttledSubresource = null;
  const onResponse = (res) => {
    if (throttledSubresource) return;
    if (!THROTTLE_STATUSES.has(res.status())) return;
    if (!res.url().toLowerCase().startsWith(baseUrl.toLowerCase())) return;
    if (!renderTypes.has(res.request().resourceType())) return;
    throttledSubresource = `${res.status()} ${res.request().resourceType()}`;
  };
  page.on("response", onResponse);
  // Attached before the navigation so it also sees the first wave of requests.
  const quiescer = doShots ? attachNetworkQuiescer(page, baseUrl) : null;
  try {
    let resp = null;
    try {
      resp = await page.goto(url, { waitUntil: doShots ? "networkidle" : "load", timeout: navTimeout });
    } catch (err) {
      if (err.name !== "TimeoutError") throw err;
      signals.navTimeout = true;
      // proceed with whatever loaded — matches the old system's behavior
    }
    // The navigation is a SECOND request, so it can be throttled even though the status
    // probe just came back 200. Without this the throttle page is what gets scraped: it has
    // no components, so the page lands as "0 elements" — indistinguishable from a genuine
    // extraction failure. Hand it back to the caller's retry loop instead.
    if (resp && THROTTLE_STATUSES.has(resp.status())) {
      rec.status = resp.status();
      rec.throttled = true;
      return rec;
    }
    if (doShots) await page.waitForTimeout(3000);

    const finalPath = new URL(page.url()).pathname.replace(/\/$/, "") || "/";
    if (finalPath !== pagePath) {
      rec.finalUrl = page.url();
      // Screenshot comparison checks redirect parity from redirect.txt.
      if (doShots) {
        const sdir = path.join(shotsOut, pathToSlugDir(pagePath));
        fs.mkdirSync(sdir, { recursive: true });
        fs.writeFileSync(path.join(sdir, "redirect.txt"), page.url(), "utf8");
      }
    }

    // Wait (softly) until the scope selector exists, so SPA hydration is done.
    const scopeWait = "#wrapper, main";
    await page.waitForSelector(scopeWait, { timeout: 15000 }).catch(() => {});

    // One end-to-end scroll to trigger lazy loaders, then back to top.
    await page.evaluate(async (stepDelay) => {
      const total = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      let y = 0;
      while (y < total) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, stepDelay));
        y += window.innerHeight * 0.9;
      }
      window.scrollTo(0, 0);
    }, scrollStepDelay).catch(() => {});
    await page.waitForTimeout(500);

    // Checked after the settle+scroll, so it covers lazily-requested CSS/images too.
    if (throttledSubresource) {
      rec.throttled = true;
      rec.throttledSubresource = throttledSubresource;
      return rec;
    }

    if (doShots) {
      // The lazy-load scroll above starts the component data fetches that the
      // navigation's own `networkidle` finished too early to see. Let them land
      // BEFORE freezeAnimations, which stubs out setTimeout/setInterval/rAF and
      // would otherwise strand a fetch that resolves after it (React would never
      // get to commit the result, so the shot captures the empty state).
      if (shotIdleQuiet > 0 && shotIdleMax > 0 && quiescer) {
        await quiescer.idle(shotIdleQuiet, shotIdleMax);
      }
      // Before freezeAnimations: it stubs setTimeout, which the settle wait itself needs.
      if (shotSettleMax > 0) {
        const settle = await waitPageSettled(page, shotSettleQuiet, shotSettleMax);
        // Recorded only when the budget ran out, so the page marker says why its shots may move.
        if (settle && !settle.settled) rec.pageSettle = settle;
      }
      await freezeAnimations(page);
      await removeOverlayElements(page, overlaySelectors);
    }

    return await captureV2(page, pagePath, rec, quiescer);
  } finally {
    quiescer?.detach();
    await page.close();
  }
}

/**
 * Waits, within one budget of `maxMs`, for the page's web fonts, for every <img> still loading,
 * and then for the document height to stay unchanged for `quietMs`. Returns what it saw;
 * `settled` is false when the budget ran out first. Never throws: a page that cannot be measured
 * is shot as before.
 */
async function waitPageSettled(page, quietMs, maxMs) {
  return page.evaluate(async ({ quietMs, maxMs }) => {
    const t0 = performance.now();
    const left = () => Math.max(0, maxMs - (performance.now() - t0));
    const capped = (p) => Promise.race([p, new Promise((r) => setTimeout(r, left()))]);
    try { if (document.fonts?.ready) await capped(document.fonts.ready); } catch {}
    // Only images the browser is fetching now: rendered, and either eager or a lazy one within a
    // viewport of the current scroll position. A lazy image in a hidden carousel slide never
    // starts, and waiting for it would spend the whole budget on every page.
    const pending = (i) => {
      if (i.complete) return false;
      const r = i.getBoundingClientRect();
      if (!r.width && !r.height && !i.offsetParent) return false;
      if (i.loading !== "lazy") return true;
      return r.bottom > -innerHeight && r.top < 2 * innerHeight;
    };
    const loading = [...document.images].filter(pending);
    if (loading.length) {
      await capped(Promise.all(loading.map((i) => new Promise((r) => {
        i.addEventListener("load", r, { once: true });
        i.addEventListener("error", r, { once: true });
      }))));
    }
    const height = () => Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight);
    let h = height();
    let since = performance.now();
    while (left() > 0 && performance.now() - since < quietMs) {
      await new Promise((r) => setTimeout(r, 100));
      const now = height();
      if (now !== h) { h = now; since = performance.now(); }
    }
    return {
      settled: performance.now() - since >= quietMs,
      ms: Math.round(performance.now() - t0),
      imagesLoading: [...document.images].filter(pending).length,
    };
  }, { quietMs, maxMs }).catch(() => null);
}

/**
 * V2 capture for one page: resolve this page's index.json targets once, then
 * produce content (masked innerText) and/or screenshots from the same page.
 */
async function captureV2(page, pagePath, rec, quiescer) {
  // ---- full-page shot (FIRST, not scored) — the page as the component shots below see it:
  //      settled, frozen, overlays removed. Recorded on the page marker, so it reaches the
  //      shots manifest as `fullPage`; the file is `<slug>/_page<suffix>.jpg`. ----
  if (fullPageShot) {
    const shotsPageDir = path.join(shotsOut, pathToSlugDir(pagePath));
    fs.mkdirSync(shotsPageDir, { recursive: true });
    const file = `_page${shotSuffix}.jpg`;
    const shot = await captureFullPage(page, path.join(shotsPageDir, file), {
      maxHeight: fullPageMaxHeight,
      quality: fullPageQuality,
    });
    if (shot) rec.fullPage = { file, ...shot };
  }

  const indexPath = urlIndexMap.get(normalizeUrlForLookup(pagePath));
  if (!indexPath) {
    rec.noIndex = true;
    rec.elements = 0;
    return rec;
  }

  let targets = loadCaptureTargets(indexPath);
  if (bodyOnly) targets = filterBodyOnly(targets);
  markExcludedComponents(targets, excludedComponents);
  rec.targets = targets.length;
  const keys = assignComponentKeys(targets);

  // ---- content (masked innerText) — non-destructive (clone-based), so it runs
  //      first and leaves the live DOM intact for the screenshot pass. ----
  if (doContent) {
    const payload = targets.map((t) => ({
      order: t.order,
      key: keys.get(t.order),
      name: t.name,
      sel: normalizeSelector(t.selector, rebaseRules),
      index: t.index || 0,
      levelsUp: t.levelsUp || 0,
      excluded: t.excluded || false,
    }));
    const res = await page.evaluate(collectComponentTexts, { targets: payload });
    const pageDir = path.join(outDir, pathToSlugDir(pagePath));
    fs.mkdirSync(pageDir, { recursive: true });
    const components = [];
    for (const it of res.items) {
      fs.writeFileSync(path.join(pageDir, `${it.key}.txt`), it.text, "utf8");
      components.push({ order: it.order, key: it.key, name: it.name });
    }
    writeJson(path.join(pageDir, ".components.json"), { components });
    rec.elements = res.items.length;
    rec.textChars = res.items.reduce((n, it) => n + normalizeText(it.text).length, 0);
    rec.resolved = payload.length - res.unresolved.length;
    rec.unresolved = res.unresolved.length;
    if (res.excluded?.length) rec.excludedComponents = res.excluded.length;
  }

  // ---- screenshots (one element shot per component) ----
  if (doShots) {
    if (sharpMod === null) sharpMod = await getSharp();
    const resolution = await resolveAndTagTargets(page, targets, rebaseRules);
    const shotsPageDir = path.join(shotsOut, pathToSlugDir(pagePath));
    const { captured, skippedEmpty } = await captureResolvedTargets(
      page,
      targets,
      resolution,
      shotsPageDir,
      {
        suffix: shotSuffix,
        minHeight,
        maxHeight,
        sharp: sharpMod,
        keys,
        quiescer: shotCompIdleMax > 0 ? quiescer : null,
        idleQuietMs: Math.min(shotIdleQuiet, 250),
        idleMaxMs: shotCompIdleMax,
        stablePollMs: shotStablePoll,
        stableMaxMs: shotStableMax,
        stitch: shotStitch,
      }
    );
    fs.mkdirSync(shotsPageDir, { recursive: true });
    // `skipped` is the compare's evidence that a one-sided absence was a capture
    // THRESHOLD (zero-width / below --min-height) rather than a missing
    // component - it scores those pairs as not-compared instead of 0.
    writeJson(path.join(shotsPageDir, ".components.json"), { components: captured, skipped: skippedEmpty });
    rec.shotsCaptured = captured.length;
    rec.shotsResolved = resolution.resolved.length;
    rec.shotsSkippedEmpty = skippedEmpty.length;
    // Broken out of the skip count so a run that could not photograph its pages is
    // visible in the manifest, rather than reading as a page full of tiny elements.
    const unstable = skippedEmpty.filter((s) => s.reason === "unstable-layout").length;
    if (unstable) rec.shotsUnstable = unstable;
  }

  return rec;
}

let allItems = await getPathsToCapture();

// Frontend-coverage allowlist. Applied to the PAGE LIST rather than at compare time so a
// partially-built frontend costs nothing to test: capturing 4416 pages to score 1 is the
// expensive half. Empty = capture everything, so omitting it changes nothing. Both sides
// must use the same list, or the actual side is missing pages the expected side scored.
if (includePaths.active) {
  const before = allItems.length;
  allItems = allItems.filter((it) => includePaths.has(it.path));
  console.log(
    `--include: ${includePaths.size} pattern(s) — capturing ${allItems.length} of ${before} pages.`
  );
  if (allItems.length === 0) {
    console.error("--include matched no pages. Check the patterns against the page list.");
    process.exit(1);
  }
}

// Failed-only: keep just the pages that failed in the previous content report
// (found in git history / --prev-report). Empty or missing report => capture the
// full set (never silently capture nothing). Applied before --limit.
let failedOnly = false;
if (onlyFailed) {
  const reportDir = path.join(process.cwd(), "tests");
  const prev = loadPreviousReport(reportDir, args["prev-report"] || null);
  const failedSet = prev ? failedPagePaths(prev.report) : new Set();
  if (failedSet.size > 0) {
    const before = allItems.length;
    allItems = allItems.filter((it) => failedSet.has(it.path));
    failedOnly = true;
    console.log(
      `--only-failed: ${allItems.length} of ${before} pages previously failed (from ${prev.source}) — capturing only those.`
    );
  } else {
    console.warn(
      `--only-failed: no failed pages in the previous report${prev ? "" : " (none found)"} — capturing the full set.`
    );
  }
}

if (previewSecret) {
  console.log(
    `Preview bypass armed: protected pages (${[...PROTECTED_STATUSES].join("/")}) are re-probed with ` +
      `is_visual_testing${previewAuthenticated ? " + is_authenticated_editing_mode" : ""}.`
  );
}

const allSelected = limit > 0 ? allItems.slice(0, limit) : allItems;

// --shards K: K capture processes, each with every K-th page. One process funnels every page through
// its single node main thread (CDP traffic, extraction, image work), which sat at ~80% of a core while
// the tuner held ~80 pages and two thirds of a 30-core box idled. The parent starts K copies of this
// command with --shard i/K and its share of --browsers / --concurrency-start / --concurrency-max,
// shows their page lines as one counter, and writes the manifest from the page markers as before.
// A child writes no manifest, so the K never race on one file. Default 1 = one process, as before.
const shardCount = Math.max(1, parseInt(args["shards"] || "1", 10) || 1);
const shardSpec = typeof args["shard"] === "string" ? args["shard"].match(/^(\d+)\/(\d+)$/) : null;
const shardChild = shardSpec ? { index: Number(shardSpec[1]), count: Number(shardSpec[2]) } : null;
const shardParent = shardCount > 1 && !shardChild;
const items = shardChild ? allSelected.filter((_, i) => i % shardChild.count === shardChild.index) : allSelected;
if (shardChild) console.log(`Shard ${shardChild.index + 1}/${shardChild.count}: ${items.length} of ${allSelected.length} pages`);
let shardFailures = 0;
if (shardParent) {
  const share = (name, fallback) => {
    const v = parseInt(args[name] ?? fallback, 10);
    return Number.isFinite(v) && v > 0 ? String(Math.max(1, Math.ceil(v / shardCount))) : null;
  };
  const perChild = {
    browsers: share("browsers", "1"),
    "concurrency-start": share("concurrency-start", "4"),
    "concurrency-max": args["concurrency-max"] ? share("concurrency-max") : String(Math.max(1, Math.ceil(defaultMaxConcurrency() / shardCount))),
  };
  if (!autoConcurrency) perChild.concurrency = share("concurrency", "6");
  // The child command line: this one without --shards, with the per-child shares replacing the originals.
  const replaced = new Set(["shards", ...Object.keys(perChild)]);
  const base = [];
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const name = a.startsWith("--") ? a.slice(2).split("=")[0] : null;
    if (name && replaced.has(name)) { if (!a.includes("=") && raw[i + 1] !== undefined && !raw[i + 1].startsWith("--")) i++; continue; }
    base.push(a);
  }
  for (const [k, v] of Object.entries(perChild)) if (v) base.push(`--${k}`, v);
  console.log(`Shards: ${shardCount} capture processes (per process: ${Object.entries(perChild).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  const { spawn } = await import("node:child_process");
  const readline = await import("node:readline");
  // This module itself, not process.argv[1]: started through bin/cli.mjs, argv[1] is the dispatcher,
  // which has already removed the command word these flags follow.
  const selfPath = (await import("node:url")).fileURLToPath(import.meta.url);
  let shown = 0;
  const runChild = (i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [selfPath, ...base, "--shard", `${i}/${shardCount}`], { stdio: ["ignore", "pipe", "inherit"] });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const m = line.match(/^\[\d+\/\d+\]( .*)$/);
      if (m) console.log(`[${++shown}/${allSelected.length}]${m[1]}`);
      else if (!/^(Capturing \d+|Done: )/.test(line)) console.log(line);
    });
    child.on("exit", (code) => { if (code) shardFailures++; resolve(); });
  });
  await Promise.all(Array.from({ length: shardCount }, (_, i) => runChild(i)));
}
console.log(
  `Capturing ${items.length}${limit > 0 ? ` (of ${allItems.length}, --limit)` : ""} pages from ${baseUrl}` +
    `${outDir ? ` -> ${outDir}` : ""}${shotsOut ? ` + ${shotsOut}` : ""}`
);

// --browsers N: N Chromium instances, each new worker on the least loaded one. One browser funnels
// every page through its own main thread and one GPU compositor (VizCompositor), which top out at
// ~80 pages while the rest of the machine idles; N browsers split both N ways. Default 1.
const browserCount = Math.max(1, parseInt(args["browsers"] || "1", 10) || 1);
const browsers = shardParent ? [] : await Promise.all(Array.from({ length: browserCount }, () => chromium.launch()));
const browserLoad = browsers.map(() => 0);
if (browserCount > 1) console.log(`Browsers: ${browserCount} (workers spread over them)`);
let done = 0;
let failed = 0;
let non200 = 0;
let bypassed = 0;
const queue = [...items];

// Workers read the tuner's target before each page: one above it retires, and the controller
// below spawns new ones when the target rises. Without --concurrency auto there is no tuner and
// the pool is the fixed --concurrency it always was.
const tuner = autoConcurrency
  ? new ConcurrencyTuner({ start: concurrency, max: concurrencyMax, intervalMs: autotuneIntervalMs })
  : null;
let active = 0;

async function worker() {
  // Counted synchronously, before the first await, so the controller never over-spawns.
  active++;
  let counted = true;
  const release = () => {
    if (counted) {
      counted = false;
      active--;
    }
  };
  try {
    await runWorker(release);
  } finally {
    release();
  }
}

async function runWorker(release) {
  let bi = 0;
  for (let i = 1; i < browsers.length; i++) if (browserLoad[i] < browserLoad[bi]) bi = i;
  browserLoad[bi]++;
  try {
    await runWorkerOn(browsers[bi], release);
  } finally {
    browserLoad[bi]--;
  }
}

async function runWorkerOn(browser, release) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
    extraHTTPHeaders: extraHeaders,
    // The local stage server is fronted by portless over HTTPS with a local CA
    // (cha-e2e.localhost); accept it. Remote prod-mirror certs stay valid, so
    // this only relaxes the local-CA case.
    ignoreHTTPSErrors: true,
  });
  // Content-only: block images/media/fonts (dead weight for text). When we also
  // take screenshots, images/fonts must load — block only heavy animated media.
  await context.route("**/*", async (route) => {
    const type = route.request().resourceType();
    if (!doShots) {
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return await continueSameOrigin(route, type);
    }
    const u = route.request().url().toLowerCase();
    if (/\.gif(\?|#|$)/.test(u)) return route.abort();
    if (type === "media" || /\.(m3u8|mpd|ts|m4s|mp4|webm|mov)(\?|#|$)/.test(u)) return route.abort();
    return await continueSameOrigin(route, type);
  });

  for (;;) {
    if (tuner && active > tuner.target) {
      release();
      break;
    }
    const item = queue.shift();
    if (item === undefined) break;
    const { path: pagePath, prodStatus } = item;
    const statusOnly = prodStatus !== null && prodStatus !== 200;

    // Resume: skip only if every REQUESTED output already has this page's marker.
    if (resume) {
      const contentDone = !doContent || fs.existsSync(markerPath(outDir, pagePath));
      const shotsDone = !doShots || fs.existsSync(markerPath(shotsOut, pagePath));
      if (contentDone && shotsDone) {
        done++;
        continue;
      }
    }

    let rec;
    // Load symptoms for the tuner. A zero-capture retry is deliberately not one: a page that
    // genuinely has no components would otherwise hold the pool down for the whole run.
    const signals = {};
    const degraded = new Set();
    const pageStarted = Date.now();
    // Every status a retry was spent on. Whether that was load can only be told afterwards.
    const retriedStatuses = [];
    for (let attempt = 1; ; attempt++) {
      try {
        rec = await capturePage(context, pagePath, statusOnly, signals);
        if (rec.throttled) degraded.add("throttled");
        // Throttled navigation: back off and re-run the whole page. Applies on both sides and
        // regardless of --no-retry, because the alternative is writing a phantom non-200.
        if (rec.throttled) {
          const what = rec.throttledSubresource ? `${rec.throttledSubresource} on` : `${rec.status} navigating`;
          if (attempt < THROTTLE_MAX_ATTEMPTS) {
            const wait = throttleDelayMs(null, attempt);
            console.warn(`  ${what} ${pagePath} - throttled, waiting ${Math.round(wait / 1000)}s`);
            await sleep(wait);
            continue;
          }
          throttleExhausted++;
          console.warn(`  ${what} ${pagePath} - STILL throttled after ${attempt} attempts; recording it`);
        }
        if (!noRetry && !statusOnly && rec.status === 200 && !rec.noIndex && attempt < 2) {
          const emptyContent = doContent && !rec.elements;
          const emptyShots = doShots && !rec.shotsCaptured;
          if ((doContent && emptyContent) || (!doContent && emptyShots)) {
            console.warn(`  zero captured on ${pagePath} - retrying once`);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
        }
        const looksTransient = statusOnly
          ? rec.status >= 500 && rec.status !== prodStatus
          : rec.status !== 200;
        // A stage page that disagrees with a prod 200 gets ONE retry even under --no-retry.
        // --no-retry exists so a genuinely-broken page does not multiply the wait, but a one-off
        // 404/500 from the local server otherwise sticks and scores that page a flat 0: one crawl
        // produced five such pages, every one of them answering 200 on an immediate re-request.
        const worthOneRetry = looksTransient && prodStatus === 200 && attempt < 2;
        if (args["paths"] && looksTransient && (worthOneRetry || (!noRetry && attempt < 3))) {
          degraded.add("transient status");
          retriedStatuses.push(rec.status);
          console.warn(`  status ${rec.status} on ${pagePath} - retrying in 10s`);
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        break;
      } catch (err) {
        degraded.add("exception");
        const maxAttempts = noRetry ? 1 : args["paths"] ? 3 : 2;
        if (attempt >= maxAttempts) {
          rec = { status: 0, error: String(err.message || err).slice(0, 300) };
          failed++;
          break;
        }
        console.warn(`  retrying ${pagePath}: ${err.message}`);
        await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }

    // Write the page marker into each active output dir.
    if (doContent) writeJson(markerPath(outDir, pagePath), rec);
    if (doShots) writeJson(markerPath(shotsOut, pagePath), rec);
    done++;
    // A status every attempt returned alike (a real 404) is the page's answer, not a busy server:
    // the retries could not change it, so it must not make the tuner back off. A retry that came
    // back different - most of all a 200 - was transient, and stays a load signal.
    if (retriedStatuses.length && rec && retriedStatuses.every((s) => s === rec.status)) {
      degraded.delete("transient status");
    }
    if (tuner) {
      if (signals.navTimeout) degraded.add("nav timeout");
      if (rec.shotsUnstable) degraded.add("unstable layout");
      // Parity probes are a status request, not a page load: they say nothing about throughput.
      // Work = the page's component count: in full mode its time grows with its shots.
      tuner.record([...degraded], !statusOnly, rec.targets || 1, Date.now() - pageStarted);
    }
    if (!statusOnly && rec.status !== 200) non200++;
    if (rec.previewBypass) bypassed++;
    const extra = statusOnly
      ? `status ${rec.status} (parity probe, prod was ${prodStatus})`
      : rec.status !== 200
        ? rec.error ? `ERROR ${rec.error}` : `status ${rec.status}`
        : rec.noIndex
          ? "no index.json"
          : [
              doContent ? `${rec.elements} elements` : null,
              doShots ? `${rec.shotsCaptured} shots` : null,
            ].filter(Boolean).join(", ");
    console.log(`[${done}/${items.length}] ${pagePath} — ${extra}${rec.previewBypass ? " [preview bypass]" : ""}`);
  }
  await context.close();
}

const running = shardParent ? [] : Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
const controller = tuner && !shardParent
  ? setInterval(() => {
      const target = tuner.tick();
      while (active < target && queue.length > 0) running.push(worker());
    }, 1000)
  : null;
// The pool can grow while we wait, so drain until no worker is left.
while (running.length) await Promise.all(running.splice(0));
if (controller) clearInterval(controller);
if (tuner && !shardParent) console.log(tuner.summary());
await Promise.all(browsers.map((b) => b.close()));

// A shard child is done here: the parent writes the manifest once every child has finished.
if (shardChild) {
  console.log(`Done: shard ${shardChild.index + 1}/${shardChild.count}, ${items.length} pages, ${non200} non-200 (${failed} hard failures)`);
  process.exit(throttleExhausted || items.length === 0 || failed > items.length / 2 ? 1 : 0);
}
// The parent counts from the markers its children wrote.
if (shardParent) {
  for (const { path: p } of items) {
    const m = markerPath(doShots ? shotsOut : outDir, p);
    if (!fs.existsSync(m)) { failed++; continue; }
    try { const rec = readJson(m); if (!rec.status) failed++; else if (rec.status !== 200 && !rec.statusOnly) non200++; } catch { failed++; }
  }
}

// Aggregate per-page markers into a manifest, once per active output dir.
//
// --merge-manifest keeps the pages an EARLIER capture into the same dir listed and this one did
// not ask for, so several page scopes can share one dataset: a narrow scope captured with
// --resume into a dir a wide scope already filled visits nothing and leaves the wide manifest
// intact, where a plain rewrite would shrink it to the narrow scope's pages. Pages this capture
// did ask for are re-read from their markers either way.
const mergeManifest = Boolean(args["merge-manifest"]);
function writeManifest(dir) {
  const pages = {};
  if (mergeManifest) {
    const prevFile = path.join(dir, "manifest.json");
    if (fs.existsSync(prevFile)) {
      try {
        Object.assign(pages, readJson(prevFile).pages || {});
      } catch {
        // an unreadable manifest is rebuilt from this capture's markers alone
      }
    }
  }
  for (const { path: pagePath } of items) {
    const m = markerPath(dir, pagePath);
    pages[pagePath] = fs.existsSync(m) ? readJson(m) : { status: 0, error: "not captured" };
  }
  writeJson(path.join(dir, "manifest.json"), {
    baseUrl,
    side: isStage ? "migrated" : "prod",
    captureMode,
    generatedAt: new Date().toISOString(),
    source: args["sitemap"] ? "sitemap" : args["pages-from-dir"] ? "pages-from-dir" : "paths",
    partial: limit > 0 || undefined,
    failedOnly: failedOnly || undefined,
    pages,
  });
  return path.join(dir, "manifest.json");
}
const manifests = [];
if (doContent) manifests.push(writeManifest(outDir));
if (doShots) manifests.push(writeManifest(shotsOut));

const totalShots = doShots
  ? items.reduce((n, it) => {
      const m = markerPath(shotsOut, it.path);
      if (!fs.existsSync(m)) return n;
      try { return n + (readJson(m).shotsCaptured || 0); } catch { return n; }
    }, 0)
  : 0;
console.log(
  `Done: ${items.length} pages, ${non200} non-200 (${failed} hard failures)` +
    `${bypassed ? `, ${bypassed} opened via the preview bypass` : ""}` +
    `${throttleExhausted ? `, ${throttleExhausted} STILL THROTTLED` : ""}` +
    `${doShots ? `, ${totalShots} screenshots` : ""}. Manifest(s): ${manifests.join(", ")}`
);

if (items.length === 0 || failed > items.length / 2 || shardFailures) {
  console.error("Capture unhealthy (no pages or >50% failures) — failing.");
  process.exit(1);
}

// A page still throttled after every retry is recorded with its 429/503, which reads exactly
// like a genuine non-200 downstream. That is a corrupt dataset, not a slow one, so refuse to
// let it be committed as a baseline — lower --concurrency and re-run (--resume keeps the good
// pages; delete the .page.json markers of the throttled ones first so they are re-captured).
if (throttleExhausted) {
  console.error(
    `Capture poisoned: ${throttleExhausted} page(s) still throttled after ${THROTTLE_MAX_ATTEMPTS} attempts. ` +
      (tuner
        ? `Re-run with a lower --concurrency-max (the tuner ended at ${tuner.target}).`
        : `Re-run with a lower --concurrency (current ${concurrency}).`)
  );
  process.exit(1);
}
