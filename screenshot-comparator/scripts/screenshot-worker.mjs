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