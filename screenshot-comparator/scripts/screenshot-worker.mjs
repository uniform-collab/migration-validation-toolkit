import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { env, retryWithBackoff } from './utils.js';
import dotenv from 'dotenv';
import sharp from 'sharp';
dotenv.config();

process.on('SIGTERM', () => {
    console.log('Worker received termination signal. Cleaning up...');
    process.exit(0);
});

process.on('message', async (obj) => {
    process.send(await doWork(obj));
});

async function doWork(obj) {
    const { prodUrl, migratedUrl } = obj;

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    try {
        await screenshotPageComponents(context, prodUrl, '.comparison_results/prod');
        await screenshotPageComponents(context, migratedUrl, '.comparison_results/migrated', true);
        return true;
    } catch (error) {
        console.error(`🆘 Error processing ${prodUrl}:`, error);
        return false;
    } finally {
        await browser.close();
    }
}

async function screenshotPageComponents(context, url, baseDir, isStage = false) {
    const page = await context.newPage();

    if (isStage && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
        await page.setExtraHTTPHeaders({
            'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
            'x-vercel-set-bypass-cookie': 'true',
        });
    }

    const parsedUrl = new URL(url);
    const searchTerm = parsedUrl.searchParams.get('searchTerm');

    if (searchTerm) {
        parsedUrl.searchParams.delete('searchTerm');
        const cleanUrl = parsedUrl.toString();

        await retryWithBackoff(() =>
            page.goto(cleanUrl, {
                waitUntil: 'load',
                timeout: process.env.PLAYWRIGHT_TIMEOUT ? parseInt(process.env.PLAYWRIGHT_TIMEOUT) : 90000,
            })
        );

        console.log(`🔎 Performing search for "${searchTerm}" on URL: ${url}`);
        await page.waitForSelector('input[placeholder="What can we help you find?"]', { timeout: 10000 });
        await page.fill('input[placeholder="What can we help you find?"]', searchTerm);
        await page.click('button[aria-label="search-button"]');
        await page.waitForTimeout(10000);
    } else {
        await retryWithBackoff(() =>
            page.goto(url, {
                waitUntil: 'networkidle',
                timeout: process.env.PLAYWRIGHT_TIMEOUT ? parseInt(process.env.PLAYWRIGHT_TIMEOUT) : 90000,
            })
        );
    }

    await freezeAnimations(page);

    const componentDir = path.join(baseDir, encodeURLToFolder(url));
    fs.mkdirSync(componentDir, { recursive: true });

    const components = await getComponentSelectors(page);
    await screenshotComponents(page, components, componentDir, isStage);

    await page.close();
}

async function getComponentSelectors(page) {
    return await page.evaluate(() => {
        const selectors = [];
        const header = document.querySelector('header');
        const footer = document.querySelector('footer');

        if (header) selectors.push({ name: 'header', selector: 'header' });

        const isFixed = (el) => {
            const style = window.getComputedStyle(el);
            return style.position === 'fixed';
        };

        if (header && footer) {
            let current = header.nextElementSibling;
            let index = 0;
            while (current && current !== footer) {
                if (
                    current.tagName.toLowerCase() !== 'script' &&
                    current.nodeType === 1 &&
                    !isFixed(current)
                ) {
                    const uniqueSelector = `div-${index}`;
                    current.setAttribute('data-component-id', uniqueSelector);
                    selectors.push({
                        name: uniqueSelector,
                        selector: `[data-component-id="${uniqueSelector}"]`,
                    });
                    index++;
                }
                current = current.nextElementSibling;
            }
        }

        if (footer) selectors.push({ name: 'footer', selector: 'footer' });

        return selectors;
    });
}

async function screenshotComponents(page, components, outputDir, isStage) {
    for (const comp of components) {
        try {
            const element = await page.$(comp.selector);
            if (!element) {
                console.warn(`⚠️ Selector not found: ${comp.selector}`);
                continue;
            }

            const box = await element.boundingBox();
            if (!box || box.width === 0 || box.height === 0) {
                console.warn(`⚠️ Skipping invisible component: ${comp.name} width: ${box ? box.width : 'N/A'}, height: ${box ? box.height : 'N/A'}`);
                continue;
            }

            const filePath = path.join(outputDir, `${isStage?"migrated_":"prod_"}${comp.name}.png`);
            await element.screenshot({ path: filePath });

            await cropImageHeightIfNeeded(filePath, 9000);

            console.log(`📸 Component screenshot saved: ${filePath}`);
        } catch (err) {
            console.error(`🆘 Failed to screenshot ${comp.name}:`, err.message);
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

        document.querySelectorAll('video').forEach((video) => {
            try {
                video.pause();
            } catch (e) {}
        });

        const freezeSingleGif = async (imgElement) => {
            return new Promise((resolve) => {
                try {
                    const src = imgElement.src;
                    const tempImg = new Image();
                    tempImg.crossOrigin = 'anonymous';
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

        try {
            const rmcTrack = document.querySelector('.react-multi-carousel-track');
            if (rmcTrack) {
                rmcTrack.style.transition = 'none';
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
            console.warn('❄️ Failed to freeze react-multi-carousel:', e);
        }

        const toastEl = document.querySelector('[id^="nextjs-toast"], .nextjs-toast-container, .nextjs-toast');
        if (toastEl) {
            toastEl.remove();
            console.log('🔥 Removed nextjs-toast element from DOM');
        }
    });
}

function encodeURLToFolder(url) {
    const illegalCharsRegex = /[<>:"/\\|?*\0]/g;
    return url
        .replace(env('STAGE_WEBSITE_URL'), '')
        .replace(env('PROD_WEBSITE_URL'), '')
        .replace(illegalCharsRegex, (char) => `%${char.charCodeAt(0).toString(16)}`)
        .replace(/^\/+/g, '')
        .replace(/\/+$/g, '')
        .replace(/\//g, '_') || 'index';
}

async function cropImageHeightIfNeeded(imgPath, maxHeight = 9000) {
  try {
    const image = sharp(imgPath);
    const metadata = await image.metadata();
    if (metadata.height > maxHeight) {
      console.log(`✂️ Trimming image ${imgPath} from ${metadata.height}px to ${maxHeight}px`);
      await image
        .extract({ top: 0, left: 0, width: metadata.width, height: maxHeight })
        .toFile(imgPath); // overwrite
    }
  } catch (e) {
    console.warn(`⚠️ Could not crop ${imgPath}: ${e.message}`);
  }
}