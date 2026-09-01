#!/usr/bin/env node
/**
 * Convert a generated Markdown report to PDF.
 *
 *   node src/utils/md-to-pdf.mjs <report.md> [more.md ...] [--out <file.pdf>]
 *                                [--playwright-dir <dir>] [--format A4] [--title "..."]
 *
 * Used by the report stages (3-transform has none; see 6-tests/6300, 6-tests/6400 and
 * 7-reports/7000) so every Markdown report also ships as a PDF next to it. Default
 * output path = the input path with its extension replaced by `.pdf`.
 *
 * Rendering is fully offline and dependency-free apart from Playwright's Chromium,
 * which this package installs (`migration-validate install-browsers`) - Chromium's
 * print-to-PDF is what turns the rendered HTML into the PDF.
 *
 * The Markdown subset covered is exactly what the report generators emit: ATX
 * headings, paragraphs, GFM tables, fenced code, nested bullet/ordered lists,
 * blockquotes, rules, and inline code/links/emphasis. Raw HTML is deliberately
 * NOT passed through - the reports quote source markup (`<style>`, `<iframe>`, ...)
 * as content, so it is escaped and shown literally instead of being rendered.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// ---------- args ----------

function parseArgs(argv) {
  const inputs = [];
  const opts = { format: "A4" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--playwright-dir") opts.playwrightDir = argv[++i];
    else if (a === "--format") opts.format = argv[++i];
    else if (a === "--title") opts.title = argv[++i];
    // Debug aid: keep the intermediate HTML next to the PDF instead of in the temp dir.
    else if (a === "--keep-html") opts.keepHtml = true;
    else if (a.startsWith("--")) fail(`Unknown option '${a}'.`);
    else inputs.push(a);
  }
  if (!inputs.length) fail("No input Markdown file given.");
  if (opts.out && inputs.length > 1) fail("--out can only be used with a single input file.");
  return { inputs, opts };
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  console.error("Usage: migration-validate md-to-pdf <report.md> [more.md ...] [--out <file.pdf>]");
  process.exit(1);
}

// ---------- markdown -> html ----------

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const expandTabs = (s) => s.replace(/\t/g, "    ");

/** Inline spans. Code spans are lifted out first so their contents stay literal. */
function inline(text) {
  let s = escapeHtml(text);
  const codes = [];
  s = s.replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, code) => {
    codes.push(code.replace(/^ (.*) $/, "$1"));
    return `\u0000C${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, '<img alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w\\])__([^_]+)__(?!\w)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|[^*\w\\])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w\\])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([\s\S]+?)~~/g, "<del>$1</del>");
  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

const RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^`]*)$/;
const RE_HEADING = /^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_HR = /^(\s{0,3})(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^(\s{0,3})>\s?(.*)$/;
const RE_TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlockStart = (line) =>
  line.trim() === "" ||
  RE_FENCE.test(line) ||
  RE_HEADING.test(line) ||
  RE_ITEM.test(line) ||
  RE_HR.test(line) ||
  RE_QUOTE.test(line) ||
  (line.trim().startsWith("|") && line.includes("|"));

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += s[i];
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function alignmentsOf(delimLine) {
  return splitRow(delimLine).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return null;
  });
}

/** Build a nested list tree out of the collected block, then render it. */
function renderList(block) {
  const first = RE_ITEM.exec(block[0]);
  const root = { ordered: !/^[-*+]$/.test(first[2]), items: [] };
  const stack = [{ indent: expandTabs(first[1]).length, list: root }];

  for (const raw of block) {
    const m = RE_ITEM.exec(raw);
    if (m) {
      const indent = expandTabs(m[1]).length;
      const ordered = !/^[-*+]$/.test(m[2]);
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
      let top = stack[stack.length - 1];
      if (indent > top.indent) {
        const list = { ordered, items: [] };
        const parent = top.list.items[top.list.items.length - 1];
        if (parent) parent.children.push(list);
        else top.list.items.push({ text: "", children: [list] });
        stack.push({ indent, list });
        top = stack[stack.length - 1];
      }
      top.list.items.push({ text: m[3], children: [] });
      continue;
    }
    // Lazy continuation of the item above.
    const text = raw.trim();
    if (!text) continue;
    const top = stack[stack.length - 1];
    const item = top.list.items[top.list.items.length - 1];
    if (item) item.text += ` ${text}`;
  }

  const renderOne = (list) => {
    const tag = list.ordered ? "ol" : "ul";
    const items = list.items
      .map((it) => `<li>${inline(it.text)}${it.children.map(renderOne).join("")}</li>`)
      .join("");
    return `<${tag}>${items}</${tag}>`;
  };
  return renderOne(root);
}

function renderMarkdown(src) {
  const lines = expandTabs(src.replace(/\r\n?/g, "\n")).split("\n");
  const out = [];
  let title = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const len = fence[2].length;
      const lang = fence[3].trim().split(/\s+/)[0] || "";
      const body = [];
      i++;
      while (i < lines.length) {
        const close = /^(\s{0,3})(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[2][0] === marker && close[2].length >= len) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      const level = heading[2].length;
      const text = inline(heading[3]);
      if (level === 1 && !title) title = heading[3];
      out.push(`<h${level}>${text}</h${level}>`);
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // GFM table: a pipe row followed by a delimiter row.
    if (line.trim().startsWith("|") && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = alignmentsOf(lines[i + 1]);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        body.push(splitRow(lines[i]));
        i++;
      }
      const cell = (tag, text, n) => {
        const a = align[n] ? ` style="text-align:${align[n]}"` : "";
        return `<${tag}${a}>${inline(text)}</${tag}>`;
      };
      const head = `<tr>${header.map((c, n) => cell("th", c, n)).join("")}</tr>`;
      const rows = body
        .map((r) => `<tr>${r.map((c, n) => cell("td", c, n)).join("")}</tr>`)
        .join("");
      out.push(`<table><thead>${head}</thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && (RE_QUOTE.test(lines[i]) || (body.length && lines[i].trim() !== ""))) {
        const m = RE_QUOTE.exec(lines[i]);
        body.push(m ? m[2] : lines[i]);
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n")).html}</blockquote>`);
      continue;
    }

    if (RE_ITEM.test(line)) {
      const block = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (RE_ITEM.test(cur)) {
          block.push(cur);
          i++;
          continue;
        }
        // An indented non-item line continues the previous item; a blank line only
        // stays inside the list when the list actually resumes after it.
        if (cur.trim() !== "" && /^\s/.test(cur) && !RE_FENCE.test(cur)) {
          block.push(cur);
          i++;
          continue;
        }
        if (cur.trim() === "" && i + 1 < lines.length && RE_ITEM.test(lines[i + 1])) {
          i++;
          continue;
        }
        break;
      }
      out.push(renderList(block));
      continue;
    }

    // Paragraph: run of lines until a blank line or the start of another block.
    const para = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join(" ").trim())}</p>`);
  }

  return { html: out.join("\n"), title };
}

const PAGE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 10.5pt/1.5 "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: #1b1f24;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 .5em; break-after: avoid; page-break-after: avoid; }
  h1 { font-size: 20pt; margin-top: 0; border-bottom: 2px solid #d8dee4; padding-bottom: .25em; }
  h2 { font-size: 15pt; border-bottom: 1px solid #e3e8ee; padding-bottom: .2em; }
  h3 { font-size: 12.5pt; }
  h4, h5, h6 { font-size: 11pt; }
  p { margin: .55em 0; }
  a { color: #0b5cad; text-decoration: none; word-break: break-word; }
  ul, ol { margin: .5em 0; padding-left: 1.6em; }
  li { margin: .18em 0; }
  li > ul, li > ol { margin: .18em 0; }
  hr { border: 0; border-top: 1px solid #d8dee4; margin: 1.4em 0; }
  blockquote { margin: .8em 0; padding: .1em 1em; border-left: 3px solid #d8dee4; color: #4a5259; }
  code {
    font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
    font-size: .88em;
    background: #f2f4f7;
    border-radius: 3px;
    padding: .1em .3em;
    word-break: break-word;
  }
  pre {
    background: #f6f8fa;
    border: 1px solid #e3e8ee;
    border-radius: 4px;
    padding: .6em .8em;
    margin: .7em 0;
    /* Report code blocks hold long single-line HTML - wrap, never clip. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  pre code { background: none; padding: 0; font-size: .82em; line-height: 1.45; }
  table {
    border-collapse: collapse;
    margin: .8em 0;
    width: 100%;
    font-size: .92em;
  }
  th, td { border: 1px solid #d8dee4; padding: .3em .5em; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #f2f4f7; font-weight: 600; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  thead { display: table-header-group; }
  tr, li { break-inside: avoid; page-break-inside: avoid; }
  img { max-width: 100%; }
`;

function buildHtml(markdown, titleOverride) {
  const { html, title } = renderMarkdown(markdown);
  const docTitle = titleOverride || title || "Report";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(docTitle)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
${html}
</body>
</html>`;
}

// ---------- chromium ----------

/**
 * Playwright lives in the 6-tests harness (installed by stage 6000), so resolve it
 * from there by default - the report stages must not need an npm install of their own.
 */
function loadPlaywright(explicitDir) {
  const candidates = [
    explicitDir,
    process.env.MD_TO_PDF_PLAYWRIGHT_DIR,
    // This package: playwright is a direct dependency, so this is the normal hit.
    path.resolve(scriptDir, ".."),
    process.cwd(),
    scriptDir,
  ].filter(Boolean);

  const tried = [];
  for (const dir of candidates) {
    const anchor = path.join(dir, "package.json");
    tried.push(dir);
    try {
      // require(), not import(): playwright is CommonJS, so a dynamic import would
      // hand back a namespace whose `chromium` may only live under `.default`.
      const require = createRequire(pathToFileURL(anchor));
      return require("playwright");
    } catch {
      /* try the next candidate */
    }
  }
  console.error("ERROR: could not resolve the 'playwright' package - it renders the PDF.");
  console.error(`Looked in: ${tried.join(", ")}`);
  console.error("Fix: run 'npm install' and 'npx playwright install chromium' in the toolkit checkout");
  console.error("(migration-validate install-browsers does the second), or pass --playwright-dir <dir>.");
  process.exit(1);
}

const footerTemplate = (name) => `
<div style="font:8pt 'Segoe UI',Arial,sans-serif;color:#6a737d;width:100%;padding:0 12mm;display:flex;justify-content:space-between;">
  <span>${escapeHtml(name)}</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;

async function main() {
  const { inputs, opts } = parseArgs(process.argv.slice(2));

  const jobs = inputs.map((input) => {
    const inPath = path.resolve(input);
    if (!fs.existsSync(inPath)) fail(`Input file not found: ${inPath}`);
    const outPath = opts.out
      ? path.resolve(opts.out)
      : path.join(path.dirname(inPath), `${path.basename(inPath, path.extname(inPath))}.pdf`);
    return { inPath, outPath };
  });

  const playwright = await loadPlaywright(opts.playwrightDir);
  const browser = await playwright.chromium.launch();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-to-pdf-"));
  try {
    for (const { inPath, outPath } of jobs) {
      const started = Date.now();
      const markdown = fs.readFileSync(inPath, "utf8");
      // Chromium loads the HTML from disk: setContent() on a multi-megabyte report
      // is far slower than a file:// navigation and can trip protocol size limits.
      const htmlDir = opts.keepHtml ? path.dirname(outPath) : tempDir;
      const htmlPath = path.join(htmlDir, `${path.basename(inPath, path.extname(inPath))}.html`);
      fs.mkdirSync(htmlDir, { recursive: true });
      fs.writeFileSync(htmlPath, buildHtml(markdown, opts.title), "utf8");

      const page = await browser.newPage();
      try {
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 0 });
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        await page.pdf({
          path: outPath,
          format: opts.format,
          printBackground: true,
          margin: { top: "14mm", bottom: "16mm", left: "12mm", right: "12mm" },
          displayHeaderFooter: true,
          headerTemplate: "<div></div>",
          footerTemplate: footerTemplate(path.basename(inPath)),
        });
      } finally {
        await page.close();
      }

      const mb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`PDF: ${outPath} (${mb} MB, ${secs}s)`);
    }
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`ERROR: PDF conversion failed - ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
