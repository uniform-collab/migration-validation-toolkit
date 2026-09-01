/**
 * V2 (selector-driven) support for the 6-tests harness.
 *
 * Ported from the migration-validation-toolkit's selector-driven pipeline
 * (screenshot-comparator/scripts/index-json.js). Instead of one hand-authored
 * selector map applied to every page, V2 derives each page's capture targets
 * from the migration's per-page index.json, which lists every Sitecore
 * rendering and (when resolvable) its prod-DOM CssSelector.
 *
 * index.json shape (nested):
 *   { ItemPath, Name, ID, Placeholders: [ { Key, Renderings: [ {
 *       Name, ID, RenderingID, CssSelector?, Placeholders: [ ... ] // recurses
 *   } ] } ] }
 *
 * Public URL ↔ index.json comes from Sitecore itself: every item in the frozen
 * export (`data/items/<lang>/<a>/<b>/<guid>.json`) carries the resolved `Slug`,
 * and index.json carries that item's `ID`, so the two join directly. Re-deriving
 * the URL by slugifying ItemPath is only a FALLBACK for datasets without the item
 * export — it cannot reproduce Sitecore's rules (see buildUrlToIndexMap).
 *
 * Unlike the toolkit copy, functions here take explicit parameters (no env
 * reads) — the pipeline passes everything as CLI args to capture.mjs.
 */
import fs from "fs";
import path from "path";

/**
 * Slugify a single content-tree segment into a URL segment.
 *
 * Approximate by design: this is the ItemPath FALLBACK path (buildUrlToIndexMap prefers the
 * item's real Slug) and, separately, the basis of componentKey — which names files in the frozen
 * expected dataset, so its output must stay stable. Do not "fix" the whitespace rule here to match
 * Sitecore: it would rename every component key and unpair the whole dataset.
 */
export function slugifySegment(segment) {
  return String(segment ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function trimTrailingSlashes(s) {
  return String(s ?? "").replace(/\/+$/g, "");
}

/**
 * Convert an item's ItemPath to its public URL, relative to rootItemPath.
 * The root item itself maps to "/". Returns null if not under rootItemPath.
 */
export function slugifyItemPathToUrl(itemPath, rootItemPath) {
  const item = trimTrailingSlashes(itemPath);
  const root = trimTrailingSlashes(rootItemPath);
  if (!item || !root) return null;
  if (item.toLowerCase() === root.toLowerCase()) return "/";
  const prefix = root + "/";
  if (item.toLowerCase().indexOf(prefix.toLowerCase()) !== 0) return null;
  const rest = item.slice(prefix.length);
  const segments = rest.split("/").filter(Boolean).map(slugifySegment);
  return "/" + segments.join("/");
}

/** Normalize a URL (from sitemap/manifest) for map lookups. */
export function normalizeUrlForLookup(url) {
  let u = String(url ?? "").trim();
  try {
    u = new URL(u).pathname;
  } catch {
    // already relative
  }
  if (!u.startsWith("/")) u = "/" + u;
  u = u.toLowerCase();
  if (u.length > 1) u = u.replace(/\/+$/g, "") || "/";
  return u;
}

/**
 * Directories that never hold a page: `_assets` is where `download-presentation --assets` puts the
 * downloaded site assets (thousands of files, none of them a page), the rest are the usual noise a
 * dump root can accumulate. Skipping them keeps the walk to the page tree.
 */
const SKIP_DIRS = new Set(["_assets", "node_modules", "reports", "test-results"]);

/** Recursively collect every index.json path under a directory. */
export function findIndexJsonFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === "index.json") out.push(full);
    }
  }
  return out;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`WARN: failed to parse ${file}: ${e.message}`);
    return null;
  }
}

/**
 * Read ONLY `ItemPath` and `ID` out of an index.json, without parsing the file.
 *
 * Building the URL map needs exactly those two fields from every index.json in the tree —
 * the renderings are read later, per page, and only for pages actually captured. Whether
 * that is cheap depends entirely on the export: a presentation-only index.json is a few
 * KB, but an export that embeds each rendering's rendered `Html` runs to ~1.5 MB per page
 * (3.5 MB at the tail). At 4416 pages that is ~6.6 GB to parse — and the map was doing it
 * TWICE, once to resolve the root ItemPath and once to build the map, which took the build
 * from seconds to over ten minutes.
 *
 * So: read a bounded head of the file and pull the two scalars out with a regex. Both keys
 * sit in the first object level ahead of the `Placeholders` array in every export seen so
 * far, and HEAD_BYTES is far larger than that prefix. Anything that does not match falls
 * back to a full parse, so an export that orders its keys differently is slower but still
 * correct — never silently wrong.
 */
const HEAD_BYTES = 64 * 1024;

function readIndexHeader(file) {
  let head;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      head = buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const itemPath = /"ItemPath"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  const id = /"ID"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (itemPath && id) {
    return { ItemPath: JSON.parse(`"${itemPath[1]}"`), ID: JSON.parse(`"${id[1]}"`) };
  }
  // Unrecognised shape (reordered keys, or a prefix longer than HEAD_BYTES): pay for the
  // full parse rather than dropping the page.
  const json = readJsonSafe(file);
  return json ? { ItemPath: json.ItemPath, ID: json.ID } : null;
}

/**
 * Read an item out of the frozen Sitecore export.
 *
 * Two export layouts are in the wild and BOTH must work, because a miss here is SILENT:
 * the caller just falls back to slugifying ItemPath, which drops pages without erroring.
 *   sharded  data/items/<lang>/<a>/<b>/<guid>.json   (first two GUID chars)
 *   flat     data/items/<lang>/{<guid>}.json         (braces kept, one directory)
 * The braces are part of the FILENAME in the flat form while the id inside index.json is
 * bare, so both spellings are tried.
 */
function readExportedItem(itemsRoot, rawId) {
  const id = String(rawId ?? "")
    .replace(/[{}]/g, "")
    .trim()
    .toLowerCase();
  if (!itemsRoot || id.length < 2) return null;
  const candidates = [
    path.join(itemsRoot, id[0], id[1], `${id}.json`),
    path.join(itemsRoot, `{${id}}.json`),
    path.join(itemsRoot, `${id}.json`),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return readJsonSafe(file);
  }
  return null;
}

/**
 * Build a map of public URL → absolute index.json path.
 *
 * The URL comes from Sitecore, not from us: each item in the export carries the `Slug`
 * Sitecore itself resolved, and index.json carries that item's `ID`, so the join is exact.
 * Deriving the URL from ItemPath instead cannot reproduce Sitecore's rules and silently drops
 * pages from the comparison (a missing URL is not an error here — the page is simply never
 * scored). Two classes it got wrong on this dataset: item BUCKETS, where the yyyy/mm/dd folders
 * are hidden from the URL for events but kept for news, so no path rule covers both; and names
 * containing a double space, which Sitecore slugifies per character ("A  B" → "a--b") while a
 * `/\s+/` slugifier collapses the run to one dash.
 *
 * `itemsRoot` is optional: without it (or for an item missing from the export) the old
 * ItemPath slugify still runs, so a dataset with no item export keeps working, just with the
 * coverage gap that implies.
 *
 * @returns {{ map: Map<string,string>, rootItemPath: string, files: string[], stats: object }}
 */
export function buildUrlToIndexMap(rootDir, rootItemPathOverride, itemsRoot) {
  const files = findIndexJsonFiles(rootDir);
  // One header read per file, shared by the root resolution below and the map build, so a
  // large export is scanned once rather than twice (see readIndexHeader).
  const headers = new Map(files.map((f) => [f, readIndexHeader(f)]));
  const rootItemPath = resolveRootItemPathFrom(rootDir, headers, rootItemPathOverride);
  if (!rootItemPath) {
    throw new Error(
      `Could not determine root ItemPath under ${rootDir}. Set TEST_SELECTOR_ITEM_ROOT_PATH.`
    );
  }
  const map = new Map();
  const stats = { fromSlug: 0, fromItemPath: 0, unresolved: 0, duplicates: 0 };
  for (const file of files) {
    const json = headers.get(file);
    if (!json?.ItemPath) continue;
    const item = readExportedItem(itemsRoot, json.ID);
    let url = null;
    if (item?.Slug) {
      url = normalizeUrlForLookup(item.Slug);
      stats.fromSlug++;
    } else {
      url = slugifyItemPathToUrl(json.ItemPath, rootItemPath);
      if (url === null) {
        stats.unresolved++;
        continue;
      }
      stats.fromItemPath++;
    }
    // First writer wins, so a Slug-derived entry is never displaced by a fallback one.
    if (map.has(url)) stats.duplicates++;
    else map.set(url, file);
  }
  return { map, rootItemPath, files, stats };
}

/**
 * Resolve the tree's root ItemPath from an already-read header map (see buildUrlToIndexMap).
 * An explicit override wins; otherwise the tree root's own index.json, else the shortest
 * ItemPath in the tree.
 */
function resolveRootItemPathFrom(rootDir, headers, override) {
  if (override && override.trim()) return trimTrailingSlashes(override.trim());
  const rootIndex = path.join(rootDir, "index.json");
  const rootHead = headers.get(rootIndex);
  if (rootHead?.ItemPath) return trimTrailingSlashes(rootHead.ItemPath);
  let shortest = null;
  for (const head of headers.values()) {
    const ip = head?.ItemPath;
    if (!ip) continue;
    if (shortest === null || ip.length < shortest.length) shortest = ip;
  }
  return shortest ? trimTrailingSlashes(shortest) : null;
}

function hasSelector(rendering) {
  return (
    typeof rendering?.CssSelector === "string" &&
    rendering.CssSelector.trim().length > 0
  );
}

/**
 * DFS the presentation tree → ordered flat list of capture targets (renderings
 * with a non-empty CssSelector). `order` is a stable DFS counter (identical for
 * prod & stage because both derive from the same index.json). `rootPlaceholderKey`
 * is the top-level page placeholder the target descends from (used for the
 * body-only filter, e.g. drop "header"/"footer"/GTM).
 */
export function extractCaptureTargets(indexJson) {
  const targets = [];
  let order = 0;

  const walk = (renderings, depth, placeholderKey, rootPlaceholderKey) => {
    if (!Array.isArray(renderings)) return;
    for (const r of renderings) {
      if (hasSelector(r)) {
        targets.push({
          order: order++,
          name: r.Name || "<unnamed>",
          id: r.ID || "",
          renderingId: r.RenderingID || "",
          selector: r.CssSelector.trim(),
          // A selector is allowed to match a few elements; the migration pins which one this
          // rendering is (index into querySelectorAll) and how far up its root sits from the
          // matched element (CSS has no parent combinator).
          index: Number.isInteger(r.CssSelectorIndex) ? r.CssSelectorIndex : 0,
          levelsUp: Number.isInteger(r.CssSelectorLevelsUp) ? r.CssSelectorLevelsUp : 0,
          depth,
          placeholderKey,
          rootPlaceholderKey,
        });
      }
      if (Array.isArray(r.Placeholders)) {
        for (const ph of r.Placeholders) {
          walk(ph.Renderings, depth + 1, ph.Key || placeholderKey, rootPlaceholderKey);
        }
      }
    }
  };

  if (Array.isArray(indexJson?.Placeholders)) {
    for (const ph of indexJson.Placeholders) {
      const key = ph.Key || "";
      walk(ph.Renderings, 0, key, key);
    }
  }
  return targets;
}

export function loadCaptureTargets(indexPath) {
  const json = readJsonSafe(indexPath);
  if (!json) return [];
  return extractCaptureTargets(json);
}

/** Placeholders excluded by the body-only filter (matches V1's "between header and footer"). */
const NON_BODY_PLACEHOLDER = /^(header|footer)$/i;
const GTM_PLACEHOLDER = /google-tag|gtm/i;
/**
 * Ad slots (`*-ad-top`, `*-ads-rail`) hold SmartAdServer renderings the migration
 * deliberately does not carry. Their selectors are positional — `.ad_spot_container > div`
 * [0] — so with the ad element absent the target re-resolves onto whatever follows, and the
 * comparison then scores an unrelated component against the ad's empty prod capture. On CHT
 * articles it landed on the Related Events block, producing 8 diffs whose text was
 * byte-identical to that page's own (correctly scoring) Related Events capture.
 */
const AD_PLACEHOLDER = /(^|-)ads?(-|$)/i;

/** Parse a comma-separated list of rendering names into a lookup set. */
export function parseExcludedComponents(value) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Flag targets whose rendering is deliberately out of scope (TEST_EXCLUDE_COMPONENTS).
 *
 * They are flagged, NOT dropped: an excluded component still has to be resolved and masked out of
 * its ancestors' text, or the parent simply inherits what the child was rendering and diffs in its
 * place. Excluding is only meaningful if the subtree leaves the comparison entirely.
 */
export function markExcludedComponents(targets, excluded) {
  if (!excluded || excluded.size === 0) return targets;
  for (const t of targets) {
    if (excluded.has(String(t.name || "").toLowerCase())) t.excluded = true;
  }
  return targets;
}

/** Keep only main-content targets (drop header/footer/GTM/ad top-level placeholders). */
export function filterBodyOnly(targets) {
  return targets.filter((t) => {
    const k = String(t.rootPlaceholderKey || "");
    if (NON_BODY_PLACEHOLDER.test(k)) return false;
    if (GTM_PLACEHOLDER.test(k)) return false;
    // Ad slots are nested inside `main`, so they have to be matched on the target's own
    // placeholder, not the root one.
    if (AD_PLACEHOLDER.test(String(t.placeholderKey || ""))) return false;
    return true;
  });
}

/**
 * Selector re-anchoring. The migration derives CssSelectors from the PROD DOM,
 * where the SXA container #wrapper is body > div:nth-of-type(2). The migrated
 * (Uniform/Next.js) frontend keeps inner markup/classes but adds an outer
 * wrapper, so re-anchoring the prod prefix to #wrapper makes the same selector
 * resolve on BOTH sides. Override with a JSON array of {from,to}; "[]" disables.
 */
export function parseRebaseRules(json) {
  if (json === undefined || json === null || String(json).trim() === "") {
    return [{ from: "body > div:nth-of-type(2)", to: "#wrapper" }];
  }
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (r) => r && typeof r.from === "string" && typeof r.to === "string"
      );
    }
  } catch {
    /* fall through */
  }
  return [{ from: "body > div:nth-of-type(2)", to: "#wrapper" }];
}

export function normalizeSelector(selector, rules) {
  let s = String(selector ?? "").replace(/\s+/g, " ").trim();
  for (const rule of rules || []) {
    const f = String(rule.from).replace(/\s+/g, " ").trim();
    if (!f) continue;
    if (s === f) return rule.to;
    if (s.startsWith(f + " ")) return rule.to + s.slice(f.length);
  }
  return s;
}

/**
 * How a target resolves to an element — the contract every capture path must follow:
 *
 *     querySelectorAll(selector)[index]  then  .parentElement × levelsUp
 *
 * `querySelector` alone is wrong: the migration deliberately emits selectors that may match a few
 * elements and disambiguates by index. The two in-page resolvers (`collectComponentTexts` for
 * content, `resolveAndTagTargets` for screenshots) each inline this, because a `page.evaluate`
 * function is serialized without its module scope and cannot import a shared helper.
 */

const KEY_ILLEGAL = /[<>:"/\\|?*\0]/g;

/**
 * Filesystem-safe, human-readable component key (folder-free basename).
 *
 * Keyed on the rendering's own layout UID, NOT on its position in the target list: the position
 * shifts whenever selector coverage changes (a rendering that gains a selector renumbers everything
 * after it), which would silently unpair every component against the frozen expected dataset. The
 * UID is stable for the life of the page's layout.
 */
export function componentKey(target) {
  const name = slugifySegment(target.name).replace(KEY_ILLEGAL, "") || "component";
  const id = String(target.id || "").replace(/[{}]/g, "").slice(0, 8);
  if (!id) {
    // No UID to key on — fall back to the positional form so the key is at least unique.
    return `${String(target.order).padStart(2, "0")}__${name}__noid`;
  }
  return `${name}__${id}`;
}

/**
 * Component keys for a whole page, with collisions (the same rendering UID twice) broken by DFS
 * order so no two targets can ever share a dataset filename.
 * @returns {Map<number,string>} target.order → key
 */
export function assignComponentKeys(targets) {
  const used = new Set();
  const keys = new Map();
  for (const t of targets) {
    let key = componentKey(t);
    if (used.has(key)) key = `${key}__${String(t.order).padStart(2, "0")}`;
    used.add(key);
    keys.set(t.order, key);
  }
  return keys;
}
