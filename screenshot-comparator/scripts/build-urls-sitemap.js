import fs from "fs";
import { env } from "./utils.js";
import dotenv from "dotenv";
import {
  parseDynamicSamplePatterns,
  applyDynamicUrlSampling,
} from "./sitemap-dynamic-samples.js";
dotenv.config();

async function getSitemapUrls(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error: ${res.statusText}`);

  const xml = await res.text();

  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) =>
    match[1].replace(/\/$/, "").replace(/\/home(?=\/|$)/, "/")
  );

  return urls;
}

(async () => {
  const urls = await getSitemapUrls(env("SITEMAP_URL"));

  const paths = urls.map((u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  });

  if (!paths.includes("/")) {
    paths.unshift("/");
  }

  let result = [...new Set(paths.map((p) => (p.startsWith("/") ? p : `/${p}`)))];
  result.sort();

  const patternRaw = process.env.SITEMAP_DYNAMIC_SAMPLE_PATTERNS?.trim();
  const patterns = parseDynamicSamplePatterns(patternRaw);
  const sampleCount = process.env.SITEMAP_DYNAMIC_SAMPLE_COUNT
    ? parseInt(process.env.SITEMAP_DYNAMIC_SAMPLE_COUNT, 10)
    : 2;

  if (patterns.length > 0) {
    const before = result.length;
    const { paths: sampled, stats } = applyDynamicUrlSampling(
      result,
      patterns,
      Number.isFinite(sampleCount) ? sampleCount : 2,
    );
    result = sampled;
    console.log(
      `Dynamic sampling (${patterns.length} pattern(s), up to ${Number.isFinite(sampleCount) ? sampleCount : 2} URL(s) each): ${before} → ${result.length} paths`,
    );
    for (const s of stats) {
      if (s.kept > 0 || s.skipped > 0) {
        console.log(
          `  • ${s.pattern}: kept ${s.kept}, skipped ${s.skipped} (same composition)`,
        );
      }
    }
  }

  console.log(`Urls count: ${result.length}`);
  try {
    fs.mkdirSync(".temp", { recursive: true });
  } catch {}
  fs.writeFileSync(
    "./.temp/urls-sitemap.json",
    JSON.stringify(result, null, 2),
    {
      encoding: "utf8",
    }
  );

  console.log("✅ build-urls-sitemap complete! Output: .temp/urls-sitemap.json");
})();
