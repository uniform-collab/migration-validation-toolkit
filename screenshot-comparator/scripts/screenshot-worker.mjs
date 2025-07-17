// Import required libraries
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { env, retryWithBackoff } from "./utils.js";
import sharp from 'sharp';
import { rename } from 'fs/promises';

import dotenv from 'dotenv';
dotenv.config();

process.on('SIGTERM', () => {
    console.log('Worker received termination signal. Cleaning up...');
    process.exit(0);
});
  
// Listen for messages from the main process
process.on('message', async (obj) => {    
    process.send(await doWork(obj))
});

async function doWork(obj) {
    const { prodUrl, migratedUrl, prodImgPath, migratedImgPath } = obj;

    //const browser = await chromium.launch({ headless: false, slowMo: 100 });
    const browser = await chromium.launch();
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
    });
   
    try {
        if (!fs.existsSync(prodImgPath)) {
            await preparePage(context, prodUrl, prodImgPath);
            console.log(`🟦 Screenshot taken for production URL: ${prodUrl}`);
        } else {
            console.log(`🟦 Screenshot already exists for production URL: ${prodUrl}`);
        }

        if (!fs.existsSync(migratedImgPath)) {
            await preparePage(context, migratedUrl, migratedImgPath, true);
            console.log(`🟨 Screenshot taken for migrated URL: ${migratedUrl}`);
        } else {
            console.log(`🟨 Screenshot already exists for migrated URL: ${migratedUrl}`);
        }

        return true;
    } catch (error) {
        console.error(`🆘 Error processing ${prodUrl}:`, error);
        return false;
    } finally {
        await browser.close();
    }
}

async function preparePage(context, url, imgPath, isStage = false) {
    const page = await context.newPage();

    if (isStage && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
        await page.setExtraHTTPHeaders({
            'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
            'x-vercel-set-bypass-cookie': 'true'
        });
    }

    const parsedUrl = new URL(url);
    const searchTerm = parsedUrl.searchParams.get('searchTerm');
    
    if (searchTerm) {
        parsedUrl.searchParams.delete('searchTerm');
        const cleanUrl = parsedUrl.toString();

        await retryWithBackoff(() =>
            page.goto(cleanUrl, { waitUntil: 'load', timeout: process.env.PLAYWRIGHT_TIMEOUT ? parseInt(process.env.PLAYWRIGHT_TIMEOUT) : 90000 })
        );

        console.log(`🔎 Performing search for "${searchTerm}" on URL: ${url}`);

        await page.waitForSelector('input[placeholder="What can we help you find?"]', { timeout: 10000 });
        await page.fill('input[placeholder="What can we help you find?"]', searchTerm);

        await page.click('button[aria-label="search-button"]');
        await page.waitForTimeout(2000);
        console.log(`✅ Search completed for "${searchTerm}"`);
    }else{
      await retryWithBackoff(() =>
          page.goto(url, { waitUntil: 'networkidle', timeout: process.env.PLAYWRIGHT_TIMEOUT ? parseInt(process.env.PLAYWRIGHT_TIMEOUT) : 90000 })
      );
    }

    await freezeAnimations(page);
    await page.screenshot({ path: imgPath, fullPage: true });
    await page.close();

    await cropImageHeightIfNeeded(imgPath, 9000);
}

async function cropImageHeightIfNeeded(imgPath, maxHeight = 3000) {
  try {
    const image = sharp(imgPath);
    const metadata = await image.metadata();

    if (metadata.height > maxHeight) {
      const tmpPath = imgPath + '.tmp';

      await image
        .extract({
          left: 0,
          top: 0,
          width: metadata.width,
          height: maxHeight,
        })
        .toFile(tmpPath);

      await rename(tmpPath, imgPath);

      console.log(`✂️ Cropped ${imgPath} to max height ${maxHeight}px`);
    } else {
      console.log(`✅ No cropping needed for ${imgPath} (height: ${metadata.height}px)`);
    }
  } catch (err) {
    console.warn(`⚠️ Failed to crop ${imgPath}: ${err.message}`);
  }
}

async function freezeAnimations(page) {
  // Inject CSS to disable all animations, transitions, and transforms
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
    `
  });

  // Wait for all dynamic content to render
  await page.waitForTimeout(1000);

  // Evaluate in page context to freeze dynamic behavior
  await page.evaluate(async () => {
    // Disable JS animation functions
    window.requestAnimationFrame = () => {};
    window.setInterval = () => 0;
    window.setTimeout = () => 0;

    // Pause all <video> elements
    document.querySelectorAll('video').forEach(video => {
      try {
        video.pause();
      } catch (e) {}
    });

    // Freeze all .gif images by replacing them with canvas-rendered PNGs
    const freezeSingleGif = async (imgElement) => {
      return new Promise((resolve) => {
        try {
          const src = imgElement.src;
          const tempImg = new Image();
          tempImg.crossOrigin = 'anonymous';

          // Prevent caching of animated src
          tempImg.src = src + (src.includes('?') ? '&freezeCacheBust=' + Date.now() : '?freezeCacheBust=' + Date.now());

          tempImg.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = tempImg.naturalWidth;
              canvas.height = tempImg.naturalHeight;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(tempImg, 0, 0);
              const still = canvas.toDataURL('image/png');
              imgElement.src = still;
              resolve();
            } catch (e) {
              console.warn('❄️ Failed to draw GIF:', src, e);
              resolve();
            }
          };

          tempImg.onerror = () => {
            console.warn('❄️ Failed to load GIF:', src);
            resolve();
          };
        } catch (err) {
          console.warn('❄️ Unexpected error freezing GIF:', err);
          resolve();
        }
      });
    };

    const gifImgs = [...document.querySelectorAll('img[src$=".gif"]')];
    await Promise.all(gifImgs.map(freezeSingleGif));

    // Freeze react-multi-carousel (stop autoplay, cancel transitions)
    try {
      const rmcTrack = document.querySelector('.react-multi-carousel-track');
      if (rmcTrack) {
        rmcTrack.style.transition = 'none';
        rmcTrack.style.transform = getComputedStyle(rmcTrack).transform;

        // Attempt to stop autoplay via timers (brute-force fallback)
        const originalSetInterval = window.setInterval;
        const originalClearInterval = window.clearInterval;
        const activeIntervals = [];

        window.setInterval = function (...args) {
          const id = originalSetInterval(...args);
          activeIntervals.push(id);
          return id;
        };

        setTimeout(() => {
          activeIntervals.forEach(id => originalClearInterval(id));
        }, 50);
      }
    } catch (e) {
      console.warn('❄️ Failed to freeze react-multi-carousel:', e);
    }

    const toastEl = document.querySelector('[id^="nextjs-toast"], .nextjs-toast-container, .nextjs-toast');
    if (toastEl) {
      toastEl.remove();
      console.log('🔥 Removed nextjs-toast element from DOM');
    }
  });
}
