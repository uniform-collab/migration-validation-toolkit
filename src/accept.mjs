#!/usr/bin/env node
/**
 * accept — add element diffs of a report to an accepted-differences file (lib/accepted.mjs).
 *
 *   migration-validate accept --report <report.json> --accepted <file> --reason "<why>"
 *       [--page <glob>] [--component <name|regex>] [--max-score <n>] [--dry-run]
 *
 *   --report     = a report.json written by `compare` (its diffs carry prodPrint/stagePrint)
 *   --accepted   = the file to add to; created when absent. An entry for the same page +
 *                  componentKey is replaced, so re-accepting after a change is one command.
 *   --reason     = required: why this difference is not fixed. It is what the report shows.
 *   --page       = page path glob (`*` = any run of characters), case-insensitive; default all
 *   --component  = rendering name, exact or /regex/; default all
 *   --max-score  = only diffs scoring at most this (raw score); default 99.99
 *   --dry-run    = list what would be added, write nothing
 *
 * Pick narrowly: every diff the filters match is accepted as it is today, whatever it is.
 */
import fs from "fs";
import path from "path";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const k = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[k] = true;
  else { args[k] = next; i++; }
}
if (args.help || !args.report || !args.accepted || !args.reason || args.reason === true) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  process.exit(args.help ? 0 : 1);
}

const globToRe = (g) =>
  new RegExp("^" + String(g).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
const pageRe = args.page && args.page !== true ? globToRe(args.page) : null;
let compTest = () => true;
if (args.component && args.component !== true) {
  const c = String(args.component);
  const m = c.match(/^\/(.*)\/([a-z]*)$/);
  const re = m ? new RegExp(m[1], m[2]) : null;
  compTest = (name) => (re ? re.test(name || "") : name === c);
}
const maxScore = args["max-score"] !== undefined ? Number(args["max-score"]) : 99.99;

const report = JSON.parse(fs.readFileSync(args.report, "utf8"));
const picked = [];
for (const p of report.pages || []) {
  if (pageRe && !pageRe.test(p.path)) continue;
  for (const e of p.elements || []) {
    const raw = e.rawScore ?? e.score;
    if (raw > maxScore || !e.prodPrint || !e.stagePrint) continue;
    if (!compTest(e.name)) continue;
    picked.push({ page: p.path, key: e.key, name: e.name, prod: e.prodPrint, stage: e.stagePrint, score: raw });
  }
}

const file = path.resolve(args.accepted);
const doc = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""))
  : { version: 1, entries: [] };
doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
const id = (e) => `${String(e.page).toLowerCase()}|${e.key}`;
const index = new Map(doc.entries.map((e, i) => [id(e), i]));
let added = 0, replaced = 0;
for (const p of picked) {
  const entry = { page: p.page, key: p.key, name: p.name, prod: p.prod, stage: p.stage, reason: args.reason };
  console.log(`${args["dry-run"] ? "would accept" : "accept"}  ${p.score.toFixed(1).padStart(5)}  ${p.page}  ${p.name}`);
  if (index.has(id(entry))) { doc.entries[index.get(id(entry))] = entry; replaced++; }
  else { index.set(id(entry), doc.entries.length); doc.entries.push(entry); added++; }
}
doc.entries.sort((a, b) => id(a).localeCompare(id(b)));
console.log(`${picked.length} diff(s) matched: ${added} new, ${replaced} replaced${args["dry-run"] ? " (dry run, nothing written)" : ` -> ${file}`}.`);
if (!args["dry-run"]) fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
