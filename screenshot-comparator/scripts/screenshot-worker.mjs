// Import required libraries
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { env } from "./utils.js";
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
    const { prodUrl, migratedUrl } = obj;

    const prodDir = path.join('.screenshots', 'prod', encodeURLToFolder(prodUrl));
    const migratedDir = path.join('.screenshots', 'migrated', encodeURLToFolder(migratedUrl));

    fs.mkdirSync(prodDir, { recursive: true });
    fs.mkdirSync(migratedDir, { recursive: true });

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    try {
        const page = await context.newPage();

        // Screenshot components from production
        await page.goto(prodUrl, { waitUntil: 'networkidle', timeout: 90000 });
        const prodComponents = await getComponentSelectors(page);
        await screenshotComponents(page, prodComponents, prodDir);

        // Screenshot components from staging
        if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
            await page.setExtraHTTPHeaders({
                'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
                'x-vercel-set-bypass-cookie': 'true'
            });
        }

        await page.goto(migratedUrl, { waitUntil: 'networkidle', timeout: 90000 });
        const stageComponents = await getComponentSelectors(page);
        await screenshotComponents(page, stageComponents, migratedDir);

        await page.close();
        return true;
    } catch (error) {
        console.error(`🚘 Error processing ${prodUrl}:`, error);
        return false;
    } finally {
        await browser.close();
    }
}

async function getComponentSelectors(page) {
    return await page.evaluate(() => {
        const selectors = [];
        const header = document.querySelector('header');
        const footer = document.querySelector('footer');

        if (header) selectors.push({ name: 'header', selector: 'header' });

        if (header && footer) {
            const components = [];
            let current = header.nextElementSibling;
            let index = 0;
            while (current && current !== footer) {
                if (current.tagName.toLowerCase() !== 'script' && current.nodeType === 1) {
                    const uniqueSelector = `div-${index}`;
                    current.setAttribute('data-component-id', uniqueSelector);
                    selectors.push({ name: uniqueSelector, selector: `[data-component-id="${uniqueSelector}"]` });
                    index++;
                }
                current = current.nextElementSibling;
            }
        }

        if (footer) selectors.push({ name: 'footer', selector: 'footer' });

        return selectors;
    });
}

async function screenshotComponents(page, components, outputDir) {
    for (const comp of components) {
        try {
            const element = await page.$(comp.selector);
            if (!element) {
                console.warn(`⚠️ Selector not found: ${comp.selector}`);
                continue;
            }

            const box = await element.boundingBox();
            if (!box || box.width === 0 || box.height === 0) {
                console.warn(`⚠️ Skipping invisible component: ${comp.name}`);
                continue;
            }

            const filePath = path.join(outputDir, `${comp.name}.png`);
            await element.screenshot({ path: filePath });
            console.log(`📸 Component screenshot saved: ${filePath}`);
        } catch (err) {
            console.error(`🆘 Failed to screenshot ${comp.name}:`, err.message);
        }
    }
}

function encodeURLToFolder(url) {
    const illegalCharsRegex = /[<>:"/\\|?*\0]/g;
    return url.replace(env("STAGE_WEBSITE_URL"), "")
              .replace(env("PROD_WEBSITE_URL"), "")
              .replace(illegalCharsRegex, (char) => `%${char.charCodeAt(0).toString(16)}`)
              .replace(/^\/+/g, '')
              .replace(/\/+$/g, '')
              .replace(/\//g, '_') || 'index';
}