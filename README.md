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
  accept               Add diffs of a compare report to an accepted-differences file
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
  --out ./expected-v2 --presentation-root <presentation>/en

# actual side (migrated), page list from the expected manifest
migration-validate capture --base-url https://stage.example.com \
  --paths ./expected-v2/manifest.json --stage \
  --out ./actual-v2 --presentation-root <presentation>/en
```

| flag | meaning |
|---|---|
| `--base-url <url>` | **required.** Site to crawl. |
| `--out <dir>` | Content dataset output. Required unless `--capture-mode screenshots`. |
| `--shots-out <dir>` | Screenshot output. Required when screenshots are requested. |
| `--sitemap <url>` | Page list from a sitemap. |
| `--pages-from-selectors` | Page list from the selector index — the URLs it resolved from each item's `Slug`. **Prefer this over `--pages-from-dir` whenever the site's URLs are not its item names.** See *Page list from the selector index*. |
| `--pages-from-dir <dir>` / `--page-marker <file\|*.ext>` | Page list from a static mirror's tree — the files are the authority on what it can serve. See *Page list from a static mirror*. |
| `--page-rewrite "<from>=><to>,…"` | Prefix rewrites applied to a **derived** page list (mirror or sitemap), for when the two sides spell a path differently. See *Page list from a static mirror*. |
| `--paths <manifest.json>` | Page list from an existing manifest — how the actual side is pinned to exactly the expected side's pages. |
| `--stage` | This is the migrated side (names shots `_migrated`, enables status-only parity probes). |
| `--capture-mode content\|screenshots\|full` | What to record. Default `content`. |
| `--presentation-root <dir>` | **required.** Root of the per-page `index.json` presentation tree — the component model. |
| `--items-root <dir>` | Item export whose `Slug` supplies each page's real URL. **Strongly recommended** — see *Where a page URL comes from*. |
| `--item-root <path>` | Override the auto-detected tree root item path. |
| `--rebase <json>` | `[{from,to}]` selector-prefix rewrites (legacy positional selectors). |
| `--body-only false` | Include header/footer/analytics instead of main content only. |
| `--exclude-components <names>` | Rendering names resolved and masked, but never compared. |
| `--include /a,/b` | Allowlist of paths the migrated frontend covers so far (exact or `*` glob). Empty = the whole page list. See *Scoping a partially-built frontend*. |
| `--concurrency <n>\|auto` | Parallel browser contexts. `auto` sizes the pool while the run is in flight — see *Auto concurrency*. |
| `--concurrency-max <n>` / `--autotune-interval <s>` | Upper bound for `auto` (default: the host's CPUs, or its **free** memory at ~600 MB a worker, whichever is lower) and the shortest measurement window (default 15). |
| `--concurrency-start <n>` | Where `auto` starts (default 4, clamped to `--concurrency-max`). A short capture ends before the slow-start climbs far; start higher on a host known to hold it. |
| `--limit <n>` | Smoke mode: first N pages only. |
| `--resume` | Skip pages already present in the output dataset. |
| `--merge-manifest` | Keep the pages an earlier capture into the same output dir listed in `manifest.json`, instead of rewriting it with only this capture's pages. With `--resume`, lets several page scopes (a sample and a full scope) share one dataset. |
| `--only-failed` / `--prev-report <path>` | Re-capture only the pages that scored < 100 in the previous report. |
| `--timeout <ms>` / `--no-retry` | Navigation budget and retry behaviour. |
| `--min-height` / `--max-height` / `--remove-before` | Element thresholds and pre-capture removals. |
| `--bypass-secret <s>` | `x-vercel-protection-bypass` header for a protected deployment. |
| `--preview-secret <s>` / `--preview-authenticated` | Render access-gated pages via the frontend's preview escape hatch. |
| `--shot-idle-quiet` / `--shot-idle-max` / `--shot-component-idle-max` | Network-idle gate (ms; `0` disables). |
| `--shot-stable-poll` / `--shot-stable-max` | Layout-stability gate (ms; `0` disables). |
| `--shot-settle-quiet` / `--shot-settle-max` | Page-settled gate, once per page before the shots: web fonts, images still loading, then the page height unchanged for the quiet time (ms; defaults 500 / 5000; `--shot-settle-max 0` disables). A page whose budget ran out carries `pageSettle` in its marker. |
| `--shot-stitch 0` | Fall back to `elementHandle.screenshot()` instead of tile+stitch. |
| `--full-page-shot false` / `--full-page-max-height <px>` / `--full-page-quality <1-100>` | The per-page full-page JPEG (on by default whenever shots are; clipped at 16000 px, quality 70). Never scored — see [Full-page shot](#full-page-shot-not-scored). |

> **Both sides must use identical gate values.** Different settling rules on the expected and
> actual captures make the two datasets incomparable — that is why the gates are inputs, not
> per-side defaults.

### `compare`

```bash
migration-validate compare --expected ./expected-v2 --actual ./actual-v2 \
  --report-dir ./tests [--fail-under 95] [--exclude /404,/search]
```

| flag | meaning |
|---|---|
| `--expected <dir>` / `--actual <dir>` | **required.** The two content datasets. |
| `--report-dir <dir>` | **required.** Where `report.md` / `report.json` (and, in V2, `report-components.md`/`.json`) are written. |
| `--fail-under <n>` | Exit 1 when the overall score is below N. Omit to report only. |
| `--exclude /a,/b` | Paths deliberately not migrated: listed, not scored. |
| `--include /a,/b` | Allowlist of paths the frontend covers so far: everything else is out of scope entirely. Empty = whole site. |
| `--link-target-rewrite "<pattern>=><replacement>,…"` | Regex rewrites applied to the **target** of every link annotation, on both sides. See *Rewriting link targets*. |
| `--exclude-components <names>` | Rendering names left out of the score, on both sides. The capture-time flag of the same name, one layer later — see *Excluding a component*. |
| `--accepted <file>` | Accepted differences: listed diffs score 100 and are reported apart, while both sides stay exactly as accepted. See *Accepted differences*. |
| `--missing-words <n>` | Component report: trim a one-sided component's text to N words (`0` = full, default 8). |
| `--only-failed` / `--prev-report <path>` | Score only the previously-failing subset. |

### `compare-screenshots`

```bash
migration-validate compare-screenshots --shots-dir <root> --report-dir ./tests \
  [--run <runId>] [--fail-under 95] [--strict] [--exclude /404]
```

`--include` and `--exclude-components` scope it the same way `compare` does, so the content and
visual reports of one run describe the same set of components. Pairs prod↔stage element screenshots by
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

## The component model

A page is not compared as one blob of text: it is partitioned into the **renderings** the migration
knows about. That partition comes from the migration's **per-page `index.json`** — the capture walks
the presentation tree, captures every rendering that has a `CssSelector`, and **masks descendant
components** so a parent is compared without the children captured separately.

That gives each component a **stable `componentKey`**, which is what pairs the two sides: pairing is
order-independent, and the report names the rendering rather than a positional index. On disk a page
is `<slug>/<componentKey>.txt` plus a `<slug>/.components.json` listing the order and names.

### How a target resolves to an element

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
- `CssSelectorScopeUp` / `CssSelectorScopeIndex` (optional) count the same instance inside an
  enclosing rendering (`ScopeUp` renderings up the tree) instead of across the page. When that
  rendering resolved, the target is `scope.querySelectorAll(CssSelector)[CssSelectorScopeIndex]`, so a
  wrapper the migrated page adds or drops elsewhere no longer shifts a page-wide ordinal onto a
  neighbour. Without them, or when the scope did not resolve, the page-wide index applies.

**Never resolve one with `querySelector`** — that silently ignores the index and captures the wrong
instance. Both in-page resolvers (`src/lib/extract-selectors.mjs` for content,
`src/lib/screenshot.mjs` for screenshots) inline this form; the contract is documented in
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

### Page list from the selector index

`--pages-from-selectors` takes the list from the selector index itself: the URLs it already resolved
from each item's **`Slug`**, which is Sitecore's own answer to "what is this page's URL". It needs
`--presentation-root` and `--items-root`, both of which the V2 selector mode wants anyway.

**Prefer it to `--pages-from-dir` whenever a site's URLs are not simply its item names.** A
presentation dump writes one directory per *item*, so `--pages-from-dir` names each page after the
item; a site running Sitecore's `useDisplayName` link provider serves the *display name* instead.
The two agree only while the item name happens to match — in practice, while it is in the site's
primary language.

Where they disagree, the folder-derived URL exists on **neither** side, and the failure is silent
rather than loud: the expected side resolves 0 selector targets (the index is keyed by Slug, so
nothing matches) and the stage returns 404, so the page is captured, counted, and scores nothing.
On one real dataset that was **113 of 780 project pages** — items such as
`2025-ruimte-voor-de-rivier-2-0`, whose Slug is `/en-gl/projects/2025-room-for-the-river-2-0`, and
`adr-e-wsp-la-strategia-…`, whose Slug is `/en-gl/projects/aeroporti-di-roma`. The report said
"780 pages captured, 666 scored" and nothing explained the difference.

Index keys are lowercased for lookup, so `--page-rewrite` is still what spells the locale the way
the stage serves it.

### Page list from a static mirror

`--pages-from-dir` takes the page list off disk instead of a sitemap, because the FILES are the
authority on what a mirror can actually serve (one real dataset: 1,782 pages on disk against 601
`<loc>` entries, 80 of which had no page file at all). Two mirroring tools produce two layouts, and
`--page-marker` picks which:

| marker | layout | produced by |
|---|---|---|
| `prod.html` (any file name) | one file per directory, the directory named after the URL: `public/<path>/prod.html` → `/<path>` | a hand-built mirror app (`D:\cha-prod-mirror`) |
| `*.html` (a `*.ext` marker) | `<path>.html` → `/<path>`, and `<dir>/index.html` → `/<dir>` | **httrack** (`D:\wsp\prod-mirror`) |

Only the extension is read out of a `*.ext` marker — it is not a general glob. Directories named
`-` (Sitecore's `/-/media` asset tree) and anything starting with `_` (`_next`, `_assets`) are
skipped in both modes: thousands of files, no pages.

`--page-rewrite "<from>=><to>,…"` then fixes up a list whose paths the two sides spell differently.
The case that motivated it: WSP's legacy URLs are lowercased by a Sitecore link provider, so the
mirror's tree is `en-gl/`, while the migrated frontend routes on the Uniform locale and publishes
`/en-GL/...`. One page list has to address both, so the locale segment is rewritten to the stage's
spelling (`/en-gl=>/en-GL`) and the mirror is served case-insensitively. Rules are comma-separated
(comma, not `|`, because on Windows the CLI is reached through a `.cmd` shim where `|` is a pipe),
prefix-only, first match wins, and they apply to a **derived** list — `--pages-from-dir` or
`--sitemap` — never to `--paths`, which is already the canonical list the expected side recorded.
The rules are recorded in the `pages.json` snapshot next to the dataset.

A mirror can also lie about status: a crawler follows strings that only look like links, and a CMS
answers those with its own 404 *page* and a 200 *status*, so the mirror serves a page that the live
site never had. That is the serving side's problem, not this tool's — `D:\wsp\pipeline\utils\prod-mirror-server.mjs`
restores the 404 by matching the page title — but it is worth knowing when a page list is suspiciously
large.

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

**Once an expected dataset is frozen, use `compare --exclude-components` instead.** The capture flag
works on the dataset, so both sides have to be captured with the same value; adding a name to it
against a frozen expected side drops the component from the actual side only, and every instance
then scores 0.0 as `missing-on-stage` — worse than not excluding it. Re-capturing the expected side
to match re-bases the freeze and makes the new report incomparable with every earlier one, which is
what the freeze exists to prevent. `compare` (and `compare-screenshots`) take the same flag and
apply it one layer later: both datasets keep the component, the score just leaves it out. The
trade-off is that it is a plain omission rather than a masked one — the excluded component's text
stays inside whatever ancestor element also happens to be a target, so check that no ancestor
inherits it before reaching for the compare-time form. Both reports print what they dropped in
their header and `report.json` carries an `excludedComponents` array, so neither form is silent.

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

### Auto concurrency (`--concurrency auto`)

The right pool size depends on the host, on the server being crawled and on how heavy its pages
are, and a wrong one is worse than slow: under too much load a capture gets **wrong**, not just
late — a starved navigation times out and is scraped half-rendered, a shot is taken while the
layout still moves, a throttled stylesheet leaves text un-transformed. Nothing downstream tells
those from real migration differences. So `auto` maximises throughput **only among levels that
capture cleanly** (`src/lib/autotune.mjs`):

- **Throughput** — a hill climb on pages/s, the one siphon's `ThreadAutoTuner` uses (keep a step
  that beats the previous window by 5%, else revert and try the other direction), preceded by a
  ×1.5 slow start from 4, because a capture is minutes long and +1 per window would never get there.
- **Quality** — any window in which a page showed a load symptom (navigation timeout, throttled
  response, a transient non-200 or exception that needed a retry, a shot skipped for an unstable
  layout, host memory under 8% free) cuts the pool by a quarter at once and makes the level that
  hurt a **ceiling** the climb may not re-enter. It lifts by one after 6 clean windows, because a
  cold server's first minute is not its steady state. A zero-capture retry is deliberately not a
  symptom: a page that genuinely has no components would hold the pool down all run.

A window closes once it has lasted `--autotune-interval` **and** completed one page per worker, so a
single slow page cannot decide it; status-only parity probes do not count toward throughput. Every
verdict is logged as an `[autotune]` line, and the run ends with the best clean rate and the level
that achieved it — a good value to pin with a plain `--concurrency <n>` if a run must be repeatable.

---

## Element filters

A resolved target is still dropped from the comparison when it has nothing to compare: elements that
are invisible (`display:none` / `visibility:hidden`), below `--min-height` (default 30px), or whose
normalized innerText is empty. `--remove-before` strips nodes from the page first (cookie banners
and the like), and `--max-height` caps an oversized capture.

> A **zero-height** container is not invisible. A wrapper whose children are all floated collapses
> to `808x0` while still rendering their text, so the visibility filter falls back to "has non-empty
> innerText" when the rect is zero. A zero rect is the right test for a *screenshot* (no pixels to
> grab — the screenshot path keeps its minimum) and the wrong one for *innerText*.

### Links are folded into the text

Plain `innerText` drops `href` entirely, so a link pointing at the wrong page reads as a perfect
match. Before the text is read, every `<a href>` in the (cloned) component is rewritten in place to
markdown **`[text](target)`**, which puts the target into the compared string.

- **Same-origin targets are reduced to an origin-relative path**, so the two sides — served from
  different hosts — do not diff on every internal link. Cross-origin links keep their full URL,
  which is identical on both sides anyway.
- **The target is emitted verbatim; the link text is not.** The inserted markup sits in a
  `text-transform:none` span, because `innerText` applies the anchor's computed `text-transform` to
  whatever is inside it — an uppercasing CTA would otherwise yield `[LEARN MORE](/ABOUT-CHA)`, a
  mangled target that also stops the media-URL mask below from matching. The link *text* stays
  transformed on purpose: that is visible content, and a casing difference between the two sides is
  a real diff worth scoring.
- It runs **after** the geometry-driven inline-space pass, which measures real rects: lengthening
  every link first would move those rects and silently change where synthetic spaces land.

#### Rewriting link targets

The two sides can spell a target they both serve differently for reasons belonging to how the
**datasets** were produced rather than to the migration. `--link-target-rewrite` (on `compare`) takes
comma-separated `pattern=>replacement` regex rules and applies them to each annotation's target, in
order, on **both** sides.

The case it exists for is an expected side crawled with **httrack**, which rewrites every href in the
markup it saves: prod serves `/en-gl/what-we-do`, the mirror's copy says `../what-we-do.html`, and the
capture resolves that to `/en-GL/what-we-do.html`. The migrated site is right to emit no extension, so
every link in every component diffs by five characters that describe the crawler. Stripping that
suffix collapses both spellings to one — on WSP's project pages it was worth **+4.2 points** of page
score, because a link annotation is a large part of a short component's text.

- `$` anchors to the end of the **target**, not of the surrounding text: each target is rewritten on
  its own, so a mid-path match is left alone and so is the same text outside an annotation.
- Rules run **after** media-asset masking, so a rule cannot reach inside the placeholder.
- Which pattern to strip is a property of one project's expected side, so it is configuration: keep
  the literal in the caller (a pipeline's `.env`), not in this repo.

It is a **comparison-time** rewrite, like the asset masking above and for the same reason: an
`expected/` dataset is normally a frozen one-time capture, so a capture-side or mirror-side fix would
only ever reach the stage side.

> **This is part of the dataset contract.** Turning it on or off changes every captured component
> that contains a link, so the expected side must be re-captured to match — see *Both sides must be
> captured under identical rules* under Development.

During capture, images/media/fonts are network-blocked in `content` mode (text-only comparison, a
large speed win), the page is scrolled once end-to-end to trigger lazy loaders, and navigation waits
for `load` + the scope selector + a short settle. Page status is taken from a direct HTTP request
**without following redirects** — a 3xx counts as "not 200" and is reported as such, and its
`Location` is recorded in the page's record (`location`; a path when it stays on the page's own
origin, the full URL when it leaves it).

### Accepted differences

Some differences are looked at and deliberately not fixed: a legacy bug the migration corrects,
chrome of a legacy product with no counterpart, data the export cannot give back. When a whole
class of them is one regex over link targets, `--link-target-rewrite` is the tool. The rest -
one element on one page - goes in an **accepted-differences file**:

```json
{ "version": 1,
  "entries": [ { "page": "/en-cn/x", "key": "<componentKey>", "name": "<rendering>",
                 "prod": "<fingerprint>", "stage": "<fingerprint>", "reason": "why it is not fixed" } ] }
```

`prod` / `stage` are fingerprints (16 hex of sha1) of each side's compared text, after every
normalization and rewrite. `compare --accepted <file>` scores an element whose page, key and BOTH
fingerprints match an entry as 100 (keeping `rawScore` and the `accepted` reason on it in
report.json) and lists the matches in report.md under *Accepted differences*, by reason. Change
either side by one character and the entry no longer matches: the element is scored again and the
entry is listed as **stale**. So an accepted diff cannot hide a regression, and the file only ever
describes diffs exactly as someone accepted them.

Every diff in report.json carries `prodPrint` / `stagePrint`, which is what `accept` reads:

```
migration-validate accept --report <report.json> --accepted <file> --reason "<why>"
    [--page <glob>] [--component <name|/regex/>] [--max-score <n>] [--dry-run]
```

It adds (or, for the same page + key, replaces) one entry per matching diff. Filter narrowly and
`--dry-run` first: every diff it matches is accepted as it stands.

---

## Scoring (content)

Per element pair, paired by `componentKey`:

```
score = 100 * LCS(prodText, stageText).length / max(prodText.length, stageText.length)
```

- Texts are whitespace-normalized first (`\s+` → single space, trimmed).
- **Media-asset URLs are masked** to `asset-links-are-hidden-in-e2e` on both sides
  (`src/lib/util.mjs`). The link annotation above puts `href` targets into the compared text, and
  the two sites address the *same* asset with structurally unrelated URLs — a CMS media path, a DAM
  CDN URL, a role-gated proxy path whose token varies per render — so those links could never match
  and are pure false negatives. The link **text** is still scored, so a missing or renamed document
  still diffs. Unresolved asset **placeholders** are deliberately *not* masked: they mean the asset
  was never resolved to a real URL — a genuine migration defect that must keep showing as a diff.
  Masking happens at comparison time, not in the capture, so it applies to an already-captured
  dataset with no re-capture and the datasets keep real URLs for debugging.
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
  **A redirect matches by kind and target, not by exact code**: 301 and 308 are both permanent,
  302/303/307 all temporary (frameworks do not all let a page pick — Next.js answers a permanent
  redirect with 308 where a legacy site sends 301), and the two `Location`s must agree after the
  `--link-target-rewrite` rules. A dataset captured before locations were recorded is judged by
  kind alone.
- **A page the actual side answers 404 is not scored** — by the content report or the screenshot
  report — while the expected side serves it (200, or a redirect: a parity miss that lands on a 404
  counts here too). It is a page the migration does not have, a coverage gap rather than a quality
  defect, and scoring it 0 buried every real diff under it (189 of 273 pages of one suite pulled the
  content score to 5.5%). It is counted instead: both reports write `pagesInScope` (in-scope pages
  the expected side does not 404), `pagesAvailable` (those the actual side does not 404),
  `pagesByLocale` (the same per first-path-segment locale) and `notFoundOnStage` (the paths), and
  the viewer shows `available / in scope` as a headline counter. Any other non-200 (a 500, a capture
  error) is a broken page and still scores 0. `--only-failed` re-checks the 404 pages too.
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
`--prev-report` - a file, or a directory holding the previous run's `report.json` and
`report-screenshots.json` side by side (`compare-screenshots` reads both: one for its regression
diff, the other for `--only-failed`). Pass it whenever the current branch's history is not where the
previous run left its report. It reports page-score buckets (**100%**, **50–100%**, **0–50%**) as
`previous → current (Δ)` plus the overall move, **new diffs** (elements now < 100 that were 100 or
absent — regressions) and **gone diffs** (were < 100, now 100 or gone — fixes). An element diff is
keyed by `page + element`, i.e. "same slot on the same page". First-ever run prints a baseline note.

**Component-scoped report** (`report-components.md`/`.json`, V2 only — component names are
regroups the *same* scored data by rendering **name** instead of by page:

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
                           <page_slug>/_page_prod.jpg                               (full-page shot, not scored)
  runs/
    latest.json            { runId } — the last run that captured successfully
    <runId>/
      migrated/            <page_slug>/<componentKey>/<componentKey>_migrated.png  (+ manifest.json, .components.json)
                           <page_slug>/_page_migrated.jpg                           (full-page shot, not scored)
      diff/                <page_slug>/<componentKey>/<componentKey>_diff.png
```

`prod/` stays at the root: it is the one-time baseline and belongs to no single run. The **actual**
side is kept **per run**, so a new run does not overwrite an older one's images — git versions
everything else (datasets, reports), and these PNGs live outside the repo, so the run directory is
their version history. `compare-screenshots` records the run it scored in `report-screenshots.json`,
and the viewer resolves PNGs through that field, so checking out an older run's report and reloading
the viewer shows that run's screenshots as long as its directory is still on disk.


### Full-page shot (not scored)

Before the component shots, every page is also photographed WHOLE — one `_page_<side>.jpg` in the
page's shot dir, taken after the settle, `freezeAnimations` and `--remove-before`, so it shows the
same frozen state the component shots are cut from. It is there for a person: to see the two pages
side by side and understand a component diff in context without opening both sites.

It is **outside every number**. `compare-screenshots` only walks the per-component subfolders of a
page dir, and this file sits in the page dir itself, so it adds nothing to a page's visual score,
the component counts or the regression diff; no diff image is made of it. Its size is recorded on
the page marker (`fullPage: { file, width, height, pageHeight, truncated }`), which is how it
reaches `manifest.json` and how a viewer finds it.

It is a JPEG (quality 70) clipped at 16000 px: full pages at 1280 wide run to 8-12k px, a PNG of that
is tens of MB, and a single oversized capture can fail on Chromium's texture limit. `truncated: true`
says a page was taller than the clip. `--full-page-shot false` turns it off.
---

## Dataset layout (content)

```
<expected dir>/            # captured once from the legacy site; commit this
  manifest.json            # { pages: { "/path": { status, elements, finalUrl? } } }
  sitemap.xml              # copy of the page list the dataset was built from
  <page_slug>/<key>.txt    # raw innerText per component
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
                 '--out', $expectedDir, '--presentation-root', $presentationRoot)
migration-validate @captureArgs

migration-validate compare --expected $expectedDir --actual $actualDir --report-dir $reportDir
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
src/lib/extract-selectors.mjs # in-page component resolution + masking
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
