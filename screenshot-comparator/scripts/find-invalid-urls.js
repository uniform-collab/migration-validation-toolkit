// find-invalid-urls.js
// Requires: Node 18+ (global fetch), "cheerio" package, and utils.js with env()

import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import { env } from "./utils.js";
import dotenv from "dotenv";

dotenv.config();

const BASE_URL = env("STAGE_WEBSITE_URL");
const SITEMAP_FILE = "./.temp/urls.json";

// Default concurrency for processing sitemap entries
const DEFAULT_CONCURRENCY = 4;

let CONCURRENCY = DEFAULT_CONCURRENCY;
try {
  const raw = env("URL_CHECK_CONCURRENCY");
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    CONCURRENCY = parsed;
  }
} catch {
  // If env("URL_CHECK_CONCURRENCY") is not defined, fallback to default
}

// Array that will store all invalid URLs found during the scan
const invalidUrls = [];

// Keywords/phrases for soft 404
const SOFT_404_PHRASES = [
  "404",
  "not found",
  "page not found",
  "page you are looking for"
];

// Keywords/phrases for soft 500
const SOFT_500_PHRASES = [
  "500",
  "internal server error",
  "server error"
];

/**
 * Read array of URL paths from JSON file.
 * Expected format: ["/product/foo", "/product/bar", ...] or absolute URLs.
 */
async function readPathsFromFile(filePath) {
  const fileContent = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(fileContent);

  if (!Array.isArray(data)) {
    throw new Error("Sitemap file must contain a JSON array of URL values.");
  }

  return data;
}

// Helper to extract only visible, human-readable text from HTML
function extractVisibleText(html) {
  const $ = cheerio.load(html);

  // Remove elements that never represent visible page text
  $("script, style, noscript, template, iframe, svg, canvas").remove();

  // Remove elements that are explicitly marked as hidden
  $(
    "[aria-hidden='true'], " +
      "[hidden], " +
      "[type='hidden'], " +
      "[style*='display:none'], " +
      "[style*='display: none'], " +
      "[style*='visibility:hidden'], " +
      "[style*='visibility: hidden']"
  ).remove();

  // Extract text from body only
  const text = $("body").text() || "";

  // Normalize whitespace
  return text.replace(/\s+/g, " ").trim();
}

// Helper: wait for N milliseconds
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry configuration (universal)
const RETRY_COUNT = Number(process.env.URL_CHECK_RETRY) || 3;
const RETRY_DELAY = Number(process.env.URL_CHECK_RETRY_DELAY) || 500;

/**
 * Check a single URL with retry on HTTP 502:
 * - HTTP status
 * - soft 404 (visible text only)
 * - soft 500 (visible text only)
 * - retry logic for 502 using URL_CHECK_RETRY and URL_CHECK_RETRY_DELAY
 */
async function checkUrl(url) {
  let attempt = 0;

  while (true) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      const status = res.status;
      const html = await res.text();

      // Retry logic only for HTTP 502
      if (status === 502 && attempt < RETRY_COUNT) {
        attempt++;
        console.log(
          `⚠️  502 received for ${url}, retry ${attempt}/${RETRY_COUNT}...`
        );
        await sleep(RETRY_DELAY);
        continue;
      }

      let ok = status < 400;
      let reason = "";

      if (!ok) {
        reason = `HTTP status ${status}`;
      } else if (status === 200) {
        const visibleText = extractVisibleText(html).toLowerCase();

        const soft404 = SOFT_404_PHRASES.some((p) =>
          visibleText.includes(p.toLowerCase())
        );
        const soft500 = SOFT_500_PHRASES.some((p) =>
          visibleText.includes(p.toLowerCase())
        );

        if (soft404) {
          ok = false;
          reason = "soft 404: visible page text contains 404-like content";
        } else if (soft500) {
          ok = false;
          reason = "soft 500: visible page text contains 500-like error content";
        }
      }

      return { url, ok, status, reason };

    } catch (err) {
      return { url, ok: false, status: 0, reason: err.message };
    }
  }
}

/**
 * Extract all internal links using cheerio.
 */
function extractLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();
  const pageOrigin = new URL(pageUrl).origin;

  $("a[href]").each((_, el) => {
    let href = $(el).attr("href");
    if (!href) return;
    href = href.trim();

    // Skip anchors and non-http links
    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    ) {
      return;
    }

    try {
      const absolute = new URL(href, pageUrl);

      if (!["http:", "https:"].includes(absolute.protocol)) return;
      if (absolute.origin !== pageOrigin) return;

      urls.add(absolute.toString());
    } catch {
      // Invalid href ignored
    }
  });

  return [...urls];
}

/**
 * Process page:
 * - validate and build base URL from raw sitemap value
 * - check the page itself
 * - fetch and extract internal links
 */
async function processPage(rawValue, seenUrls) {
  if (!BASE_URL) {
    throw new Error("STAGE_WEBSITE_URL is not defined.");
  }

  let pageUrl;
  try {
    // rawValue can be relative path or absolute URL
    pageUrl = new URL(rawValue, BASE_URL).toString();
  } catch {
    // Invalid URL in sitemap file
    logResult({
      url: String(rawValue),
      ok: false,
      status: 0,
      reason: "invalid URL value in sitemap file"
    });
    return;
  }

  // If this page URL was already processed, skip everything
  if (seenUrls.has(pageUrl)) {
    console.log(`\n=== Sitemap page already processed, skipping: ${pageUrl}`);
    return;
  }

  console.log(`\n=== Sitemap page: ${pageUrl}`);

  // Mark page as seen before any network requests to avoid reprocessing
  seenUrls.add(pageUrl);

  const pageCheckResult = await checkUrl(pageUrl);
  logResult(pageCheckResult);

  let html;
  try {
    const res = await fetch(pageUrl, { redirect: "follow" });
    html = await res.text();
  } catch (err) {
    console.error(`Failed to load page ${pageUrl}: ${err.message}`);
    logResult({
      url: pageUrl,
      ok: false,
      status: 0,
      reason: `failed to fetch page: ${err.message}`
    });
    return;
  }

  const links = extractLinks(html, pageUrl);
  console.log(`Found links on page: ${links.length}`);

  for (const link of links) {
    if (seenUrls.has(link)) continue;
    seenUrls.add(link);

    const result = await checkUrl(link);
    logResult(result);
  }
}

/**
 * Logging + collecting invalid URLs
 */
function logResult({ url, ok, status, reason }) {
  if (ok) {
    console.log(`✅ OK  (${status}) ${url}`);
  } else {
    console.log(`❌ BAD (${status}) ${url} — ${reason}`);
    invalidUrls.push({ url, status, reason });
  }
}

/**
 * Main
 * - reads sitemap
 * - runs processPage in parallel with a bounded concurrency
 */
async function main() {
  try {
    const rawPaths = await readPathsFromFile(SITEMAP_FILE);
    const seenUrls = new Set();

    console.log(
      `Using concurrency: ${CONCURRENCY} (set via URL_CHECK_CONCURRENCY or default=${DEFAULT_CONCURRENCY})`
    );

    // Shared index for concurrent workers
    let currentIndex = 0;

    // Worker that processes sitemap entries one by one
    async function worker(workerId) {
      while (true) {
        const index = currentIndex++;
        if (index >= rawPaths.length) {
          break;
        }

        const entry = rawPaths[index];

        // Non-string or empty values are considered invalid
        if (typeof entry !== "string" || !entry.trim()) {
          logResult({
            url: String(entry),
            ok: false,
            status: 0,
            reason: "non-string or empty value in sitemap file"
          });
          continue;
        }

        await processPage(entry.trim(), seenUrls);
      }
    }

    // Start N workers in parallel
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push(worker(i));
    }

    await Promise.all(workers);

    console.log("\nDone. Total unique URLs seen:", seenUrls.size);

    console.log("\n==============================");
    console.log("INVALID URLS (final report):");
    console.log("==============================\n");

    if (invalidUrls.length === 0) {
      console.log("🎉 No invalid URLs found!");
    } else {
      invalidUrls.forEach((u) => {
        console.log(`❌ ${u.url} (${u.status}) — ${u.reason}`);
      });
    }
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

main();
