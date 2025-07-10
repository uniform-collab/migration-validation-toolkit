// Import required libraries
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { env, retryWithBackoff } from "./utils.js";
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
   
    const browser = await chromium.launch();
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
    });
   
    try {
        if (!fs.existsSync(prodImgPath)) {
            const prodPage = await context.newPage();
            await retryWithBackoff(() =>
                prodPage.goto(prodUrl, { waitUntil: 'networkidle', timeout: 90000 })
            );
            await freezeAnimations(prodPage);
            await prodPage.screenshot({ path: prodImgPath, fullPage: true });
            await prodPage.close();
            console.log(`🟦 Screenshot taken for production URL: ${prodUrl}`);
        } else {
            console.log(`🟦 Screenshot already exists for production URL: ${prodUrl}`);
        }

        if (!fs.existsSync(migratedImgPath)) {
            const stagePage = await context.newPage();

            if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
                await stagePage.setExtraHTTPHeaders({
                    'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
                    'x-vercel-set-bypass-cookie': 'true'
                });
            }

            await retryWithBackoff(() =>
                stagePage.goto(migratedUrl, { waitUntil: 'networkidle', timeout: 90000 })
            );
            await freezeAnimations(stagePage);
            await stagePage.screenshot({ path: migratedImgPath, fullPage: true });
            await stagePage.close();
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
