import { fork } from "child_process";
import fs from "fs";
import { env } from "./utils.js";
import dotenv from "dotenv";
import { create } from "xmlbuilder2";
import path from "path";
dotenv.config();

const useSitemap = process.argv.includes("--sitemap");
const urlsFilePath = useSitemap? "./.temp/urls-sitemap.json" : "./.temp/urls.json";
console.log(`Using URLs from: ${urlsFilePath}`);
const urls = JSON.parse(fs.readFileSync(urlsFilePath, "utf8"));

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
    const relativeUrl = chunk[j];

    const prodUrl = new URL(relativeUrl, env("PROD_WEBSITE_URL")).toString();
    const migratedUrl = new URL(relativeUrl, env("STAGE_WEBSITE_URL")).toString();

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
          const isSame = result?.match === true || result?.mismatch === 0;

          console.log(
            `🧩 Diff result: ${isSame ? "✅ same" : "🆘 different"}${mismatch}`
          );

          if (results.length === urls.length) {
            generateXmlReport(results);
            writeMediaUrlsReport(results);
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

function isHeaderName(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('header');
}

function isFooterName(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('footer');
}

function writeJUnit(filePath, testsuiteObj) {
  const xml = create(testsuiteObj).end({ prettyPrint: true });
  fs.writeFileSync(filePath, xml, { encoding: 'utf8' });
}

function tagRank(tag) {
  switch ((tag || '').toLowerCase()) {
    case 'critical-diff': return 5;
    case 'major-diff':    return 4;
    case 'medium-diff':   return 3;
    case 'minor-diff':    return 2;
    case 'perfect-match': return 1;
    default:              return 0; // 'not compared' or unknown
  }
}

function pickWorstTag(tags) {
  let worst = null, worstRank = -1;
  for (const t of tags) {
    const r = tagRank(t);
    if (r > worstRank) { worst = t; worstRank = r; }
  }
  return worst ?? 'not compared';
}

function makeComponentTestCase(result, comp, outputDir) {
  const mismatchStr = comp.mismatch != null ? comp.mismatch.toFixed(2) : 'NaN';
  const tag = comp.tag ?? result.tag ?? 'unclassified';

  const attaches = [];
  if (comp.prodImg)  attaches.push(path.relative(outputDir, path.join(outputDir, comp.prodImg)));
  if (comp.stageImg) attaches.push(path.relative(outputDir, path.join(outputDir, comp.stageImg)));
  if (comp.diffImg)  attaches.push(path.relative(outputDir, path.join(outputDir, comp.diffImg)));

  const sysout = [
    `• ${comp.component}: ${comp.mismatch != null ? comp.mismatch.toFixed(2) + '%' : 'N/A'} ${comp.tag ? '[' + comp.tag + ']' : ''}`,
    '',
    ...attaches.map(p => `[[ATTACHMENT|${p}]]`),
  ].join('\n');

  const tc = {
    '@name': `[${tag}]: ${result.url} :: ${comp.component}`,
    '@classname': tag,
    properties: {
      property: [
        { '@name': 'url', '@value': result.url },
        { '@name': 'component', '@value': comp.component },
        { '@name': 'mismatchPercentage', '@value': mismatchStr },
      ],
    },
    'system-out': { '#': `<![CDATA[\n${sysout}\n]]>` },
  };

  const failing = comp.match === false || (typeof comp.mismatch === 'number' && comp.mismatch > 0);
  if (failing) {
    tc.failure = {
      '@message': `Visual mismatch in ${comp.component} for ${result.url}`,
      '#': `Component mismatch: ${mismatchStr}%.`,
    };
  }

  return tc;
}

function generateXmlReport(results) {
  const outputDir = "./.comparison_results";

  const overallCases = [];

  for (const r of results) {
    if (!r?.components?.length) continue;

    const bodyComps = r.components.filter(c => !isHeaderName(c.component) && !isFooterName(c.component));
    const bodyDiffs = bodyComps.filter(c => c.match === false || (typeof c.mismatch === 'number' && c.mismatch > 0));

    if (bodyDiffs.length === 0) continue;

    const tableText = bodyComps
      .map(c => `• ${c.component}: ${c.mismatch != null ? c.mismatch.toFixed(2) + '%' : 'N/A'} ${c.tag ? '[' + c.tag + ']' : ''}`)
      .join('\n');

    const attachments = bodyComps.flatMap(c => {
      const out = [];
      if (c.prodImg)  out.push({ path: c.prodImg });
      if (c.stageImg) out.push({ path: c.stageImg });
      if (c.diffImg)  out.push({ path: c.diffImg });
      return out;
    });

    const bodyTag = pickWorstTag(bodyComps.map(c => c.tag));

    const attachmentBlock = attachments
      .map(a => `[[ATTACHMENT|${path.relative(outputDir, path.join(outputDir, a.path))}]]`)
      .join('\n');

    const tc = {
      '@name': `[${bodyTag}]: ${r.url}`,
      '@classname': bodyTag,
      properties: {
        property: [
          { '@name': 'mismatchTag', '@value': r.tag ?? 'undefined' },
          { '@name': 'mismatchPercentage', '@value': 'N/A' },
        ],
      },
      failure: {
        '@message': `Visual mismatch (excluding header/footer) for ${r.url}`,
        '#': `Body components have differences. See details below.`,
      },
      'system-out': { '#': `<![CDATA[\n${tableText}\n\n${attachmentBlock}\n]]>` },
    };

    overallCases.push(tc);
  }

  const overallSuite = {
    testsuite: {
      '@name': 'Visual Regression (without header/footer)',
      '@tests': overallCases.length,
      '@failures': overallCases.length,
      testcase: overallCases,
    },
  };

  writeJUnit(path.join(outputDir, 'results.xml'), overallSuite);

  const headerCases = [];
  for (const r of results) {
    if (!r?.components?.length) continue;
    for (const c of r.components) {
      if (isHeaderName(c.component)) {
        headerCases.push(makeComponentTestCase(r, c, outputDir));
      }
    }
  }
  const headerSuite = {
    testsuite: {
      '@name': 'Visual Regression — Headers',
      '@tests': headerCases.length,
      '@failures': headerCases.filter(tc => !!tc.failure).length,
      testcase: headerCases,
    },
  };
  writeJUnit(path.join(outputDir, 'results_header.xml'), headerSuite);

  const footerCases = [];
  for (const r of results) {
    if (!r?.components?.length) continue;
    for (const c of r.components) {
      if (isFooterName(c.component)) {
        footerCases.push(makeComponentTestCase(r, c, outputDir));
      }
    }
  }
  const footerSuite = {
    testsuite: {
      '@name': 'Visual Regression — Footers',
      '@tests': footerCases.length,
      '@failures': footerCases.filter(tc => !!tc.failure).length,
      testcase: footerCases,
    },
  };
  writeJUnit(path.join(outputDir, 'results_footer.xml'), footerSuite);

  console.log('📝 Wrote:',
    path.join(outputDir, 'results.xml'),
    path.join(outputDir, 'results_header.xml'),
    path.join(outputDir, 'results_footer.xml'),
  );
}

function encodeURLToFilename(url) {
  const illegalCharsRegex = /[<>:"\/\\|?*\0]/g;
  return url.replace(illegalCharsRegex, ch => `%${ch.charCodeAt(0).toString(16)}`);
}

function getFileName(url) {
  url = url.replace(env("STAGE_WEBSITE_URL"), "");
  url = url.replace(env("PROD_WEBSITE_URL"), "");
  url = url.startsWith("/") ? url.substring(1) : url;
  const filename = encodeURLToFilename(url);
  return filename || "index";
}

// https://img.uniform.global/.../<assetId>-<filename.ext> → <filename.ext>
function mediaFilenameFromUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    let last = u.pathname.split("/").filter(Boolean).pop() || "";
    last = decodeURIComponent(last);

    if (host === "img.uniform.global" || host.endsWith(".uniform.global")) {
      const i = last.indexOf("-");
      if (i > 0 && i < last.length - 1) {
        const candidate = last.slice(i + 1);
        if (candidate.includes(".")) return candidate.toLowerCase();
      }
    }
    return last.toLowerCase();
  } catch {
    return null;
  }
}

function collectMediaNamesFromBlocked(folderAbs) {
  const file = path.join(folderAbs, "blocked-urls.txt");
  if (!fs.existsSync(file)) return { names: [], existed: false };

  const lines = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const set = new Set();
  for (const line of lines) {
    const name = mediaFilenameFromUrl(line);
    if (name) set.add(name);
  }
  return { names: Array.from(set).sort(), existed: true };
}

function arrDiff(a, b) {
  const B = new Set(b);
  return a.filter(x => !B.has(x));
}

function compareBlockedMediaForSubdir(outputDir, subdir, urlForLog) {
  const prodFolderAbs = path.join(outputDir, "prod", subdir);
  const migFolderAbs  = path.join(outputDir, "migrated", subdir);

  const prodInfo = collectMediaNamesFromBlocked(prodFolderAbs);
  const migInfo  = collectMediaNamesFromBlocked(migFolderAbs);

  const missingInMigrated = arrDiff(prodInfo.names, migInfo.names);
  const extraInMigrated   = arrDiff(migInfo.names, prodInfo.names);

  const union = new Set([...prodInfo.names, ...migInfo.names]);
  const diffCount = missingInMigrated.length + extraInMigrated.length;
  const mismatchPct = union.size ? (diffCount / union.size) * 100 : 0;

  const isEqual = diffCount === 0;

  const logLines = [];
  logLines.push(`URL: ${urlForLog}`);
  if (!prodInfo.existed)     logLines.push("prod/blocked-urls.txt: not found");
  if (!migInfo.existed)      logLines.push("migrated/blocked-urls.txt: not found");
  if (isEqual) {
    logLines.push(`Media filenames match (${prodInfo.names.length})`);
  } else {
    logLines.push(
      `Media filenames differ`,
      `  Missing in migrated (${missingInMigrated.length}): ${missingInMigrated.join(", ") || "-"}`,
      `  Extra in migrated (${extraInMigrated.length}): ${extraInMigrated.join(", ") || "-"}`
    );
  }

  return {
    url: urlForLog,
    component: "__blocked_media_urls__",
    match: isEqual,
    mismatch: mismatchPct,
    tag: isEqual ? "perfect-match" : "minor-diff", 
    log: logLines.join("\n"),
  };
}

function makeMediaTestCase(comp) {
  const mismatchStr = comp.mismatch != null ? comp.mismatch.toFixed(2) : 'NaN';
  const tc = {
    '@name': `[${comp.tag}]: ${comp.url} :: ${comp.component}`,
    '@classname': comp.tag,
    properties: {
      property: [
        { '@name': 'url', '@value': comp.url },
        { '@name': 'component', '@value': comp.component },
        { '@name': 'mismatchPercentage', '@value': mismatchStr },
      ],
    },
    'system-out': { '#': `<![CDATA[\n• ${comp.component}: ${mismatchStr}% [${comp.tag}]\n\n${comp.log}\n]]>` },
  };

  if (!comp.match || (typeof comp.mismatch === 'number' && comp.mismatch > 0)) {
    tc.failure = {
      '@message': `Blocked media filenames mismatch for ${comp.url}`,
      '#': `Mismatch: ${mismatchStr}%`,
    };
  }
  return tc;
}

function writeMediaUrlsReport(results) {
  const cases = [];
  for (const r of results) {
    if (!r?.url) continue;
    const subdir = getFileName(r.url);
    const comp = compareBlockedMediaForSubdir(outputDir, subdir, r.url);
    cases.push(makeMediaTestCase(comp));
  }
  const suite = {
    testsuite: {
      '@name': 'Blocked Media URLs',
      '@tests': cases.length,
      '@failures': cases.filter(tc => !!tc.failure).length,
      testcase: cases,
    },
  };
  writeJUnit(path.join(outputDir, 'results_media_urls.xml'), suite);
  console.log('📝 Wrote:', path.join(outputDir, 'results_media_urls.xml'));
}
