import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText, ASSET_LINK_PLACEHOLDER } from "./util.mjs";

const P = ASSET_LINK_PLACEHOLDER;
const link = (target) => `[Download the flyer](${target})`;
const masked = `[Download the flyer](${P})`;

/**
 * Media-asset URL masking. The two sides address the SAME file with structurally
 * unrelated URLs, so an unmasked target is a guaranteed false negative — and for
 * the local-edge form it is worse than that: its port is random per run, so the
 * link would not even match ITSELF between two stage captures.
 */
test("masks the uniform-local-edge media proxy (random port, asset host in the PATH)", () => {
  assert.equal(
    normalizeText(link("http://127.0.0.1:60990/media/img.uniform.global/E7C748FF1D00F7FB.jpg")),
    masked
  );
  assert.equal(
    normalizeText(link("http://127.0.0.1:55632/media/files.uniform.global/p/KVeGtFeb/x-compare.pdf")),
    masked
  );
  // Same route on a named host / another port — the port must not matter.
  assert.equal(normalizeText(link("http://localhost:3000/media/files.uniform.global/p/a-b.pdf")), masked);
});

test("masks Uniform asset hosts directly, files. as well as img.", () => {
  assert.equal(normalizeText(link("https://canary-img.uniform.global/p/abc-x.jpg")), masked);
  // `files.` is the common host (documents); matching only `img.` left every PDF unmasked.
  assert.equal(normalizeText(link("https://canary-files.uniform.global/p/abc-x.pdf")), masked);
  assert.equal(normalizeText(link("https://files.uniform.global/p/abc-x.pdf")), masked);
  // protocol-relative
  assert.equal(normalizeText(link("//img.uniform.global/p/abc-x.jpg")), masked);
});

test("masks Sitecore media paths and the role-gated proxy", () => {
  assert.equal(normalizeText(link("/-/media/files/analytics/compare.pdf")), masked);
  assert.equal(normalizeText(link("/-/jssmedia/images/x.jpg")), masked);
  assert.equal(normalizeText(link("https://www.childrenshospitals.org/-/media/files/x.pdf")), masked);
  assert.equal(normalizeText(link("/_protected-media/per-render-token/id-x.pdf")), masked);
});

test("does NOT mask an unresolved /uniform_asset/ placeholder", () => {
  // Those mean the asset was never resolved to a real URL — a genuine migration
  // defect that must keep showing up as a diff.
  const raw = link("/uniform_asset/2f0689cc-1234-4000-9000-abcdefabcdef");
  assert.equal(normalizeText(raw), raw);
});

test("does NOT mask non-asset URLs", () => {
  for (const url of [
    "https://www.childrenshospitals.org/news/some-article",
    "mailto:psosupport@childpso.org",
    "tel:(913) 981-4130",
    "/about-cha/about/careers",
    // a /media/ route that is not the local-edge asset proxy
    "https://example.org/media/press-kit.pdf",
    // uniform.global, but not an asset host
    "https://docs.uniform.global/docs/guides",
  ]) {
    const raw = link(url);
    assert.equal(normalizeText(raw), raw, url);
  }
});

test("masks the target but keeps the link TEXT scored", () => {
  // A renamed or missing document must still diff; only the target is dropped.
  assert.equal(
    normalizeText("[2025 impact report](https://files.uniform.global/p/a-2025-impact-report.pdf)"),
    `[2025 impact report](${P})`
  );
  assert.notEqual(
    normalizeText("[2025 impact report](/-/media/x.pdf)"),
    normalizeText("[2024 impact report](/-/media/x.pdf)")
  );
});

test("masks every occurrence in one string, and collapses whitespace", () => {
  assert.equal(
    normalizeText(`  [a](/-/media/1.pdf)\n\n[b](http://127.0.0.1:1/media/files.uniform.global/2.pdf)  `),
    `[a](${P}) [b](${P})`
  );
});
