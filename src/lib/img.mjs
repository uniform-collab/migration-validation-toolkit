/**
 * Long-path-safe sharp I/O + raw-RGBA helpers, shared by the screenshot capture
 * and compare passes.
 *
 * WHY the buffer indirection: sharp is libvips behind a native binding, and on
 * Windows a native lib cannot open a path at or past MAX_PATH (260 chars) — it
 * fails with `Input file is missing: <the path that is plainly there>` even
 * though Node's own fs reads and writes it fine. Component screenshots nest
 * page slug + component key, so a handful of the longest article URLs cross that
 * line on every run and used to land in the visual report as `compare-error`
 * (13 of them in cha-413 — see the "compare-error is a harness fault" note in
 * compare-screenshots.mjs). Reading the bytes with fs and handing sharp a Buffer
 * — and encoding to a Buffer instead of `.toFile()` — makes path length stop
 * mattering.
 */
import fs from "fs";
import path from "path";

// Loaded lazily so importing this module never hard-requires sharp: capture.mjs
// pulls it in for every mode, but only the screenshot passes actually need it
// (content-only capture keeps working with sharp absent, as it always has).
let sharpMod = null;
async function sharpLib() {
  if (!sharpMod) sharpMod = (await import("sharp")).default;
  return sharpMod;
}

/** sharp instance for a file, immune to Windows MAX_PATH. */
export async function readImage(file) {
  const sharp = await sharpLib();
  return sharp(await fs.promises.readFile(file));
}

export async function imageMeta(file) {
  return await (await readImage(file)).metadata();
}

/** Decode to RGBA at the image's OWN size: { data, width, height }. */
export async function readRawRgba(file) {
  const { data, info } = await (await readImage(file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Encode a sharp instance to PNG and write it, immune to Windows MAX_PATH. */
export async function writePng(file, instance) {
  const buf = await instance.png().toBuffer();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, buf);
}

/** Raw RGBA buffer -> PNG on disk. */
export async function writeRawAsPng(file, data, width, height) {
  const sharp = await sharpLib();
  await writePng(file, sharp(data, { raw: { width, height, channels: 4 } }));
}
