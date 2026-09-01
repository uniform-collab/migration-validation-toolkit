#!/usr/bin/env node
/**
 * migration-validate — CLI entrypoint for the migration validation toolkit.
 *
 *   migration-validate <command> [options]
 *
 * Commands are the toolkit's original standalone scripts, unchanged: each one
 * parses `process.argv.slice(2)` itself, so this dispatcher simply removes the
 * command word from argv and hands over. That keeps every flag exactly as the
 * scripts document it and leaves them runnable directly (`node src/compare.mjs`)
 * for debugging.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");

const COMMANDS = {
  capture: {
    module: "src/capture.mjs",
    summary: "Crawl a site and record per-component innerText and/or screenshots.",
  },
  compare: {
    module: "src/compare.mjs",
    summary: "Score an actual innerText dataset against the expected one; write report.md/.json.",
  },
  "compare-screenshots": {
    module: "src/compare-screenshots.mjs",
    summary: "Pixel-diff the captured component screenshots; write report-screenshots.md/.json.",
  },
  "report-viewer": {
    module: "src/report-viewer/server.mjs",
    summary: "Serve the interactive viewer that joins both reports with the datasets.",
  },
  "md-to-pdf": {
    module: "src/md-to-pdf.mjs",
    summary: "Render generated Markdown reports to PDF using the bundled Chromium.",
  },
};

function usage() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length), "install-browsers".length);
  const lines = Object.entries(COMMANDS).map(
    ([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`
  );
  console.log(`migration-validate ${pkg.version}
${pkg.description}

Usage: migration-validate <command> [options]

Commands:
${lines.join("\n")}
  ${"install-browsers".padEnd(width)}  Install the Playwright Chromium build the other commands need.

Run a command with --help for its own options, or read the README:
  ${path.join(PKG_ROOT, "README.md")}`);
}

/**
 * Install the browser binary. Resolved out of THIS package's dependency tree so
 * the version always matches the `playwright` the capture commands import — an
 * `npx playwright` in the caller's cwd could pick up a different one.
 */
function installBrowsers(argv) {
  const require = createRequire(pathToFileURL(path.join(PKG_ROOT, "package.json")));
  // `cli.js` sits in the package dir but is NOT in its `exports` map, so it cannot be
  // resolved by subpath. Resolve the package entry (which is exported) and join instead.
  let cli = null;
  for (const pkg of ["playwright", "playwright-core"]) {
    try {
      const candidate = path.join(path.dirname(require.resolve(pkg)), "cli.js");
      if (fs.existsSync(candidate)) {
        cli = candidate;
        break;
      }
    } catch {
      /* try the next package */
    }
  }
  if (!cli) {
    console.error("ERROR: could not resolve the Playwright CLI.");
    console.error(`Run 'npm install' in ${PKG_ROOT} first.`);
    return 1;
  }
  const targets = argv.length ? argv : ["chromium"];
  const r = spawnSync(process.execPath, [cli, "install", ...targets], {
    stdio: "inherit",
    cwd: PKG_ROOT,
  });
  return r.status ?? 1;
}

const [, , command, ...rest] = process.argv;

if (!command || command === "--help" || command === "-h" || command === "help") {
  usage();
  process.exit(command ? 0 : 1);
}

if (command === "--version" || command === "-v") {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

if (command === "install-browsers") {
  process.exit(installBrowsers(rest));
}

const entry = COMMANDS[command];
if (!entry) {
  console.error(`ERROR: unknown command '${command}'.`);
  console.error("");
  usage();
  process.exit(1);
}

// Drop the command word so the target script sees exactly the flags it documents.
process.argv.splice(2, 1);
await import(pathToFileURL(path.join(PKG_ROOT, entry.module)).href);
