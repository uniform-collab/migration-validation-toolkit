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
  removeOverlayElements,
  resolveAndTagTargets,
  captureResolvedTargets,
  parseOverlaySelectors,
  getSharp,
  attachNetworkQuiescer,
} from "./lib/screenshot.mjs";
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
  const itemsRoot =
    typeof args["items-root"] === "string" && args["items-root"].trim()
      ? args["items-root"].trim()
      : undefined;
  const built = buildUrlToIndexMap(presentationRoot, itemRoot, itemsRoot);
  urlIndexMap = built.map;
  const st = built.stats || {};
  console.log(
    `V2 selector mode: indexed ${built.files.length} index.json under ${presentationRoot} ` +
      `(root ItemPath ${built.rootItemPath}); ${urlIndexMap.size} URLs; body-only=${bodyOnly}.`
  );
  console.log(
    itemsRoot
      ? `  URLs from item Slug: ${st.fromSlug || 0}, from ItemPath fallback: ${st.fromItemPath || 0}, ` +
          `unresolved: ${st.unresolved || 0}, duplicates: ${st.duplicates || 0} (items root ${itemsRoot}).`
      : `  WARNING: no --items-root given; all ${st.fromItemPath || 0} URLs derived from ItemPath. ` +
          `Pages whose Sitecore URL differs from their tree path will not be scored.`
  );
}
console.log(`Capture mode: ${captureMode} (content=${doContent}, screenshots=${doShots})${isStage ? " [stage]" : ""}`);

const concurrency = Math.max(1, parseInt(args["concurrency"] || "6", 10) || 6);
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
// Capture mechanism. Stitching walks the element past the viewport a band at a time and
// composites the viewport rasters, instead of handing CDP one oversized clip - see
// captureStitched in lib/screenshot.mjs for why that path is worth avoiding. Output
// geometry is identical either way, so this can be turned off without re-capturing a
// baseline; 0 = use elementHandle.screenshot() as before.
const shotStitch = !(args["shot-stitch"] === "0" || args["shot-stitch"] === false);
let sharpMod = null;

// Header-only bypass on purpose: adding x-vercel-set-bypass-cookie makes Vercel
// answer 307 (cookie-set redirect), which the redirect-less status check would
// misread as non-200. The header alone passes every request.
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
 */
function listPagesFromDir(rootDir, marker) {
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
      } else if (e.name === marker) {
        out.push(rel === "" ? "/" : rel);
      }
    }
  }
  return [...new Set(out)].sort();
}

async function getPathsToCapture() {
  if (args["pages-from-dir"]) {
    const dir = String(args["pages-from-dir"]);
    const marker = String(args["page-marker"] || "prod.html");
    const paths = listPagesFromDir(dir, marker);
    if (!paths.length) {
      console.error(`No "${marker}" files found under ${dir} — nothing to capture.`);
      process.exit(1);
    }
    // Snapshot the derived list next to the output, the same way --sitemap snapshots the XML,
    // so the dataset records which page set it was built from.
    for (const d of [outDir, shotsOut]) {
      if (d) {
        fs.mkdirSync(d, { recursive: true });
        writeJson(path.join(d, "pages.json"), { source: dir, marker, count: paths.length, paths });
      }
    }
    console.log(`Page list: ${paths.length} pages from ${marker} files under ${dir}.`);
    return paths.map((p) => ({ path: p, prodStatus: null }));
  }
  if (args["sitemap"]) {
    const paths = await getSitemapPaths(String(args["sitemap"]));
    return paths.map((p) => ({ path: p, prodStatus: null }));
  }
  if (args["paths"]) {
    const manifest = readJson(String(args["paths"]));
    return Object.entries(manifest.pages)
      .map(([p, rec]) => ({ path: p, prodStatus: rec.status }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  console.error(
    "Provide one of --sitemap <url>, --pages-from-dir <static-mirror-dir>, or --paths <manifest.json>"
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
        res.resume();   // drain: we only want the status line
        resolve(res.statusCode);
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

async function getStatus(request, url) {
  if (isLocalhostHost(url)) return await probeLocalhostStatus(url);
  for (let attempt = 1; ; attempt++) {
    const res = await request.get(url, { maxRedirects: 0, timeout: navTimeout, failOnStatusCode: false });
    const status = res.status();
    if (!THROTTLE_STATUSES.has(status)) return status;
    if (attempt >= THROTTLE_MAX_ATTEMPTS) {
      throttleExhausted++;
      console.warn(`  ${status} on ${url} - STILL throttled after ${attempt} attempts; recording it`);
      return status;
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

async function capturePage(context, pagePath, statusOnly) {
  let url = baseUrl + pagePath;
  const rec = { status: 0 };

  rec.status = await getStatus(context.request, url);

  // Route-protected page + a preview secret => re-probe once through the bypass and, if that
  // opens it, capture from the bypass URL. Skipped for statusOnly pages on purpose: those are
  // the prod-non-200 parity probes, where turning a matching 404 into a 200 would MANUFACTURE
  // a status mismatch. So this only ever unlocks a page prod itself served with 200 — i.e. it
  // does nothing until the prod baseline for protected pages is captured signed in.
  if (previewSecret && !statusOnly && PROTECTED_STATUSES.has(rec.status)) {
    const bypassUrl = withPreviewBypass(url);
    const bypassStatus = await getStatus(context.request, bypassUrl);
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
 * V2 capture for one page: resolve this page's index.json targets once, then
 * produce content (masked innerText) and/or screenshots from the same page.
 */
async function captureV2(page, pagePath, rec, quiescer) {
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

const items = limit > 0 ? allItems.slice(0, limit) : allItems;
console.log(
  `Capturing ${items.length}${limit > 0 ? ` (of ${allItems.length}, --limit)` : ""} pages from ${baseUrl}` +
    `${outDir ? ` -> ${outDir}` : ""}${shotsOut ? ` + ${shotsOut}` : ""}`
);

const browser = await chromium.launch();
let done = 0;
let failed = 0;
let non200 = 0;
let bypassed = 0;
const queue = [...items];

async function worker() {
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
    for (let attempt = 1; ; attempt++) {
      try {
        rec = await capturePage(context, pagePath, statusOnly);
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
          console.warn(`  status ${rec.status} on ${pagePath} - retrying in 10s`);
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        break;
      } catch (err) {
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

await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
await browser.close();

// Aggregate per-page markers into a manifest, once per active output dir.
function writeManifest(dir) {
  const pages = {};
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

if (items.length === 0 || failed > items.length / 2) {
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
      `Re-run with a lower --concurrency (current ${concurrency}).`
  );
  process.exit(1);
}
