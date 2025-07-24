import { fork } from "child_process";
import fs from "fs";
import path from "path";
import { env } from "./utils.js";
import dotenv from "dotenv";
dotenv.config();

const illegalCharsRegex = /[<>:"\/\\|?*\0]/g;

const urls = JSON.parse(fs.readFileSync("./.temp/urls.json", "utf8"));

const prodOnly = process.argv.includes("--prod-only");
const migratedOnly = process.argv.includes("--migrated-only");

const outputDir = "./.comparison_results";
const screenshotsProdDir = path.join(outputDir, "prod");
const screenshotsMigratedDir = path.join(outputDir, "migrated");

fs.mkdirSync(screenshotsProdDir, { recursive: true });
fs.mkdirSync(screenshotsMigratedDir, { recursive: true });

const taskQueue = urls
  .map((prodUrl) => {
    const migratedUrl = prodUrl.replace(
      env("PROD_WEBSITE_URL"),
      env("STAGE_WEBSITE_URL")
    );
    const prodImgPath = path.join(
      screenshotsProdDir,
      `prod_${getFileName(prodUrl)}.png`
    );
    const migratedImgPath = path.join(
      screenshotsMigratedDir,
      `migrated_${getFileName(migratedUrl)}.png`
    );

    if (fs.existsSync(prodImgPath) && fs.existsSync(migratedImgPath))
      return null;

    return { prodUrl, migratedUrl, prodImgPath, migratedImgPath, prodOnly, migratedOnly };
  })
  .filter(Boolean);

const numWorkers = process.env.PLAYWRIGHT_WORKERS ? parseInt(process.env.PLAYWRIGHT_WORKERS) : 4;
const results = [];

let activeWorkers = 0;
const workers = [];

for (let i = 0; i < numWorkers; i++) {
  spawnWorker(i);
}

function spawnWorker(id) {
  if (taskQueue.length === 0) return;

  const job = taskQueue.shift();
  const worker = fork("./scripts/screenshot-worker.mjs");
  activeWorkers++;
  workers.push(worker);

  console.log(`📸 Worker ${id} -> Prod: ${job.prodUrl}`);

  worker.send(job);

  worker.on("message", (result) => {
    results.push(result);
    console.log(result ? `✅ Worker ${id} success` : `🆘 Worker ${id} failed`);

    worker.kill("SIGTERM");
    activeWorkers--;

    if (taskQueue.length > 0) {
      spawnWorker(id); // Запустить следующий таск на этом же worker ID
    } else if (activeWorkers === 0) {
      console.log(`✅ All tasks done. ${results.length} processed.`);
    }
  });

  worker.on("error", (err) => {
    console.error(`❌ Worker ${id} error:`, err);
    worker.kill("SIGTERM");
    activeWorkers--;
    spawnWorker(id);
  });

  worker.on("exit", (code) => {
    if (code !== 0) {
      console.warn(`⚠️ Worker ${id} exited with code ${code}`);
    }
  });
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
