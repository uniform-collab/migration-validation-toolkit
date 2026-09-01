/**
 * Screenshot capture helpers (V2), shared by capture.mjs.
 *
 * Ported from the migration-validation-toolkit's selector-driven pipeline
 * (screenshot-comparator/scripts/capture-lib.mjs). These operate on a live
 * Playwright page that capture.mjs has already navigated/scrolled, so a single
 * page visit can produce BOTH innerText (content) and screenshots (see the
 * unified capture in capture.mjs, driven by TEST_CAPTURE_MODE).
 */
import fs from "fs";
import path from "path";
import { componentKey, normalizeSelector } from "./index-json.mjs";
import { readImage, writePng } from "./img.mjs";

/** Cookie banners / overlays removed before every capture (JSON array or CSV). */
export function parseOverlaySelectors(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return ["#onetrust-consent-sdk"];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string" && x.trim());
  } catch {
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return ["#onetrust-consent-sdk"];
}

// sharp is only needed to crop very tall screenshots; load it lazily so capture
// still works (crop becomes a no-op) if it is somehow unavailable.
let sharpMod = null;
export async function getSharp() {
  if (sharpMod === null) {
    try {
      sharpMod = (await import("sharp")).default;
    } catch {
      sharpMod = false;
    }
  }
  return sharpMod || null;
}

/**
 * In-flight request tracker, so a shot can wait for the COMPONENT's own data
 * fetch rather than only for the page navigation.
 *
 * Playwright's `networkidle` fires once after the navigation settles. Everything
 * a component fetches later - an IntersectionObserver listing that only queries
 * once it scrolls into view, a client-side search - lands after that, so the
 * shot pass could photograph a spinner or an empty grid on one side and the
 * loaded result on the other. That is real, unattributable +/-0.5pt of run-to-run
 * noise in the visual score, and it is exactly the kind of flake that makes a
 * small regression indistinguishable from luck.
 *
 * Attach ONCE per page, then `await q.idle(...)` before each screenshot. When
 * nothing is in flight it resolves on the next tick, so the common case costs
 * nothing; when something is, it waits for the quiet window (bounded by maxMs).
 * Only same-origin requests count - third-party beacons and analytics never go
 * quiet and would burn the whole budget on every component.
 */
export function attachNetworkQuiescer(page, baseUrl) {
  const origin = (() => {
    try {
      return new URL(baseUrl).origin.toLowerCase();
    } catch {
      return null;
    }
  })();
  const tracked = (req) => {
    if (!origin) return true;
    return req.url().toLowerCase().startsWith(origin);
  };
  let inFlight = 0;
  let lastActivity = Date.now();
  const onStart = (req) => {
    if (!tracked(req)) return;
    inFlight++;
    lastActivity = Date.now();
  };
  const onEnd = (req) => {
    if (!tracked(req)) return;
    inFlight = Math.max(0, inFlight - 1);
    lastActivity = Date.now();
  };
  page.on("request", onStart);
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);

  return {
    /** Resolve once nothing has been in flight for quietMs, or maxMs elapses. */
    async idle(quietMs, maxMs) {
      const deadline = Date.now() + Math.max(0, maxMs);
      for (;;) {
        const quietFor = Date.now() - lastActivity;
        if (inFlight === 0 && quietFor >= quietMs) return true;
        if (Date.now() >= deadline) return false;
        const wait = inFlight > 0 ? 50 : Math.min(quietMs - quietFor, 50);
        await page.waitForTimeout(Math.max(10, wait)).catch(() => {});
      }
    },
    detach() {
      page.off("request", onStart);
      page.off("requestfinished", onEnd);
      page.off("requestfailed", onEnd);
    },
  };
}

export async function removeOverlayElements(page, overlaySelectors) {
  if (!overlaySelectors || !overlaySelectors.length) return;
  await page
    .evaluate((sels) => {
      for (const raw of sels) {
        const sel = String(raw).trim();
        if (!sel) continue;
        try {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        } catch {}
      }
    }, overlaySelectors)
    .catch(() => {});
}

export async function freezeAnimations(page) {
  await page.addStyleTag({
    content: `
      * { animation: none !important; transition: none !important; transform: none !important; }
      *::before, *::after { animation: none !important; transition: none !important; }
      [class*="carousel"], [class*="slider"], [class*="marquee"], [class*="animated"] {
        animation: none !important; transition: none !important; transform: none !important;
      }
      video { object-position: 0% 0% !important; }
    `,
  });
  await page.waitForTimeout(500);
  await page
    .evaluate(async () => {
      window.requestAnimationFrame = () => {};
      window.setInterval = () => 0;
      window.setTimeout = () => 0;
      document.querySelectorAll("video").forEach((v) => {
        try {
          v.pause();
        } catch {}
      });
      // Bake animated GIFs to a static first frame so they diff deterministically.
      const gifImgs = [...document.querySelectorAll('img[src$=".gif"]')];
      await Promise.all(
        gifImgs.map(
          (imgElement) =>
            new Promise((resolve) => {
              try {
                const src = imgElement.src;
                const tempImg = new Image();
                tempImg.crossOrigin = "anonymous";
                tempImg.src = src + (src.includes("?") ? "&fcb=1" : "?fcb=1");
                tempImg.onload = () => {
                  try {
                    const canvas = document.createElement("canvas");
                    canvas.width = tempImg.naturalWidth;
                    canvas.height = tempImg.naturalHeight;
                    canvas.getContext("2d").drawImage(tempImg, 0, 0);
                    imgElement.src = canvas.toDataURL("image/png");
                  } catch {}
                  resolve();
                };
                tempImg.onerror = () => resolve();
              } catch {
                resolve();
              }
            })
        )
      );
      const toastEl = document.querySelector('[id^="nextjs-toast"], .nextjs-toast-container, .nextjs-toast');
      if (toastEl) toastEl.remove();
    })
    .catch(() => {});
}

/** Resolve each target selector (with #wrapper rebase) and tag matches with
 *  data-sel-comp-id + a marker class. Returns { resolved:[order], unresolved:[] }. */
export async function resolveAndTagTargets(page, targets, rebaseRules) {
  const payload = targets.map((t) => ({
    order: t.order,
    name: t.name,
    normalized: normalizeSelector(t.selector, rebaseRules),
    index: t.index || 0,
    levelsUp: t.levelsUp || 0,
  }));
  return await page.evaluate((ts) => {
    const resolved = [];
    const unresolved = [];
    // Selector + index + levelsUp — see "How a target resolves to an element" in index-json.mjs.
    const resolveTarget = (t) => {
      let list;
      try {
        list = document.querySelectorAll(t.normalized);
      } catch {
        return null;
      }
      let el = list[t.index || 0];
      for (let i = 0; el && i < (t.levelsUp || 0); i++) el = el.parentElement;
      return el || null;
    };
    for (const t of ts) {
      const el = resolveTarget(t);
      if (el) {
        el.setAttribute("data-sel-comp-id", String(t.order));
        el.classList.add("__sel_comp__");
        resolved.push(t.order);
      } else {
        unresolved.push({ order: t.order, name: t.name });
      }
    }
    return { resolved, unresolved };
  }, payload);
}

async function restoreMasks(page) {
  await page
    .evaluate(() => {
      if (Array.isArray(window.__selMask)) {
        for (const { ph, node } of window.__selMask) {
          if (ph && ph.parentNode) ph.replaceWith(node);
        }
      }
      window.__selMask = [];
      if (Array.isArray(window.__selHidden)) {
        for (const el of window.__selHidden) {
          const orig = el.getAttribute("data-sel-orig-visibility");
          el.style.visibility = orig || "";
          el.removeAttribute("data-sel-orig-visibility");
        }
      }
      window.__selHidden = [];
    })
    .catch(() => {});
}

/**
 * The host's rect in DOCUMENT coordinates, plus the page height — one round-trip,
 * which also forces a synchronous layout flush (getBoundingClientRect does).
 *
 * Document, not viewport, coordinates on purpose: this is the same quantity
 * Playwright reconstructs for the capture clip (`boundingBox()` + `window.scrollY`,
 * read in two SEPARATE round-trips), so sampling it is what tells us whether that
 * clip is still valid. `scrollHeight` rides along because a page that is still
 * growing is about to move this element even when its own rect has not changed yet.
 */
async function hostDocRect(page, order) {
  return await page
    .evaluate((o) => {
      const host = document.querySelector(`[data-sel-comp-id="${o}"]`);
      if (!host) return null;
      const b = host.getBoundingClientRect();
      return {
        x: Math.round(b.x + window.scrollX),
        y: Math.round(b.y + window.scrollY),
        w: Math.round(b.width),
        h: Math.round(b.height),
        docH: Math.round(document.documentElement.scrollHeight),
      };
    }, order)
    .catch(() => null);
}

function sameRect(a, b, tolerance = 1) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance &&
    Math.abs(a.h - b.h) <= tolerance &&
    Math.abs(a.docH - b.docH) <= tolerance
  );
}

/**
 * Block until the host has stopped moving, then hand back its settled rect.
 *
 * Why this exists. `elementHandle.screenshot()` has NO layout-stability guarantee:
 * Playwright measures the element (`boundingBox()`), reads `window.scrollY` in a
 * second round-trip, adds them into a document rect, and only THEN asks Chromium to
 * rasterize it (`Page.captureScreenshot`, with `captureBeyondViewport` whenever the
 * element does not fit the viewport - which any element wider than 1280px does not).
 * Anything that relaids out in between - a Suspense fallback collapsing, a late image,
 * a font swap - moves the pixels while the clip stays put, and the shot comes back as
 * the CORRECT picture translated by N px: N blank rows at one edge, N lost rows at the
 * other. Playwright waits for a stable position before a click (`rafCountForStablePosition`)
 * and for nothing at all before a screenshot, so the harness has to do it here.
 *
 * Measured on 40 CHT article pages against a cold server at concurrency 6: 36 of 40
 * `Article Detail` shots came back translated by 8-107px, and the same 40 came back
 * clean once the layout had settled. In cha/413 it hit 311 of 439 shots of that one
 * component. Nothing downstream detects it - the image looks like a real rendering
 * difference and just scores badly.
 *
 * Cost when the page is already still (the normal case): two round-trips and one
 * `pollMs` sleep. `pollMs = 0` disables the gate entirely.
 *
 * @returns {Promise<{rect: object|null, stable: boolean}>}
 */
export async function waitForLayoutStable(page, order, pollMs, maxMs) {
  let rect = await hostDocRect(page, order);
  if (!pollMs || pollMs <= 0 || !rect) return { rect, stable: true };
  const deadline = Date.now() + Math.max(0, maxMs);
  for (;;) {
    await page.waitForTimeout(pollMs).catch(() => {});
    const next = await hostDocRect(page, order);
    if (!next) return { rect, stable: false };
    if (sameRect(rect, next)) return { rect: next, stable: true };
    rect = next;
    if (Date.now() >= deadline) return { rect, stable: false };
  }
}

/**
 * Take the element's picture WITHOUT `elementHandle.screenshot()`, by scrolling it past
 * the viewport a band at a time and stitching the viewport rasters together.
 *
 * Why not just use elementHandle.screenshot(). It hands CDP the element's whole box, so
 * anything bigger than the viewport arrives as `Page.captureScreenshot({captureBeyondViewport:
 * true})` - and on that path Chromium relays the page out at a degenerate viewport and back
 * (two `Page.frameResized` during the capture; media queries flip all the way down to
 * `max-height: 50px`, while JS timers never observe it) before rasterizing at coordinates
 * measured beforehand. Shots that come back as the CORRECT picture translated by N px - N
 * blank rows at one edge, N real rows lost at the other - only ever appeared on that path:
 * 311 of 439 `Article Detail` shots in cha/413 at 1310x635, none at 1280x719 once the element
 * fit. Nothing downstream can tell a translated shot from a real rendering difference.
 *
 * A viewport-sized clip never takes that path (`captureBeyondViewport: false`, zero
 * frameResized), so every band here is a plain viewport raster. `page.screenshot({clip})`
 * on that path is BOTH capped at the viewport and measured FROM it - ask for 3000px in a
 * 720px viewport and 720px come back, silently - which is exactly why the bands have to be
 * cut by hand rather than by one tall clip.
 *
 * Output geometry is deliberately identical to what elementHandle.screenshot() produced:
 * a rect.w x rect.h canvas, with anything off-canvas left WHITE (an element wider than the
 * document already came back with white margins). That keeps the images comparable with the
 * frozen prod baseline, so the mechanism can change without re-capturing it.
 *
 * Scroll is read back rather than assumed: `scrollTo` clamps near the document end, so the
 * band's viewport-relative position is derived from where the page ACTUALLY landed.
 *
 * @returns {Promise<Buffer|null>} PNG buffer, or null if the element could not be resolved.
 */
export async function captureStitched(page, order, sharp, opts) {
  const { maxHeight = 9000, bandSettleMs = 50 } = opts || {};
  const geom = await page
    .evaluate((o) => {
      const host = document.querySelector(`[data-sel-comp-id="${o}"]`);
      if (!host) return null;
      const b = host.getBoundingClientRect();
      // Playwright's own rounding (helper.enclosingIntRect), reproduced verbatim so the
      // stitched image is the SAME size as the element shot down to the pixel - `Math.round`
      // on the width lands 1px short about half the time, and the compare treats a >2px size
      // disagreement as content.
      const x = Math.floor(b.x + window.scrollX + 1e-3);
      const y = Math.floor(b.y + window.scrollY + 1e-3);
      const x2 = Math.ceil(b.x + window.scrollX + b.width - 1e-3);
      const y2 = Math.ceil(b.y + window.scrollY + b.height - 1e-3);
      return { x, y, w: x2 - x, h: y2 - y, vw: window.innerWidth, vh: window.innerHeight };
    }, order)
    .catch(() => null);
  if (!geom || geom.w <= 0 || geom.h <= 0) return null;

  const height = Math.min(geom.h, maxHeight);
  const multiTile = height > geom.vh || geom.w > geom.vw;
  const bands = [];
  // Tiles, not just rows: an element can also be WIDER than the viewport (448 shots in
  // cha/420), and on a page that really scrolls sideways those columns carry content, not
  // margin. Where the page refuses to scroll that far - `overflow-x: hidden`, or simply
  // nothing there - the scroll read-back clamps, the tile lands outside the viewport, and
  // the region is left white, which is exactly what the element-shot path returned for it.
  for (let top = 0; top < height; top += geom.vh) {
    const bandH = Math.min(geom.vh, height - top);
    for (let left = 0; left < geom.w; left += geom.vw) {
      const bandW = Math.min(geom.vw, geom.w - left);
      const scrolled = await page.evaluate(
        ([targetX, targetY]) => {
          window.scrollTo(targetX, targetY);
          return { sx: window.scrollX, sy: window.scrollY };
        },
        [Math.max(0, geom.x + left), geom.y + top]
      );
      if (multiTile) await page.waitForTimeout(bandSettleMs).catch(() => {});

      // Where this tile sits in the viewport, clamped to it.
      const clipX = geom.x + left - scrolled.sx;
      const clipY = geom.y + top - scrolled.sy;
      const x0 = Math.max(0, clipX);
      const y0 = Math.max(0, clipY);
      const x1 = Math.min(geom.vw, clipX + bandW);
      const y1 = Math.min(geom.vh, clipY + bandH);
      if (x1 <= x0 || y1 <= y0) continue;

      const buf = await page.screenshot({
        clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      });
      bands.push({
        input: buf,
        left: Math.round(left + (x0 - clipX)),
        top: Math.round(top + (y0 - clipY)),
      });
    }
  }

  const canvas = sharp({
    create: { width: geom.w, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  });
  return await canvas.composite(bands).png().toBuffer();
}

// Read/write through buffers, not paths: the deepest component screenshots cross
// Windows MAX_PATH and libvips cannot open those by name. See lib/img.mjs.
async function cropImageHeightIfNeeded(imgPath, maxHeight) {
  try {
    const image = await readImage(imgPath);
    const metadata = await image.metadata();
    if (metadata.height > maxHeight) {
      await writePng(imgPath, image.extract({ top: 0, left: 0, width: metadata.width, height: maxHeight }));
    }
  } catch (e) {
    console.warn(`  could not crop ${imgPath}: ${e.message}`);
  }
}

/**
 * Screenshot every resolved target under pageDir, masking descendant components
 * first (top-most descendants replaced by same-size transparent placeholders) so
 * a parent's shot doesn't duplicate children captured in their own shots.
 * Assumes resolveAndTagTargets already tagged the DOM.
 *
 * `skippedEmpty` carries a `reason`: `zero-size` / `below-min-height` are capture
 * THRESHOLDS (the element is there but not worth a picture), `unstable-layout` is the
 * harness refusing to publish a shot it could not take cleanly. All three reach the
 * compare through the same `skipped` list and score as "not compared".
 *
 * @returns {Promise<{captured: {order,key,name}[], skippedEmpty: object[]}>}
 */
export async function captureResolvedTargets(page, targets, resolution, pageDir, opts) {
  const {
    suffix,
    minHeight,
    maxHeight,
    sharp,
    keys,
    quiescer,
    idleQuietMs = 250,
    idleMaxMs = 3000,
    stablePollMs = 50,
    stableMaxMs = 2000,
    stitch = true,
  } = opts;
  const byOrder = new Map(targets.map((t) => [t.order, t]));
  const captured = [];
  const skippedEmpty = [];

  for (const order of resolution.resolved) {
    const target = byOrder.get(order);
    if (!target) continue;
    // Out-of-scope components stay tagged (so they are masked out of their parents' shots) but
    // never get a shot of their own — the same contract the content pass uses.
    if (target.excluded) continue;
    // Same keys the content pass used, so a component's text and its screenshot stay paired.
    const key = keys?.get(order) ?? componentKey(target);

    try {
      const prep = await page.evaluate((o) => {
        const host = document.querySelector(`[data-sel-comp-id="${o}"]`);
        if (!host) return { ok: false, reason: "host-not-found" };
        const inHeader = !!host.closest("header");

        const comps = Array.from(document.querySelectorAll(".__sel_comp__"));
        const descendants = comps.filter((c) => c !== host && host.contains(c));
        const topMost = descendants.filter((c) => !descendants.some((p) => p !== c && p.contains(c)));
        window.__selMask = [];
        for (const child of topMost) {
          const rect = child.getBoundingClientRect();
          const ph = document.createElement("div");
          ph.setAttribute("data-hint", "child-placeholder");
          ph.style.cssText =
            `width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;` +
            "margin:0;padding:0;border:0;background:transparent;box-sizing:border-box;";
          child.replaceWith(ph);
          window.__selMask.push({ ph, node: child });
        }

        window.__selHidden = [];
        const header = document.querySelector("header");
        for (const el of Array.from(document.body.querySelectorAll("*"))) {
          if (el === host || host.contains(el)) continue;
          const style = window.getComputedStyle(el);
          const isFixed = style.position === "fixed" || style.position === "sticky";
          const isHeader = el === header && !inHeader;
          if (isFixed || isHeader) {
            el.setAttribute("data-sel-orig-visibility", el.style.visibility || "");
            el.style.visibility = "hidden";
            window.__selHidden.push(el);
          }
        }

        const box = host.getBoundingClientRect();
        return { ok: true, width: Math.round(box.width), height: Math.round(box.height) };
      }, order);

      if (!prep.ok) {
        await restoreMasks(page);
        continue;
      }
      if (prep.width === 0 || prep.height < minHeight) {
        // `key` travels with the skip so the compare can tell a deliberate
        // one-side skip from a component that genuinely is not there.
        skippedEmpty.push({ order, key, name: target.name, width: prep.width, height: prep.height, reason: prep.width === 0 ? "zero-size" : "below-min-height" });
        await restoreMasks(page);
        continue;
      }

      const element = await page.$(`[data-sel-comp-id="${order}"]`);
      if (!element) {
        await restoreMasks(page);
        continue;
      }

      const compDir = path.join(pageDir, key);
      fs.mkdirSync(compDir, { recursive: true });
      const filePath = path.join(compDir, `${key}${suffix}.png`);

      await element.evaluate((el) => el.scrollIntoView({ behavior: "auto", block: "center" }));
      await page.waitForTimeout(400);

      // Scrolling the element into view is what arms an IntersectionObserver, so
      // its data fetch starts HERE - after the page-level networkidle already
      // passed. Wait for it (cheap no-op when nothing is in flight) before the
      // image-decode wait below, which only covers <img> that already exist.
      if (quiescer) await quiescer.idle(idleQuietMs, idleMaxMs);

      await Promise.race([
        element.evaluate(async (el) => {
          const images = el.querySelectorAll("img");
          await Promise.all(
            Array.from(images).map((img) => {
              if (img.complete) return Promise.resolve();
              return new Promise((resolve) => {
                img.onload = () => resolve();
                img.onerror = () => resolve();
              });
            })
          );
        }),
        page.waitForTimeout(5000),
      ]);
      await page.waitForTimeout(200);

      const box = await element.boundingBox();
      if (!box || box.width === 0 || box.height === 0) {
        skippedEmpty.push({ order, key, name: target.name, width: 0, height: 0, reason: "zero-size" });
        await restoreMasks(page);
        continue;
      }

      // Shoot only once the element has stopped moving, and prove afterwards that it
      // did not move THROUGH the raster - a shot taken across a relayout is the right
      // picture at the wrong offset (see waitForLayoutStable). One retry, because the
      // thing that moved it is nearly always a one-off (a fallback collapsing, an image
      // landing); if it moves twice the page is genuinely unsettled and a shot from it
      // would be a lie, so drop it into `skipped` instead - the compare already reads
      // that list and scores such a pair as "not compared" rather than as a diff.
      let shotRect = null;
      let unstable = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await waitForLayoutStable(page, order, stablePollMs, stableMaxMs);
        // Stitching needs sharp to composite the bands; with sharp unavailable (it is an
        // optional dependency here) fall back to the element shot rather than skip the page.
        let stitched = null;
        if (stitch && sharp) {
          stitched = await captureStitched(page, order, sharp, { maxHeight }).catch((e) => {
            console.warn(`  stitch failed for ${key}, falling back: ${String(e.message || e).slice(0, 120)}`);
            return null;
          });
        }
        if (stitched) fs.writeFileSync(filePath, stitched);
        else await element.screenshot({ path: filePath });
        const after = await hostDocRect(page, order);
        if (!stablePollMs || stablePollMs <= 0 || sameRect(before.rect, after)) {
          shotRect = after || before.rect;
          unstable = null;
          break;
        }
        unstable = { before: before.rect, after };
        fs.rmSync(filePath, { force: true });
      }

      if (unstable) {
        console.warn(
          `  unstable layout, not shooting ${key}: moved ${JSON.stringify(unstable.before)} -> ${JSON.stringify(unstable.after)}`
        );
        skippedEmpty.push({
          order,
          key,
          name: target.name,
          width: prep.width,
          height: prep.height,
          reason: "unstable-layout",
        });
        await restoreMasks(page);
        continue;
      }

      if (sharp) await cropImageHeightIfNeeded(filePath, maxHeight);
      captured.push({ order, key, name: target.name });
    } catch (err) {
      console.warn(`  failed to screenshot ${key}: ${String(err.message || err).slice(0, 200)}`);
    } finally {
      await restoreMasks(page);
    }
  }

  return { captured, skippedEmpty };
}
