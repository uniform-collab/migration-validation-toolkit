import fs from 'fs';
import path from 'path';
import resemble from 'resemblejs';
import { env } from "./utils.js";
import dotenv from 'dotenv';
dotenv.config();

process.on('SIGTERM', () => {
    console.log('Worker received termination signal. Cleaning up...');
    process.exit(0);
});

process.on('message', async (obj) => {
    process.send(await doWork(obj));
});

async function doWork(obj) {
    const { outputDir, prodUrl, migratedUrl } = obj;

    const screenshotsDir = "./.screenshots";
    const screenshotsProdDir = path.join(screenshotsDir, "prod");
    const screenshotsMigratedDir = path.join(screenshotsDir, "migrated");

    const diffDir = path.join(outputDir, "diffs");

    const prodImgPath = path.join(screenshotsProdDir, `${getFileName(prodUrl ?? throwError('prodUrl'))}.png`);
    const stageImgPath = path.join(screenshotsMigratedDir, `${getFileName(migratedUrl ?? throwError('migratedUrl'))}.png`);
    const diffImgPath = path.join(diffDir, `${getFileName(prodUrl)}.png`);

    fs.mkdirSync(diffDir, { recursive: true });

    try {
        if (!fs.existsSync(prodImgPath) || !fs.existsSync(stageImgPath)) {
            const log = `Production images do not exist: ${prodImgPath}`;
            console.error(`🆘 ${log}`);
            return {
                url: prodUrl,
                prodImg: path.relative(outputDir, prodImgPath),
                stageImg: path.relative(outputDir, stageImgPath),
                diffImg: null,
                match: false,
                mismatch: null,
                log
            };
        }

        if (!fs.existsSync(stageImgPath)) {
            const log = `Target images do not exist: ${stageImgPath}`;
            console.error(`🆘 ${log}`);
            return {
                url: prodUrl,
                prodImg: path.relative(outputDir, prodImgPath),
                stageImg: path.relative(outputDir, stageImgPath),
                diffImg: null,
                match: false,
                mismatch: null,
                log
            };
        }

        console.log(`🔗 Comparing screenshots:\n   🟦 ${prodImgPath}\n   🟨 ${stageImgPath}`);

        const { match, mismatch, error } = await compareImages(prodImgPath, stageImgPath, diffImgPath);

        return {
            url: prodUrl,
            prodImg: path.relative(outputDir, prodImgPath),
            stageImg: path.relative(outputDir, stageImgPath),
            diffImg: match ? null : path.relative(outputDir, diffImgPath),
            match,
            mismatch,
            log: error ?? null
        };
    } catch (error) {
        console.error(`❌ Error processing ${prodUrl}:`, error);
        return null;
    }
}

async function compareImages(prodImgPath, stageImgPath, diffImgPath) {
    const prodBuffer = fs.readFileSync(prodImgPath);
    const stageBuffer = fs.readFileSync(stageImgPath);

    console.log(`🧪 Buffer sizes — prod: ${prodBuffer.length}, stage: ${stageBuffer.length}`);

    return new Promise((resolve, reject) => {
        resemble(prodBuffer)
            .compareTo(stageBuffer)
            .ignoreAntialiasing()
            .outputSettings({
                errorColor: { red: 255, green: 0, blue: 0 },
                errorType: 'flat',
                transparency: 0.3,
                largeImageThreshold: 1200,
                useCrossOrigin: false
            })
            .onComplete(data => {
                if (data.error) {
                    console.error('❌ Resemble error:', data.error);
                    const mismatch = 100.0;
                    console.log(`📊 Mismatch percentage: ${mismatch.toFixed(2)}%`);
                    return resolve({ match: false, mismatch, error: data.error });
                }

                let mismatch = parseFloat(data?.misMatchPercentage ?? '100.0');
                if (isNaN(mismatch)) {
                    mismatch = 100.0;
                    console.warn('⚠️ misMatchPercentage was NaN, forced to 100.0');
                }

                console.log(`📊 Mismatch percentage: ${mismatch.toFixed(2)}%`);

                if (mismatch > 0 && typeof data.getBuffer === 'function') {
                    fs.writeFileSync(diffImgPath, data.getBuffer());
                    console.log('📷 Diff image saved to:', diffImgPath);
                }

                resolve({ match: mismatch === 0, mismatch });
            });
    });
}

function getFileName(url) {
    url = url.replace(env("STAGE_WEBSITE_URL"), "");
    url = url.replace(env("PROD_WEBSITE_URL"), "");
    url = url.startsWith('/') ? url.substring(1) : url;
    
    const filename = encodeURLToFilename(url);
    return filename || 'index';
}

function encodeURLToFilename(url) {
    const illegalCharsRegex = /[<>:"\/\\|?*\0]/g;
    return url.replace(illegalCharsRegex, char =>
        `%${char.charCodeAt(0).toString(16)}`
    );
}

function throwError(msg) {
    throw new Error(msg);
}
