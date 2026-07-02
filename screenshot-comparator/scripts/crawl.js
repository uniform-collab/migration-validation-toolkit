import axios from "axios";
import { load } from "cheerio";
import fs from "fs";
import { env, prodVercelBypassHeaders } from "./utils.js";
import dotenv from 'dotenv';
dotenv.config();

// When PROD_WEBSITE_URL points at a Vercel deployment (prod-mirror), all
// crawled URLs live on that Vercel deployment and need the automation bypass
// secret to get past deployment protection.
const prodRequestHeaders = prodVercelBypassHeaders();
const axiosRequestConfig = prodRequestHeaders
  ? { headers: prodRequestHeaders }
  : undefined;
if (prodRequestHeaders) {
  console.log(
    "🔓 Using Vercel automation bypass header for prod requests (PROD_WEBSITE_VERCEL_MIRROR=true)."
  );
}

const visitedPages = new Set();
let pagesToVisit = [];
const urls = new Set();

if(!fs.existsSync("./.temp")) {
  fs.mkdirSync("./.temp", { recursive: true });
}

if (fs.existsSync("./.temp/urls.json")) {
  console.log("./.temp/urls.json already exists; loading it to resume crawling");
  JSON.parse(fs.readFileSync("./.temp/urls.json", { encoding: "utf8" })).map((x) =>
    urls.add(x)
  );
}

if (fs.existsSync("./.temp/_crawl_visitedPages.json")) {
  console.log(
    "./.temp/_crawl_visitedPages.json already exists; loading it to resume crawling"
  );
  JSON.parse(
    fs.readFileSync("./.temp/_crawl_visitedPages.json", { encoding: "utf8" })
  ).map((x) => visitedPages.add(x));
}

async function crawl(baseUrl) {
  while (pagesToVisit.length > 0) {
    fs.writeFileSync(
      "./.temp/_crawl_pagesToVisit.json",
      JSON.stringify(Array.from(pagesToVisit), null, 2),
      { encoding: "utf8" }
    );
    const currentPage = pagesToVisit.pop();

    if (!visitedPages.has(currentPage)) {
      fs.writeFileSync(
        "./.temp/_crawl_visitedPages.json",
        JSON.stringify(Array.from(visitedPages), null, 2),
        { encoding: "utf8" }
      );
      try {
        fs.writeFileSync("./.temp/_crawl_resume.json", JSON.stringify(currentPage), {
          encoding: "utf8",
        });
        console.log(`Crawling: ${currentPage}`);
        visitedPages.add(currentPage);

        const response = await axios.get(currentPage, axiosRequestConfig);
        const $ = load(response.data);

        // Collect all links on the page
        $("a[href]").each((_, element) => {
          const href = $(element).attr("href");
          let absoluteUrl = new URL(href, baseUrl).href;
          absoluteUrl =
            absoluteUrl.indexOf("?") >= 0
              ? absoluteUrl.substring(0, absoluteUrl.indexOf("?"))
              : absoluteUrl;
          absoluteUrl =
            absoluteUrl.indexOf("#") >= 0
              ? absoluteUrl.substring(0, absoluteUrl.indexOf("#"))
              : absoluteUrl;
          if (
            absoluteUrl.startsWith(baseUrl) ||
            absoluteUrl.startsWith(baseUrl.replace("://", "://www."))
          ) {
            urls.add(absoluteUrl);

            if (!urls.has(absoluteUrl))
              console.log(`  new URL detected: ${absoluteUrl}`);
            fs.writeFileSync(
              "./.temp/urls.json",
              JSON.stringify(Array.from(urls), null, 2),
              { encoding: "utf8" }
            );
            if (!visitedPages.has(absoluteUrl)) {
              pagesToVisit.push(absoluteUrl);
            } else {
              //console.log(`  Skip: ${absoluteUrl} because it was visited before`)
            }
          } else {
            //console.log(`  Skip: ${absoluteUrl} because it does not start with ${baseUrl}`)
          }
        });
      } catch (error) {
        console.error(`🆘 Error crawling ${currentPage}:`, error.message);
      }
    } else {
      //console.log(`  Skip: ${currentPage} because it was visited before`)
    }
  }

  const a = Array.from(urls);
  a.sort();
  fs.writeFileSync("./.temp/urls.json", JSON.stringify(a, null, 2), {
    encoding: "utf8",
  });

  console.log("✅ Crawling complete! Check urls.json");
}

function throwError(msg) {
  throw new Error(msg);
}

const baseUrl = new URL(env("PROD_WEBSITE_URL") ?? throwError("pass website URL"))
  .origin;

if (fs.existsSync("./.temp/_crawl_pagesToVisit.json")) {
  pagesToVisit = JSON.parse(
    fs.readFileSync("./.temp/_crawl_pagesToVisit.json", { encoding: "utf8" })
  );
}

if (pagesToVisit.length === 0) {
  pagesToVisit.push(baseUrl);
}

crawl(baseUrl);
