/**
 * Element-screenshot pixel diff. Extracted from compare-screenshots.mjs so the
 * scoring rule is unit-testable on synthetic images (lib/pixdiff.test.mjs) -
 * this is the one piece of the visual gate where a wrong rule quietly
 * manufactures thousands of findings, so it needs a proof that does not depend
 * on having a captured dataset on disk.
 */
import pixelmatch from "pixelmatch";
import { readRawRgba, writeRawAsPng } from "./img.mjs";

/* ---------- blank-pixel test ----------
 * A pixel counts as blank when it is white-ish or transparent, i.e. it is page
 * background rather than rendered content. Both element screenshots are taken
 * over the live page, so an element that is one row taller on one side pads with
 * exactly this.
 */
const BLANK_RGB_MIN = 250; // r,g,b at or above this read as background
const BLANK_ALPHA_MAX = 16; // alpha at or below this is fully transparent
/** Diff-PNG paint: neutral grey = never looked at, orange = one-sided content. */
const NOT_COMPARED_RGBA = Buffer.from([234, 234, 234, 255]);
const OVERHANG_RGB = [255, 140, 0];
/**
 * How much of a size disagreement counts as layout rounding rather than content.
 * 2px, chosen by measurement: on a 450-component cha-413 sample it silenced 40
 * tiny-mismatch components and pushed ZERO real differences (mismatch >= 5%) below
 * half their score. 1px silences 37 of the same 40, 3px adds nothing - so the
 * noise really is sub-pixel and the constant is not on a slope.
 */
const SIZE_TOLERANCE_PX = 2;

export function isBlank(buf, o) {
  if (buf[o + 3] <= BLANK_ALPHA_MAX) return true;
  return buf[o] >= BLANK_RGB_MIN && buf[o + 1] >= BLANK_RGB_MIN && buf[o + 2] >= BLANK_RGB_MIN;
}

/** Top-left w*h crop of a raw RGBA image, by row copy (no re-encode). */
function cropRaw(img, w, h) {
  if (img.width === w && img.height === h) return img.data;
  const out = Buffer.alloc(w * h * 4);
  const srcStride = img.width * 4;
  const dstStride = w * 4;
  for (let y = 0; y < h; y++) {
    const src = y * srcStride;
    img.data.copy(out, y * dstStride, src, src + dstStride);
  }
  return out;
}

/**
 * Count (and optionally paint) the pixels one side has OUTSIDE the compared
 * region, ignoring blank (white / transparent) ones.
 *
 * Only reached when the size delta EXCEEDS SIZE_TOLERANCE_PX, i.e. when one side
 * really is rendering something the other is not. It is what makes genuine
 * content loss visible: measured on cha-413, a 779x652 accordion that renders at
 * 779x87 on the stage scored a **perfect match** under the old rule, because the
 * shorter image was padded with opaque white and the missing content happened to
 * sit on a white background. 963 components carried a real difference the old
 * canvas-padding hid this way.
 */
function scoreOverhang(img, iw, ih, out, W, color) {
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    const inBand = y < ih;
    const rowBase = y * img.width;
    for (let x = inBand ? iw : 0; x < img.width; x++) {
      const o = (rowBase + x) * 4;
      if (isBlank(img.data, o)) continue;
      count++;
      if (out) {
        const d = (y * W + x) * 4;
        out[d] = color[0];
        out[d + 1] = color[1];
        out[d + 2] = color[2];
        out[d + 3] = 255;
      }
    }
  }
  return count;
}

/**
 * Pixel-diff two element screenshots. Returns
 * { mismatch, height, width, prodSize, migSize, diffWritten }.
 *
 * THE RULE: a disagreement about the element's SIZE of a pixel or two is layout
 * rounding, not a rendering difference. Two consequences, both bounded by
 * SIZE_TOLERANCE_PX:
 *
 *   1. an overhang band within tolerance is not compared at all;
 *   2. when the sizes differ, the trailing strip of the SHARED region is dropped
 *      too - that strip is the disputed edge itself, so a one-pixel shift lands
 *      the element's bottom border on background on one side and on colour on the
 *      other.
 *
 * Both were pure noise, and (2) is the one the old pad-to-union rule could not
 * express at all. Measured on cha-413 that noise sat on ~16% of the components
 * scoring a tiny non-zero mismatch, which is what kept pages off a clean 100%
 * while telling you nothing.
 *
 * A size delta LARGER than the tolerance is content, and is counted (see
 * scoreOverhang). The mismatch%% denominator stays the UNION area, so the number
 * still reads as "share of the component's footprint that differs" and stays
 * comparable with the content report's scale.
 */
export async function compareImages(prodPath, migPath, diffPath) {
  const p = await readRawRgba(prodPath);
  const m = await readRawRgba(migPath);
  const W = Math.max(p.width, m.width);
  const H = Math.max(p.height, m.height);
  const dw = Math.abs(p.width - m.width);
  const dh = Math.abs(p.height - m.height);

  // The compared region: the intersection, minus the disputed trailing edge.
  let iw = Math.min(p.width, m.width);
  let ih = Math.min(p.height, m.height);
  if (dh > 0) ih = Math.max(0, ih - SIZE_TOLERANCE_PX);
  if (dw > 0) iw = Math.max(0, iw - SIZE_TOLERANCE_PX);
  const sizeIsContent = dw > SIZE_TOLERANCE_PX || dh > SIZE_TOLERANCE_PX;

  let interDiff = null;
  let mismatched = 0;
  if (iw > 0 && ih > 0) {
    interDiff = Buffer.alloc(iw * ih * 4);
    mismatched += pixelmatch(cropRaw(p, iw, ih), cropRaw(m, iw, ih), interDiff, iw, ih, {
      threshold: 0.1,
      includeAA: false,
      alpha: 0.3,
      diffColor: [255, 0, 0],
    });
  }
  if (sizeIsContent) {
    mismatched += scoreOverhang(p, iw, ih, null, W, null);
    mismatched += scoreOverhang(m, iw, ih, null, W, null);
  }

  const mismatch = W && H ? (mismatched / (W * H)) * 100 : 0;
  let diffWritten = false;
  if (mismatch > 0) {
    // Only now is the union-sized canvas worth building - the identical majority
    // of pairs never allocates or paints it.
    const out = Buffer.alloc(W * H * 4);
    out.fill(NOT_COMPARED_RGBA); // neutral grey wherever the compare did not look
    if (interDiff) {
      const dstStride = W * 4;
      const srcStride = iw * 4;
      for (let y = 0; y < ih; y++) {
        const src = y * srcStride;
        interDiff.copy(out, y * dstStride, src, src + srcStride);
      }
    }
    if (sizeIsContent) {
      // Orange = content present on one side only, outside the region the other
      // side covers at all. Deliberately a different colour from the red
      // in-region mismatch, so a diff PNG says which kind of problem it is at a
      // glance; grey says "not compared".
      scoreOverhang(p, iw, ih, out, W, OVERHANG_RGB);
      scoreOverhang(m, iw, ih, out, W, OVERHANG_RGB);
    }
    await writeRawAsPng(diffPath, out, W, H);
    diffWritten = true;
  }
  return {
    mismatch,
    height: p.height || H,
    width: p.width || W,
    prodSize: { width: p.width, height: p.height },
    migSize: { width: m.width, height: m.height },
    diffWritten,
  };
}
