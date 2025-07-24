import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { env, retryWithBackoff, gotoWithHardTimeout } from "./utils.js";
import dotenv from "dotenv";
import sharp from "sharp";
dotenv.config();

// Shared browser and context reused across tasks
const browser = await chromium.launch();

const PLAYWRIGHT_TIMEOUT = process.env.PLAYWRIGHT_TIMEOUT
  ? parseInt(process.env.PLAYWRIGHT_TIMEOUT)
  : 90000;

process.on("SIGTERM", async () => {
  console.log("Worker received termination signal. Cleaning up...");
  await browser.close();
  process.exit(0);
});

process.on("message", async (obj) => {
  const start = Date.now();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  let result = false;
  try {
    result = await Promise.race([
      doWork(obj, context),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("💣 Global task timeout (e.g. 2.5 min)")),
          150_000
        )
      ),
    ]);
  } catch (err) {
    console.error(`🆘 Worker error:`, err);
  } finally {
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      result ? `✅ Task done (${duration}s)` : `🆘 Task failed (${duration}s)`
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
        ".comparison_results/prod"
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
  } catch (error) {
    console.error(`🆘 Error processing ${prodUrl}:`, error);
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
  if (fs.existsSync(componentDir)) {
    console.log(`📂 Skipping existing directory: ${componentDir}`);
    return;
  }

  const page = await context.newPage();

  try {
    if (isStage && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      await page.setExtraHTTPHeaders({
        "x-vercel-protection-bypass":
          process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        "x-vercel-set-bypass-cookie": "true",
      });
    }

    const parsedUrl = new URL(url);
    const searchTerm = parsedUrl.searchParams.get("searchTerm");

    if (searchTerm) {
      parsedUrl.searchParams.delete("searchTerm");
      const cleanUrl = parsedUrl.toString();
      await retryWithBackoff(
        () =>
          page.goto(cleanUrl, {
            waitUntil: "load",
            timeout: PLAYWRIGHT_TIMEOUT,
          }),
        1,
        5000,
        PLAYWRIGHT_TIMEOUT
      );

      console.log(`🔎 Performing search for "${searchTerm}" on URL: ${url}`);
      await page.waitForSelector(
        'input[placeholder="What can we help you find?"]',
        { timeout: 10000 }
      );
      await page.fill(
        'input[placeholder="What can we help you find?"]',
        searchTerm
      );
      await page.click('button[aria-label="search-button"]');
      await page.waitForTimeout(10000);
    } else {
      await retryWithBackoff(
        () =>
          page.goto(url, {
            waitUntil: "networkidle",
            timeout: PLAYWRIGHT_TIMEOUT,
          }),
        1,
        5000,
        PLAYWRIGHT_TIMEOUT
      );

      await page.waitForTimeout(5000); // ⏳ wait 5 seconds before screenshot
    }

    const finalUrl = page.url();
    const redirected = finalUrl !== url;

    const componentDir = path.join(baseDir, encodeURLToFolder(url));
    fs.mkdirSync(componentDir, { recursive: true });

    if (redirected) {
      console.warn(`⛔ Redirect detected: ${url} → ${finalUrl}`);
      const redirectFile = path.join(componentDir, "redirect.txt");
      fs.writeFileSync(redirectFile, finalUrl, { encoding: "utf8" });
    }

    await freezeAnimations(page);

    const components = await getComponentSelectors(page);
    await screenshotComponents(url, page, components, componentDir, isStage);
  } finally {
    await page.close(); // always close the page
  }
}

async function getComponentSelectors(page) {
  return await page.evaluate(() => {
    const selectors = [];
    const header = document.querySelector("header");
    const footer = document.querySelector("footer");

    if (header) selectors.push({ name: "header", selector: "header" });

    const isFixed = (el) => {
      const style = window.getComputedStyle(el);
      return style.position === "fixed";
    };

    if (header && footer) {
      let current = header.nextElementSibling;
      let index = 0;
      while (current && current !== footer) {
        if (
          current.tagName.toLowerCase() !== "script" &&
          current.nodeType === 1 &&
          !isFixed(current)
        ) {
          const uniqueSelector = `div-${String(index).padStart(2, "0")}`;
          current.setAttribute("data-component-id", uniqueSelector);
          selectors.push({
            name: uniqueSelector,
            selector: `[data-component-id="${uniqueSelector}"]`,
          });
          index++;
        }
        current = current.nextElementSibling;
      }
    }

    if (footer) selectors.push({ name: "footer", selector: "footer" });

    return selectors;
  });
}

async function screenshotComponents(url, page, components, outputDir, isStage) {
  for (const comp of components) {
    try {
      const element = await page.$(comp.selector);
      if (!element) {
        console.warn(`⚠️ Selector not found: ${comp.selector}`);
        continue;
      }

      const box = await element.boundingBox();
      if (!box || box.width === 0 || box.height === 0) {
        console.warn(
          `⚠️ Skipping invisible component: ${comp.name}, width: ${
            box ? box.width : "N/A"
          }, height: ${box ? box.height : "N/A"}`
        );
        continue;
      }

      // ⛔ Hide all position: fixed elements (except the one we're capturing)
      // ⛔ Also hide the header if current component is not header
      await page.evaluate(
        ({ selector, compName }) => {
          const all = Array.from(document.body.querySelectorAll("*"));

          const isHeaderComponent = compName === "header";
          const header = document.querySelector("header");

          all.forEach((el) => {
            const style = window.getComputedStyle(el);
            const isFixed = style.position === "fixed";
            const isHeader = el === header;

            if (
              (isFixed || (!isHeaderComponent && isHeader)) &&
              !el.matches(selector)
            ) {
              el.setAttribute(
                "data-original-visibility",
                el.style.visibility || ""
              );
              el.style.visibility = "hidden";
            }
          });
        },
        { selector: comp.selector, compName: comp.name }
      );

      const roundedBox = {
        x: Math.floor(box.x),
        y: Math.floor(box.y),
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      };

      const filePath = path.join(
        outputDir,
        `${comp.name}${isStage ? "_migrated" : "_prod"}.png`
      );

      // Scroll component into view to trigger lazy loading
      await element.evaluate((el) =>
        el.scrollIntoView({ behavior: "auto", block: "center" })
      );

      // Give the browser some time to render any lazy-loaded content
      await page.waitForTimeout(500);

      // Wait until all images within the component are fully loaded
      await element.evaluate(async (el) => {
        const images = el.querySelectorAll("img");
        await Promise.all(
          Array.from(images).map((img) => {
            if (img.complete) return Promise.resolve();
            return new Promise((resolve) => {
              img.onload = () => resolve();
              img.onerror = () => resolve();
            });
          })
        );
      });

      // Final buffer before capture for extra stability
      await page.waitForTimeout(300);

      // Capture the screenshot
      await element.screenshot({ path: filePath, clip: roundedBox });

      // Crop height if necessary
      await cropImageHeightIfNeeded(filePath, 9000);

      // ✅ Restore fixed elements
      await page.evaluate(() => {
        const allHidden = document.querySelectorAll(
          "[data-original-visibility]"
        );
        allHidden.forEach((el) => {
          const original = el.getAttribute("data-original-visibility");
          el.style.visibility = original || "";
          el.removeAttribute("data-original-visibility");
        });
      });

      console.log(`📸 Component screenshot saved: ${filePath}`);
    } catch (err) {
      console.error(
        `🆘 Failed to screenshot ${comp.name} - ${url}:`,
        err.message
      );
    }
  }
}

async function freezeAnimations(page) {
  await page.addStyleTag({
    content: `
      * {
        animation: none !important;
        transition: none !important;
        transform: none !important;
      }
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
      }
      [class*="carousel"],
      [class*="slider"],
      [class*="marquee"],
      [class*="animated"] {
        animation: none !important;
        transition: none !important;
        transform: none !important;
      }
      video {
        object-position: 0% 0% !important;
      }
    `,
  });

  await page.waitForTimeout(1000);

  await page.evaluate(async () => {
    window.requestAnimationFrame = () => {};
    window.setInterval = () => 0;
    window.setTimeout = () => 0;

    document.querySelectorAll("video").forEach((video) => {
      try {
        video.pause();
      } catch (e) {}
    });

    const freezeSingleGif = async (imgElement) => {
      return new Promise((resolve) => {
        try {
          const src = imgElement.src;
          const tempImg = new Image();
          tempImg.crossOrigin = "anonymous";
          tempImg.src =
            src +
            (src.includes("?")
              ? "&freezeCacheBust=" + Date.now()
              : "?freezeCacheBust=" + Date.now());

          tempImg.onload = () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = tempImg.naturalWidth;
              canvas.height = tempImg.naturalHeight;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(tempImg, 0, 0);
              const still = canvas.toDataURL("image/png");
              imgElement.src = still;
              resolve();
            } catch (e) {
              console.warn("❄️ Failed to draw GIF:", src, e);
              resolve();
            }
          };

          tempImg.onerror = () => {
            console.warn("❄️ Failed to load GIF:", src);
            resolve();
          };
        } catch (err) {
          console.warn("❄️ Unexpected error freezing GIF:", err);
          resolve();
        }
      });
    };

    const gifImgs = [...document.querySelectorAll('img[src$=".gif"]')];
    await Promise.all(gifImgs.map(freezeSingleGif));

    try {
      const rmcTrack = document.querySelector(".react-multi-carousel-track");
      if (rmcTrack) {
        rmcTrack.style.transition = "none";
        rmcTrack.style.transform = getComputedStyle(rmcTrack).transform;

        const originalSetInterval = window.setInterval;
        const originalClearInterval = window.clearInterval;
        const activeIntervals = [];

        window.setInterval = function (...args) {
          const id = originalSetInterval(...args);
          activeIntervals.push(id);
          return id;
        };

        setTimeout(() => {
          activeIntervals.forEach((id) => originalClearInterval(id));
        }, 50);
      }
    } catch (e) {
      console.warn("❄️ Failed to freeze react-multi-carousel:", e);
    }

    const toastEl = document.querySelector(
      '[id^="nextjs-toast"], .nextjs-toast-container, .nextjs-toast'
    );
    if (toastEl) {
      toastEl.remove();
      console.log("🔥 Removed nextjs-toast element from DOM");
    }
  });
}

function encodeURLToFolder(url) {
  const illegalCharsRegex = /[<>:"/\\|?*\0]/g;
  return (
    url
      .replace(env("STAGE_WEBSITE_URL"), "")
      .replace(env("PROD_WEBSITE_URL"), "")
      .replace(
        illegalCharsRegex,
        (char) => `%${char.charCodeAt(0).toString(16)}`
      )
      .replace(/^\/+/g, "")
      .replace(/\/+$/g, "")
      .replace(/\//g, "_") || "index"
  );
}

async function cropImageHeightIfNeeded(imgPath, maxHeight = 9000) {
  try {
    const image = sharp(imgPath);
    const metadata = await image.metadata();
    if (metadata.height > maxHeight) {
      console.log(
        `✂️ Trimming image ${imgPath} from ${metadata.height}px to ${maxHeight}px`
      );
      await image
        .extract({ top: 0, left: 0, width: metadata.width, height: maxHeight })
        .toFile(imgPath); // overwrite
    }
  } catch (e) {
    console.warn(`⚠️ Could not crop ${imgPath}: ${e.message}`);
  }
}
