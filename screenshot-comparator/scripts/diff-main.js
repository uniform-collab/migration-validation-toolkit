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

function generateXmlReport(results) {
  const testSuite = {
    testsuite: {
      "@name": "Visual Regression",
      "@tests": results.length,
      "@failures": results.filter((r) => r.components?.some(c => !c.match)).length,
      testcase: results.map((result) => {
        const mismatchOverall = result.mismatch?.toFixed(2) ?? "NaN";
        const tag = result.tag ?? "unclassified";
        const hasFailure = result.components?.some(c => !c.match);

        const attachments = result.components
          .flatMap(component => {
            const out = [];
            if (component.prodImg)
              out.push({ label: `${component.component} PROD`, path: component.prodImg });
            if (component.stageImg)
              out.push({ label: `${component.component} STAGE`, path: component.stageImg });
            if (component.diffImg)
              out.push({ label: `${component.component} DIFF`, path: component.diffImg });
            return out;
          });

        const attachmentBlock = attachments
          .map(item => `[[ATTACHMENT|${path.relative(outputDir, path.join(outputDir, item.path))}]]`)
          .join('\n');

        const tableText = result.components
          .map(c => {
            return `• ${c.component}: ${c.mismatch != null ? c.mismatch.toFixed(2) + "%" : "N/A"} ${c.tag ? `[${c.tag}]` : ""}`;
          })
          .join('\n');

        const testCase = {
          "@name": `[${tag}]: ${result.url}`,
          "@classname": `${tag}`,
          properties: {
            property: [
              { "@name": "mismatchTag", "@value": result.tag ?? "undefined" },
              { "@name": "mismatchPercentage", "@value": mismatchOverall },
            ],
          },
        };

        if (hasFailure) {
          testCase.failure = {
            "@message": `Visual mismatch detected for ${result.url}`,
            "#": `Overall mismatch: ${mismatchOverall}%. See details below.`,
          };
        }

        if (attachmentBlock || tableText) {
          testCase["system-out"] = {
            "#": `<![CDATA[\n${tableText}\n\n${attachmentBlock}\n]]>`,
          };
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
