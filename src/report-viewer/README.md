# E2E report viewer

An interactive front end for what `tests/report*.md` states in prose. It reads only
artifacts a `6-tests` run already produced — nothing is captured, compared, built or
pushed — so it is safe to run at any time, including while a pipeline run is going.

```powershell
.\src\data\tests\view-report.ps1            # http://localhost:8099
.\src\data\tests\view-report.ps1 -Port 9000 -Open
# or, equivalently:
node src\data\tests\harness\report-viewer\server.mjs --port 8099
```

Zero dependencies (Node's own `http`/`fs`; the client is plain ES modules) and zero
network access. Reports are re-read when their mtime changes — after a new run just
reload the page (or press `r`).

## What it shows

**Overview** — content and visual KPIs with the regression delta vs the previous run,
plus four charts:

| chart | reads |
|---|---|
| Page score distribution | content vs visual page scores, 11 buckets (√ count scale — the 100 bucket holds most of the mass). Click a bar to filter Pages. |
| Content vs visual, per page | one dot per page scored on both. **Bottom-right = innerText matches prod but pixels do not** — the CSS/layout class the content gate structurally cannot see. Log scale near 100, where the failures live. |
| Worst component types | paired content / visual averages per component type. Click for every instance. |
| Diff severity | the `tag` each compare assigned (`critical-diff`, `extra-on-stage`, …). |

Then the regression tables (new / gone diffs vs the previous committed report) and the
worst component instances.

**Pages** — every page, sortable, filterable by content diffs / visual diffs / score
bucket / the two interesting quadrants, searchable by path.

**Page detail** — the components of one page, each with its content score, visual score
and tags. Expand one for:

- **Text diff** — side-by-side or unified word-level diff (sentence-level fallback for
  very long bodies), on the *normalized* text the scorer actually compared (whitespace
  collapsed, media URLs masked — toggle `raw text` for the capture on disk). The
  **scored run** mode highlights the single longest common substring, i.e. exactly what
  produced the number: `score = 100 × run / max(len)`. One early mismatch therefore
  costs far more than it looks, which this mode makes obvious.
- **Screenshots** — side by side, **swipe** (drag divider), **onion skin** (opacity
  slider) and the **diff heatmap**, at fit / 1:1 / 2×. Flags a prod↔stage size
  difference explicitly, since the compare normalizes onto a common canvas anchored
  top-left and a size delta alone registers as mismatch.
- **Details** — component key, both text file paths and all three PNG paths (copyable).

**Components** — per-type ranking, then every instance of one type worst-first with a
diff thumbnail (hover to enlarge). This is the view that turns "Breadcrumb: mean 84
over 14 pages" into "the same 7px height difference on every page".

## Data it joins

Everything is joined on `path` + `componentKey`, the same pairing the compares use:

```
tests/report.json              content scores per page/element (+ regression diff)
tests/report-screenshots.json  visual scores per page/component
tests/report-components.json   per-component-type aggregate (content)
<--expected-dir>/              prod innerText   <slug>/<key>.txt
tests/actual-v2/               stage innerText  <slug>/<key>.txt
TEST_SCREENSHOT_DIR/prod/<slug>/<key>/<key>_prod.png                 shared baseline
TEST_SCREENSHOT_DIR/runs/<runId>/{migrated,diff}/<slug>/<key>/...    one dir PER RUN
```

Stage screenshots are stored per run (they are ~1.3 GB of PNGs outside git, so the run
directory is what keeps an older run's images from being overwritten — see
the package README). The viewer resolves which run to show from
`report-screenshots.json`'s `runId`, so an older report checked out of git shows ITS
screenshots; it falls back to `runs/latest.json` and then to a pre-per-run root-level
`migrated/`+`diff/`. `--run <runId>` forces one. The startup banner prints the run it
picked.

`TEST_SCREENSHOT_DIR`, `TEST_PROD_URL` and `TEST_STAGE_URL` come from the repo `.env`
(override with `--shots`, `--root`, `--report-dir`). Missing artifacts degrade
gracefully: no screenshot report → the visual columns read `—`; no shots dir → the
Screenshots tab explains which `TEST_MODE` to capture with.

`lcs-span.mjs` is a deliberate copy of `lib/lcs.mjs`'s suffix-automaton extended with
offsets. `lib/lcs.mjs` is the verified scoring path and must keep its exact behaviour,
so the viewer does not touch it.

## Keyboard

`1`/`2`/`3` views · `/` search · `j`/`k` list · `Enter` open · `Esc` back ·
`[`/`]` prev/next component · `d` next component with a diff · `t`/`i` text/image tab ·
`m` cycle image mode · `r` reload reports · `?` help.
