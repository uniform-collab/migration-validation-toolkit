/**
 * In-page element collection + innerText extraction. The exported function is
 * passed to Playwright's page.evaluate(), so it must be fully self-contained
 * (no imports, no closures). It is a port of the old system's
 * getCaptureSelectors + extractInnerTextForContentCompare
 * (data/screenshots/scripts/screenshot-worker.mjs / utils.js), minus the
 * screenshot-only concerns.
 *
 * Before reading innerText, each element's <a href> links are rewritten in
 * place (on a throwaway clone) to markdown "[text](target)", so link targets
 * are part of the compared text — plain innerText would drop href entirely and
 * hide link-only differences between prod and stage.
 *
 * @param cfg { scopeSelectors: string[],
 *              items: { strategy: "directChildren"|"querySelectorAll", selector?: string },
 *              minHeight?: number,
 *              removeBeforeCapture?: string[] }
 * @returns string[] raw innerText per kept element, in DOM order
 */
export function collectElementTexts(cfg) {
  const minHeight = Number.isFinite(cfg.minHeight) ? cfg.minHeight : 30;

  for (const sel of cfg.removeBeforeCapture || []) {
    document.querySelectorAll(sel).forEach((el) => el.remove());
  }

  let scope = null;
  for (const sel of cfg.scopeSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      scope = el;
      break;
    }
  }
  if (!scope) return [];

  const rawSections =
    cfg.items.strategy === "directChildren"
      ? Array.from(scope.children).filter(
          (el) =>
            el.nodeType === 1 &&
            el.tagName !== "SCRIPT" &&
            el.tagName !== "STYLE"
        )
      : Array.from(scope.querySelectorAll(cfg.items.selector));

  // querySelectorAll can match a component nested inside another match; keep
  // only the outermost so nested markup on one site doesn't inflate its
  // element count relative to the other site.
  const sections =
    cfg.items.strategy === "directChildren"
      ? rawSections
      : rawSections.filter(
          (el) => !rawSections.some((other) => other !== el && other.contains(el))
        );

  const isFixed = (el) => getComputedStyle(el).position === "fixed";
  const isVisible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const isTooSmall = (el) => el.getBoundingClientRect().height < minHeight;

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

  // Rewrite every <a href> in the clone to markdown "[text](target)" so the
  // link target rides along in innerText (plain innerText drops href entirely,
  // hiding link-only differences from the comparison). The target is normalized
  // to an origin-relative path for same-origin links, so prod and stage — served
  // from different domains — don't diff on every internal link; cross-origin
  // links keep their full URL (identical on both sides).
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
      a.insertBefore(document.createTextNode("["), a.firstChild);
      a.appendChild(document.createTextNode("](" + target + ")"));
    }
  }

  // Insert synthetic spaces between adjacent inline elements (</span><span>)
  // so innerText doesn't glue words together where HTML had no text node.
  function insertSpacesBetweenAdjacentInlineElements(root) {
    const stack = [root];
    while (stack.length) {
      const parent = stack.pop();
      const nodes = [...parent.childNodes];
      for (let i = nodes.length - 2; i >= 0; i--) {
        const cur = nodes[i];
        const nxt = nodes[i + 1];
        if (cur.nodeType !== 1 || nxt.nodeType !== 1) continue;
        if (isInlineElement(cur) && isInlineElement(nxt)) {
          parent.insertBefore(document.createTextNode(" "), nxt);
        }
      }
      for (const n of parent.childNodes) {
        if (n.nodeType === 1) stack.push(n);
      }
    }
  }

  function extractInnerText(el) {
    const clone = el.cloneNode(true);
    annotateLinksMarkdown(clone);
    insertSpacesBetweenAdjacentInlineElements(clone);
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    // Off-screen only — visibility:hidden makes innerText empty in Chromium.
    host.style.cssText =
      "position:fixed;left:-10000px;top:0;width:max-content;max-width:1280px;pointer-events:none;z-index:-1;";
    host.appendChild(clone);
    document.body.appendChild(host);
    try {
      const text = clone.innerText ?? "";
      if (text.trim()) return text;
    } finally {
      host.remove();
    }
    return el.innerText ?? "";
  }

  const texts = [];
  for (const el of sections) {
    if (isFixed(el)) continue;
    if (!isVisible(el)) continue;
    if (isTooSmall(el)) continue;
    const text = extractInnerText(el);
    // Text comparison only: an element with no text at all (e.g. image-only)
    // carries no signal and is skipped on both sides.
    if (!text.replace(/\s+/g, " ").trim()) continue;
    texts.push(text);
  }
  return texts;
}
