import fs from "fs";
import { env } from "./utils.js";
import dotenv from "dotenv";
dotenv.config();

async function getSitemapUrls(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error: ${res.statusText}`);

  const xml = await res.text();

  const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) =>
    match[1].replace(/\/$/, "")
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

  const result = Array.from(paths);
  console.log(`Urls count: ${result.length}`);
  result.sort();
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

  console.log("✅ build-urls complete! Check urls.json");
})();
