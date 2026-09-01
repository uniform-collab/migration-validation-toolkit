/**
 * CHA e2e report viewer — client.
 *
 * Three views over the joined reports:
 *   Overview    KPIs + charts (score distribution, content-vs-visual scatter,
 *               worst components, diff severity, regression vs previous run)
 *   Pages       filterable/sortable page table -> page detail with, per component
 *               instance, the innerText diff AND the prod/stage/diff screenshots
 *   Components  per-component-type ranking -> every instance of that type
 *
 * No build step, no dependencies: ES modules straight off the local server.
 */

// --------------------------------------------------------------- tiny helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? "—" : n.toFixed(d));
const int = (n) => (n == null ? "—" : n.toLocaleString("en-US"));
const grade = (s) => (s == null ? "" : s >= 99.95 ? "good" : s >= 90 ? "warn" : "bad");
const worstOf = (r) => Math.min(r.contentScore ?? 101, r.visualScore ?? 101);
const shortDate = (iso) =>
  iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—";

function scoreCell(score, { width = true } = {}) {
  if (score == null)
    return `<div class="score"><span class="num faint">—</span>${
      width ? '<span class="track"></span>' : ""
    }</div>`;
  const g = grade(score);
  return `<div class="score"><span class="num s-${g}">${fmt(score)}</span>${
    width
      ? `<span class="track"><span class="fill f-${g}" style="width:${Math.max(
          1,
          score
        )}%"></span></span>`
      : ""
  }</div>`;
}

function chip(text, kind = "") {
  return `<span class="chip ${kind}">${esc(text)}</span>`;
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------- state
const S = {
  model: null,
  view: "overview",
  q: "",
  filters: { content: false, visual: false, quadrant: null, bucket: null },
  pageSort: { key: "worst", dir: 1 },
  compSort: { key: "contentAvg", dir: 1 },
  detail: null,
  open: null,
  tab: "text",
  textMode: "side", // side | unified | scored
  raw: false,
  imgMode: "side", // side | swipe | onion | diff
  zoom: "fit",
  sel: 0,
  visiblePages: [],
};

// --------------------------------------------------------------------- charts
const TIP = document.createElement("div");
TIP.className = "tooltip hidden";
document.body.appendChild(TIP);
function tip(html, ev) {
  if (!html) return TIP.classList.add("hidden");
  TIP.innerHTML = html;
  TIP.classList.remove("hidden");
  const pad = 14;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  const r = TIP.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
  TIP.style.left = `${x}px`;
  TIP.style.top = `${y}px`;
}
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest("[data-tip]");
  if (t) tip(t.dataset.tip, e);
});
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest("[data-tip]");
  if (t) tip(t.dataset.tip, e);
  else if (!TIP.classList.contains("hidden")) tip(null);
});
// A click usually re-renders the thing the cursor was over, so its mouseout
// never fires and the tooltip would hang around over the new view.
document.addEventListener("click", () => tip(null), true);
window.addEventListener("hashchange", () => tip(null));

const BUCKETS = [
  [0, 10], [10, 20], [20, 30], [30, 40], [40, 50],
  [50, 60], [60, 70], [70, 80], [80, 90], [90, 100],
];
const bucketOf = (s) => {
  if (s == null) return -1;
  if (s >= 99.95) return 10; // exact-100 gets its own bar: it is most of the mass
  return Math.min(9, Math.floor(s / 10));
};
const bucketLabel = (i) => (i === 10 ? "100" : `${BUCKETS[i][0]}–${BUCKETS[i][1]}`);

/**
 * Grouped histogram of page scores, content vs visual. Bars are clickable.
 *
 * √ scale on the count axis on purpose: the 100 bucket holds most of the mass
 * (289 of 513 pages in the cha/377 content run), and on a linear axis every
 * failing bucket — the only ones worth looking at — collapses into the baseline.
 */
function chartHistogram(pages) {
  const c = new Array(11).fill(0);
  const v = new Array(11).fill(0);
  for (const p of pages) {
    const bc = bucketOf(p.contentScore);
    if (bc >= 0) c[bc]++;
    const bv = bucketOf(p.visualScore);
    if (bv >= 0) v[bv]++;
  }
  const W = 720, H = 250, L = 42, R = 8, T = 10, B = 34;
  const max = Math.max(1, ...c, ...v);
  const bw = (W - L - R) / 11;
  const y = (n) => H - B - Math.sqrt(Math.max(0, n) / max) * (H - T - B);
  let bars = "";
  let ticks = "";
  for (let i = 0; i < 11; i++) {
    const x0 = L + i * bw;
    const pad = bw * 0.14;
    const w = (bw - pad * 2) / 2;
    const mk = (n, off, fill, kind) =>
      n
        ? `<rect class="bar" data-bucket="${i}" data-kind="${kind}" x="${(x0 + pad + off).toFixed(
            1
          )}" y="${y(n).toFixed(1)}" width="${w.toFixed(1)}" height="${(
            H - B - y(n)
          ).toFixed(1)}" rx="2" fill="${fill}" data-tip="${kind} · ${bucketLabel(
            i
          )}% → <b>${n}</b> page${n === 1 ? "" : "s"} (click to filter)"></rect>`
        : "";
    bars += mk(c[i], 0, "var(--accent)", "content") + mk(v[i], w, "#a371f7", "visual");
    ticks += `<text x="${(x0 + bw / 2).toFixed(1)}" y="${H - B + 14}" text-anchor="middle">${bucketLabel(
      i
    )}</text>`;
  }
  let grid = "";
  for (const n of [...new Set([0, 1, 5, 25, 100, 250, max].filter((x) => x <= max))]) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(n).toFixed(1)}" y2="${y(n).toFixed(
      1
    )}"/><text x="${L - 6}" y="${(y(n) + 3).toFixed(1)}" text-anchor="end">${n}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img">
    <g class="grid axis">${grid}</g>
    ${bars}
    <g class="axis">${ticks}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
      <text x="${L - 6}" y="${T + 2}" text-anchor="end" style="fill:var(--fg-faint)">pages</text>
      <text x="${W - R}" y="${H - 4}" text-anchor="end" style="fill:var(--fg-faint)">page score bucket · √ count scale</text>
    </g>
  </svg>`;
}

/**
 * Content score (x) vs visual score (y), one dot per page scored on both.
 * The bottom-right cloud is the interesting one: innerText matches, pixels do
 * not — the CSS/layout class no text comparison can ever see.
 */
function chartScatter(pages) {
  const pts = pages.filter((p) => p.contentScore != null && p.visualScore != null);
  const W = 720, H = 300, L = 44, R = 12, T = 12, B = 38;
  if (!pts.length)
    return `<div class="empty">No page has both a content and a visual score yet.</div>`;
  // Scores pile up against the 100 ceiling, so a linear axis puts every point in
  // one corner. Plot log10(1 + (100 − score)): 100 sits at the far end and the
  // 90–100 band — where the interesting failures live — gets most of the room.
  const t = (s) => 1 - Math.log10(1 + Math.max(0, 100 - s)) / Math.log10(101);
  const x = (s) => L + t(s) * (W - L - R);
  const y = (s) => H - B - t(s) * (H - T - B);
  const TICKS = [0, 50, 80, 95, 99, 100];
  let dots = "";
  for (const p of pts) {
    const g = grade(Math.min(p.contentScore, p.visualScore));
    dots += `<circle class="dot-page" data-path="${esc(p.path)}" cx="${x(
      p.contentScore
    ).toFixed(1)}" cy="${y(p.visualScore).toFixed(1)}" r="4.2" fill="var(--${
      g === "good" ? "good" : g === "warn" ? "warn" : "bad"
    })" fill-opacity=".65" data-tip="${esc(
      p.path
    )}<br>content <b>${fmt(p.contentScore)}</b> · visual <b>${fmt(p.visualScore)}</b>"></circle>`;
  }
  let grid = "";
  for (const s of TICKS) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(s).toFixed(1)}" y2="${y(s).toFixed(1)}"/>
      <text x="${L - 6}" y="${(y(s) + 3).toFixed(1)}" text-anchor="end">${s}</text>
      <line y1="${T}" y2="${H - B}" x1="${x(s).toFixed(1)}" x2="${x(s).toFixed(1)}"/>
      <text y="${H - B + 14}" x="${x(s).toFixed(1)}" text-anchor="middle">${s}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img">
    <g class="grid axis">${grid}</g>
    <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end" style="fill:var(--fg-faint)">content score → (log near 100)</text>
    <text class="axis" x="6" y="${T + 4}" style="fill:var(--fg-faint)">↑ visual score</text>
    <text x="${W - R - 4}" y="${H - B - 10}" text-anchor="end" style="fill:var(--fg-faint);font:10px var(--mono)">text ok, pixels differ ↓</text>
    ${dots}
  </svg>`;
}

/** Worst component types: paired content / visual average bars. */
function chartComponents(types, limit = 14) {
  const rows = [...types]
    .sort((a, b) => worstAvg(a) - worstAvg(b))
    .slice(0, limit);
  if (!rows.length) return `<div class="empty">No components.</div>`;
  const rowH = 26, W = 720, L = 210, R = 46;
  const H = rows.length * rowH + 12;
  const x = (s) => ((s ?? 0) / 100) * (W - L - R);
  let out = "";
  rows.forEach((t, i) => {
    const yTop = i * rowH + 4;
    const bar = (score, off, color, kind, n) =>
      score == null
        ? `<text x="${L + 4}" y="${yTop + off + 8}" style="fill:var(--fg-faint);font:9.5px var(--mono)">no ${kind} data</text>`
        : `<rect class="bar" data-comp="${esc(t.name)}" x="${L}" y="${yTop + off}" width="${Math.max(
            1.5,
            x(score)
          ).toFixed(1)}" height="8" rx="2" fill="${color}" data-tip="${esc(
            t.name
          )} · ${kind} avg <b>${fmt(score)}</b> over ${n} instance${
            n === 1 ? "" : "s"
          } (click)"></rect>
           <text x="${(L + x(score) + 5).toFixed(1)}" y="${yTop + off + 8}" style="fill:var(--fg-dim);font:10px var(--mono)">${fmt(
            score
          )}</text>`;
    out += `<text class="bar" data-comp="${esc(t.name)}" x="${L - 8}" y="${
      yTop + 12
    }" text-anchor="end" style="fill:var(--fg);font:11.5px var(--sans)">${esc(
      t.name
    )}</text>
      ${bar(t.contentAvg, 0, "var(--accent)", "content", t.contentScored)}
      ${bar(t.visualAvg, 10, "#a371f7", "visual", t.visualScored)}`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`;
}
const worstAvg = (t) => Math.min(t.contentAvg ?? 101, t.visualAvg ?? 101);

/** Diff-severity tallies straight from each compare's own `tag`. */
function chartSeverity(tags) {
  const COLORS = {
    "critical-diff": "var(--bad)",
    "major-diff": "#fb8500",
    "medium-diff": "var(--warn)",
    "minor-diff": "#8b949e",
    "extra-on-stage": "var(--bad)",
    "missing-on-stage": "var(--bad)",
    "extra-in-migrated": "var(--bad)",
    "missing-in-migrated": "var(--bad)",
  };
  const block = (title, obj) => {
    const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length)
      return `<div class="stat" style="margin:6px 0 12px">${title}: <span class="faint">no tagged diffs</span></div>`;
    const total = entries.reduce((n, [, v]) => n + v, 0);
    let bar = "";
    let off = 0;
    for (const [k, v] of entries) {
      const w = (v / total) * 100;
      bar += `<div data-tip="${esc(k)} → <b>${v}</b>" style="width:${w}%;background:${
        COLORS[k] || "var(--fg-faint)"
      }"></div>`;
      off += w;
    }
    return `<div class="stat" style="margin:8px 0 4px">${title} <span class="faint">(${total})</span></div>
      <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;border:1px solid var(--line)">${bar}</div>
      <div class="legend" style="padding-top:8px">${entries
        .map(
          ([k, v]) =>
            `<span><i style="background:${COLORS[k] || "var(--fg-faint)"}"></i>${esc(
              k
            )} <b class="mono">${v}</b></span>`
        )
        .join("")}</div>`;
  };
  return block("Content diffs by tag", tags?.content) + block("Visual diffs by tag", tags?.visual);
}

// ------------------------------------------------------------------ diff engine
const tokenize = (s) => s.match(/\s+|\S+/g) || [];
const sentences = (s) => s.split(/(?<=[.!?…])\s+/).filter(Boolean);

/**
 * LCS token diff with a common prefix/suffix shortcut. Falls back to a coarser
 * granularity (sentences) when the DP table would get silly — an Article Detail
 * body can be thousands of words.
 */
function diffTokens(aTok, bTok) {
  const ops = [];
  let s = 0;
  while (s < aTok.length && s < bTok.length && aTok[s] === bTok[s]) s++;
  let e = 0;
  while (
    e < aTok.length - s &&
    e < bTok.length - s &&
    aTok[aTok.length - 1 - e] === bTok[bTok.length - 1 - e]
  )
    e++;
  if (s) ops.push({ t: "=", text: aTok.slice(0, s).join("") });

  const a = aTok.slice(s, aTok.length - e);
  const b = bTok.slice(s, bTok.length - e);
  const n = a.length, m = b.length;

  if (n && m && n * m <= 4_000_000) {
    const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * (m + 1) + j] =
          a[i] === b[j]
            ? dp[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    let i = 0, j = 0;
    const push = (t, text) => {
      const last = ops[ops.length - 1];
      if (last && last.t === t) last.text += text;
      else ops.push({ t, text });
    };
    while (i < n && j < m) {
      if (a[i] === b[j]) push("=", a[i]), i++, j++;
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) push("-", a[i++]);
      else push("+", b[j++]);
    }
    while (i < n) push("-", a[i++]);
    while (j < m) push("+", b[j++]);
  } else if (n || m) {
    if (n) ops.push({ t: "-", text: a.join("") });
    if (m) ops.push({ t: "+", text: b.join("") });
  }
  if (e) ops.push({ t: "=", text: aTok.slice(aTok.length - e).join("") });
  return ops;
}

function diffText(prod, stage) {
  const aw = tokenize(prod), bw = tokenize(stage);
  // Word level whenever the DP is affordable after prefix/suffix trimming;
  // otherwise sentence level, which keeps long article bodies usable.
  if (aw.length * bw.length > 30_000_000) {
    const ops = diffTokens(sentences(prod), sentences(stage));
    return { ops, granularity: "sentence" };
  }
  return { ops: diffTokens(aw, bw), granularity: "word" };
}

const renderOps = (ops, sides) =>
  ops
    .filter((o) => sides.includes(o.t))
    .map((o) =>
      o.t === "=" ? esc(o.text) : o.t === "-" ? `<del>${esc(o.text)}</del>` : `<ins>${esc(o.text)}</ins>`
    )
    .join("");

/** Plain text with the LCS run the score credited highlighted. */
function renderScored(text, start, length) {
  if (start == null || start < 0 || !length) return esc(text);
  return (
    esc(text.slice(0, start)) +
    `<mark class="span">${esc(text.slice(start, start + length))}</mark>` +
    esc(text.slice(start + length))
  );
}

// ----------------------------------------------------------------------- views
function renderRunMeta() {
  const m = S.model;
  const bits = [
    `<span><b>content</b> ${m.content ? `${fmt(m.content.overallScore)}% · ${int(
      m.content.pagesScored
    )} pages · ${shortDate(m.content.generatedAt)}` : "missing"}</span>`,
    `<span><b>visual</b> ${m.visual ? `${fmt(m.visual.overallScore)}% · ${int(
      m.visual.pagesScored
    )} pages · ${shortDate(m.visual.generatedAt)}` : "missing"}</span>`,
    `<span><b>prod</b> ${esc(m.prodUrl)}</span>`,
    `<span><b>stage</b> ${esc(m.stageUrl)}</span>`,
    `<span><b>shots</b> ${esc(m.shotsDir || "—")}</span>`,
  ];
  $("#runmeta").innerHTML = bits.join("");
}

function coverageWarning() {
  const m = S.model;
  if (!m.content || !m.visual) return "";
  const c = m.content.pagesScored, v = m.visual.pagesScored;
  if (v >= c) return "";
  return `<div class="warnbar">⚠️ <span><b>Partial visual coverage.</b> The content report scores
    <b>${int(c)}</b> pages, the screenshot report only <b>${int(v)}</b> — the two overall numbers are
    not over the same page set. Capture the rest with <span class="mono">TEST_MODE=full</span> +
    <span class="mono">TEST_PAGE_LIMIT=0</span> (delete <span class="mono">${esc(
      m.shotsDir
    )}\\prod</span> first, or 6100 self-skips).</span></div>`;
}

function viewOverview() {
  const m = S.model;
  const cmp = m.content?.comparison;
  const delta = cmp ? m.content.overallScore - cmp.prevOverall : null;
  const pages = m.pages;

  const kpi = (label, value, sub, extra = "") =>
    `<div class="kpi ${extra}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  const deltaHtml =
    delta == null
      ? "no previous report"
      : `<span class="delta ${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${fmt(
          Math.abs(delta),
          Math.abs(delta) < 0.1 ? 3 : 1
        )}</span> vs ${fmt(cmp.prevOverall)} (${esc(cmp.source || "prev")})`;

  const kpis = [
    kpi(
      "Content score",
      m.content ? `<span class="s-${grade(m.content.overallScore)}">${fmt(m.content.overallScore)}%</span>` : "—",
      deltaHtml,
      "big"
    ),
    kpi(
      "Visual score",
      m.visual ? `<span class="s-${grade(m.visual.overallScore)}">${fmt(m.visual.overallScore)}%</span>` : "—",
      m.visual
        ? `${int(m.visual.componentsCompared)} shots · ${int(m.visual.componentsScoringZero)} at 0`
        : "run 6400 to produce it",
      "big"
    ),
    kpi(
      "Pages",
      int(m.content?.pagesScored ?? m.visual?.pagesScored),
      `${int(m.visual?.pagesScored || 0)} with screenshots · ${int(
        (m.content?.excluded || []).length
      )} excluded`
    ),
    kpi(
      "Element diffs",
      int(pages.reduce((n, p) => n + p.contentDiffs, 0)),
      `${int(m.content?.elementsCompared)} compared · ${int(m.content?.elementsScoringZero)} at 0`
    ),
    kpi(
      "Visual diffs",
      int(pages.reduce((n, p) => n + p.visualDiffs, 0)),
      // "not compared" is deliberately on the face of the tile: a one-side-skipped
      // pair or a compare-error is a harness gap, and folding it into either the
      // diff count or the compared count is how it stays invisible.
      `${int(m.visual?.componentsCompared || 0)} compared` +
        (m.visual?.componentsNotCompared
          ? ` · ${int(m.visual.componentsNotCompared)} not compared` +
            (m.visual.componentsCompareError ? ` (${int(m.visual.componentsCompareError)} error)` : "")
          : "")
    ),
    kpi(
      "Status parity",
      int(m.content?.statusMismatches ?? 0),
      `${int((m.content?.prodNon200 || []).length)} prod non-200`
    ),
  ].join("");

  const regression = cmp
    ? `<div class="cards" style="grid-template-columns:1fr">
        <div class="card">
          <header><h3>Change since the previous run</h3>
            <span class="hint">${esc(cmp.source || "")} · ${shortDate(cmp.prevGeneratedAt)}</span></header>
          <div class="legend">
            <span><i style="background:var(--bad)"></i>new diffs <b class="mono">${
              (cmp.newDiffs || []).length
            }</b></span>
            <span><i style="background:var(--good)"></i>gone diffs <b class="mono">${
              (cmp.goneDiffs || []).length
            }</b></span>
            <span>diff count <b class="mono">${cmp.prevDiffCount} → ${cmp.curDiffCount}</b></span>
          </div>
          ${
            (cmp.newDiffs || []).length
              ? `<table class="grid"><thead><tr><th>new diff — page</th><th>component</th><th>score</th></tr></thead>
                 <tbody>${(cmp.newDiffs || [])
                   .slice(0, 40)
                   .map(
                     (d) =>
                       `<tr data-goto="${esc(d.page)}"><td class="mono">${esc(
                         d.page
                       )}</td><td>${esc(d.name || d.key || d.index || "")}</td><td>${scoreCell(
                         d.score ?? null
                       )}</td></tr>`
                   )
                   .join("")}</tbody></table>`
              : `<div class="stat" style="padding:6px 0 12px">No new diffs. 🎉</div>`
          }
        </div>
      </div>`
    : "";

  const worst = m.worstInstances || [];
  return `${coverageWarning()}
    <div class="kpis">${kpis}</div>

    <h2 class="section">Distribution &amp; correlation</h2>
    <div class="cards">
      <div class="card">
        <header><h3>Page score distribution</h3><span class="hint">click a bar to filter Pages</span></header>
        <div class="legend"><span><i style="background:var(--accent)"></i>content</span><span><i style="background:#a371f7"></i>visual</span></div>
        ${chartHistogram(pages)}
      </div>
      <div class="card">
        <header><h3>Content vs visual, per page</h3><span class="hint">click a dot to open the page</span></header>
        <div class="legend"><span>bottom-right = <b>innerText matches but pixels differ</b> (CSS/layout — invisible to the content gate)</span></div>
        ${chartScatter(pages)}
      </div>
      <div class="card">
        <header><h3>Worst component types</h3><span class="hint">click for every instance</span></header>
        <div class="legend"><span><i style="background:var(--accent)"></i>content avg</span><span><i style="background:#a371f7"></i>visual avg</span></div>
        ${chartComponents(m.componentTypes)}
      </div>
      <div class="card">
        <header><h3>Diff severity</h3><span class="hint">tags assigned by the compares</span></header>
        ${chartSeverity(m.tags)}
      </div>
    </div>

    ${regression ? `<h2 class="section">Regression</h2>${regression}` : ""}

    <h2 class="section">Worst component instances <span class="faint" style="text-transform:none;letter-spacing:0">— worst 20 of ${int(
      worst.length
    )}; every one is in <a href="#/components">Components</a></span></h2>
    <table class="grid">
      <thead><tr><th>page</th><th>component</th><th>content</th><th>visual</th><th>tags</th></tr></thead>
      <tbody>${
        worst.length
          ? worst
              .slice(0, 20)
              .map(
                (i) => `<tr data-goto="${esc(i.page)}" data-comp-key="${esc(i.key)}">
          <td class="mono">${esc(i.page)}</td>
          <td>${esc(i.name)}<div class="key mono faint">${esc(i.key)}</div></td>
          <td>${scoreCell(i.contentScore)}</td>
          <td>${scoreCell(i.visualScore)}</td>
          <td>${[i.tag, i.visualTag].filter(Boolean).map((t) => chip(t, "bad")).join(" ")}</td></tr>`
              )
              .join("")
          : `<tr><td colspan="5" class="faint">Nothing below 100 — either a perfect run or no data.</td></tr>`
      }</tbody>
    </table>`;
}

function filteredPages() {
  const q = S.q.trim().toLowerCase();
  let rows = S.model.pages.filter((p) => {
    if (q && !p.path.toLowerCase().includes(q)) return false;
    if (S.filters.content && !(p.contentDiffs > 0)) return false;
    if (S.filters.visual && !(p.visualDiffs > 0)) return false;
    if (S.filters.bucket != null) {
      const k = S.filters.bucket.kind === "visual" ? p.visualScore : p.contentScore;
      if (bucketOf(k) !== S.filters.bucket.i) return false;
    }
    if (S.filters.quadrant === "textok-pixelbad")
      if (!(p.contentScore >= 99.95 && p.visualScore != null && p.visualScore < 99.95)) return false;
    if (S.filters.quadrant === "pixelok-textbad")
      if (!(p.visualScore >= 99.95 && p.contentScore != null && p.contentScore < 99.95)) return false;
    return true;
  });
  const k = S.pageSort.key;
  const val = (p) =>
    k === "path"
      ? p.path
      : k === "worst"
      ? worstOf(p)
      : k === "content"
      ? p.contentScore ?? 101
      : k === "visual"
      ? p.visualScore ?? 101
      : p[k] ?? 0;
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return c * S.pageSort.dir;
  });
  S.visiblePages = rows;
  return rows;
}

function viewPages() {
  const rows = filteredPages();
  const f = S.filters;
  const th = (key, label, extra = "") =>
    `<th data-sort="${key}" class="${S.pageSort.key === key ? `sorted ${S.pageSort.dir === 1 ? "asc" : ""}` : ""}" ${extra}>${label}</th>`;
  const bucketChip =
    f.bucket != null
      ? chip(`${f.bucket.kind} ${bucketLabel(f.bucket.i)}% ✕`, "accent")
      : "";
  return `<div class="filters">
      <button class="btn ${f.content ? "on" : ""}" data-toggle="content">content diffs</button>
      <button class="btn ${f.visual ? "on" : ""}" data-toggle="visual">visual diffs</button>
      <button class="btn ${f.quadrant === "textok-pixelbad" ? "on" : ""}" data-quadrant="textok-pixelbad"
        data-tip="Pages whose innerText matches prod exactly but whose screenshots do not">text ok · pixels differ</button>
      <button class="btn ${f.quadrant === "pixelok-textbad" ? "on" : ""}" data-quadrant="pixelok-textbad"
        data-tip="Pages that look identical but whose text differs">pixels ok · text differs</button>
      <span id="bucketChip" data-clear-bucket>${bucketChip}</span>
      <span class="spacer"></span>
      <span class="count">${int(rows.length)} / ${int(S.model.pages.length)} pages</span>
    </div>
    <table class="grid" id="pagesTable">
      <thead><tr>
        ${th("path", "page")}
        ${th("content", "content")}
        ${th("visual", "visual")}
        ${th("elements", "elems")}
        ${th("contentDiffs", "c-diffs")}
        ${th("visualDiffs", "v-diffs")}
        ${th("shots", "shots")}
        <th>status</th>
      </tr></thead>
      <tbody>${rows
        .map(
          (p, i) => `<tr data-goto="${esc(p.path)}" class="${i === S.sel ? "sel" : ""}">
        <td class="mono">${esc(p.path)}</td>
        <td>${scoreCell(p.contentScore)}</td>
        <td>${scoreCell(p.visualScore)}</td>
        <td class="right mono faint">${p.elements || "—"}</td>
        <td class="right mono ${p.contentDiffs ? "s-warn" : "faint"}">${p.contentDiffs || "—"}</td>
        <td class="right mono ${p.visualDiffs ? "s-warn" : "faint"}">${p.visualDiffs || "—"}</td>
        <td class="right mono faint">${p.shots || "—"}</td>
        <td class="nowrap">${
          p.statusMismatch
            ? chip(`${p.prodStatus} ≠ ${p.stageStatus}`, "bad")
            : `<span class="faint mono">${p.prodStatus ?? "—"}</span>`
        }</td></tr>`
        )
        .join("")}</tbody>
    </table>
    ${rows.length ? "" : `<div class="empty">No page matches the filters.</div>`}`;
}

function viewComponents() {
  const k = S.compSort.key;
  const rows = [...S.model.componentTypes].sort((a, b) => {
    const val = (t) =>
      k === "name" ? t.name : k === "worst" ? worstAvg(t) : t[k] ?? (k.endsWith("Avg") ? 101 : 0);
    const x = val(a), y = val(b);
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * S.compSort.dir;
  });
  const th = (key, label) =>
    `<th data-csort="${key}" class="${S.compSort.key === key ? `sorted ${S.compSort.dir === 1 ? "asc" : ""}` : ""}">${label}</th>`;
  return `<div class="filters"><span class="count">${rows.length} component types</span></div>
    <table class="grid">
      <thead><tr>
        ${th("name", "component")}
        ${th("contentAvg", "content avg")}
        ${th("visualAvg", "visual avg")}
        ${th("instances", "instances")}
        ${th("pages", "pages")}
        ${th("contentDiffs", "c-diffs")}
        ${th("visualDiffs", "v-diffs")}
        ${th("contentZeros", "zeros")}
      </tr></thead>
      <tbody>${rows
        .map(
          (t) => `<tr data-comp="${esc(t.name)}">
        <td>${esc(t.name)}</td>
        <td>${scoreCell(t.contentAvg)}</td>
        <td>${scoreCell(t.visualAvg)}</td>
        <td class="right mono faint">${int(t.instances)}</td>
        <td class="right mono faint">${int(t.pages)}</td>
        <td class="right mono ${t.contentDiffs ? "s-warn" : "faint"}">${t.contentDiffs || "—"}</td>
        <td class="right mono ${t.visualDiffs ? "s-warn" : "faint"}">${t.visualDiffs || "—"}</td>
        <td class="right mono ${t.contentZeros + t.visualZeros ? "s-bad" : "faint"}">${
            t.contentZeros + t.visualZeros || "—"
          }</td></tr>`
        )
        .join("")}</tbody>
    </table>`;
}

async function viewComponent(name) {
  const d = await getJson(`/api/component?name=${encodeURIComponent(name)}`);
  const t = S.model.componentTypes.find((x) => x.name === name);
  return `<div class="crumb"><a href="#/components">← all components</a></div>
    <div class="detail-head"><h1>${esc(name)}</h1>
      ${t ? chip(`content avg ${fmt(t.contentAvg)}`, grade(t.contentAvg)) : ""}
      ${t ? chip(`visual avg ${fmt(t.visualAvg)}`, grade(t.visualAvg)) : ""}
      ${chip(`${d.instances.length} instances`)}
    </div>
    <table class="grid">
      <thead><tr><th>page</th><th>content</th><th>visual</th><th>diff</th><th>tags</th><th>len prod→stage</th></tr></thead>
      <tbody>${d.instances
        .map(
          (i) => `<tr data-goto="${esc(i.page)}" data-comp-key="${esc(i.key)}">
        <td class="mono">${esc(i.page)}</td>
        <td>${scoreCell(i.contentScore)}</td>
        <td>${scoreCell(i.visualScore)}</td>
        <td>${
          i.diffImg
            ? `<img class="thumb" src="${i.diffImg}" loading="lazy" alt=""
                 data-tip="<img src='${i.diffImg}' style='max-width:430px;display:block'>">`
            : '<span class="faint">—</span>'
        }</td>
        <td>${[i.tag, i.visualTag].filter(Boolean).map((x) => chip(x, "bad")).join(" ")}</td>
        <td class="mono faint">${i.prodLen ?? "—"} → ${i.stageLen ?? "—"}</td></tr>`
        )
        .join("")}</tbody>
    </table>`;
}

// ------------------------------------------------------------------ page detail
async function viewPage(pagePath) {
  const d = await getJson(`/api/page?path=${encodeURIComponent(pagePath)}`);
  S.detail = d;
  if (!S.open || !d.rows.some((r) => r.key === S.open)) {
    const firstDiff = d.rows.find(
      (r) => (r.content && r.content.score < 100) || (r.visual && r.visual.score < 100)
    );
    S.open = firstDiff?.key || d.rows[0]?.key || null;
  }
  const idx = S.visiblePages.findIndex((p) => p.path === pagePath);
  const nav = (delta, label) => {
    const t = S.visiblePages[idx + delta];
    return t
      ? `<a class="btn" href="#/page/${encodeURIComponent(t.path)}">${label}</a>`
      : `<span class="btn" style="opacity:.4">${label}</span>`;
  };

  return `<div class="crumb"><a href="#/pages">← pages</a></div>
    <div class="detail-head">
      <h1>${esc(d.path)}</h1>
      ${chip(`content ${fmt(d.contentScore)}`, grade(d.contentScore))}
      ${chip(`visual ${fmt(d.visualScore)}`, grade(d.visualScore))}
      ${d.statusMismatch ? chip(`status ${d.prodStatus} ≠ ${d.stageStatus}`, "bad") : ""}
      <span class="spacer"></span>
    </div>
    <div class="detail-sub">
      <span>${d.prodHref ? `<a href="${esc(d.prodHref)}" target="_blank" rel="noreferrer">prod ↗</a>` : ""}
      ${d.stageHref ? ` · <a href="${esc(d.stageHref)}" target="_blank" rel="noreferrer">stage ↗</a>` : ""}</span>
      <span class="mono faint">slug ${esc(d.slug)}</span>
      <span class="mono faint">${d.rows.length} components</span>
      ${idx >= 0 ? `<span>${nav(-1, "◀ prev page")} ${nav(1, "next page ▶")}</span>` : ""}
    </div>
    <div id="comps">${d.rows.map((r, i) => componentBlock(r, i)).join("")}</div>`;
}

function componentBlock(r, i) {
  const open = r.key === S.open;
  const cs = r.content?.score ?? null;
  const vs = r.visual?.score ?? null;
  const badges = [
    r.content?.tag ? chip(r.content.tag, "bad") : "",
    r.visual?.tag && r.visual.score < 100
      ? chip(r.visual.tag, r.visual.score < 90 ? "bad" : "warn")
      : "",
    r.text?.identical ? chip("text identical", "good") : "",
    Object.keys(r.images || {}).length ? chip(`${Object.keys(r.images).length} shots`) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<section class="comp ${open ? "sel" : ""}" data-key="${esc(r.key)}">
    <div class="head" data-expand="${esc(r.key)}">
      <div class="idx">${i + 1}</div>
      <div><div class="name">${esc(r.name)}</div><div class="key">${esc(r.key)}</div></div>
      <div data-tip="content innerText score">${scoreCell(cs)}</div>
      <div data-tip="visual pixel score">${scoreCell(vs)}</div>
      <div class="badges">${badges}</div>
    </div>
    ${open ? `<div class="body">${componentBody(r)}</div>` : ""}
  </section>`;
}

function componentBody(r) {
  const tabs = [
    ["text", "Text diff", Boolean(r.text)],
    ["images", "Screenshots", Boolean(Object.keys(r.images || {}).length)],
    ["meta", "Details", true],
  ];
  const tab = tabs.find(([k]) => k === S.tab && tabs.find(([kk, , ok]) => kk === k && ok))
    ? S.tab
    : tabs.find(([, , ok]) => ok)[0];
  const bar = `<div class="subtabs">${tabs
    .map(
      ([k, label, ok]) =>
        `<button data-tab="${k}" class="${k === tab ? "on" : ""}" ${ok ? "" : "disabled style=opacity:.4"}>${label}</button>`
    )
    .join("")}</div>`;
  const body =
    tab === "text" ? textBody(r) : tab === "images" ? imageBody(r) : metaBody(r);
  return bar + body;
}

function textBody(r) {
  if (!r.text)
    return `<div class="empty">No captured innerText for this component
      (${esc(r.files.prodTxt || "")}).</div>`;
  const t = r.text;
  const prod = S.raw ? t.prodRaw ?? "" : t.prod;
  const stage = S.raw ? t.stageRaw ?? "" : t.stage;
  const score = r.content?.score;
  const maxLen = Math.max(t.prod.length, t.stage.length);

  const toolbar = `<div class="toolbar">
      <button class="btn ${S.textMode === "side" ? "on" : ""}" data-textmode="side">side by side</button>
      <button class="btn ${S.textMode === "unified" ? "on" : ""}" data-textmode="unified">unified</button>
      <button class="btn ${S.textMode === "scored" ? "on" : ""}" data-textmode="scored"
        data-tip="Highlight the single longest common run — the score is 100 × its length / max(len)">scored run</button>
      <span class="sep"></span>
      <button class="btn ${S.raw ? "on" : ""}" data-raw
        data-tip="Normalized = what the scorer compared (whitespace collapsed, media URLs masked). Raw = the capture on disk.">raw text</button>
      <span class="sep"></span>
      <span class="stat">${
        score != null
          ? `score <b class="s-${grade(score)}">${fmt(score)}</b> = 100 × ${int(
              t.span.length
            )} / ${int(maxLen)}`
          : "not scored"
      } · prod ${int(t.prod.length)} ch · stage ${int(t.stage.length)} ch</span>
    </div>`;

  if (t.identical && S.textMode !== "scored")
    return (
      toolbar +
      `<div class="identical">✓ innerText is identical after normalization (${int(
        t.prod.length
      )} chars).</div>` +
      `<div class="pane"><div class="text">${esc(prod)}</div></div>`
    );

  if (S.textMode === "scored") {
    const aStart = S.raw ? -1 : t.span.aStart;
    const bStart = S.raw ? -1 : t.span.bStart;
    return (
      toolbar +
      `<div class="diff-panes">
        <div class="pane"><h4><span>prod (expected)</span><span>${int(prod.length)} ch</span></h4>
          <div class="text">${renderScored(prod, aStart, t.span.length)}</div></div>
        <div class="pane"><h4><span>stage (actual)</span><span>${int(stage.length)} ch</span></h4>
          <div class="text">${renderScored(stage, bStart, t.span.length)}</div></div>
      </div>`
    );
  }

  const { ops, granularity } = diffText(prod, stage);
  const adds = ops.filter((o) => o.t === "+").reduce((n, o) => n + o.text.length, 0);
  const dels = ops.filter((o) => o.t === "-").reduce((n, o) => n + o.text.length, 0);
  const stats = `<div class="stat" style="margin-bottom:8px">${granularity}-level diff ·
    <span class="s-bad">−${int(dels)}</span> / <span class="s-good">+${int(adds)}</span> chars</div>`;

  if (S.textMode === "unified")
    return (
      toolbar +
      stats +
      `<div class="diff-panes diff-unified"><div class="pane">
        <h4><span>unified — <del>prod</del> / <ins>stage</ins></span></h4>
        <div class="text">${renderOps(ops, ["=", "-", "+"])}</div></div></div>`
    );

  return (
    toolbar +
    stats +
    `<div class="diff-panes">
      <div class="pane"><h4><span>prod (expected)</span><span>${int(prod.length)} ch</span></h4>
        <div class="text" data-sync>${renderOps(ops, ["=", "-"])}</div></div>
      <div class="pane"><h4><span>stage (actual)</span><span>${int(stage.length)} ch</span></h4>
        <div class="text" data-sync>${renderOps(ops, ["=", "+"])}</div></div>
    </div>`
  );
}

function imageBody(r) {
  const im = r.images || {};
  if (!im.prod && !im.migrated && !im.diff)
    return `<div class="empty">No screenshots for this component. Run 6100/6200 with
      <span class="mono">TEST_MODE=full</span> (or <span class="mono">screenshots</span>).</div>`;
  const dims = (x) => (x ? `${x.w}×${x.h}` : "—");
  const sizeNote =
    im.prod && im.migrated && (im.prod.w !== im.migrated.w || im.prod.h !== im.migrated.h)
      ? chip(`size differs ${dims(im.prod)} → ${dims(im.migrated)}`, "warn")
      : "";
  const modes = [
    ["side", "side by side"],
    ["swipe", "swipe"],
    ["onion", "onion skin"],
    ["diff", "diff heatmap"],
  ];
  const toolbar = `<div class="toolbar">
      ${modes
        .map(
          ([k, label]) =>
            `<button class="btn ${S.imgMode === k ? "on" : ""}" data-imgmode="${k}">${label}</button>`
        )
        .join("")}
      <span class="sep"></span>
      <button class="btn ${S.zoom === "fit" ? "on" : ""}" data-zoom="fit">fit</button>
      <button class="btn ${S.zoom === "1" ? "on" : ""}" data-zoom="1">1:1</button>
      <button class="btn ${S.zoom === "2" ? "on" : ""}" data-zoom="2">2×</button>
      <span class="sep"></span>
      <span class="stat">${
        r.visual
          ? `visual <b class="s-${grade(r.visual.score)}">${fmt(r.visual.score)}</b> · ${fmt(
              r.visual.mismatch,
              2
            )}% pixels differ`
          : "not scored visually"
      } · prod ${dims(im.prod)} · stage ${dims(im.migrated)}</span>
      ${sizeNote}
    </div>`;

  const style = (x) =>
    S.zoom === "fit"
      ? "width:100%"
      : `width:${Math.round((x?.w || 0) * Number(S.zoom))}px`;

  if (S.imgMode === "side")
    return (
      toolbar +
      `<div class="img-row">
        ${["prod", "migrated"]
          .map((side) =>
            im[side]
              ? `<div class="img-col"><h4>${side === "prod" ? "prod (baseline)" : "stage (migrated)"} — ${dims(
                  im[side]
                )}</h4><div class="img-stage"><img src="${im[side].url}" style="${style(
                  im[side]
                )}" alt=""></div></div>`
              : `<div class="img-col"><h4>${side}</h4><div class="empty">missing — component ${
                  side === "prod" ? "extra on stage" : "missing on stage"
                }</div></div>`
          )
          .join("")}
      </div>`
    );

  if (S.imgMode === "diff")
    return (
      toolbar +
      (im.diff
        ? `<div class="img-stage"><img src="${im.diff.url}" style="${style(im.diff)}" alt=""></div>
           <div class="stat" style="margin-top:6px">Red = differing pixels (pixelmatch, threshold 0.1, on a
           common ${dims(im.diff)} canvas anchored top-left).</div>`
        : `<div class="empty">No diff image — the pair scored 100 (identical) or one side is missing.</div>`)
    );

  if (!im.prod || !im.migrated)
    return (
      toolbar +
      `<div class="empty">Overlay modes need both sides; only ${
        im.prod ? "prod" : "stage"
      } exists here.</div>`
    );

  if (S.imgMode === "swipe")
    return (
      toolbar +
      `<div class="img-stage swipe" id="swipe">
        <img src="${im.prod.url}" style="${style(im.prod)}" alt="">
        <div class="over" style="width:50%"><img src="${im.migrated.url}" style="${style(
        im.migrated
      )}" alt=""></div>
        <div class="handle" style="left:50%"></div>
      </div>
      <div class="stat" style="margin-top:6px">Drag the handle: left = prod, right = stage.</div>`
    );

  return (
    toolbar +
    `<div class="img-stage onion" id="onion">
      <img src="${im.prod.url}" style="${style(im.prod)}" alt="">
      <div class="top" style="opacity:.5"><img src="${im.migrated.url}" style="${style(
      im.migrated
    )}" alt=""></div>
    </div>
    <div class="toolbar" style="margin-top:8px"><span class="stat">prod</span>
      <input type="range" id="onionRange" min="0" max="100" value="50" style="flex:1">
      <span class="stat">stage</span></div>`
  );
}

function metaBody(r) {
  const rows = [
    ["component key", r.key],
    ["name", r.name],
    ["order", r.order],
    ["content score", r.content ? fmt(r.content.score) : "—"],
    ["content tag", r.content?.tag || "—"],
    ["prod / stage chars", r.content ? `${r.content.prodLen} / ${r.content.stageLen}` : "—"],
    ["visual score", r.visual ? `${fmt(r.visual.score)} (${fmt(r.visual.mismatch, 2)}% off)` : "—"],
    ["shot height", r.visual?.height ?? "—"],
    ["prod text file", r.files.prodTxt],
    ["stage text file", r.files.stageTxt],
    ["prod png", r.files.prodPng],
    ["stage png", r.files.migratedPng],
    ["diff png", r.files.diffPng],
  ];
  return `<table class="meta-table">${rows
    .map(
      ([k, v]) =>
        `<tr><td>${esc(k)}</td><td>${esc(v ?? "—")}${
          typeof v === "string" && v.includes("\\")
            ? `<button class="copy" data-copy="${esc(v)}">copy</button>`
            : ""
        }</td></tr>`
    )
    .join("")}</table>`;
}

// --------------------------------------------------------------------- routing
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = h.split("/");
  const arg = decodeURIComponent(rest.join("/") || "");
  if (head === "page" && arg) return { view: "page", arg };
  if (head === "component" && arg) return { view: "component", arg };
  if (["pages", "components", "overview"].includes(head)) return { view: head };
  return { view: "overview" };
}

async function render() {
  const route = parseHash();
  S.view = route.view;
  $$("#tabs a").forEach((a) =>
    a.classList.toggle(
      "active",
      a.dataset.view === route.view ||
        (route.view === "page" && a.dataset.view === "pages") ||
        (route.view === "component" && a.dataset.view === "components")
    )
  );
  const host = $("#view");
  try {
    if (route.view === "overview") host.innerHTML = viewOverview();
    else if (route.view === "pages") host.innerHTML = viewPages();
    else if (route.view === "components") host.innerHTML = viewComponents();
    else if (route.view === "component") host.innerHTML = await viewComponent(route.arg);
    else if (route.view === "page") {
      if (!S.visiblePages.length) filteredPages();
      host.innerHTML = await viewPage(route.arg);
      const open = $(`.comp[data-key="${cssEscape(S.open)}"]`);
      if (open) open.scrollIntoView({ block: "nearest" });
      wireImageWidgets();
    }
  } catch (err) {
    host.innerHTML = `<div class="empty">${esc(String(err))}</div>`;
  }
}

const cssEscape = (s) => String(s).replace(/["\\]/g, "\\$&");

/** Re-render just the open component (keeps table/scroll state stable). */
function rerenderOpen() {
  const r = S.detail?.rows.find((x) => x.key === S.open);
  if (!r) return render();
  const el = $(`.comp[data-key="${cssEscape(S.open)}"]`);
  if (!el) return render();
  el.outerHTML = componentBlock(r, S.detail.rows.indexOf(r));
  wireImageWidgets();
}

// ------------------------------------------------------------ image widgets
function wireImageWidgets() {
  const sw = $("#swipe");
  if (sw) {
    const move = (ev) => {
      const box = sw.getBoundingClientRect();
      const pct = Math.min(100, Math.max(0, ((ev.clientX - box.left) / box.width) * 100));
      sw.querySelector(".over").style.width = `${pct}%`;
      sw.querySelector(".handle").style.left = `${pct}%`;
    };
    sw.addEventListener("pointerdown", (e) => {
      move(e);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
  const rng = $("#onionRange");
  if (rng)
    rng.addEventListener("input", () => {
      $("#onion .top").style.opacity = String(rng.value / 100);
    });
}

// -------------------------------------------------------------------- events
document.addEventListener("click", async (e) => {
  const t = e.target;

  // charts -> filters / navigation
  const bar = t.closest("[data-bucket]");
  if (bar) {
    S.filters.bucket = { i: Number(bar.dataset.bucket), kind: bar.dataset.kind };
    location.hash = "#/pages";
    return render();
  }
  const dot = t.closest("[data-path]");
  if (dot) {
    location.hash = `#/page/${encodeURIComponent(dot.dataset.path)}`;
    return;
  }
  const compBar = t.closest("[data-comp]");
  if (compBar) {
    location.hash = `#/component/${encodeURIComponent(compBar.dataset.comp)}`;
    return;
  }

  // page/component navigation from tables
  const goto = t.closest("[data-goto]");
  if (goto) {
    S.open = goto.dataset.compKey || null;
    location.hash = `#/page/${encodeURIComponent(goto.dataset.goto)}`;
    return;
  }

  // filters
  const toggle = t.closest("[data-toggle]");
  if (toggle) {
    S.filters[toggle.dataset.toggle] = !S.filters[toggle.dataset.toggle];
    return render();
  }
  const quad = t.closest("[data-quadrant]");
  if (quad) {
    S.filters.quadrant = S.filters.quadrant === quad.dataset.quadrant ? null : quad.dataset.quadrant;
    return render();
  }
  if (t.closest("[data-clear-bucket]") && S.filters.bucket) {
    S.filters.bucket = null;
    return render();
  }

  // sorting
  const sortTh = t.closest("[data-sort]");
  if (sortTh) {
    const k = sortTh.dataset.sort;
    S.pageSort = { key: k, dir: S.pageSort.key === k ? -S.pageSort.dir : 1 };
    return render();
  }
  const csortTh = t.closest("[data-csort]");
  if (csortTh) {
    const k = csortTh.dataset.csort;
    S.compSort = { key: k, dir: S.compSort.key === k ? -S.compSort.dir : 1 };
    return render();
  }

  // page detail interactions
  const expand = t.closest("[data-expand]");
  if (expand) {
    S.open = S.open === expand.dataset.expand ? null : expand.dataset.expand;
    return render();
  }
  const tab = t.closest("[data-tab]");
  if (tab) {
    S.tab = tab.dataset.tab;
    return rerenderOpen();
  }
  const tm = t.closest("[data-textmode]");
  if (tm) {
    S.textMode = tm.dataset.textmode;
    return rerenderOpen();
  }
  if (t.closest("[data-raw]")) {
    S.raw = !S.raw;
    return rerenderOpen();
  }
  const imode = t.closest("[data-imgmode]");
  if (imode) {
    S.imgMode = imode.dataset.imgmode;
    return rerenderOpen();
  }
  const zoom = t.closest("[data-zoom]");
  if (zoom) {
    S.zoom = zoom.dataset.zoom;
    return rerenderOpen();
  }
  const copy = t.closest("[data-copy]");
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy);
    copy.textContent = "copied";
    setTimeout(() => (copy.textContent = "copy"), 1200);
    return;
  }

  if (t.closest("#helpBtn")) return $("#help").classList.remove("hidden");
  if (t.closest("#helpClose") || t.id === "help") return $("#help").classList.add("hidden");
  if (t.closest("#themeToggle")) {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("cha-e2e-theme", next);
    return;
  }
});

$("#globalSearch").addEventListener("input", (e) => {
  S.q = e.target.value;
  S.sel = 0;
  if (S.view === "pages") render();
  else if (S.q) location.hash = "#/pages";
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const k = e.key;
  if (k === "/") {
    e.preventDefault();
    return $("#globalSearch").focus();
  }
  if (k === "?") return $("#help").classList.toggle("hidden");
  if (k === "1") return (location.hash = "#/overview");
  if (k === "2") return (location.hash = "#/pages");
  if (k === "3") return (location.hash = "#/components");
  if (k === "r") return boot();
  if (k === "Escape") {
    if (!$("#help").classList.contains("hidden")) return $("#help").classList.add("hidden");
    if (S.view === "page") return (location.hash = "#/pages");
    if (S.view === "component") return (location.hash = "#/components");
  }
  if (S.view === "pages" && (k === "j" || k === "k")) {
    e.preventDefault();
    S.sel = Math.min(
      Math.max(0, S.sel + (k === "j" ? 1 : -1)),
      Math.max(0, S.visiblePages.length - 1)
    );
    render();
    $(".grid tbody tr.sel")?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (S.view === "pages" && k === "Enter" && S.visiblePages[S.sel]) {
    location.hash = `#/page/${encodeURIComponent(S.visiblePages[S.sel].path)}`;
    return;
  }
  if (S.view === "page" && S.detail) {
    const rows = S.detail.rows;
    const i = rows.findIndex((r) => r.key === S.open);
    if (k === "[" || k === "]") {
      const n = Math.min(rows.length - 1, Math.max(0, i + (k === "]" ? 1 : -1)));
      S.open = rows[n]?.key ?? S.open;
      return render();
    }
    if (k === "d") {
      const isDiff = (r) =>
        (r.content && r.content.score < 100) || (r.visual && r.visual.score < 100);
      const next = rows.slice(i + 1).find(isDiff) || rows.find(isDiff);
      if (next) {
        S.open = next.key;
        return render();
      }
    }
    if (k === "t") {
      S.tab = "text";
      return rerenderOpen();
    }
    if (k === "i") {
      S.tab = "images";
      return rerenderOpen();
    }
    if (k === "m") {
      const order = ["side", "swipe", "onion", "diff"];
      S.imgMode = order[(order.indexOf(S.imgMode) + 1) % order.length];
      S.tab = "images";
      return rerenderOpen();
    }
  }
});

window.addEventListener("hashchange", render);

// ----------------------------------------------------------------------- boot
async function boot() {
  const saved = localStorage.getItem("cha-e2e-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  S.model = await getJson("/api/overview");
  renderRunMeta();
  await render();
}

boot().catch((err) => {
  $("#view").innerHTML = `<div class="empty">Failed to load reports: ${esc(String(err))}</div>`;
});
