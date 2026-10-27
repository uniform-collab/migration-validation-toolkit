import test from "node:test";
import assert from "node:assert/strict";

import { extractCaptureTargets } from "./index-json.mjs";

const r = (Name, ID, extra = {}, children = []) => ({
  Name,
  ID,
  ...extra,
  Placeholders: children.length ? [{ Key: "ph", Renderings: children }] : [],
});

test("a scoped selector names the enclosing rendering's target, counting renderings without a selector", () => {
  const page = {
    Placeholders: [
      {
        Key: "main",
        Renderings: [
          r("Section", "s", { CssSelector: ".section" }, [
            // no selector: still one level of CssSelectorScopeUp
            r("Column", "c", {}, [
              r("Teaser", "t", {
                CssSelector: ".teaser",
                CssSelectorIndex: 5,
                CssSelectorScopeUp: 2,
                CssSelectorScopeIndex: 1,
              }),
            ]),
          ]),
        ],
      },
    ],
  };
  const [section, teaser] = extractCaptureTargets(page);
  assert.equal(teaser.scopeOrder, section.order);
  assert.equal(teaser.scopeIndex, 1);
  assert.equal(teaser.index, 5);
  assert.equal(teaser.matchCount, 0);
  assert.equal(section.scopeOrder, null);
});

test("a scope that points at a rendering without a selector is dropped", () => {
  const page = {
    Placeholders: [
      {
        Key: "main",
        Renderings: [
          r("Column", "c", {}, [r("Teaser", "t", { CssSelector: ".teaser", CssSelectorScopeUp: 1 })]),
        ],
      },
    ],
  };
  const [teaser] = extractCaptureTargets(page);
  assert.equal(teaser.scopeOrder, null);
});
