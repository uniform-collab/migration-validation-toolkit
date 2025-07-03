import { fork } from "child_process";
import fs from "fs";
import { env } from "./utils.js";
import dotenv from "dotenv";
import { create } from "xmlbuilder2";
import path from "path";
dotenv.config();

const urls = JSON.parse(
  fs.readFileSync("./.temp/urls.json", { encoding: "utf8" })
);
const outputDir = "./.comparison_results";

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const numWorkers = 4;
const chunkSize = Math.ceil(urls.length / numWorkers);
const results = [];

for (let i = 0; i < numWorkers; i++) {
  const chunk = urls.slice(i * chunkSize, (i + 1) * chunkSize);
  for (let j = 0; j < chunk.length; ++j) {
    const prodUrl = chunk[j];
    const migratedUrl = prodUrl.replace(
      env("PROD_WEBSITE_URL"),
      env("STAGE_WEBSITE_URL")
    );

    const obj = { outputDir, prodUrl, migratedUrl };
    console.log(
      "💠 Diff the screenshot of " + obj.prodUrl + " with " + obj.migratedUrl
    );

    try {
      const worker = fork("./scripts/diff-worker.mjs");
      worker.send(obj);

      worker.on("exit", (code) => {
        if (code) {
          console.error(`🆘 Worker ${i} exited with code ${code}`);
        }
      });

      await new Promise((resolve, reject) => {
        worker.on("message", (result) => {
          results.push(result);
          worker.kill("SIGTERM");

          const mismatch =
            result?.mismatch != null ? ` (${result.mismatch.toFixed(2)}%)` : "";
          console.log(
            `🧩 Diff result: ${
              result?.match ? "✅ same" : "🆘 different"
            }${mismatch}`
          );

          if (results.length === urls.length) {
            generateHtmlReport(results);
            generateXmlReport(results);
            console.log(
              "✅ Processing complete. Results saved to " + outputDir
            );
          }

          resolve();
        });

        worker.on("error", (err) => {
          console.error(`🆘 Worker ${i} encountered an error:`, err);
          worker.kill("SIGTERM");
          reject();
        });
      });
    } catch (ex) {
      console.error(
        "🆘 Failed to diff " +
          obj.prodUrl +
          " with " +
          obj.migratedUrl +
          ", " +
          ex.message
      );
    }
  }
}

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
      <th>Mismatch %</th>
      <th>Tag</th>
      <th>Status</th>
    </tr>
    ${results
      .map(
        (result) => `
    <tr>
      <td>${result.url}</td>
      <td><img src='${result.prodImg}' /></td>
      <td><img src='${result.stageImg}' /></td>
      <td>${
        result.diffImg ? `<img src='${result.diffImg}' />` : "No Difference"
      }</td>
      <td>${
        result.footerDiffImg
          ? `<img src='${result.footerDiffImg}' />`
          : "No Difference"
      }</td>
      <td>${
        result.mismatch != null ? result.mismatch.toFixed(2) + "%" : "—"
      }</td>
      <td>${result.tag ?? "—"}</td>
      <td>${result.match ? "Match" : "Mismatch"}</td>
    </tr>`
      )
      .join("")}
  </table>
</body>
</html>`;

  fs.writeFileSync(path.join(outputDir, "report.html"), htmlContent);
}

function generateXmlReport(results) {
  const testSuite = {
    testsuite: {
      "@name": "Visual Regression",
      "@tests": results.length,
      "@failures": results.filter((r) => !r.match).length,
      testcase: results.map((result) => {
        const testCase = {
          "@name": `Compare: ${result.url}`,
          "@classname": "ScreenshotComparison",
          properties: {
            property: [
              { "@name": "mismatchTag", "@value": result.tag ?? "undefined" },
              {
                "@name": "mismatchPercentage",
                "@value": result.mismatch?.toFixed(2) ?? "NaN",
              },
            ],
          },
        };

        if (!result.match) {
          testCase.failure = {
            "@message": "Visual mismatch detected",
            "#": `Mismatch: ${result.mismatch?.toFixed(2) ?? "unknown"}%. ${
              result.log ?? ""
            }`.trim(),
          };

          if (result.diffImg) {
            const relativePath = path.relative(
              outputDir,
              path.join(outputDir, result.diffImg)
            );
            testCase["system-out"] = {
              "#": `<![CDATA[
                    [[ATTACHMENT|${relativePath}]]
                    ]]>`,
            };
          }
        }

        return testCase;
      }),
    },
  };

  const xml = create(testSuite).end({ prettyPrint: true });
  fs.writeFileSync(path.join(outputDir, "results.xml"), xml, {
    encoding: "utf8",
  });
}
