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
 
    const diffDir1 = path.join(outputDir, "diffs");

    const prodImgPath = path.join(screenshotsDir, `${getFileName(prodUrl ?? throwError('prodUrl'))}-prod.png`);
    const stageImgPath = path.join(screenshotsDir, `${getFileName(stageUrl ?? throwError('stageUrl'))}-stage.png`);
    const diffImgPath1 = path.join(diffDir1, `${getFileName(prodUrl)}-DIFF.png`);

    fs.mkdirSync(diffDir1, { recursive: true });

    try {
        if (!fs.existsSync(prodImgPath) || !fs.existsSync(stageImgPath)) {
            console.error(`🆘 One or both images do not exist: ${prodImgPath}, ${stageImgPath}`);
            return ({
                url: prodUrl,
                prodImg: path.relative(outputDir, prodImgPath),
                stageImg: path.relative(outputDir, stageImgPath),
                diffImg: null,
                match: false,
                log: `One or both images do not exist: ${prodImgPath}, ${stageImgPath}`
            });
        }

        
        const match = compareImages(prodImgPath, stageImgPath, diffImgPath1, parseFloat(15));

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
function compareImages(prodImgPath, stageImgPath, diffImgPath) {
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

    const threshold = process.env.PIXEL_MATCH_THRESHOLD ?? 15;
    // Perform pixel comparison
    const mismatchCount = pixelmatch(
        prodPadded.data,
        stagePadded.data,
        diff.data,
        width,
        height,
        { threshold: threshold }
    );
    console.log(`🔍 Comparing images: ${prodImgPath} vs ${stageImgPath} threshold: ${threshold} mismatchCount: ${mismatchCount} `);
    // Save diff image if differences exist
    if (mismatchCount > 0) {
        console.log('📷 Saving diff to:', diffImgPath);
        fs.writeFileSync(diffImgPath, PNG.sync.write(diff));
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