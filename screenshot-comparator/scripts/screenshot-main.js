import { fork } from "child_process";
import fs from "fs";
import path from "path";
import { env } from "./utils.js";
import dotenv from "dotenv";
dotenv.config();

const illegalCharsRegex = /[<>:"\/\\|?*\0]/g;

const prodOnly = process.argv.includes("--prod-only");
const migratedOnly = process.argv.includes("--migrated-only");

const useSitemap = process.argv.includes("--sitemap");
const urlsFilePath = useSitemap? "./.temp/urls-sitemap.json" : "./.temp/urls.json";
console.log(`Using URLs from: ${urlsFilePath}`);
const urls = JSON.parse(fs.readFileSync(urlsFilePath, "utf8"));

const outputDir = "./.comparison_results";
const screenshotsProdDir = path.join(outputDir, "prod");
const screenshotsMigratedDir = path.join(outputDir, "migrated");

fs.mkdirSync(screenshotsProdDir, { recursive: true });
fs.mkdirSync(screenshotsMigratedDir, { recursive: true });

const rawQueue = urls
  .map((relativeUrl) => {
    // Build full URLs using URL API
    const prodUrl = new URL(relativeUrl, env("PROD_WEBSITE_URL")).toString();
    const migratedUrl = new URL(relativeUrl, env("STAGE_WEBSITE_URL")).toString();

    const prodImgPath = path.join(
      screenshotsProdDir,
      `prod_${getFileName(prodUrl)}.png`
    );
    const migratedImgPath = path.join(
      screenshotsMigratedDir,
      `migrated_${getFileName(migratedUrl)}.png`
    );

    return {
      prodUrl,
      migratedUrl,
      prodImgPath,
      migratedImgPath,
      prodOnly,
      migratedOnly,
    };
  })
  .filter(Boolean);

const totalTasks = rawQueue.length;
const taskQueue = [...rawQueue];

const numWorkers = process.env.PLAYWRIGHT_WORKERS
  ? parseInt(process.env.PLAYWRIGHT_WORKERS)
  : 4;

const workers = [];
let results = [];

for (let i = 0; i < numWorkers; i++) {
  const worker = fork("./scripts/screenshot-worker.mjs");
  workers.push({ id: i, process: worker, busy: false });

  worker.on("message", (result) => {
    results.push(result);

    const remaining = taskQueue.length;
    const done = results.length;
    const percent = ((done / totalTasks) * 100).toFixed(1);

    console.log(
      result
        ? `✅ Worker ${i} success (${remaining} left, ${percent}% done)`
        : `🆘 Worker ${i} failed (${remaining} left, ${percent}% done)`
    );

    workers[i].busy = false;
    assignNextTask(i);
  });

  worker.on("error", (err) => {
    console.error(`❌ Worker ${i} error:`, err);
    workers[i].busy = false;
    assignNextTask(i);
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      console.warn(`⚠️ Worker ${i} exited with code ${code}`);
    }
  });
}

function assignNextTask(workerId) {
  if (taskQueue.length === 0) {
    const allDone = workers.every((w) => !w.busy);
    if (allDone) {
      console.log(`🏁 All tasks completed. Total: ${results.length}`);
      workers.forEach((w) => w.process.kill("SIGTERM"));
    }
    return;
  }

  const task = taskQueue.shift();
  if (task) {
    workers[workerId].busy = true;
    console.log(`📸 Worker ${workerId} -> Prod: ${task.prodUrl}`);
    workers[workerId].process.send(task);
  }
}

// Start initial assignment
for (let i = 0; i < workers.length; i++) {
  assignNextTask(i);
}

function encodeURLToFilename(url) {
  return url.replace(
    illegalCharsRegex,
    (char) => `%${char.charCodeAt(0).toString(16)}`
  );
}

function getFileName(url) {
  url = url
    .replace(env("STAGE_WEBSITE_URL"), "")
    .replace(env("PROD_WEBSITE_URL"), "");
  url = url.startsWith("/") ? url.substring(1) : url;
  const filename = encodeURLToFilename(url);
  return filename || "index";
}
