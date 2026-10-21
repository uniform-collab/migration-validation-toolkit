import test from "node:test";
import assert from "node:assert/strict";
import { initialState, decide, WARMUP_WINDOWS } from "./autotune.mjs";

const clean = (completed, seconds = 10) => ({ seconds, completed, degraded: 0 });
const bad = (completed = 5) => ({ seconds: 10, completed, degraded: 1, reasons: ["1 nav-timeout"] });

test("slow start grows multiplicatively while throughput improves", () => {
  let s = initialState({ start: 4, max: 32 });
  ({ state: s } = decide(s, clean(10))); // baseline at 4
  assert.equal(s.target, 6);
  ({ state: s } = decide(s, clean(15))); // better -> keep, grow
  assert.equal(s.target, 9);
  ({ state: s } = decide(s, clean(15))); // no better -> revert to 6, switch to +/-1
  assert.equal(s.target, 6);
  assert.equal(s.phase, "climb");
  ({ state: s } = decide(s, clean(15))); // fresh baseline at 6 -> try 7
  assert.equal(s.target, 7);
});

test("a slow-start step past the max tries the max itself", () => {
  let s = initialState({ start: 9, max: 11 });
  ({ state: s } = decide(s, clean(10)));
  assert.equal(s.target, 11);
});

test("hill climb reverses after a step that did not help", () => {
  let s = { ...initialState({ start: 6, max: 32 }), phase: "climb" };
  ({ state: s } = decide(s, clean(10))); // baseline 6 -> 7
  assert.equal(s.target, 7);
  ({ state: s } = decide(s, clean(10))); // no better -> revert to 6, direction flips
  assert.equal(s.target, 6);
  assert.equal(s.direction, -1);
  ({ state: s } = decide(s, clean(10))); // baseline 6 -> 5
  assert.equal(s.target, 5);
});

test("a degraded window backs off and caps the climb below the level that hurt", () => {
  let s = { ...initialState({ start: 12, max: 32 }), phase: "climb", windows: WARMUP_WINDOWS };
  ({ state: s } = decide(s, bad()));
  assert.equal(s.target, 9);
  assert.equal(s.ceiling, 11);
  // Climbing never proposes a level above the ceiling.
  for (let i = 0; i < 4; i++) ({ state: s } = decide(s, clean(100 + i * 50)));
  assert.ok(s.target <= 11, `target ${s.target} above ceiling`);
});

test("the ceiling relaxes after enough clean windows", () => {
  let s = { ...initialState({ start: 8, max: 32 }), phase: "climb", windows: WARMUP_WINDOWS };
  ({ state: s } = decide(s, bad()));
  const capped = s.ceiling;
  for (let i = 0; i < 6; i++) ({ state: s } = decide(s, clean(10)));
  assert.equal(s.ceiling, capped + 1);
});

test("a degraded warm-up window cuts the level but sets no ceiling and keeps the slow start", () => {
  let s = initialState({ start: 16, max: 100 });
  ({ state: s } = decide(s, bad())); // a cold server's first window
  assert.equal(s.target, 12);
  assert.equal(s.ceiling, 100);
  assert.equal(s.phase, "slow-start");
  ({ state: s } = decide(s, clean(10))); // baseline at 12, slow start proposes x1.5
  assert.equal(s.target, 18);
  // Past the warm-up the old rule holds: a degraded window caps the climb.
  s = { ...s, windows: WARMUP_WINDOWS };
  ({ state: s } = decide(s, bad()));
  assert.equal(s.ceiling, 17);
});

test("never goes below min or above max, and holds on an empty window", () => {
  let s = initialState({ start: 1, max: 2 });
  ({ state: s } = decide(s, bad()));
  assert.equal(s.target, 1);
  const before = s;
  ({ state: s } = decide(s, clean(0)));
  assert.deepEqual(s, before);
  s = initialState({ start: 2, max: 2 });
  ({ state: s } = decide(s, clean(10)));
  assert.ok(s.target >= 1 && s.target <= 2);
});


test("a kind seen at the minimum level stops counting and lifts the ceiling", () => {
  const layout = (completed = 2) => ({ seconds: 20, completed, degraded: 1, reasons: ["1 unstable layout"], kinds: { "unstable layout": 1 } });
  let s = { ...initialState({ start: 1, max: 60 }), windows: WARMUP_WINDOWS, ceiling: 1 };
  let note;
  ({ state: s, note } = decide(s, layout())); // at the minimum: the pages' own
  assert.deepEqual(s.ignored, ["unstable layout"]);
  assert.equal(s.ceiling, 60);
  assert.match(note, /no longer a degradation signal/);
  ({ state: s } = decide(s, clean(4, 20))); // baseline at 1 -> slow start
  assert.equal(s.target, 2);
  ({ state: s } = decide(s, layout(8))); // the ignored kind alone is a clean window: better -> keep, grow
  assert.equal(s.ceiling, 60);
  assert.equal(s.target, 3);
});

test("host memory low counts even at the minimum level", () => {
  let s = { ...initialState({ start: 1, max: 60 }), windows: WARMUP_WINDOWS };
  ({ state: s } = decide(s, { seconds: 20, completed: 2, degraded: 1, reasons: ["host memory low"], kinds: { "host memory low": 1 } }));
  assert.equal(s.ignored, undefined);
  assert.equal(s.target, 1);
});

test("a kind seen above the minimum still backs off", () => {
  let s = { ...initialState({ start: 8, max: 60 }), windows: WARMUP_WINDOWS };
  ({ state: s } = decide(s, { seconds: 20, completed: 2, degraded: 1, reasons: ["1 unstable layout"], kinds: { "unstable layout": 1 } }));
  assert.equal(s.target, 6);
  assert.equal(s.ceiling, 7);
  assert.equal(s.ignored, undefined);
});