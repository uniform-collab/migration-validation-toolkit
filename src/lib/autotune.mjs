/**
 * Finds a good --concurrency while a capture is in flight (`--concurrency auto`).
 *
 * The right number of parallel browser contexts depends on the machine, on the server being
 * crawled and on how heavy its pages are - none of which is knowable before the run starts. Too
 * few wastes the run; too many is worse than slow, because a capture does not merely take longer
 * under load, it gets WRONG: a starved page times out and is scraped half-rendered, a shot is taken
 * while the layout is still moving (see waitForLayoutStable in screenshot.mjs - 36 of 40 shots
 * translated at a fixed concurrency 6 against a cold server), a throttled stylesheet leaves text
 * un-transformed. Nothing downstream tells those from real migration differences.
 *
 * So the tuner optimises throughput only among concurrency levels that capture CLEANLY:
 *
 *  - Throughput: every window it compares pages/s against the window before, siphon's
 *    ThreadAutoTuner hill climb - keep a step that beat the baseline by IMPROVEMENT_THRESHOLD,
 *    otherwise revert and try the other direction next. It starts with a multiplicative
 *    slow-start (x1.5 per improving window) instead of +1, because a capture is minutes, not the
 *    hours a siphon download is, and +1 every window would never reach the plateau in time.
 *  - Quality: any window with a degradation signal (a navigation timeout, a throttled response,
 *    a transient non-200 or exception that needed a retry, a shot skipped for an unstable layout,
 *    host memory running out) is a verdict on the concurrency itself. The level is cut by a
 *    quarter at once and becomes a CEILING the climb may not re-enter, so the tuner does not
 *    oscillate back into the level that hurt. The ceiling is lifted by one after CEILING_RELAX
 *    consecutive clean windows, because a cold server's first minute is not the steady state.
 *
 * A window closes once it has lasted `intervalMs` AND completed at least `target` pages, so each
 * worker contributes about one page and one slow page cannot decide a window on its own. Windows
 * with nothing completed hold the level (a stall measures nothing).
 *
 * `decide()` is pure - state in, state out - so the policy is testable without a browser.
 */
import os from "node:os";

export const IMPROVEMENT_THRESHOLD = 0.05;
export const SLOW_START_FACTOR = 1.5;
export const BACKOFF_FACTOR = 0.75;
export const CEILING_RELAX = 6;
/**
 * Windows at the start that are a cold server's, not the steady state's: a degradation there still cuts
 * the level, but sets no ceiling and keeps the multiplicative slow-start. Measured on a 30-core box:
 * the first 16 pages against eight freshly started frontend copies all timed out, the ceiling fell to
 * 2, and relaxing it one step per CEILING_RELAX clean windows held a 100-wide capture at ~5 for hours.
 */
export const WARMUP_WINDOWS = 3;
/**
 * ...and at least this long from the start. A degraded window closes at once, so three windows can
 * pass in seconds: on eight cold frontend copies whose first renders of two listing pages took
 * 11-14 s each, the warm-up was over before the copies were warm and the ceiling fell to 1.
 */
export const WARMUP_MS = 240_000;
/**
 * Resident cost of one worker (a browser context with a heavy page open), measured on a WSP
 * capture: 8 workers held ~4.7 GB.
 */
export const CONTEXT_MEMORY_BYTES = 600 * 1024 * 1024;
/** Free host memory below this fraction of total counts as a degradation signal. */
export const LOW_MEMORY_FRACTION = 0.08;
/**
 * A window is a verdict on its level only when more than this fraction of its pages degraded. One
 * page in a window of 60 is the page, not the level: on a WSP capture single slow pages cut a
 * level of 58 by a quarter, window after window, down to 3. At a low level one page is still more
 * than this, so the tuner stays as careful there as before.
 */
export const TOLERATED_FRACTION = 0.05;
/** Degradation kinds that always count, even when they show at the minimum level. */
export const PERSISTENT_KINDS = new Set(["host memory low"]);

/**
 * Upper bound when --concurrency-max is not given: CPU- or memory-bound, whichever is lower.
 * Memory is what is FREE now, not what is installed - a capture shares the box with the servers
 * it crawls, and past free memory the host swaps and every page times out.
 */
export function defaultMaxConcurrency() {
  const byCpu = Math.max(1, os.cpus().length);
  const byMem = Math.max(1, Math.floor((os.freemem() * 0.8) / CONTEXT_MEMORY_BYTES));
  return Math.max(1, Math.min(byCpu, byMem));
}

export function initialState({ start, min = 1, max }) {
  const lo = Math.max(1, min);
  const hi = Math.max(lo, max);
  return {
    target: clamp(start, lo, hi),
    min: lo,
    max: hi,
    ceiling: hi,
    phase: "slow-start", // then "climb"
    direction: 1,
    baselineScore: -1,
    baselineTarget: 0,
    awaitingVerdict: false,
    cleanStreak: 0,
    windows: 0,
  };
}

/**
 * One window's verdict. `window` = { seconds, completed, degraded, reasons? }.
 * Returns { state, note } - `note` is a human-readable line when something happened, else null.
 */
export function decide(prev, window) {
  const s = { ...prev };
  const current = s.target;
  if (window.completed > 0 || window.degraded > 0) s.windows = (s.windows || 0) + 1;

  // A signal that shows at the minimum level is the pages' own, not the load's: a carousel that never
  // settles, a page that always throws. Measured on a WSP capture: hub pages showed 'unstable layout'
  // at 1, and treating it as a verdict on the level held a 60-wide capture at 1-3. Such a kind stops
  // counting from then on (the pages still record it), and the ceilings it set are lifted.
  // `window.kinds` = { <kind>: <pages> }; a caller that does not pass it keeps the old behaviour.
  if (window.degraded > 0 && window.kinds) {
    const ignored = new Set(s.ignored || []);
    const kinds = Object.keys(window.kinds).filter((k) => !ignored.has(k));
    const fresh = current <= s.min ? kinds.filter((k) => !PERSISTENT_KINDS.has(k)) : [];
    if (fresh.length) {
      s.ignored = [...ignored, ...fresh];
      s.ceiling = s.max;
      s.phase = "slow-start";
      s.direction = 1;
      s.baselineScore = -1;
      s.awaitingVerdict = false;
      s.cleanStreak = 0;
      return {
        state: s,
        note: `${current}: ${fresh.join(", ")} at the minimum level - the pages' own, not load: no longer a degradation signal, ceiling lifted`,
      };
    }
    if (!kinds.length) window = { ...window, degraded: 0 };
    else if (!kinds.some((k) => PERSISTENT_KINDS.has(k)) && window.degraded <= window.completed * TOLERATED_FRACTION) {
      window = { ...window, degraded: 0 };
    }
  }

  if (window.degraded > 0) {
    // `window.sinceStart` (ms since the tuner started) is optional: without it, windows alone decide.
    const warmup = s.windows <= WARMUP_WINDOWS || (window.sinceStart !== undefined && window.sinceStart < WARMUP_MS);
    const cut = Math.max(s.min, Math.min(current - 1, Math.floor(current * BACKOFF_FACTOR)));
    if (!warmup) s.ceiling = Math.max(s.min, current - 1);
    s.target = Math.min(cut, s.ceiling);
    s.phase = warmup ? "slow-start" : "climb";
    s.direction = 1;
    s.baselineScore = -1;
    s.awaitingVerdict = false;
    s.cleanStreak = 0;
    const why = window.reasons?.length ? ` (${window.reasons.join(", ")})` : "";
    return {
      state: s,
      note:
        s.target === current
          ? `${current}: ${window.degraded} degraded page(s)${why} - already at the minimum, holding`
          : `${current}: ${window.degraded} degraded page(s)${why} - backing off to ${s.target}` +
            (warmup ? " (warm-up: no ceiling)" : `, ceiling ${s.ceiling}`),
    };
  }

  if (window.completed === 0) return { state: s, note: null };

  s.cleanStreak++;
  if (s.ceiling < s.max && s.cleanStreak >= CEILING_RELAX) {
    s.ceiling++;
    s.cleanStreak = 0;
  }

  const score = window.score ?? window.completed / Math.max(window.seconds, 0.001);
  const rate = `${score.toFixed(2)} ${window.unit || "pages/s"}`;

  if (s.baselineScore < 0 || !s.awaitingVerdict) {
    s.baselineScore = score;
    s.baselineTarget = current;
    return propose(s, `${current}: baseline ${rate}`);
  }

  if (score > s.baselineScore * (1 + IMPROVEMENT_THRESHOLD)) {
    const note = `${current}: ${rate} beats ${s.baselineScore.toFixed(2)} at ${s.baselineTarget} - keeping it`;
    s.baselineScore = score;
    s.baselineTarget = current;
    return propose(s, note);
  }

  // No better: revert, measure the reverted level afresh, then step the other way.
  const revertTo = s.baselineTarget;
  const note =
    `${current}: ${rate} is no better than ${s.baselineScore.toFixed(2)} at ${revertTo} - ` +
    `reverting to ${revertTo}` + (s.phase === "slow-start" ? ", switching to +/-1 steps" : "");
  if (s.phase === "slow-start") s.phase = "climb";
  else s.direction = -s.direction;
  s.target = revertTo;
  s.baselineScore = -1;
  s.awaitingVerdict = false;
  return { state: s, note };
}

function propose(s, note) {
  const current = s.target;
  const hi = Math.min(s.max, s.ceiling);
  let next =
    s.phase === "slow-start"
      ? Math.max(current + 1, Math.ceil(current * SLOW_START_FACTOR))
      : current + s.direction;
  // A slow-start step that overshoots the bound tries the bound itself - it has not been measured.
  if (s.phase === "slow-start" && next > hi && hi > current) next = hi;
  if (next > hi || next < s.min) {
    if (s.phase === "slow-start") s.phase = "climb";
    s.direction = next > hi ? -1 : 1;
    next = current + s.direction;
  }
  next = clamp(next, s.min, hi);
  if (next === current) {
    s.awaitingVerdict = false;
    return { state: s, note };
  }
  s.target = next;
  s.awaitingVerdict = true;
  return { state: s, note: `${note}; trying ${next}` };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * The live wrapper: counts page outcomes, closes windows on a timer, logs each verdict.
 * Workers read `target` before taking each page; the pool grows or shrinks to it.
 */
export class ConcurrencyTuner {
  constructor({ start, min = 1, max, intervalMs = 15000, log = console.log }) {
    this.state = initialState({ start, min, max });
    this.intervalMs = intervalMs;
    this.log = log;
    this.windowStart = Date.now();
    this.startedAt = this.windowStart;
    this.completed = 0;
    this.units = 0;
    this.busyMs = 0;
    this.degraded = 0;
    this.reasons = new Map();
    this.best = { score: 0, unit: "pages/s", target: this.state.target };
    this.log(
      `[autotune] on: starting at ${this.state.target}, between ${this.state.min} and ${this.state.max}, ` +
        `window >= ${Math.round(intervalMs / 1000)}s and >= one page per worker.`
    );
  }

  get target() {
    return this.state.target;
  }

  /**
   * One page finished. `reasons` = the degradation signals it showed (empty = clean);
   * `counts` = false for work too cheap to measure throughput by (a status-only probe);
   * `units` = how much work the page was (its component count) and `ms` = how long it took.
   */
  record(reasons, counts = true, units = 1, ms = 0) {
    if (counts) {
      this.completed++;
      this.units += Math.max(1, units);
      this.busyMs += Math.max(0, ms);
    }
    if (reasons && reasons.length) {
      this.degraded++;
      for (const r of reasons) this.reasons.set(r, (this.reasons.get(r) || 0) + 1);
    }
  }

  /** Called on a timer. Closes the window when it is due; returns the (possibly new) target. */
  tick(now = Date.now()) {
    const elapsed = now - this.windowStart;
    if (elapsed < this.intervalMs) return this.state.target;
    const memLow = os.freemem() < os.totalmem() * LOW_MEMORY_FRACTION;
    // A window closes only once every worker has had a chance to finish a page. A degraded one closes
    // at once only when its degraded pages already exceed the tolerated share of the level - there
    // is nothing to gain from measuring more of a level that hurts. Closing on the first degraded
    // page judged a level of 58 on the 10-30 pages done in 15 s, where one page is over the share.
    const evident = this.degraded > this.state.target * TOLERATED_FRACTION;
    if (!memLow && !evident && this.completed < this.state.target && elapsed < this.intervalMs * 6) {
      return this.state.target;
    }
    const reasons = [...this.reasons].map(([r, n]) => `${n} ${r}`);
    const kinds = Object.fromEntries(this.reasons);
    if (memLow) {
      reasons.push("host memory low");
      kinds["host memory low"] = 1;
    }
    // Throughput by Little's law - workers x work per busy-second - rather than completions per
    // window: pages differ several-fold in component count, and a window holds only a handful of
    // them, so a count of completions measured the page mix and its own rounding more than the
    // level (the same level read 0.31 and 0.21 pages/s in consecutive windows).
    const score =
      this.busyMs > 0
        ? (this.state.target * this.units) / (this.busyMs / 1000)
        : this.completed / (elapsed / 1000);
    const window = {
      seconds: elapsed / 1000,
      completed: this.completed,
      degraded: this.degraded + (memLow ? 1 : 0),
      reasons,
      kinds,
      sinceStart: now - this.startedAt,
      score,
      unit: this.busyMs > 0 ? "components/s" : "pages/s",
    };
    if (window.degraded === 0 && score > this.best.score) {
      this.best = { score, unit: window.unit, target: this.state.target };
    }
    const { state, note } = decide(this.state, window);
    this.state = state;
    if (note) this.log(`[autotune] ${note}`);
    this.windowStart = now;
    this.completed = 0;
    this.units = 0;
    this.busyMs = 0;
    this.degraded = 0;
    this.reasons = new Map();
    return this.state.target;
  }

  summary() {
    return (
      `[autotune] off: finished at ${this.state.target}; best clean window ` +
      `${this.best.score.toFixed(2)} ${this.best.unit} at ${this.best.target}.`
    );
  }
}
