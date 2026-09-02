/**
 * V2 in-page capture: innerText per index.json component, with descendant
 * components masked out (so a parent is compared without the children that are
 * captured separately). Passed to Playwright page.evaluate(), so it must be
 * fully self-contained (no imports, no closures).
 *
 * Masking is text-only and non-destructive: each target's element is cloned,
 * the clone's descendant component subtrees are removed, then innerText is read
 * from the clone. No DOM restore is needed, so target order doesn't matter.
 *
 * Before innerText is read, each clone's <a href> links are rewritten in place to
 * markdown "[text](target)", so link targets are part of the compared text - plain
 * innerText drops href entirely and hides link-only differences.
 *
 * @param cfg { targets: [{ order:number, key:string, name:string, sel:string,
 *                          index?:number, levelsUp?:number }] }
 * @returns { items: [{ order, key, name, text }],   // resolved, visible, non-empty
 *            unresolved: [{ order, key, name, sel }],
 *            empty: [{ order, key, name }],          // resolved but no text after masking
 *            excluded: [{ order, name }] }           // out of scope: masked out, never captured
 */
export function collectComponentTexts(cfg) {
  const MARK = "__selc__";
  const targets = cfg.targets || [];

  // Selector + index + levelsUp — see "How a target resolves to an element" in index-json.mjs.
  const resolveTarget = (t) => {
    let list;
    try {
      list = document.querySelectorAll(t.sel);
    } catch {
      return null;
    }
    let el = list[t.index || 0];
    for (let i = 0; el && i < (t.levelsUp || 0); i++) el = el.parentElement;
    return el || null;
  };

  // 1) Resolve + tag every target so masking can find component boundaries.
  const resolved = [];
  const unresolved = [];
  for (const t of targets) {
    const el = resolveTarget(t);
    if (el) {
      // The element is kept by reference, not re-queried by attribute: two renderings can legitimately
      // resolve to the same element (e.g. a wrapper reached via levelsUp), and the second tag would
      // otherwise overwrite the first and lose a component.
      el.classList.add(MARK);
      resolved.push({ t, el });
    } else {
      unresolved.push({ order: t.order, name: t.name, sel: t.sel });
    }
  }

  const isVisible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    // A container whose children are all floated (or absolutely positioned) collapses to a
    // zero-HEIGHT box while still rendering their text - e.g. the Related Topics tag wrapper,
    // which measures 808x0 on prod yet reads "Access to Care Children With Medical Complexity
    // Medicaid". A zero rect is the right test for a SCREENSHOT (there are no pixels to grab),
    // but this is the innerText comparison, so dropping it discards real text and scores the
    // component 0 against a stage whose markup happens to give the same box a height.
    // Anything genuinely hidden yields "" here anyway, so it still gets filtered out.
    return (el.innerText || "").trim().length > 0;
  };
  const isFixed = (el) => getComputedStyle(el).position === "fixed";

  const inlineTags = new Set([
    "A", "SPAN", "EM", "STRONG", "B", "I", "U", "SMALL", "SUB", "SUP",
    "CODE", "LABEL", "ABBR", "CITE", "Q", "MARK", "TIME", "DATA", "BUTTON",
  ]);
  function isInlineElement(node) {
    if (node.nodeType !== 1) return false;
    if (inlineTags.has(node.tagName)) return true;
    try {
      return getComputedStyle(node).display.startsWith("inline");
    } catch {
      return false;
    }
  }
  // Two inline elements that are element-siblings with no text node between them are
  // CONCATENATED by innerText - correct when they really abut (`<a>(CHIP)</a><b>.</b>`
  // renders "(CHIP)."), wrong when layout separates them (tag pills whose gap comes from
  // margins, not markup). The old rule inserted a space for EVERY such pair, which was
  // right for the pills and wrong for rich text: Lexical puts the format on each leaf, so
  // `<strong>x </strong><a><strong>y</strong></a><strong>.</strong>` is three adjacent
  // inline elements where prod's single wrapping <strong> is one - 43 of the cha/427
  // report's 144 diffs were nothing but those phantom spaces, in BOTH directions.
  //
  // So decide by GEOMETRY instead of markup: insert only when the pair is visually
  // separated - a horizontal gap on the same line, or a line break between them. The clone
  // must already be attached to the (off-screen) host for the rects to be real, hence the
  // call order in extractMaskedInnerText.
  const MIN_VISUAL_GAP_PX = 0.5;
  function isVisuallySeparated(cur, nxt) {
    const rc = cur.getClientRects();
    const rn = nxt.getClientRects();
    if (!rc.length || !rn.length) return false;
    const a = rc[rc.length - 1];
    const b = rn[0];
    // Different line boxes (wrap, or a block-ish sibling): innerText already breaks there
    // on both sides, but a space keeps the words apart in the flattened text.
    const sameLine = Math.abs(b.top - a.top) < Math.max(1, Math.min(a.height, b.height) * 0.5);
    if (!sameLine) return true;
    return b.left - a.right > MIN_VISUAL_GAP_PX;
  }
  function insertSpacesBetweenAdjacentInlineElements(root) {
    const stack = [root];
    const pending = [];
    while (stack.length) {
      const parent = stack.pop();
      const nodes = [...parent.childNodes];
      for (let i = nodes.length - 2; i >= 0; i--) {
        const cur = nodes[i];
        const nxt = nodes[i + 1];
        if (cur.nodeType !== 1 || nxt.nodeType !== 1) continue;
        if (!isInlineElement(cur) || !isInlineElement(nxt)) continue;
        if (!isVisuallySeparated(cur, nxt)) continue;
        // Collect first, insert after the whole walk: mutating mid-walk reflows the
        // clone and would move every rect measured after it.
        pending.push([parent, nxt]);
      }
      for (const n of parent.childNodes) {
        if (n.nodeType === 1) stack.push(n);
      }
    }
    for (const [parent, nxt] of pending) parent.insertBefore(document.createTextNode(" "), nxt);
  }

  // Rewrite every <a href> in the clone to markdown "[text](target)" so the link
  // target rides along in innerText (plain innerText drops href entirely, hiding
  // link-only differences from the comparison). The target is normalized to an
  // origin-relative path for same-origin links, so prod and stage — served from
  // different domains — don't diff on every internal link; cross-origin links keep
  // their full URL (identical on both sides).
  //
  // Media-asset URLs would still differ (a CMS media path vs a DAM CDN URL for the
  // SAME file), so they are masked out at COMPARISON time — see normalizeText in
  // lib/util.mjs. That masking only has anything to mask because of this rewrite.
  function annotateLinksMarkdown(root) {
    const anchors =
      root.nodeType === 1 && root.tagName === "A" && root.hasAttribute("href")
        ? [root, ...root.querySelectorAll("a[href]")]
        : [...root.querySelectorAll("a[href]")];
    for (const a of anchors) {
      const raw = a.getAttribute("href");
      if (raw == null || !raw.trim()) continue;
      let target = raw.trim();
      try {
        const u = new URL(target, document.baseURI);
        target =
          u.origin === location.origin
            ? (u.pathname.replace(/\/+$/, "") || "/") + u.search + u.hash
            : u.href;
      } catch {
        // Unparseable href (e.g. "javascript:…") — keep the raw attribute value.
      }
      // The target goes in a text-transform:none span, NOT a bare text node.
      // innerText applies the anchor's computed text-transform to whatever is
      // inside it, so an uppercasing link (`text-transform:uppercase`, very common
      // on CTAs) would emit "[LEARN MORE](/ABOUT-CHA)" — a mangled target that also
      // stops the media-URL mask in normalizeText from matching `/-/media/`. The
      // link TEXT is deliberately left transformed: that is visible content, and a
      // casing difference between prod and stage is a real diff worth scoring.
      const open = document.createElement("span");
      open.style.textTransform = "none";
      open.textContent = "[";
      const close = document.createElement("span");
      close.style.textTransform = "none";
      close.textContent = "](" + target + ")";
      a.insertBefore(open, a.firstChild);
      a.appendChild(close);
    }
  }

  // Clone the element, remove descendant component subtrees (top-most marked
  // descendants — removing an ancestor drops its nested components too), then
  // read innerText from an off-screen clone.
  function extractMaskedInnerText(el) {
    const clone = el.cloneNode(true);
    const marks = Array.from(clone.getElementsByClassName(MARK));
    const topMost = marks.filter(
      (m) => !marks.some((p) => p !== m && p.contains(m))
    );
    for (const m of topMost) m.remove();

    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    // Off-screen only — visibility:hidden makes innerText empty in Chromium.
    host.style.cssText =
      "position:fixed;left:-10000px;top:0;width:max-content;max-width:1280px;pointer-events:none;z-index:-1;";
    host.appendChild(clone);
    document.body.appendChild(host);
    try {
      // Attached first: the space insertion is now a geometry test and needs real rects.
      insertSpacesBetweenAdjacentInlineElements(clone);
      // STRICTLY AFTER the geometry pass: this lengthens every link's text, which
      // would move the rects the space insertion measures and silently change where
      // synthetic spaces land. It is purely structural, so it is safe here.
      annotateLinksMarkdown(clone);
      return clone.innerText ?? "";
    } finally {
      host.remove();
    }
  }

  const items = [];
  const empty = [];
  const excluded = [];
  for (const { t, el } of resolved) {
    // Out-of-scope components were still resolved and marked above, so they are masked out of
    // their ancestors — they just never become an element of their own.
    if (t.excluded) {
      excluded.push({ order: t.order, name: t.name });
      continue;
    }
    if (isFixed(el) || !isVisible(el)) {
      empty.push({ order: t.order, name: t.name });
      continue;
    }
    const text = extractMaskedInnerText(el);
    if (!text.replace(/\s+/g, " ").trim()) {
      empty.push({ order: t.order, name: t.name });
      continue;
    }
    items.push({ order: t.order, key: t.key, name: t.name, text });
  }

  return { items, unresolved, empty, excluded };
}
