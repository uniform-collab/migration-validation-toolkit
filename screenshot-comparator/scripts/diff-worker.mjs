import fs from "fs";
import path from "path";
import resemble from "resemblejs";
import sharp from "sharp";
import {
  buildContentComparisonData,
  isContentComparisonEnabled,
  normalizeInnerTextForCompare,
} from "./utils.js";
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
  const contentComparison = isContentComparisonEnabled();

  const folderName = getFileName(prodUrl);
  console.log(`\n=== Processing URL: ${relativeUrl} | Folder: ${folderName} ===`);

  const prodFolder = path.join(outputDir, "prod", folderName);
  const migratedFolder = path.join(
    outputDir,
    "migrated",
    getFileName(migratedUrl)
  );
  const diffFolder = path.join(outputDir, "diffs", folderName);

  const prodComponentNames = listComponentNames(prodFolder, "_prod.png");
  const migratedComponentNames = listComponentNames(
    migratedFolder,
    "_migrated.png"
  );

  const allComponentNames = new Set([
    ...prodComponentNames,
    ...migratedComponentNames,
  ]);

  const results = [];
  const contentDiffJsonComponents = [];
  let totalWeightedMismatch = 0;
  let totalHeight = 0;

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

    console.log(`🔍 Comparing ${allComponentNames.size} components for URL: ${relativeUrl}`);
    for (const componentName of allComponentNames) {
      const prodImgPath = path.join(
        prodFolder,
        componentName,
        `${componentName}_prod.png`
      );
      console.log("📷 PROD image path:", prodImgPath);
      const stageImgPath = path.join(
        migratedFolder,
        componentName,
        `${componentName}_migrated.png`
      );
      const diffImgPath = path.join(
        diffFolder,
        componentName,
        `${componentName}_diff.png`
      );

      const prodExists = fs.existsSync(prodImgPath);
      const stageExists = fs.existsSync(stageImgPath);

      console.log(`🔎 Comparing component: ${componentName} | PROD exists: ${prodExists} | MIGRATED exists: ${stageExists}`);
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
          ...contentSidecarsIfEnabled(
            contentComparison,
            prodFolder,
            migratedFolder,
            componentName,
            contentDiffJsonComponents
          ),
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
          ...contentSidecarsIfEnabled(
            contentComparison,
            prodFolder,
            migratedFolder,
            componentName,
            contentDiffJsonComponents
          ),
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
        results.push({
          component: componentName,
          prodImg: path.relative(outputDir, prodImgPath),
          stageImg: path.relative(outputDir, stageImgPath),
          diffImg: null,
          match: true,
          mismatch: null,
          log: `Ignored difference for ${relativeUrl} :: ${componentName} with ${mismatch}% mismatch as per ignore list`,
          tag: "ignored-diff",
          ...contentSidecarsIfEnabled(
            contentComparison,
            prodFolder,
            migratedFolder,
            componentName,
            contentDiffJsonComponents
          ),
        });
        continue;
      }

      if (!isNaN(mismatch) && height > 0) {
        totalWeightedMismatch += mismatch * height;
        totalHeight += height;
      }

      if (!match && diffBuffer) {
        fs.mkdirSync(path.dirname(diffImgPath), { recursive: true });
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
        ...contentSidecarsIfEnabled(
          contentComparison,
          prodFolder,
          migratedFolder,
          componentName,
          contentDiffJsonComponents
        ),
      });
    }

    const totalMismatchScore =
      totalHeight > 0 ? totalWeightedMismatch / totalHeight : null;

    let contentDiffJson = null;
    if (contentComparison) {
      contentDiffJson = writePageContentDiffJson(
        diffFolder,
        { url: relativeUrl, prodUrl, migratedUrl },
        contentDiffJsonComponents,
        outputDir
      );
    }

    return {
      url: relativeUrl,
      mismatch:
        totalMismatchScore != null
          ? parseFloat(totalMismatchScore.toFixed(2))
          : null,
      tag: getDiffTag(totalMismatchScore),
      components: results,
      contentDiffJson,
    };
  } catch (error) {
    console.error(`❌ Error processing ${prodUrl}:`, error);
    return null;
  }
}

function contentSidecarsIfEnabled(
  enabled,
  prodFolder,
  migratedFolder,
  componentName,
  contentDiffJsonComponents
) {
  if (!enabled) return {};
  const comparison = compareInnerTextSidecars(
    prodFolder,
    migratedFolder,
    componentName
  );
  if (comparison.jsonEntry) {
    contentDiffJsonComponents.push({
      component: componentName,
      contentMatch: comparison.contentMatch,
      contentTag: comparison.contentTag,
      prod: comparison.jsonEntry.prod,
      migrated: comparison.jsonEntry.migrated,
    });
  }
  const { contentMatch, contentTag, contentLog } = comparison;
  return { contentMatch, contentTag, contentLog };
}

function compareInnerTextSidecars(prodFolder, migratedFolder, componentName) {
  const prodPath = path.join(
    prodFolder,
    componentName,
    `${componentName}_prod.innerText.txt`
  );
  const migPath = path.join(
    migratedFolder,
    componentName,
    `${componentName}_migrated.innerText.txt`
  );
  const prodHas = fs.existsSync(prodPath);
  const migHas = fs.existsSync(migPath);

  const prodN = prodHas
    ? normalizeInnerTextForCompare(fs.readFileSync(prodPath, "utf8"))
    : "";
  const migN = migHas
    ? normalizeInnerTextForCompare(fs.readFileSync(migPath, "utf8"))
    : "";

  return buildContentComparisonData(prodN, migN, { prodHas, migHas });
}

function writePageContentDiffJson(diffFolder, meta, components, outputDir) {
  if (!components.length) return null;

  fs.mkdirSync(diffFolder, { recursive: true });
  const filePath = path.join(diffFolder, "content-diff.json");
  const doc = {
    url: meta.url,
    prodUrl: meta.prodUrl,
    migratedUrl: meta.migratedUrl,
    generatedAt: new Date().toISOString(),
    components,
  };
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), "utf8");
  console.log(`📝 Content diff JSON saved: ${filePath}`);
  return path.relative(outputDir, filePath);
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

/**
 * List component subfolders under a page folder (e.g. `component-00`, `component-01`).
 * Only returns names for which the expected image file exists inside, so we skip
 * stray directories that don't contain a captured component.
 */
function listComponentNames(pageFolder, imageSuffix) {
  if (!fs.existsSync(pageFolder)) return [];
  return fs
    .readdirSync(pageFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      fs.existsSync(path.join(pageFolder, name, `${name}${imageSuffix}`))
    );
}

function getFileName(input) {
  // Must produce the exact same relative path that `encodeURLToFolder` in
  // screenshot-worker.mjs used to create the folder — otherwise we'd look
  // in the wrong place. Nested per URL path, percent-encoding illegal chars
  // per segment.
  let pathname = input;

  try {
    const u = new URL(input);
    pathname = u.pathname;
  } catch {
    pathname = input;
  }

  pathname = pathname.replace(/^\/+|\/+$/g, "");

  if (!pathname) return "index";

  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.replace(/[<>:"\\|?*\0]/g, (char) =>
        `%${char.charCodeAt(0).toString(16)}`
      )
    )
    .join("/");
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
