// Import required libraries
// import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
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
    const {outputDir, prodUrl, stageUrl} = obj;
    
    const screenshotsDir = path.join(outputDir ?? throwError('outputDir'), "screenshots");
    fs.mkdirSync(screenshotsDir, { recursive: true });
   
    // const browser = await chromium.launch();
    // const context = await browser.newContext({
    //     viewport: { width: 1280, height: 720 }, // Set a fixed viewport size
    //     httpCredentials: {
    //         username: "phoenix",
    //         password: "suns"
    //     }
    // });

    const config = { 'main': '15.0', 'mid': '5.2', 'high': '3.2' }

    const diffDir1 = path.join(outputDir, "diffs", config.main);
    const diffDir2 = path.join(outputDir, "diffs", config.mid);
    const diffDir3 = path.join(outputDir, "diffs", config.high);
    const footerDiffDir1 = path.join(outputDir, "diffs", config.main);
    const footerDiffDir2 = path.join(outputDir, "diffs", config.mid);
    const footerDiffDir3 = path.join(outputDir, "diffs", config.high);

    const prodImgPath = path.join(screenshotsDir, `${getFileName(prodUrl ?? throwError('prodUrl'))}-prod.png`);
    const stageImgPath = path.join(screenshotsDir, `${getFileName(stageUrl ?? throwError('stageUrl'))}-stage.png`);
    const diffImgPath1 = path.join(diffDir1, `${getFileName(prodUrl)}-DIFF.png`);
    const diffImgPath2 = path.join(diffDir2, `${getFileName(prodUrl)}-DIFF.png`);
    const diffImgPath3 = path.join(diffDir3, `${getFileName(prodUrl)}-DIFF.png`);
    const footerDiffImgPath1 = path.join(footerDiffDir1, `${getFileName(prodUrl)}-FOOTER-DIFF.png`);
    const footerDiffImgPath2 = path.join(footerDiffDir2, `${getFileName(prodUrl)}-FOOTER-DIFF.png`);
    const footerDiffImgPath3 = path.join(footerDiffDir3, `${getFileName(prodUrl)}-FOOTER-DIFF.png`);

    fs.mkdirSync(diffDir1, { recursive: true });
    fs.mkdirSync(diffDir2, { recursive: true });
    fs.mkdirSync(diffDir3, { recursive: true });
    fs.mkdirSync(footerDiffDir1, { recursive: true });
    fs.mkdirSync(footerDiffDir2, { recursive: true });
    fs.mkdirSync(footerDiffDir3, { recursive: true });

    try {
        //const prodPage = await context.newPage();
        //await prodPage.goto(prodUrl, { waitUntil: 'networkidle', timeout: 90000 }); // Wait for all resources to load
        //await prodPage.screenshot({ path: prodImgPath, fullPage: true });
        //await prodPage.close();
//
        //const stagePage = await context.newPage();
        //await stagePage.goto(stageUrl, { waitUntil: 'networkidle', timeout: 90000 }); // Wait for all resources to load
        //await stagePage.screenshot({ path: stageImgPath, fullPage: true });
        //await stagePage.close();

        const match = compareImages(prodImgPath, stageImgPath, diffImgPath1, parseFloat(config.main));
        // const match2 = compareImages(prodImgPath, stageImgPath, diffImgPath2, parseFloat(config.mid));
        // const match3 = compareImages(prodImgPath, stageImgPath, diffImgPath3, parseFloat(config.high));
        // const footerMatch = compareFooters(prodImgPath, stageImgPath, footerDiffImgPath1, parseFloat(config.main));
        // const footerMatch2 = compareFooters(prodImgPath, stageImgPath, footerDiffImgPath2, parseFloat(config.mid));
        // const footerMatch3 = compareFooters(prodImgPath, stageImgPath, footerDiffImgPath3, parseFloat(config.high));

        return ({
            url: prodUrl,
            prodImg: path.relative(outputDir, prodImgPath),
            stageImg: path.relative(outputDir, stageImgPath),
            diffImg: match ? null : path.relative(outputDir, diffImgPath1),
            match
        });
    } catch (error) {
        console.error(`Error processing ${prodUrl}:`, error);

        return null;
    } finally { 
        //await browser.close();
    }
}

// Function to compare images
function compareImages(prodImgPath, stageImgPath, diffImgPath, threshold) {
    if (!fs.existsSync(prodImgPath) || !fs.existsSync(stageImgPath)) {
        console.error(`🆘 One or both images do not exist: ${prodImgPath}, ${stageImgPath}`);
        return false;
    }

    const prodImg = PNG.sync.read(fs.readFileSync(prodImgPath));
    const stageImg = PNG.sync.read(fs.readFileSync(stageImgPath));

    // Determine maximum dimensions
    const width = Math.max(prodImg.width, stageImg.width);
    const height = Math.max(prodImg.height, stageImg.height);

    // Create padded images with the maximum dimensions
    const prodPadded = new PNG({ width, height });
    const stagePadded = new PNG({ width, height });

    PNG.bitblt(prodImg, prodPadded, 0, 0, prodImg.width, prodImg.height, 0, 0);
    PNG.bitblt(stageImg, stagePadded, 0, 0, stageImg.width, stageImg.height, 0, 0);

    // Prepare for comparison
    const diff = new PNG({ width, height });

    // Perform pixel comparison
    const mismatchCount = pixelmatch(
        prodPadded.data,
        stagePadded.data,
        diff.data,
        width,
        height,
        { threshold: threshold ?? 0.2 }
    );

    // Save diff image if differences exist
    if (mismatchCount > 0) {
        fs.writeFileSync(diffImgPath, PNG.sync.write(diff));
        return false;
    }
    return true;
}

// Function to compare footers
function compareFooters(prodImgPath, stageImgPath, footerDiffImgPath) {
    const prodImg = PNG.sync.read(fs.readFileSync(prodImgPath));
    const stageImg = PNG.sync.read(fs.readFileSync(stageImgPath));

    // Extract the bottom 800px of each image
    const footerHeight = 800;
    const width = Math.min(prodImg.width, stageImg.width);
    const prodFooter = new PNG({ width, height: footerHeight });
    const stageFooter = new PNG({ width, height: footerHeight });

    PNG.bitblt(prodImg, prodFooter, 0, prodImg.height - footerHeight, width, footerHeight, 0, 0);
    PNG.bitblt(stageImg, stageFooter, 0, stageImg.height - footerHeight, width, footerHeight, 0, 0);

    const diff = new PNG({ width, height: footerHeight });

    const mismatchCount = pixelmatch(
        prodFooter.data,
        stageFooter.data,
        diff.data,
        width,
        footerHeight,
        { threshold: 0.1 }
    );

    if (mismatchCount > 0) {
        fs.writeFileSync(footerDiffImgPath, PNG.sync.write(diff));
        return false;
    }
    return true;
}

const illegalCharsRegex = /[<>:"\/\\|?*\0]/g;

// Encode the URL to a filename
function encodeURLToFilename(url) {
    return url.replace(illegalCharsRegex, char => {
        // Percent-encode illegal characters
        return `%${char.charCodeAt(0).toString(16)}`;
    });
}

function getFileName(url) {
    url = url.replace(env("STAGE_WEBSITE_URL"), "");
    url = url.replace(env("PROD_WEBSITE_URL"), "");
    url = url.startsWith('/') ? url.substring(1) : url;

    return encodeURLToFilename(url);
}

function throwError(msg) { throw new Error(msg)}