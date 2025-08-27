import fs from "fs";
import path from "path";
import resemble from "resemblejs";
import sharp from "sharp";
import { env } from "./utils.js";
import dotenv from "dotenv";
dotenv.config();

process.on("SIGTERM", () => {
  console.log("Worker received termination signal. Cleaning up...");
  process.exit(0);
});

process.on("message", async (obj) => {
  process.send(await doWork(obj));
});

async function doWork(obj) {
  const { outputDir, prodUrl, migratedUrl, relativeUrl, ignoreList } = obj;

  const prodFolder = path.join(outputDir, "prod", getFileName(prodUrl));
  const migratedFolder = path.join(
    outputDir,
    "migrated",
    getFileName(migratedUrl)
  );
  const diffFolder = path.join(outputDir, "diffs", getFileName(prodUrl));

  const prodFiles = fs.existsSync(prodFolder)
    ? fs.readdirSync(prodFolder).filter((f) => f.endsWith("_prod.png"))
    : [];

  const migratedFiles = fs.existsSync(migratedFolder)
    ? fs.readdirSync(migratedFolder).filter((f) => f.endsWith("_migrated.png"))
    : [];

  const prodComponentNames = prodFiles.map((f) => f.replace(/_prod\.png$/, ""));
  const migratedComponentNames = migratedFiles.map((f) =>
    f.replace(/_migrated\.png$/, "")
  );

  const allComponentNames = new Set([
    ...prodComponentNames,
    ...migratedComponentNames,
  ]);

  const results = [];
  let totalWeightedMismatch = 0;
  let totalHeight = 0;
  let hasDiffImages = false;

  try {
    const prodRedirectPath = path.join(prodFolder, "redirect.txt");
    const migratedRedirectPath = path.join(migratedFolder, "redirect.txt");

    const prodFinalUrl = fs.existsSync(prodRedirectPath)
      ? fs.readFileSync(prodRedirectPath, "utf8").trim()
      : prodUrl;
    const migratedFinalUrl = fs.existsSync(migratedRedirectPath)
      ? fs.readFileSync(migratedRedirectPath, "utf8").trim()
      : migratedUrl;

    if (stripDomain(prodFinalUrl) !== stripDomain(migratedFinalUrl)) {
      console.warn(
        `🚨 Redirect mismatch: PROD → ${prodFinalUrl}, MIGRATED → ${migratedFinalUrl}`
      );

      return {
        url: relativeUrl,
        mismatch: 100.0,
        tag: "redirect-url-mismatch",
        log: `🔀 Redirected URLs are different: ${prodFinalUrl} vs ${migratedFinalUrl}`,
        components: results,
      };
    }

    for (const componentName of allComponentNames) {
      const prodImgPath = path.join(prodFolder, `${componentName}_prod.png`);
      const stageImgPath = path.join(
        migratedFolder,
        `${componentName}_migrated.png`
      );
      const diffImgPath = path.join(diffFolder, `${componentName}_diff.png`);

      const prodExists = fs.existsSync(prodImgPath);
      const stageExists = fs.existsSync(stageImgPath);

      if (!prodExists && stageExists) {
        const height = await getImageHeight(stageImgPath);
        if (height > 0) {
          totalWeightedMismatch += 100.0 * height;
          totalHeight += height;
        }

        results.push({
          component: componentName,
          prodImg: null,
          stageImg: path.relative(outputDir, stageImgPath),
          diffImg: null,
          match: false,
          mismatch: 100.0,
          tag: "extra-in-migrated",
          log: `⚠️ Extra component in migrated: ${componentName}`,
          height,
        });

        continue;
      }

      const height = await getImageHeight(prodImgPath);

      if (prodExists && !stageExists) {
        results.push({
          component: componentName,
          match: false,
          mismatch: null,
          diffImg: null,
          log: `⚠️ Missing component in migrated: ${componentName}`,
          tag: "missing-in-migrated",
        });
        continue;
      }

      const { match, mismatch, diffBuffer, error } = await compareImages(
        prodImgPath,
        stageImgPath
      );

      const ignored = shouldIgnoreDiff(
        relativeUrl,
        componentName,
        mismatch,
        ignoreList
      );
      if (ignored) {
        console.log(
          `ℹ️ Ignored difference for ${relativeUrl} :: ${componentName} with ${mismatch}% mismatch as per ignore list`
        );
        return {
          component: componentName,
          match: true,
          mismatch: null,
          diffImg: null,
          log: `Ignored difference for ${relativeUrl} :: ${componentName} with ${mismatch}% mismatch as per ignore list`,
          tag: "ignored-diff",
        };
      }

      if (!isNaN(mismatch) && height > 0) {
        totalWeightedMismatch += mismatch * height;
        totalHeight += height;
      }

      if (!match && diffBuffer) {
        if (!hasDiffImages) {
          fs.mkdirSync(diffFolder, { recursive: true }); // Create only when needed
          hasDiffImages = true;
        }
        fs.writeFileSync(diffImgPath, diffBuffer);
        console.log("📷 Diff image saved to:", diffImgPath);
      }

      results.push({
        component: componentName,
        prodImg: path.relative(outputDir, prodImgPath),
        stageImg: path.relative(outputDir, stageImgPath),
        diffImg: match ? null : path.relative(outputDir, diffImgPath),
        match,
        mismatch,
        tag: getDiffTag(mismatch),
        log: error ?? null,
      });
    }

    const totalMismatchScore =
      totalHeight > 0 ? totalWeightedMismatch / totalHeight : null;

    return {
      url: relativeUrl,
      mismatch:
        totalMismatchScore != null
          ? parseFloat(totalMismatchScore.toFixed(2))
          : null,
      tag: getDiffTag(totalMismatchScore),
      components: results,
    };
  } catch (error) {
    console.error(`❌ Error processing ${prodUrl}:`, error);
    return null;
  }
}

function stripDomain(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

async function getImageHeight(imgPath) {
  try {
    const meta = await sharp(imgPath).metadata();
    return meta.height || 0;
  } catch (e) {
    console.warn(`⚠️ Failed to read image height for ${imgPath}:`, e.message);
    return 0;
  }
}

async function compareImages(prodImgPath, stageImgPath) {
  const prodBuffer = fs.readFileSync(prodImgPath);
  const stageBuffer = fs.readFileSync(stageImgPath);

  return new Promise((resolve) => {
    resemble(prodBuffer)
      .compareTo(stageBuffer)
      .ignoreAntialiasing()
      .outputSettings({
        errorColor: { red: 255, green: 0, blue: 0 },
        errorType: "flat",
        transparency: 0.3,
        largeImageThreshold: 1200,
        useCrossOrigin: false,
      })
      .onComplete((data) => {
        if (data.error) {
          console.error("❌ Resemble error:", data.error);
          return resolve({
            match: false,
            mismatch: 100.0,
            error: data.error,
            diffBuffer: null,
          });
        }

        let mismatch = parseFloat(data?.misMatchPercentage ?? "100.0");
        if (isNaN(mismatch)) {
          mismatch = 100.0;
          console.warn("⚠️ misMatchPercentage was NaN, forced to 100.0");
        }

        console.log(`📊 Mismatch percentage: ${mismatch.toFixed(2)}%`);

        const diffBuffer =
          mismatch > 0 && typeof data.getBuffer === "function"
            ? data.getBuffer()
            : null;

        resolve({ match: mismatch === 0, mismatch, diffBuffer });
      });
  });
}

function getFileName(url) {
  url = url.replace(env("STAGE_WEBSITE_URL"), "");
  url = url.replace(env("PROD_WEBSITE_URL"), "");
  url = url.startsWith("/") ? url.substring(1) : url;

  const filename = encodeURLToFilename(url);
  return filename || "index";
}

function encodeURLToFilename(url) {
  const illegalCharsRegex = /[<>:"\/\\|?*\0]/g;
  return url.replace(
    illegalCharsRegex,
    (char) => `%${char.charCodeAt(0).toString(16)}`
  );
}

function getDiffTag(mismatch) {
  if (mismatch == null) return "not compared";
  if (mismatch === 0) return "perfect-match";
  if (mismatch <= 1) return "minor-diff";
  if (mismatch <= 5) return "medium-diff";
  if (mismatch <= 20) return "major-diff";
  return "critical-diff";
}

function shouldIgnoreDiff(url, component, mismatch, ignoreList) {
  if (mismatch == null) return false;
  for (const rule of ignoreList) {
    if (!rule) continue;

    if (rule.url === url && rule.component === component && mismatch == rule.percents) {
      return true;
    }
  }
  return false;
}
