import test from "node:test";
import assert from "node:assert/strict";

import { extractCaptureTargets, extractUnselected, componentKey } from "./index-json.mjs";

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

test("extractUnselected lists the renderings with no selector, keyed like a capture target", () => {
  const page = {
    Placeholders: [
      {
        Key: "main",
        Renderings: [
          r("Section", "530be6e6-ac75-406f-b6f0-c782175746e5", { CssSelector: ".m-b-0" }, [
            r("Person Teaser", "3e0618a8-41a8-4c5a-9de0-df607d3391f2", { CssSelector: ".contact-card" }),
            r("Person Teaser", "64cf89ea-fd8b-4014-9d12-b6434ad4b72b", { LocatedBy: "absent" }),
            r("Divider", "", {}),
          ]),
        ],
      },
    ],
  };
  const located = extractCaptureTargets(page).map((t) => componentKey(t));
  assert.deepEqual(extractUnselected(page), [
    { key: "person-teaser__64cf89ea", name: "Person Teaser", locatedBy: "absent" },
  ]);
  assert.ok(!located.includes("person-teaser__64cf89ea"));
  assert.ok(located.includes("person-teaser__3e0618a8"));
});