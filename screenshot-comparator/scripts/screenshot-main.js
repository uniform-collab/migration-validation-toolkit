// main.mjs
import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import { env } from "./utils.js";
import dotenv from 'dotenv';
dotenv.config();

const illegalCharsRegex = /[<>:"\/\\|?*\0]/g;

// List of URLs for production site
const urls = JSON.parse(fs.readFileSync('./.temp/urls.json', { encoding: 'utf8'}));

// Output directories
const outputDir = "./.comparison_results";
if(!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const screenshotsProdDir = path.join(outputDir, "prod");
if (!fs.existsSync(screenshotsProdDir)) {
  fs.mkdirSync(screenshotsProdDir, { recursive: true });
}

const screenshotsMigratedDir = path.join(outputDir, "migrated");
if (!fs.existsSync(screenshotsMigratedDir)) {
  fs.mkdirSync(screenshotsMigratedDir, { recursive: true });
}

// Number of worker processes
const numWorkers = 4;
const chunkSize = Math.ceil(urls.length / numWorkers);
const results = [];

for (let i = 0; i < numWorkers; i++) {
  // Create a subset of the strings for each worker
  const chunk = urls.slice(i * chunkSize, (i + 1) * chunkSize);
  for (let j = 0; j < chunk.length; ++j) 
  {
    const prodUrl = chunk[j];
    const migratedUrl = prodUrl.replace(env("PROD_WEBSITE_URL"), env("STAGE_WEBSITE_URL"));

    const prodImgPath = path.join(screenshotsProdDir, `prod_${getFileName(prodUrl ?? throwError('prodUrl'))}.png`);
    const migratedImgPath = path.join(screenshotsMigratedDir, `migrated_${getFileName(migratedUrl ?? throwError('migratedUrl'))}.png`);

    if (fs.existsSync(prodImgPath) && fs.existsSync(migratedImgPath)){
      continue;
    }

    const obj = { prodUrl, migratedUrl, prodImgPath, migratedImgPath };
    
    // Fork a new process for the worker
    const worker = fork('./scripts/screenshot-worker.mjs');

    console.log('📸 Make screenshots Prod: ' + obj.prodUrl + ' and Stage:' + obj.migratedUrl);

    // Send the chunk to the worker
    worker.send(obj);    

    // Handle worker exit
    worker.on('exit', (code) => {
      if (code) {
        console.error(`🆘 Worker ${i} exited with code ${code}`);
      }
    });

    await new Promise((resolve, reject) => {
      // Receive processed data from the worker
      worker.on('message', (result) => {
        results.push(result);
        worker.kill('SIGTERM');
        if (result) {          
          console.log('✅  Success!');
        } else {
          console.log('🆘  Fail :(');
        }

        // If all workers are done, output the result
        if (results.length === urls.length) {
          console.log('✅ Processing complete:', results);        
        }
        
        resolve();
      });

      // Handle worker errors
      worker.on('error', (err) => {
        console.error(`🆘 Worker ${i} encountered an error:`, err);
        worker.kill('SIGTERM');
        reject();
      });
    })
  }
}

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

    const filename = encodeURLToFilename(url);
    return filename || 'index';
}

function throwError(msg) { throw new Error(msg)}