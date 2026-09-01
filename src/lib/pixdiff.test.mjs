/**
 * Proof for the intersection/overhang scoring rule (node --test lib/pixdiff.test.mjs).
 *
 * The rule this pins down, in both directions:
 *   - a size disagreement WITHIN tolerance is layout rounding, and neither the
 *     overhang nor the disputed trailing edge is compared;
 *   - a size disagreement BEYOND tolerance is content, and the non-blank part of
 *     it is counted. The old pad-to-union rule could not see this at all: it
 *     padded the shorter image with opaque white, so content missing over a white
 *     background scored a perfect match (cha-413 had a 779x652 accordion
 *     rendering at 779x87 and scoring 100).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { compareImages } from "./pixdiff.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixdiff-"));
const BLACK = [0, 0, 0];

/** White w*h PNG, optionally with filled boxes drawn on it. */
async function png(name, w, h, boxes = []) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) buf.set([255, 255, 255, 255], i);
  for (const [x0, y0, x1, y1, c = BLACK] of boxes) {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) buf.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  }
  const file = path.join(dir, `${name}.png`);
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file);
  return file;
}

const diffFile = (n) => path.join(dir, `${n}_diff.png`);

test("identical images score a perfect 0", async () => {
  const a = await png("id-a", 200, 100, [[10, 10, 60, 40]]);
  const b = await png("id-b", 200, 100, [[10, 10, 60, 40]]);
  const r = await compareImages(a, b, diffFile("id"));
  assert.equal(r.mismatch, 0);
  assert.equal(r.diffWritten, false);
});

test("one pixel of extra height is not a diff (the noise class)", async () => {
  const a = await png("h-a", 200, 100, [[10, 10, 60, 40]]);
  const b = await png("h-b", 200, 101, [[10, 10, 60, 40]]); // same content, 1px taller
  const r = await compareImages(a, b, diffFile("h"));
  assert.equal(r.mismatch, 0, "a within-tolerance overhang row must not be scored");
  assert.deepEqual(r.prodSize, { width: 200, height: 100 });
  assert.deepEqual(r.migSize, { width: 200, height: 101 });
});

test("a COLOURED one-pixel overhang is still not a diff", async () => {
  // The real shape on this dataset: element backgrounds are rarely white, so a
  // blankness test alone would have counted the whole rounding row.
  const a = await png("hc-a", 200, 100, [[0, 0, 200, 100, [40, 20, 90]]]);
  const b = await png("hc-b", 200, 101, [[0, 0, 200, 101, [40, 20, 90]]]);
  assert.equal((await compareImages(a, b, diffFile("hc"))).mismatch, 0);
});

test("the disputed trailing edge is not compared when the sizes disagree", async () => {
  // A 1px-taller element puts its bottom border one row lower, so the shared
  // region's last row is border-on-one-side / background-on-the-other. That is
  // the edge moving, not content changing.
  const a = await png("e-a", 200, 100, [[0, 98, 200, 100, [245, 94, 32]]]);
  const b = await png("e-b", 200, 101, [[0, 99, 200, 101, [245, 94, 32]]]);
  assert.equal((await compareImages(a, b, diffFile("e"))).mismatch, 0);
});

test("extra width within tolerance is not a diff either", async () => {
  const a = await png("w-a", 200, 100, [[10, 10, 60, 40]]);
  const b = await png("w-b", 202, 100, [[10, 10, 60, 40]]);
  assert.equal((await compareImages(a, b, diffFile("w"))).mismatch, 0);
});

test("real content in a beyond-tolerance overhang IS counted", async () => {
  const a = await png("c-a", 200, 100, [[10, 10, 60, 40]]);
  // 20 extra rows, of which a 50x10 block is actual content the other side lacks.
  const b = await png("c-b", 200, 120, [[10, 10, 60, 40], [0, 105, 50, 115]]);
  const r = await compareImages(b, a, diffFile("c"));
  const expected = (500 / (200 * 120)) * 100;
  assert.ok(Math.abs(r.mismatch - expected) < 0.01, `${r.mismatch} vs ${expected}`);
  assert.equal(r.diffWritten, true);
});

test("content missing over a WHITE background is caught (old rule scored it 100)", async () => {
  // cha-413's accordion class: prod renders a tall block, stage renders a stub.
  // The old pad-to-union rule filled the gap with opaque white and matched it.
  const tall = await png("k-a", 200, 400, [[0, 0, 200, 400, [30, 30, 30]]]);
  const stub = await png("k-b", 200, 40, [[0, 0, 200, 40, [30, 30, 30]]]);
  const r = await compareImages(tall, stub, diffFile("k"));
  // Compared region is 200x38 (40 shared rows, less the 2px disputed edge); every
  // row outside it on either side is dark, so 362 + 2 rows of 200 px are counted.
  const expected = ((362 + 2) * 200 / (200 * 400)) * 100;
  assert.ok(Math.abs(r.mismatch - expected) < 0.01, `${r.mismatch} vs ${expected}`);
  assert.ok(r.mismatch > 85, "a stub rendering of a tall block must read as a major loss");
});

test("a mismatch inside the shared region is still counted, over the UNION area", async () => {
  const a = await png("m-a", 100, 100, []);
  const b = await png("m-b", 100, 100, [[0, 0, 10, 10]]); // 100 black pixels
  const r = await compareImages(a, b, diffFile("m"));
  assert.ok(Math.abs(r.mismatch - 1) < 0.01, `${r.mismatch}`);
});

test("disjoint sizes with no shared pixels still score their content", async () => {
  const a = await png("d-a", 10, 10, [[0, 0, 10, 10]]);
  const b = await png("d-b", 10, 10, []);
  const r = await compareImages(a, b, diffFile("d"));
  assert.equal(r.mismatch, 100);
});
