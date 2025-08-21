export function env(key) {
  const v = process.env[key];
  if (!v) {
    throw new Error("🆘 Add this env variable to .env file: " + key);
  }
  return v;
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
