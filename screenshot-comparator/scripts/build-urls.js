import fs from "fs";
import { ProjectMapClient } from "@uniformdev/project-map";
import { RedirectClient } from "@uniformdev/redirect";
import { env } from "./utils.js";
import dotenv from "dotenv";
dotenv.config();

try {
  console.log("Reading entries from entries.json");
  const entries = JSON.parse(fs.readFileSync("data/entries.json", "utf-8"));
  console.log(`Found ${entries.length} entries.`);

  const urls = new Set();

  const projectMapClient = new ProjectMapClient({
    apiKey: env("UNIFORM_API_KEY"),
    projectId: env("UNIFORM_PROJECT_ID"),
  });

  const getStaticPaths = async () => {
    const { nodes } = await projectMapClient.getNodes({});
    return {
      paths:
        nodes?.filter((node) => node.compositionId).map((node) => node.path) ??
        [],
      fallback: false,
    };
  };

  const nodePaths = await getStaticPaths();
  const { paths } = nodePaths;
  console.log(`Found ${paths.length} paths in project map.`);

  const client = new RedirectClient({
    apiKey: process.env.UNIFORM_API_KEY,
    projectId: process.env.UNIFORM_PROJECT_ID,
  });
  const { redirects } = await client.getRedirects({ limit: 500 });

  const updatedPaths = paths?.filter(
    (path) =>
      !redirects.some((redirect) => redirect.redirect.sourceUrl === path)
  );
  console.log(`Filtered paths: ${updatedPaths.length} valid paths.`);

  const typeMapping = {
    career: "Career",
    event: "Event",    
    insight: "Insight",
    news: "News",
    product: "Product",
  };

  updatedPaths.forEach((slug) => {
    ///articles/:articles
    if (slug.includes(":")) {
      const spl = slug.split(":");
      const entryType = spl[spl.length - 1].replace(/\/$/, "");
      const typeFromMapping = typeMapping[entryType];
      const entriesByType = entries.filter((e) => e.type === typeFromMapping);
      console.log(
        `Found entries ${entriesByType.length} for type: ${entryType}`
      );
      entriesByType.forEach((entry) => {
        const url = new URL(
          slug.replace(":" + entryType, entry.slug),
          process.env.PROD_WEBSITE_URL
        ).href;
        urls.add(url);
      });
    } else {
      const url = new URL(slug, process.env.PROD_WEBSITE_URL).href;
      urls.add(url);
    }
  });

  var products = entries.filter((e) => e.type === "HardGoodDetail");
  console.log(`Found ${products.length} products.`);
  products.forEach((product) => {
    const url = `${process.env.PROD_WEBSITE_URL}search?searchTerm=${product.slug}`;
    urls.add(url);
  });

  const result = Array.from(urls);

  const relativeUrls = result.map((u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  });

  console.log(`Urls count: ${relativeUrls.length}`);
  relativeUrls.sort();
  try {
    fs.mkdirSync(".temp", { recursive: true });
  } catch {}
  fs.writeFileSync("./.temp/urls.json", JSON.stringify(relativeUrls, null, 2), {
    encoding: "utf8",
  });

  console.log("✅ build-urls complete! Check urls.json");
} catch (error) {
  console.error(`🆘 Error build-urls:`, error.message);
  throw error;
}
