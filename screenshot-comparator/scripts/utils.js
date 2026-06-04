export function env(key) {
  const v = process.env[key];
  if (!v) {
    throw new Error("🆘 Add this env variable to .env file: " + key);
  }
  return v;
}

/** When truthy (1, true, yes, on), capture and diff per-component innerText snapshots. */
export function isContentComparisonEnabled() {
  const v = String(process.env.ENABLE_CONTENT_COMPARISON || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Append migrated-site visual testing access query params for screenshot workers.
 * Uses VERCEL_PREVIEW_SECRET; leaves URL unchanged when secret is unset.
 */
export function withMigratedScreenshotAccess(urlString) {
  const secret = String(process.env.VERCEL_PREVIEW_SECRET || "").trim();
  if (!secret) return urlString;
  const u = new URL(urlString);
  u.searchParams.set("is_visual_testing", "true");
  u.searchParams.set("secret", secret);
  return u.toString();
}

/** Target line length for innerText in content diff logs (default 80, min 20, max 500). */
function getInnerTextLogWrapWidth() {
  const raw = String(process.env.INNER_TEXT_LOG_WRAP_WIDTH || "").trim();
  if (!raw) return 80;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 20 && n <= 500 ? n : 80;
}

/**
 * Word-wrap normalized innerText to fixed width; very long tokens are hard-broken.
 * Full text is always included (no truncation).
 */
export function wrapInnerTextForContentLog(normalizedText) {
  const text = String(normalizedText ?? "");
  const width = getInnerTextLogWrapWidth();
  if (!text) return "";
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  const flush = () => {
    if (line) {
      lines.push(line);
      line = "";
    }
  };
  for (const w of words) {
    if (w.length > width) {
      flush();
      let rest = w;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      line = rest;
      continue;
    }
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length <= width) {
      line = candidate;
    } else {
      flush();
      line = w;
    }
  }
  flush();
  return lines.join("\n");
}

/** Words of context around the differing span in content mismatch logs (default 8). */
function getInnerTextDiffContextWords() {
  const raw = String(process.env.INNER_TEXT_DIFF_CONTEXT_WORDS || "").trim();
  if (!raw) return 8;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 8;
}

function expandRangeWithWordContext(str, coreStart, coreEnd, wordsBefore, wordsAfter) {
  let s = coreStart;
  for (let w = 0; w < wordsBefore && s > 0; w++) {
    while (s > 0 && /\s/.test(str[s - 1])) s--;
    if (s === 0) break;
    while (s > 0 && /\S/.test(str[s - 1])) s--;
  }

  let e = coreEnd;
  for (let w = 0; w < wordsAfter && e < str.length; w++) {
    while (e < str.length && /\s/.test(str[e])) e++;
    if (e >= str.length) break;
    while (e < str.length && /\S/.test(str[e])) e++;
  }

  return { start: s, end: e };
}

function buildInnerTextDiffExcerpt(normalizedText, coreStart, coreEnd) {
  const str = String(normalizedText ?? "");
  if (!str) return "";
  const words = getInnerTextDiffContextWords();
  const { start, end } = expandRangeWithWordContext(
    str,
    coreStart,
    coreEnd,
    words,
    words
  );
  let out = str.slice(start, end);
  if (start > 0) out = `(...) ${out}`;
  if (end < str.length) out = `${out} (...)`;
  return out;
}

/**
 * Excerpts around the first/last differing span (shared prefix/suffix stripped).
 */
export function extractInnerTextDiffExcerpts(prodNormalized, migratedNormalized) {
  const a = String(prodNormalized ?? "");
  const b = String(migratedNormalized ?? "");

  let prefixLen = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefixLen < minLen && a[prefixLen] === b[prefixLen]) prefixLen++;

  let suffixLen = 0;
  const maxSuffix = Math.min(a.length - prefixLen, b.length - prefixLen);
  while (
    suffixLen < maxSuffix &&
    a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  return {
    prod: buildInnerTextDiffExcerpt(a, prefixLen, a.length - suffixLen),
    mig: buildInnerTextDiffExcerpt(b, prefixLen, b.length - suffixLen),
  };
}

/** Separator between PROD / MIGRATED blocks; width matches INNER_TEXT_LOG_WRAP_WIDTH. */
export function getContentLogSectionSeparator() {
  return "=".repeat(getInnerTextLogWrapWidth());
}

/**
 * One environment block: separator, label, blank line, then word-wrapped text.
 * @param {"PROD"|"MIGRATED"} label
 */
export function formatContentLogEnvironmentBlock(label, text) {
  const wrapped = wrapInnerTextForContentLog(text);
  const body = wrapped ? `\n\n${wrapped}` : "";
  return `${getContentLogSectionSeparator()}\n${label}: ${body}`;
}

/** PROD vs MIGRATED innerText mismatch message for reports (diff-focused excerpts). */
export function formatContentMismatchLog(prodNormalized, migratedNormalized) {
  const { prod, mig } = extractInnerTextDiffExcerpts(
    prodNormalized,
    migratedNormalized
  );
  return [
    "innerText differs (whitespace-normalized).",
    "",
    formatContentLogEnvironmentBlock("PROD", prod),
    formatContentLogEnvironmentBlock("MIGRATED", mig),
  ].join("\n");
}

/** Normalize innerText for comparison (whitespace-insensitive). */
export function normalizeInnerTextForCompare(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isGif(u) {
  if (!u) return false;
  const clean = u.split(/[?#]/)[0].toLowerCase();
  return clean.endsWith(".gif");
}

export function isVideo(u, resourceType) {
  // Playwright marks actual media streams as "media"
  if (resourceType === "media") return true;
  if (!u) return false;
  const clean = u.split(/[?#]/)[0].toLowerCase();
  return /\.(mp4|webm|m4v|mov|ogv|m3u8|mpd|ts)$/.test(clean);
}

export function extractCandidateUrl(raw) {
  try {
    const u = new URL(raw);

    // Next.js Image Optimizer
    if (u.pathname === "/_next/image") {
      const p = u.searchParams.get("url");
      if (p) return resolveNested(p, raw);
    }

    // Generic proxies: ?url=, ?src=, ?image= ...
    for (const key of ["url", "u", "src", "image", "img", "filename", "file"]) {
      const val = u.searchParams.get(key);
      if (val) return resolveNested(val, raw);
    }

    // Cloudflare Images and other path-embedded URLs
    // e.g. /cdn-cgi/image/.../https://host/path/file.gif
    const match = raw.match(/https?:\/\/[^)"'\s]+/i);
    if (match) return resolveNested(match[0], raw);

    return raw;
  } catch {
    // if raw is not a valid absolute/relative URL, try regex fallback anyway
    const match = String(raw).match(/https?:\/\/[^)"'\s]+/i);
    return match ? match[0] : raw;
  }

  function resolveNested(val, base) {
    let v = val;
    for (let i = 0; i < 3; i++) {
      try {
        const dec = decodeURIComponent(v);
        if (dec === v) break;
        v = dec;
      } catch { break; }
    }
    try { return new URL(v, base).toString(); } catch { return v; }
  }
}

export function isAllowedMediaUrl(u) {
  if (!u) return false;
  try {
    const { hostname, pathname } = new URL(u);
    return (
      hostname.toLowerCase() === "c.clarity.ms" &&
      pathname.toLowerCase().endsWith("/c.gif")
    );
  } catch {
    return false;
  }
}

export async function retryWithBackoff(
  fn,
  retries = 2,
  delay = 5000,
  hardTimeout = 60000
) {
  let attempt = 0;

  while (attempt < retries) {
    const label = `⏱️ attempt ${attempt + 1}`;
    const start = Date.now();

    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`⏰ Hard timeout after ${hardTimeout}ms`)),
            hardTimeout
          )
        ),
      ]);
      const duration = Date.now() - start;
      console.log(`✅ ${label} succeeded in ${duration}ms`);
      return result;
    } catch (err) {
      const duration = Date.now() - start;

      if (
        (err.name === "TimeoutError" ||
          err.message?.includes("Hard timeout")) &&
        attempt < retries - 1
      ) {
        console.warn(`⚠️ ${label} failed in ${duration}ms: ${err.message}`);
        console.warn(`🔁 Retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
        attempt++;
      } else {
        console.error(
          `❌ ${label} gave up after ${duration}ms: ${err.message}`
        );
        throw err;
      }
    }
  }
}

export async function gotoWithHardTimeout(
  page,
  url,
  waitUntil = "load",
  timeoutMs = 90000
) {
  return await Promise.race([
    page.goto(url, { waitUntil: waitUntil, timeout: timeoutMs }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`⏰ Hard timeout after ${timeoutMs}ms`)),
        timeoutMs + 2000
      )
    ),
  ]);
}
