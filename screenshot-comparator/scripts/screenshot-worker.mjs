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
    const { prodUrl, stageUrl, prodImgPath, stageImgPath } = obj;
   
    const browser = await chromium.launch();
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }, // Set a fixed viewport size
    });
   
    try {
        if (!fs.existsSync(prodImgPath)) {
            const prodPage = await context.newPage();
            await prodPage.goto(prodUrl, { waitUntil: 'networkidle', timeout: 90000 }); // Wait for all resources to load
            await prodPage.screenshot({ path: prodImgPath, fullPage: true });
            await prodPage.close();
        }

        if (!fs.existsSync(stageImgPath)) {
            const stagePage = await context.newPage();

            if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
                await stagePage.setExtraHTTPHeaders({
                    'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
                    'x-vercel-set-bypass-cookie': 'true'
                });
            }
            
            await stagePage.goto(stageUrl, { waitUntil: 'networkidle', timeout: 90000 }); // Wait for all resources to load
            await stagePage.screenshot({ path: stageImgPath, fullPage: true });
            await stagePage.close();
        }

        return true;
    } catch (error) {
        console.error(`🆘 Error processing ${prodUrl}:`, error);

        return false;
    } finally { 
        await browser.close();
    }
}