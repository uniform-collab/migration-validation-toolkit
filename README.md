# migration-validation-toolkit

End-to-end validation for a **content migration**: crawl the legacy site and the migrated
replacement, capture each page's content **per component** — innerText and/or element
screenshots — score the two datasets against each other, and report exactly which component on
which page diverged.

It exists because a migration pipeline can be entirely green and still render the wrong page.
Serialization validators, deploy and publish all gate on *structure*; none of them gate on what
the browser ends up showing. This is the gate that does.

```
legacy site  ──capture──▶  expected/   ┐
                                       ├──compare──▶  report.md/.json  ──▶  report-viewer
migrated site ─capture──▶  actual/     ┘
```

The toolkit is **host-project agnostic**: it takes directories and URLs as arguments and owns no
configuration of its own. A migration pipeline wires it up (see *Using it from a pipeline*).

---

## Install

```bash
cd D:\migration-validation-toolkit
npm install
npm link                       # puts `migration-validate` on PATH
migration-validate install-browsers   # Playwright Chromium (idempotent)
```

`npm link` is the same arrangement `uniform-transform` uses: one global link, and every consumer
just calls the bin. Nothing needs to vendor the code or its `node_modules`.

## Commands

```
migration-validate <command> [options]

  capture              Crawl a site; record per-component innerText and/or screenshots
  compare              Score actual vs expected innerText; write report.md/.json
  compare-screenshots  Pixel-diff the captured screenshots; write report-screenshots.md/.json
  report-viewer        Serve the interactive viewer over both reports + the datasets
  md-to-pdf            Render generated Markdown reports to PDF (bundled Chromium)
  install-browsers     Install the Playwright browser build the captures need
```

Each command is a standalone script under `src/`, so it is also runnable directly
(`node src/compare.mjs …`) when debugging.

### `capture`

One page visit per page: record the page's HTTP status and, per `--capture-mode`, the innerText of
each component **and/or** a screenshot of each component. Capturing both in a single navigation is
the point — `full` mode does not load every page twice.

```bash
# expected side (legacy), page list from a sitemap
migration-validate capture --base-url https://legacy.example.com \
  --sitemap https://legacy.example.com/sitemap.xml \
  --out ./expected-v2 --mode v2 --presentation-root <presentation>/en

# actual side (migrated), page list from the expected manifest
migration-validate capture --base-url https://stage.example.com \
  --paths ./expected-v2/manifest.json --stage \
  --out ./actual-v2 --mode v2 --presentation-root <presentation>/en
```

| flag | meaning |
|---|---|
| `--base-url <url>` | **required.** Site to crawl. |
| `--out <dir>` | Content dataset output. Required unless `--capture-mode screenshots`. |
| `--shots-out <dir>` | Screenshot output. Required when screenshots are requested. |
| `--sitemap <url>` | Page list from a sitemap. |
| `--pages-from-dir <dir>` / `--page-marker <file>` | Page list from a static mirror's `public/` tree — the files are the authority on what it can serve. |
| `--paths <manifest.json>` | Page list from an existing manifest — how the actual side is pinned to exactly the expected side's pages. |
| `--stage` | This is the migrated side (names shots `_migrated`, enables status-only parity probes). |
| `--capture-mode content\|screenshots\|full` | What to record. Default `content`. Screenshots are V2-only. |
| `--mode v1\|v2` | Component model. See *V2: selector-driven comparison*. |
| `--selector-map <file>` | V1 only: the hand-authored component map. |
| `--presentation-root <dir>` | V2: root of the per-page `index.json` presentation tree. |
| `--items-root <dir>` | V2: item export whose `Slug` supplies each page's real URL. **Strongly recommended** — see *Where a page URL comes from*. |
| `--item-root <path>` | V2: override the auto-detected tree root item path. |
| `--rebase <json>` | V2: `[{from,to}]` selector-prefix rewrites (legacy positional selectors). |
| `--body-only false` | V2: include header/footer/analytics instead of main content only. |
| `--exclude-components <names>` | V2: rendering names resolved and masked, but never compared. |
| `--include /a,/b` | Allowlist of paths the migrated frontend covers so far (exact or `*` glob). Empty = the whole page list. See *Scoping a partially-built frontend*. |
| `--concurrency <n>` | Parallel browser contexts. |
| `--limit <n>` | Smoke mode: first N pages only. |
| `--resume` | Skip pages already present in the output dataset. |
| `--only-failed` / `--prev-report <path>` | Re-capture only the pages that scored < 100 in the previous report. |
| `--timeout <ms>` / `--no-retry` | Navigation budget and retry behaviour. |
| `--min-height` / `--max-height` / `--remove-before` | Element thresholds and pre-capture removals. |
| `--bypass-secret <s>` | `x-vercel-protection-bypass` header for a protected deployment. |
| `--preview-secret <s>` / `--preview-authenticated` | Render access-gated pages via the frontend's preview escape hatch. |
| `--shot-idle-quiet` / `--shot-idle-max` / `--shot-component-idle-max` | Network-idle gate (ms; `0` disables). |
| `--shot-stable-poll` / `--shot-stable-max` | Layout-stability gate (ms; `0` disables). |
| `--shot-stitch 0` | Fall back to `elementHandle.screenshot()` instead of tile+stitch. |

> **Both sides must use identical gate values.** Different settling rules on the expected and
> actual captures make the two datasets incomparable — that is why the gates are inputs, not
> per-side defaults.

### `compare`

```bash
migration-validate compare --expected ./expected-v2 --actual ./actual-v2 \
  --report-dir ./tests --mode v2 [--fail-under 95] [--exclude /404,/search]
```

| flag | meaning |
|---|---|
| `--expected <dir>` / `--actual <dir>` | **required.** The two content datasets. |
| `--report-dir <dir>` | **required.** Where `report.md` / `report.json` (and, in V2, `report-components.md`/`.json`) are written. |
| `--mode v2` | Score V2 datasets (componentKey pairing) instead of V1 (DOM order). |
| `--fail-under <n>` | Exit 1 when the overall score is below N. Omit to report only. |
| `--exclude /a,/b` | Paths deliberately not migrated: listed, not scored. |
| `--include /a,/b` | Allowlist of paths the frontend covers so far: everything else is out of scope entirely. Empty = whole site. |
| `--missing-words <n>` | Component report: trim a one-sided component's text to N words (`0` = full, default 8). |
| `--only-failed` / `--prev-report <path>` | Score only the previously-failing subset. |

### `compare-screenshots`

```bash
migration-validate compare-screenshots --shots-dir <root> --report-dir ./tests \
  [--run <runId>] [--fail-under 95] [--strict] [--exclude /404]
```

`--include` scopes it the same way `compare` does. Pairs prod↔stage element screenshots by
`componentKey`, pixel-diffs each pair, writes
`report-screenshots.md`/`.json` and a diff PNG per differing component. **Advisory by default**
(exit 0 even below `--fail-under`) unless `--strict`.

`--run` selects which run under `<shots-dir>/runs/` to score; default is the run named by
`runs/latest.json`, with a root-level `migrated/` honoured as a pre-per-run fallback.

### `report-viewer`

```bash
migration-validate report-viewer --port 8099 --root <repo> \
  --report-dir <repo>/tests \
  --expected-dir <…>/expected-v2 --actual-dir <repo>/tests/actual-v2 \
  [--shots <dir>] [--run <runId>] [--open]
```

Read-only: it reads what a finished run already produced, so it is safe to start at any time. It
joins `report.json` + `report-screenshots.json` + `report-components.json` with the on-disk
datasets on `path` + `componentKey`, so one component instance shows its content score, its visual
score, both innerTexts (word-level diff, plus a mode highlighting the exact longest-common-substring
the score is computed from) and its prod/stage/diff screenshots (side-by-side, swipe, onion-skin,
heatmap) in one place. Its content-vs-visual scatter isolates the pages where **innerText matches
but pixels do not** — the CSS/layout class a content gate structurally cannot see.

`--expected-dir` / `--actual-dir` are the supported way to point it at the datasets. Full docs:
[`src/report-viewer/README.md`](src/report-viewer/README.md).

### `md-to-pdf`

```bash
migration-validate md-to-pdf report.md report-components.md [--out file.pdf] [--format A4]
```

Prints generated Markdown to PDF with the bundled Chromium — no extra dependency, fully offline.
The Markdown subset is exactly what the report generators emit (ATX headings, GFM tables, fenced
code, nested lists, blockquotes, rules, inline code/links/emphasis). Raw HTML is deliberately
**not** passed through: the reports quote source markup as content, so it is escaped and shown
literally.

---

## V2: selector-driven comparison

V1 partitions every page with one hand-authored `selector-map.json`. **V2** instead derives each
page's components from the migration's **per-page `index.json`**: it walks the presentation tree,
captures every rendering that has a `CssSelector`, and **masks descendant components** so a parent
is compared without the children captured separately. It is an **either/or** switch — a run is V1
*or* V2, never both — so the two never share datasets.

| | V1 | V2 |
|---|---|---|
| component source | `selector-map.json` (one map, all pages) | per-page `index.json` CssSelectors |
| pairing | DOM order (Needleman–Wunsch) | **stable componentKey** (order-independent; the report names the rendering) |
| dataset files | `<slug>/NN.txt` | `<slug>/<componentKey>.txt` + `<slug>/.components.json` |
| screenshots | not supported | supported |

### How a V2 target resolves to an element

A rendering's target is **three** fields from `index.json`, not just the selector:

```js
document.querySelectorAll(CssSelector)[CssSelectorIndex]   // then .parentElement × CssSelectorLevelsUp
```

- `CssSelector` is **page-scoped** — it is only guaranteed to identify the rendering *within its own
  page*. It is class- or id-anchored (`.component.plain-html`, `.hero__eyebrow`,
  `.article_detail.rte > div:nth-of-type(2)`) precisely so it survives the migration: a modern
  frontend that keeps the legacy class names holds a class anchor, where the old
  `body > div:nth-of-type(2) > main > div > …` path breaks on a single extra wrapper div.
- `CssSelectorIndex` (absent = 0) picks which match this instance is; a selector may match a few
  elements rather than being forced into a brittle positional path.
- `CssSelectorLevelsUp` (absent = 0) walks up from the match, for renderings whose own root element
  carries nothing identifiable but a descendant does (CSS has no parent combinator).

**Never resolve one with `querySelector`** — that silently ignores the index and captures the wrong
instance. Both in-page resolvers (`src/lib/extract-selectors.mjs` for content,
`src/lib/screenshot.mjs` for screenshots) inline the three-field form; the contract is documented in
`src/lib/index-json.mjs`.

`componentKey` is keyed on the rendering's **layout UID**, not its position in the target list, so
improving selector coverage does not renumber every component and unpair it from a frozen expected
dataset.

**Building the URL map does not parse the index.json files.** It needs only `ItemPath` and `ID` from
each, and how expensive that is depends entirely on the export: a presentation-only `index.json` is
a few KB, but an export that embeds each rendering's rendered `Html` runs to ~1.5 MB per page. At
4416 pages that is ~6.6 GB — so the two scalars are read out of a bounded head of each file, with a
full parse only as the fallback for an unrecognised key order. The renderings themselves are read
later, per page, and only for pages actually captured.

`--rebase` (`body > div:nth-of-type(2)` → `#wrapper`) is a leftover from when selectors were
absolute positional paths; it is a no-op for class-anchored selectors and is kept only for older
`index.json` trees.

### Where a page URL comes from

A page is only compared if its `index.json` can be found, and the lookup key is the page URL. That
URL is **taken from the source CMS, not derived**: every item under `--items-root` carries the
`Slug` the CMS itself resolved, and `index.json` carries that item's `ID`, so the two join exactly.

Two item-export **layouts** are supported, because a miss here is silent — the lookup just falls
back to slugifying, which drops pages without erroring:

```
sharded   <items-root>/<a>/<b>/<guid>.json     first two GUID characters
flat      <items-root>/{<guid>}.json           braces kept, one directory
```

Slugifying the item path instead (the fallback when `--items-root` is omitted) cannot reproduce the
CMS's URL rules and **silently drops pages** — an unfound URL is not an error, the page is simply
never scored. Two classes it got wrong on a real dataset: **item buckets**
(`…/Events/2027/04/05/<name>` publishes flat as `/education/events/<name>` while an equally-bucketed
`…/Newsroom/2022/06/<name>` keeps its date — no path rule covers both) and **double spaces** in item
names (Sitecore slugifies per character, `"A  B"` → `a--b`, where a `/\s+/` slugifier collapses the
run to one dash). Together that was 108 live pages never compared. The capture logs the split
(`URLs from item Slug: …, from ItemPath fallback: …`), so a regression shows up in the log.

### Excluding a component

`--exclude-components` does **not** simply skip a rendering: the target is still resolved and still
masked out of its ancestors, it just never becomes an element of its own. Dropping it outright would
leave the parent inheriting whatever the excluded child renders — one side's text against nothing —
so the diff would move up one level instead of going away.

Use it for what the migration deliberately does not reproduce (e.g. CMS-native form renderings with
no counterpart in the new frontend).

A page left with **no comparable component at all** (everything excluded or textless) is reported
under *No comparable components* and **left out of the score** — an empty element list weights to
100, and a page where nothing was compared must not claim perfect parity. Likewise, pages with **no
`index.json`** are listed under *No index.json* and left out of the score rather than scored 0.

### Scoping a partially-built frontend (`--include`)

`--exclude` and `--include` answer different questions and both are needed:

| | question it answers | empty means |
|---|---|---|
| `--exclude` | "the migration deliberately never produces this URL" | nothing excluded |
| `--include` | "the migrated frontend does not cover this page **yet**" | everything in scope |

A migration in progress is the normal case for the second one. A frontend rendering 1 of 4416
exported pages scores ~0% and buries every real diff under 4415 missing pages; listing the negative
space is not an option there, listing the positive space is. Pass the same list to `capture` and to
`compare` — on `capture` it filters the **page list**, so a partially-built frontend costs one page
to test rather than 4416.

The two are independent: a page must be included **and** not excluded. An allowlisted page that is
also excluded stays out — an exclusion states something about the *migration*, which outranks a
statement about frontend coverage.

---

## Element extraction (V1)

Driven by `--selector-map`:

- `scopeSelectors` — tried in order; the first `document.querySelector` hit is the capture root
  (e.g. `main #content`, then `main`) — i.e. everything between header and footer.
- `items` — `querySelectorAll` with a component selector list, or `directChildren` of the scope.
- `removeBeforeCapture` — nodes removed first (cookie banners and the like).
- Per-element filters, evaluated in-page: skip `position:fixed`, skip invisible
  (`display:none`/`visibility:hidden`), skip below `minHeight` (default 30px), skip elements whose
  normalized innerText is empty, and when `querySelectorAll` matches nested elements keep only the
  outermost.

> A **zero-height** container is not invisible. A wrapper whose children are all floated collapses
> to `808x0` while still rendering their text, so the visibility filter falls back to "has non-empty
> innerText" when the rect is zero. A zero rect is the right test for a *screenshot* (no pixels to
> grab — the screenshot path keeps its minimum) and the wrong one for *innerText*.

innerText is extracted from an off-screen **clone** with synthetic spaces inserted between adjacent
inline elements (`</span><span>`), so the extraction is non-destructive and stable across markup
that differs only in inline nesting. On that same clone every `<a href>` is rewritten to markdown
`[text](target)` so link targets are part of the compared text (plain innerText drops `href` and
hides link-only differences); same-origin targets are reduced to an origin-relative path so the two
hosts do not diff on every internal link, while cross-origin links keep their full URL.

During capture, images/media/fonts are network-blocked in `content` mode (text-only comparison, a
large speed win), the page is scrolled once end-to-end to trigger lazy loaders, and navigation waits
for `load` + the scope selector + a short settle. Page status is taken from a direct HTTP request
**without following redirects** — a 3xx counts as "not 200" and is reported as such.

---

## Scoring (content)

Per element pair — in V2 paired by `componentKey`, in V1 by order-preserving sequence alignment
(Needleman–Wunsch maximizing total score, gap = 0, so one missing/inserted element costs exactly one
gap instead of cascading a mismatch onto every later index):

```
score = 100 * LCS(prodText, stageText).length / max(prodText.length, stageText.length)
```

- Texts are whitespace-normalized first (`\s+` → single space, trimmed).
- **Media-asset URLs are masked** to `asset-links-are-hidden-in-e2e` on both sides
  (`src/lib/util.mjs`). The markdown link annotation puts `href` targets into the compared text, and
  the two sites address the *same* asset with structurally unrelated URLs — a CMS media path, a DAM
  CDN URL, a role-gated proxy path whose token varies per render — so those links could never match
  and were pure false negatives (~600 links on a real dataset; masking moved the overall score
  +8 points across 276 pages with 0 regressions). The link **text** is still scored, so a missing or
  renamed document still diffs. Unresolved asset **placeholders** are deliberately *not* masked:
  they mean the asset was never resolved to a real URL — a genuine migration defect that must keep
  showing as a diff. Masking happens at comparison time, not in the capture, so it applies to an
  already-frozen dataset with no re-capture and the datasets keep real URLs for debugging.
- LCS = longest common **substring**, via a suffix automaton (O(n+m)); the naive DP is O(n·m) and
  too slow for ~10k element pairs.
- Both sides empty → 100. An element present on one side only scores 0, tagged `missing-on-stage` /
  `extra-on-stage`.
- **Page score** = length-weighted mean of its element scores, each weighed by
  `max(prodLen, stageLen)` — so the page score tracks the fraction of its **text** that matches, not
  the fraction of its elements, and a long element that diverges costs more than a short one.
- **Status parity**: a page that is non-200 on the expected side must return the **same** status on
  the actual side. A mismatch (e.g. expected 404 → actual 200: a page that should not exist is being
  served) scores the page 0 and joins the overall mean; a matching status is reported, not scored.
- **Overall score** = mean of page scores across scored expected-200 pages plus any status-parity
  mismatches. `--exclude` paths are reported but not scored.

### Reports

`report.md` carries, in order: expected pages not returning 200 (with the actual status for the same
path, parity mismatch marked ❌); actual pages not returning 200; the overall score and a per-page
table worst-first; then every element scoring < 100 as a diff-focused excerpt (common prefix/suffix
trimmed with a few words of context, `(...)` marking elided text):

```
/about/board-of-trustees - component-00 - score 89

MISSION AND VALUES General Information As the national (...)
========   ⬆️⬆️⬆️ PROD ⬆️⬆️⬆️   ===//===   ⬇️⬇️⬇️ STAGE ⬇️⬇️⬇️   ========
General Information MISSION AND VALUES As the national (...)
```

`report.json` carries the same data machine-readable, including the 100s.

**Regression diff vs the previous report.** Under the overall score, the report diffs this run
against the last one. The previous `report.json` is found automatically in git history (the last
commit that changed `<report-dir>/report.json`, i.e. the prior run's compare commit) or read from
`--prev-report`. It reports page-score buckets (**100%**, **50–100%**, **0–50%**) as
`previous → current (Δ)` plus the overall move, **new diffs** (elements now < 100 that were 100 or
absent — regressions) and **gone diffs** (were < 100, now 100 or gone — fixes). An element diff is
keyed by `page + element`, i.e. "same slot on the same page". First-ever run prints a baseline note.

**Component-scoped report** (`report-components.md`/`.json`, V2 only — component names are
meaningless in V1) regroups the *same* scored data by rendering **name** instead of by page:

1. **Component average scores, worst first** — each component's mean score across the pages it
   appears on, plus **worst (0)** and **perfect (100)** counts out of N. `Promo Card | 93.4 | 12/465
   | 387/465 | 78` shows both ends of the distribution, so a component that is *slightly* off
   everywhere is distinguishable from one that is *absent* on a few pages.
2. **Differing pages by component** — for each component, only the pages scoring < 100, in the same
   `PROD … ===//=== … STAGE` block. A component present on only one side is trimmed to
   `--missing-words` words: no point printing the whole block for something simply absent.

It is derived in-memory from the page comparison — no extra capture.

> **A one-directional wall of zeros is a harness signal, not a content one.** If a component scores
> 0 on ~100% of its instances *and always in the same direction*, suspect the extractor before the
> migration: `prodLen=0` everywhere points at the capture filter, `stageLen=0` everywhere points at
> rendering or data.

---

## Screenshots

Screenshots reuse the V2 machinery wholesale — the same per-page `index.json` targets, the same
rebase, the same `componentKey` pairing — so a component's innerText and its screenshot are scored
against the same expected↔actual element pair.

| `--capture-mode` | capture (one visit) | compare with |
|---|---|---|
| `content` (default) | innerText only; images/fonts **blocked** (fast) | `compare` |
| `screenshots` | element screenshots only; images/fonts load | `compare-screenshots` |
| `full` | **both**, from the same navigation (no double page load) | both |

**Per page**: one `page.goto` → scroll to trigger lazy loads → **network-idle gate**. Content
extraction runs first (clone-based, non-destructive). Then, for screenshots: freeze animations →
remove overlay elements → resolve each target on the live DOM → per component, **mask descendant
components** with same-size placeholders, hide fixed/sticky elements and the header, scroll it into
view, **wait for its own fetch to settle**, wait for its `<img>`s, then capture. Components under
30px are skipped; shots taller than 9000px are cropped. Viewport is desktop 1280×720.

### The network-idle gate (reproducibility)

Playwright's `waitUntil: "networkidle"` covers **only the navigation**. Two later request waves are
otherwise unguarded, and shooting through either is pure run-to-run noise — the same component
photographs as a spinner on one side and as loaded content on the other:

1. the **lazy-load scroll** the capture performs, which arms every `IntersectionObserver`;
2. the **per-component `scrollIntoView`** before its shot, which arms that component's own fetch.

`attachNetworkQuiescer` (`src/lib/screenshot.mjs`) tracks in-flight **same-origin** requests for the
whole visit (third-party beacons never go quiet and would burn the budget on every component), and
the capture awaits a quiet window at both points. The page-level wait must come **before**
`freezeAnimations`, which stubs `setTimeout`/`setInterval`/`rAF` — a fetch resolving after that would
never commit to the DOM. The per-component wait is a no-op when nothing is in flight.

Defaults: quiet window 300 ms, page ceiling 8000 ms, per-component ceiling 3000 ms.

### The layout-stability gate

The idle gate waits for the **network**. A different failure survives it entirely, because the thing
that moves the page issues no request: a Suspense fallback collapsing, a font swapping, an image
finally decoding.

`elementHandle.screenshot()` offers **no layout-stability guarantee**. Playwright measures the
element (`boundingBox()`), reads `window.scrollY` in a *second* round-trip, adds them into a document
rect, and only then has Chromium rasterize it. A relayout anywhere in that sequence leaves the clip
pointing at stale coordinates and the shot comes back as the **correct picture translated by N px**:
N blank rows at one edge, N real rows lost at the other. Playwright waits for a stable position
before a *click* and for nothing at all before a *screenshot*.

Nothing downstream can tell this from a real rendering difference. On one real run it hit **311 of
439** shots of a single component (offsets 8–145 px); reproduced offline at 36 of 40 on a cold server
at concurrency 6, and 0 of 40 on the same pages once settled. The tell in an image: the top rows are
uniformly blank while the other side's shot starts on content, and the two heights differ by exactly
that many rows.

`waitForLayoutStable` samples the host's rect **in document coordinates** (`getBoundingClientRect` +
`scrollX/Y`, one round-trip, which also forces a layout flush) plus `document.scrollHeight`, and
shoots only once two consecutive samples agree. Immediately **after** the shot it re-reads the rect:
if the element moved through the raster, the PNG is deleted and the shot retried once. A second
failure is not published — the component goes into the page's `skipped` list with
`reason: "unstable-layout"`, which the compare scores as *not compared* and names separately.

Defaults: poll 50 ms, ceiling 2000 ms. The poll interval doubles as the settle wait, so on an
already-still page a shot costs one extra sleep and two round-trips.

### How a component is photographed (tile + stitch)

Shots are **not** taken with `elementHandle.screenshot()`. That call hands CDP the element's whole
box, so anything bigger than the viewport arrives as
`Page.captureScreenshot({captureBeyondViewport: true})` — and on that path Chromium relays the page
out at a degenerate viewport and back before rasterizing at coordinates measured beforehand. Verified
on Chromium 149: two `Page.frameResized` inside the capture, media queries flipping down to
`(max-height: 50px)` and `(max-width: 100px)` while `(min-height: 1900px)` never fires (the viewport
*shrinks*, it does not grow to the clip), and JS timers sampling `innerWidth`/`innerHeight` every 1 ms
observing none of it. Every confirmed translated shot sat on that path.

So `captureStitched` walks the element **a tile at a time**: scroll the tile to the viewport origin,
`page.screenshot({clip})` within the viewport, composite. Tiles rather than rows because an element
can also be wider than the viewport (448 shots in one run), and on a page that really scrolls
sideways those columns carry content. A viewport-sized clip reports `captureBeyondViewport: false`
and zero `frameResized`.

Two mechanics worth knowing before touching this:

- `page.screenshot({clip})` on the safe path is **capped at the viewport and measured from it** — ask
  for 3000 px in a 720 px viewport and 720 px come back, silently, taken from wherever the page is
  currently scrolled. Hence hand-cut tiles rather than one tall clip.
- Scroll is **read back**, never assumed: `scrollTo` clamps near document edges, so each tile's
  viewport position is derived from where the page actually landed. A tile that lands outside the
  viewport (a page with `overflow-x: hidden`) is skipped and its region stays white — which is what
  the element-shot path returned there too.

Output geometry is deliberately identical to the old path (`rect.w x rect.h`, off-canvas regions
white), verified byte-for-byte across fits / taller-than-viewport / pushed-down / wider-than-document
/ wide+tall / near-page-bottom. That is what lets the mechanism change without re-capturing a frozen
baseline. Cost is ~2× rasters at a 720 px viewport (12655 vs 6183 on one run's shot set; ~1.4× at a
1500 px viewport). `--shot-stitch 0` restores the old path.

### How it diffs

`pixelmatch` over `sharp`-decoded raw RGBA (both prebuilt — no native `canvas` build). Per-component
**score = 100 − mismatch%** (100 = identical); page score = **image-height-weighted mean** of its
components; overall = mean over scored pages — the same shape as the content report, so a screenshot
`--fail-under` reads like a content one. A diff PNG is written per differing component. A
redirect-parity mismatch scores the page 0.

**Size-tolerant intersection scoring.** The pair is diffed on the **intersection** minus a 2px
disputed trailing edge, and a size disagreement is classified before it is scored:

| size delta | treated as | scored |
|---|---|---|
| ≤ 2px (`SIZE_TOLERANCE_PX`) | layout rounding | overhang ignored; the trailing 2px strip of the shared region is not compared either |
| > 2px | content | the **non-blank** overhang is counted |

The old rule padded the shorter image to the union canvas with **opaque white** and diffed the whole
thing. That is wrong in both directions, and the second error is the serious one:

- *False findings.* When sizes disagree by a pixel, the shared region's last row is the element's own
  bottom border landing one row lower on one side — colour against background. The padding rule had
  no way to express "the edge moved"; it simply reported the row.
- *Hidden regressions.* White padding matches white content. A component rendering **779×652** on one
  side and **779×87** on the other scored a **perfect match**, because the missing 565 rows sat on a
  white background. Re-scoring one run surfaced **963 components** carrying a real difference the
  padding had hidden, and the overall score moved 96.44% → 96.11% — *down*, because the gate had been
  flattering itself.

Both constants are measured, not guessed (`src/lib/pixdiff.mjs`): on a 450-component sample, a 2px
tolerance silenced 40 tiny-mismatch components and pushed **zero** real differences (mismatch ≥ 5%)
below half their score; 1px silences 37 of the same 40 and 3px adds nothing, so the noise is
genuinely sub-pixel and the constant is not sitting on a slope. `src/lib/pixdiff.test.mjs` pins the
rule in both directions on synthetic images — including the white-background loss the old rule
scored 100.

A caveat worth keeping, because it is the trap this rule was written around: **"84% of the minor-diff
components differ in height by exactly one pixel" is true and is not the cause.** Those overhang rows
are blank 79% of the time, and white padding already matched blank rows, so the height delta was a
*correlate* of small diffs, not their source. Reading it as the cause produces a "count only
non-white overhang pixels" fix that measurably changes nothing.

In the diff PNG the compared region keeps the familiar red-on-faded look, everything not compared
(overhang and the disputed edge) is neutral grey, and overhang pixels that **did** count are
**orange** — so a diff image says at a glance which kind of problem it is.

**Not everything is scored.** Three outcomes are *not compared* — excluded from the score, the diff
list and the regression comparison, each with its own count and report section:

| tag | meaning |
|---|---|
| `skipped-in-migrated` / `skipped-in-prod` | the capture **resolved** the element on that side but declined to shoot it. `reason` says which: `zero-size` / `below-min-height` are thresholds (nothing worth photographing); `unstable-layout` means the page was still relaying out and the shot would have been the right picture at the wrong offset. Neither is a rendering difference. |
| `compare-error` | `sharp`/`pixelmatch` threw. **Always a harness fault**, never a content finding. |

A component absent from one side for any *other* reason still scores 0 as `missing-in-migrated` /
`extra-in-migrated`. Collapsing all three into "score 0" is what makes a report's zero-count mix real
content loss with harness gaps.

**Windows `MAX_PATH`.** Component screenshots nest page slug + component key, and the longest article
URLs push the PNG path past 260 chars. `sharp` is libvips behind a native binding and **cannot open
those by name** — it fails with `Input file is missing: <the path that is plainly there>` while
Node's own `fs` reads it fine (13 such pairs in one run). `src/lib/img.mjs` routes every sharp read
and write through `fs` buffers, so path length stops mattering.

### Screenshot storage layout

Screenshots are large binaries that must never enter git (unlike the small text datasets, which are
meant to be committed). `--shots-out` / `--shots-dir` point at one external root:

```
<shots root>/
  prod/                    <page_slug>/<componentKey>/<componentKey>_prod.png      (+ manifest.json, .components.json)
  runs/
    latest.json            { runId } — the last run that captured successfully
    <runId>/
      migrated/            <page_slug>/<componentKey>/<componentKey>_migrated.png  (+ manifest.json, .components.json)
      diff/                <page_slug>/<componentKey>/<componentKey>_diff.png
```

`prod/` stays at the root: it is the one-time baseline and belongs to no single run. The **actual**
side is kept **per run**, so a new run does not overwrite an older one's images — git versions
everything else (datasets, reports), and these PNGs live outside the repo, so the run directory is
their version history. `compare-screenshots` records the run it scored in `report-screenshots.json`,
and the viewer resolves PNGs through that field, so checking out an older run's report and reloading
the viewer shows that run's screenshots as long as its directory is still on disk.

---

## Dataset layout (content)

```
<expected dir>/            # captured once from the legacy site; commit this
  manifest.json            # { pages: { "/path": { status, elements, finalUrl? } } }
  sitemap.xml              # copy of the page list the dataset was built from
  <page_slug>/<key>.txt    # raw innerText per component (V1: NN.txt in DOM order)
  <page_slug>/.components.json   # V2: componentKey -> rendering name/uid

<actual dir>/              # rebuilt every run from the migrated site
  manifest.json
  <page_slug>/<key>.txt

<report dir>/
  report.md / report.json / report.pdf
  report-components.md / .json / .pdf    # V2 content only
  report-screenshots.md / .json / .pdf
```

`page_slug` preserves the URL path as nested folders (`/about/team` → `about/team/`), illegal
filename characters percent-encoded per segment; the root `/` is `index`.

**The dataset, not the source site, is the freeze.** Re-crawling the legacy side every run would
drift the score for reasons unrelated to the migration, so the expected dataset is captured once and
committed. A consequence worth stating in the host project's docs: content added or edited on the
legacy site after the migration's source export cannot be reproduced and scores as a diff. That is
baseline staleness, not a defect — only a fresh export cures it.

---

## Using it from a pipeline

The toolkit owns no configuration. A host pipeline supplies the URLs, directories and thresholds —
typically from its own `.env` — and calls the bin, exactly as it would call any other linked CLI.

```powershell
migration-validate install-browsers

$captureArgs = @('capture', '--base-url', $prodUrl, '--sitemap', $sitemapUrl,
                 '--out', $expectedDir, '--mode', 'v2', '--presentation-root', $presentationRoot)
migration-validate @captureArgs

migration-validate compare --expected $expectedDir --actual $actualDir --report-dir $reportDir --mode v2
```

A worked example — one stage per step, with the environment plumbing, the frontend build, per-run
screenshot storage and the report commits — is the `6-tests` folder of the CHA migration pipeline
(`D:\cha\src\6-tests\README.md`).

---

## Development

```bash
npm test                      # node --test over src/lib/**/*.test.mjs
node src/compare.mjs --help   # scripts run standalone, without the CLI wrapper
```

```
bin/cli.mjs                   # subcommand dispatcher (removes the command word from argv)
src/capture.mjs               # dataset capture — both sides use the same code path
src/compare.mjs               # content scoring + report
src/compare-screenshots.mjs   # pixel diff + report
src/md-to-pdf.mjs             # Markdown -> PDF via the bundled Chromium
src/lib/extract.mjs           # V1 in-page element collection + innerText extraction
src/lib/extract-selectors.mjs # V2 in-page component resolution + masking
src/lib/index-json.mjs        # index.json contract, URL join, componentKey assignment
src/lib/screenshot.mjs        # idle/stability gates, tile+stitch capture
src/lib/pixdiff.mjs           # size-tolerant intersection diff  (+ pixdiff.test.mjs)
src/lib/lcs.mjs               # longest common substring (suffix automaton, O(n+m))
src/lib/img.mjs               # sharp I/O through fs buffers (MAX_PATH)
src/lib/util.mjs              # slugs, normalization, diff excerpts, manifest I/O
src/report-viewer/            # the interactive viewer (own README)
```

Two invariants the whole toolkit rests on, worth re-reading before changing anything:

1. **Both sides must be captured under identical rules.** Every threshold, gate and filter that
   affects what gets captured changes the *dataset*, not just the score — change one and the frozen
   expected side has to be re-captured before the numbers mean anything again.
2. **`componentKey` must stay stable.** It is what pairs the two sides. Anything that renumbers or
   renames components unpairs the whole dataset.
