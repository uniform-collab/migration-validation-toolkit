import fs from "fs";
import dotenv from "dotenv";
import {
  parseDynamicSamplePatterns,
  pathMatchesAnyDynamicPattern,
} from "./sitemap-dynamic-samples.js";

dotenv.config();

const urls = JSON.parse(fs.readFileSync("./.temp/urls.json", "utf8"));
const urlsSitemap = JSON.parse(fs.readFileSync("./.temp/urls-sitemap.json", "utf8"));

const dynamicPatterns = parseDynamicSamplePatterns(
  process.env.SITEMAP_DYNAMIC_SAMPLE_PATTERNS?.trim(),
);

const setUrls = new Set(urls);
const setSitemap = new Set(urlsSitemap);

const diff = [];
/** Would-have-been diff rows suppressed because URL matches SITEMAP_DYNAMIC_SAMPLE_PATTERNS */
let suppressed = { fromUrlsJson: 0, fromSitemap: 0 };

urls.forEach((u) => {
  if (
    dynamicPatterns.length > 0 &&
    pathMatchesAnyDynamicPattern(u, dynamicPatterns)
  ) {
    if (!setSitemap.has(u)) suppressed.fromUrlsJson++;
    return;
  }
  if (!setSitemap.has(u)) {
    diff.push({
      url: u,
      source: "urls.json",
    });
  }
});

urlsSitemap.forEach((u) => {
  if (
    dynamicPatterns.length > 0 &&
    pathMatchesAnyDynamicPattern(u, dynamicPatterns)
  ) {
    if (!setUrls.has(u)) suppressed.fromSitemap++;
    return;
  }
  if (!setUrls.has(u)) {
    diff.push({
      url: u,
      source: "urls-sitemap.json",
    });
  }
});

diff.sort((a, b) => {
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  if (a.url.length !== b.url.length) return a.url.length - b.url.length;
  return a.url.localeCompare(b.url);
});

try {
  fs.mkdirSync(".temp", { recursive: true });
} catch {}

if (dynamicPatterns.length > 0) {
  console.log(
    `ℹ️ Dynamic patterns active (${dynamicPatterns.length}): suppressed ${suppressed.fromUrlsJson} + ${suppressed.fromSitemap} would-be diff row(s) (urls.json-only / sitemap-only dynamic URLs)`,
  );
}

if (diff.length > 0) {
  fs.writeFileSync("./.temp/urls-diff.json", JSON.stringify(diff, null, 2), "utf8");
  console.error(`❌ diff.json updated. Found ${diff.length} differences.`);
  console.error(JSON.stringify(diff, null, 2));

  process.exit(1);
} else {
  console.log("✅ No differences found.");
}
