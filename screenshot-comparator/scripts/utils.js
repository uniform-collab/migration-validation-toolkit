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

/**
 * e.g. "PROD: " + wrapped body; continuation lines align under the label text.
 */
export function formatPrefixedWrappedBlock(prefix, normalizedText) {
  const wrapped = wrapInnerTextForContentLog(normalizedText);
  if (!wrapped) return prefix;
  const parts = wrapped.split("\n");
  const head = `${prefix}${parts[0]}`;
  const pad = " ".repeat(prefix.length);
  return [head, ...parts.slice(1).map((l) => `${pad}${l}`)].join("\n");
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
