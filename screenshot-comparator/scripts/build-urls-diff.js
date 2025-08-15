import fs from "fs";

const urls = JSON.parse(fs.readFileSync("./.temp/urls.json", "utf8"));
const urlsSitemap = JSON.parse(fs.readFileSync("./.temp/urls-sitemap.json", "utf8"));

const setUrls = new Set(urls);
const setSitemap = new Set(urlsSitemap);

const diff = [];

urls.forEach(u => {
  if (!setSitemap.has(u)) {
    diff.push({
      url: u,
      source: "urls.json"
    });
  }
});

urlsSitemap.forEach(u => {
  if (!setUrls.has(u)) {
    diff.push({
      url: u,
      source: "urls-sitemap.json"
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


if (diff.length > 0) {
  
  fs.writeFileSync("./.temp/urls-diff.json", JSON.stringify(diff, null, 2), "utf8");
  console.error(`❌ diff.json updated. Found ${diff.length} differences.`);
  console.error(JSON.stringify(diff, null, 2));

  process.exit(1);
} else {
  console.log("✅ No differences found.");
}