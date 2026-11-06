import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractCaptureTargets, extractUnselected, componentKey, buildUrlToIndexMap, parseExcludedComponents, markExcludedComponents, markCarouselSlideComponents, slideKey } from "./index-json.mjs";

test("--carousel-slides marks the named renderings, case-insensitively, never an excluded one", () => {
  const targets = [
    { order: 0, name: "Images Carousel" },
    { order: 1, name: "Rich Text" },
    { order: 2, name: "projects gallery carousel" },
    { order: 3, name: "Images Carousel" },
  ];
  markExcludedComponents(targets, new Set([]));
  targets[3].excluded = true;
  markCarouselSlideComponents(targets, parseExcludedComponents("Images Carousel, Projects Gallery Carousel"));
  assert.deepEqual(targets.map((t) => Boolean(t.slides)), [true, false, true, false]);
});

test("--carousel-slides * marks every rendering; empty marks none", () => {
  const all = [{ order: 0, name: "A" }, { order: 1, name: "B" }];
  markCarouselSlideComponents(all, parseExcludedComponents("*"));
  assert.ok(all.every((t) => t.slides));
  const none = [{ order: 0, name: "A" }];
  markCarouselSlideComponents(none, parseExcludedComponents(""));
  assert.equal(none[0].slides, undefined);
});

test("slideKey pads the slide number and stays a legal folder name", () => {
  assert.equal(slideKey("images-carousel__1a2b3c4d", 3), "images-carousel__1a2b3c4d~slide-03");
  assert.equal(slideKey("k", 12), "k~slide-12");
  assert.doesNotMatch(slideKey("k", 1), /[<>:"/\\|?*]/);
});

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
test("two presentations for one URL: the production page's own item wins, whatever the file order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvt-twins-"));
  try {
    const pres = path.join(dir, "pres");
    const items = path.join(dir, "items");
    const kept = "dca6e5cc-0050-4171-896e-3b706718c02b";
    const twin = "d80da74b-dacd-4dac-8cf4-8e5631123da7";
    const page = (folder, id) => {
      fs.mkdirSync(path.join(pres, folder), { recursive: true });
      fs.writeFileSync(path.join(pres, folder, "index.json"), JSON.stringify({ ItemPath: `/sitecore/content/Home/${folder}`, ProductionItemID: kept, ID: id, Placeholders: [] }));
      fs.mkdirSync(path.join(items, id[0], id[1]), { recursive: true });
      fs.writeFileSync(path.join(items, id[0], id[1], `${id}.json`), JSON.stringify({ ItemID: id, Slug: "/en/projects/ntnu-campus-unification" }));
    };
    fs.writeFileSync(path.join(dir, "root.json"), "{}");
    fs.mkdirSync(pres, { recursive: true });
    fs.writeFileSync(path.join(pres, "index.json"), JSON.stringify({ ItemPath: "/sitecore/content/Home", ID: "00000000-0000-0000-0000-000000000001", Placeholders: [] }));
    // The twin's folder sorts first, so plain "first writer wins" would pick it.
    page("a-ntnu-campusutvikling-trondheim", twin);
    page("ntnu-campus-unification", kept);
    const { map, stats } = buildUrlToIndexMap(pres, null, items);
    const hit = [...map.entries()].find(([url]) => url.includes("ntnu-campus-unification"));
    assert.ok(hit, "the URL is mapped");
    assert.match(hit[1], /[\\/]ntnu-campus-unification[\\/]index\.json$/);
    assert.equal(stats.duplicates, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});