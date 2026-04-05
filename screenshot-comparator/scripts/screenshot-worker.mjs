import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  retryWithBackoff,
  isGif,
  isVideo,
  extractCandidateUrl,
  isAllowedMediaUrl,
} from "./utils.js";
import dotenv from "dotenv";
import sharp from "sharp";
dotenv.config();

const browser = await chromium.launch({
  //headless: false,
});

const PLAYWRIGHT_TIMEOUT = process.env.PLAYWRIGHT_TIMEOUT
  ? parseInt(process.env.PLAYWRIGHT_TIMEOUT)
  : 90000;

process.on("SIGTERM", async () => {
  await browser.close();
  process.exit(0);
});

process.on("message", async (obj) => {
  const start = Date.now();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    serviceWorkers: "block",
  });

  let result = false;
  try {
    result = await Promise.race([
      doWork(obj, context),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 150000)
      ),
    ]);
  } catch (err) {
    console.error("🆘 Worker error:", err);
  } finally {
    console.log(
      result
        ? `✅ Done (${((Date.now() - start) / 1000).toFixed(1)}s)`
        : "❌ Failed"
    );
    await context.close();
    process.send(result);
  }
});

async function doWork(obj, context) {
  const { prodUrl, migratedUrl, prodOnly, migratedOnly } = obj;

  try {
    if (!migratedOnly) {
      await screenshotPageComponents(
        context,
        prodUrl,
        ".comparison_results/prod",
        false
      );
    }
    if (!prodOnly) {
      await screenshotPageComponents(
        context,
        migratedUrl,
        ".comparison_results/migrated",
        true
      );
    }
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

async function screenshotPageComponents(
  context,
  url,
  baseDir,
  isStage = false
) {
  const componentDir = path.join(baseDir, encodeURLToFolder(url));
  fs.mkdirSync(componentDir, { recursive: true });

  const page = await context.newPage();

  await page.route("**/*", (route) => {
    const req = route.request();
    const url = extractCandidateUrl(req.url()).toLowerCase();

    if (isAllowedMediaUrl(url)) return route.continue();
    if (isGif(url) || isVideo(url)) return route.abort();

    return route.continue();
  });

  console.log(`🌐 ${url}`);

  await retryWithBackoff(
    () =>
      page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PLAYWRIGHT_TIMEOUT,
      }),
    1,
    2000,
    PLAYWRIGHT_TIMEOUT
  );

  await page.waitForTimeout(5000);

  await page.evaluate(() => {
    const el = document.querySelector("#full-width-shoehorn");
    if (el) {
      console.log("🗑️ Removing #full-width-shoehorn");
      el.remove();
    }
  });

  await waitForComponents(page, url, isStage);

  const { selectors: components, stats } = await getComponentSelectors(
    page,
    isStage
  );

  console.log("COMPONENT FILTER STATS:", stats);
  console.log(`🧩 Components collected: ${components.length}`);

  await screenshotComponents(page, components, componentDir, isStage);

  await page.close();
}

async function waitForComponents(page, url, isStage) {
  console.log("⏳ Waiting for components...");

  await page.waitForFunction(
    (isStage) => {
      const main = document.querySelector("main");
      if (!main) return false;

      const scope = isStage
        ? main.querySelector("#content .row") ||
          main.querySelector("#content") ||
          main.querySelector("#content-shoehorned") ||
          main
        : main.querySelector("#content-shoehorned") ||
          main.querySelector("#content .row") ||
          main.querySelector("#content") ||
          main;

      const components = isStage
        ? Array.from(scope.children).filter((el) =>
            el.matches("div.component")
          )
        : scope.querySelectorAll("div.component");

      return components.length > 0;
    },
    isStage,
    { timeout: 15000 }
  );
}

async function getComponentSelectors(page, isStage) {
  return await page.evaluate((isStage) => {
    const stats = {
      total: 0,
      hidden: 0,
      fixed: 0,
      invisible: 0,
      nested: 0,
      empty: 0,
      kept: 0,
    };

    function cleanText(text) {
      return (text || "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "") // remove zero-width chars
        .replace(/\u00A0/g, " ") // replace nbsp
        .trim();
    }

    function isHidden(el) {
      if (!(el instanceof Element)) return false;
      const style = getComputedStyle(el);
      return (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      );
    }

    function hasMeaningfulNode(root) {
      if (!root) return false;

      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
      );

      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = cleanText(node.nodeValue);
          if (text) {
            const parent = node.parentElement;
            if (parent && !isHidden(parent)) return true;
          }
          continue;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node;
          const tag = el.tagName.toLowerCase();

          if (isHidden(el)) continue;

          // Real media/content
          if (
            tag === "img" ||
            tag === "video" ||
            tag === "iframe" ||
            tag === "canvas" ||
            tag === "picture" ||
            tag === "object" ||
            tag === "embed"
          ) {
            return true;
          }

          // Form controls count as meaningful
          if (tag === "input" || tag === "textarea" || tag === "select") {
            return true;
          }
        }
      }

      return false;
    }

    const main = document.querySelector("main") || document.body;

    const scope = isStage
      ? main.querySelector("#content .row") ||
        main.querySelector("#content") ||
        main.querySelector("#content-shoehorned") ||
        main
      : main.querySelector("#content-shoehorned") ||
        main.querySelector("#content .row") ||
        main.querySelector("#content") ||
        main;

    // Collect all candidate components first
    const rawComponents = isStage
      ? Array.from(scope.children).filter((el) => el.matches("div.component"))
      : Array.from(scope.querySelectorAll("div.component"));

    // Keep only top-level components inside the current scope
    const components = rawComponents.filter((el) => {
      const parentComponent = el.parentElement?.closest?.("div.component");
      if (parentComponent) {
        stats.nested++;
        return false;
      }
      return true;
    });

    stats.total = components.length;

    const selectors = [];
    let index = 0;

    for (const el of components) {
      const style = getComputedStyle(el);

      // Skip hidden components
      if (style.display === "none" || style.visibility === "hidden") {
        stats.hidden++;
        continue;
      }

      // Skip fixed components
      if (style.position === "fixed") {
        stats.fixed++;
        continue;
      }

      // Skip zero-sized components
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        stats.invisible++;
        continue;
      }

      // If there is a direct .component-content child, validate only it.
      // Otherwise validate the whole component.
      const directContent = Array.from(el.children).find(
        (child) => child.classList?.contains("component-content")
      );

      const rootToCheck = directContent || el;

      if (!hasMeaningfulNode(rootToCheck)) {
        stats.empty++;
        continue;
      }

      const id = `component-${String(index).padStart(2, "0")}`;
      el.setAttribute("data-component-id", id);

      selectors.push({
        name: id,
        selector: `[data-component-id="${id}"]`,
      });

      stats.kept++;
      index++;
    }

    return { selectors, stats };
  }, isStage);
}

async function screenshotComponents(page, components, outputDir, isStage) {
  for (const comp of components) {
    try {
      const el = await page.$(comp.selector);
      if (!el) continue;

      await el.evaluate((e) =>
        e.scrollIntoView({ behavior: "auto", block: "center" })
      );

      await page.waitForTimeout(500);

      const filePath = path.join(
        outputDir,
        `${comp.name}${isStage ? "_migrated" : "_prod"}.png`
      );

      await el.screenshot({ path: filePath });

      await cropImageHeightIfNeeded(filePath);

      console.log("📸", filePath);
    } catch (e) {
      console.warn("⚠️ screenshot failed:", comp.name);
    }
  }
}

function encodeURLToFolder(url) {
  const illegalCharsRegex = /[<>:"/\\|?*\0]/g;

  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }

  if (!pathname || pathname === "/") {
    return "index";
  }

  return pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\//g, "_")
    .replace(illegalCharsRegex, (char) =>
      `%${char.charCodeAt(0).toString(16)}`
    );
}

async function cropImageHeightIfNeeded(imgPath, maxHeight = 9000) {
  try {
    const img = sharp(imgPath);
    const meta = await img.metadata();
    if (meta.height > maxHeight) {
      await img
        .extract({ top: 0, left: 0, width: meta.width, height: maxHeight })
        .toFile(imgPath);
    }
  } catch {}
}