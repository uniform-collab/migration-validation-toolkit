// main.mjs
import { fork } from 'child_process';
import fs from 'fs';
import { env } from "./utils.js";
import dotenv from 'dotenv';
dotenv.config();

// List of URLs for production site
const urls = JSON.parse(fs.readFileSync('./.temp/urls.json', { encoding: 'utf8'}));

// Output directories
const outputDir = "./.comparison_results";

// check
if (!fs.existsSync(outputDir)) {
  throw new Error('🆘 outputDir does not exist, which means there are no screenshots to diff: ' + outputDir);
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
    const stageUrl = prodUrl.replace(env("PROD_WEBSITE_URL"), env("STAGE_WEBSITE_URL"));

    const obj = { outputDir: outputDir, prodUrl: prodUrl, stageUrl: stageUrl };
    
    console.log('💠 Diff the screenshot of ' + obj.prodUrl + ' with ' + obj.stageUrl);

    try {
      // Fork a new process for the worker
      const worker = fork('./scripts/diff-worker.mjs');
  
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
  
          console.log('🧩 Diff result: ' + (result?.match ? '✅ same' : '🆘 different' ));
  
          // If all workers are done, output the result
          if (results.length === urls.length) {
            generateHtmlReport(results);
  
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
    } catch (ex) {
      console.error('🆘 Failed to diff ' + obj.prodUrl + ' with ' + obj.stageUrl + ', ' + ex.message)
    }
  }
}


    // HTML Report generation
function generateHtmlReport(results) {
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Visual Comparison Report</title>
  <style>
      body { font-family: Arial, sans-serif; margin: 20px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
      th { background-color: #f2f2f2; }
      img { max-width: 300px; }
  </style>
</head>
<body>
  <h1>Visual Comparison Report</h1>
  <table>
      <tr>
          <th>URL</th>
          <th>Production</th>
          <th>Staging</th>
          <th>Difference</th>
          <th>Footer Difference</th>
          <th>Status</th>
      </tr>
      ${results.map(result => `
      <tr>
          <td>${result.url}</td>
          <td><img src='${result.prodImg}' /></td>
          <td><img src='${result.stageImg}' /></td>
          <td>${result.diffImg ? `<img src='${result.diffImg}' />` : 'No Difference'}</td>
          <td>${result.footerDiffImg ? `<img src='${result.footerDiffImg}' />` : 'No Difference'}</td>
          <td>${result.match ? 'Match' : 'Mismatch'}</td>
      </tr>`).join('')}
  </table>
</body>
</html>`;

  fs.writeFileSync(path.join(outputDir, "report.html"), htmlContent);
}