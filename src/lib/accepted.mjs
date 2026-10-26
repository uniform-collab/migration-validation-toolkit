/**
 * Accepted differences: element diffs a project has looked at and decided not to fix - a legacy
 * bug the migration corrects, data the export cannot give back - listed in a file next to the
 * frozen expected dataset, so they stop costing score without being hidden.
 *
 *   { "version": 1,
 *     "entries": [ { "page": "/en-gl/x", "key": "<componentKey>", "name": "<rendering>",
 *                    "prod": "<fingerprint>", "stage": "<fingerprint>", "reason": "..." } ] }
 *
 * An entry matches one element: same page, same componentKey, and the SAME text on both sides -
 * the fingerprints of the comparison-normalized prod and stage text. A matched element is scored
 * 100 and reported under "Accepted"; its raw score is kept. Change either side by one character
 * and the fingerprint no longer matches: the diff is scored again and the entry is reported as
 * stale. So an accepted diff cannot hide a regression, and the file only ever describes diffs
 * that are exactly what someone accepted.
 *
 * The file is the project's (its facts, its reasons); the mechanism is generic.
 */
import fs from "fs";
import crypto from "crypto";

/** Fingerprint of one side's comparison text: 16 hex chars of its sha1. */
export const fingerprint = (text) =>
  crypto.createHash("sha1").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);

const entryKey = (page, key) => `${String(page).toLowerCase()}|${key}`;

/** Loads an accepted-diffs file; an absent path gives an empty set. */
export function loadAccepted(file) {
  const empty = { file: null, entries: [], byKey: new Map(), used: new Set() };
  if (!file || file === true) return empty;
  if (!fs.existsSync(file)) {
    console.warn(`--accepted: ${file} does not exist - no accepted differences.`);
    return { ...empty, file };
  }
  const doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const byKey = new Map();
  for (const e of entries) {
    if (!e || !e.page || !e.key || !e.prod || !e.stage) continue;
    byKey.set(entryKey(e.page, e.key), e);
  }
  console.log(`--accepted: ${byKey.size} accepted difference(s) from ${file}.`);
  return { file, entries, byKey, used: new Set() };
}

/** The entry accepting this exact diff, or null. Marks it used. */
export function findAccepted(accepted, page, key, prodPrint, stagePrint) {
  const k = entryKey(page, key);
  const e = accepted.byKey.get(k);
  if (!e || e.prod !== prodPrint || e.stage !== stagePrint) return null;
  accepted.used.add(k);
  return e;
}

/** Entries that matched nothing this run: the diff changed or is gone. */
export function staleAccepted(accepted) {
  return [...accepted.byKey.entries()].filter(([k]) => !accepted.used.has(k)).map(([, e]) => e);
}
