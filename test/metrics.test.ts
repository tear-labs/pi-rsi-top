import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { computeRowValues, metricSpecs } from "../src/metrics.ts";
import { buildRows } from "../src/dashboard.ts";
import type { CodeDistance, DashboardRow, MetricKind, Run, SessionSnapshot } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(
  n: number,
  metric: number,
  over: Partial<Run> = {},
): Run {
  return {
    run: n,
    commit: `c${n}`,
    metric,
    metrics: {},
    status: "keep",
    description: `run ${n}`,
    timestamp: 1_000_000 + n * 60_000,
    segment: 1,
    confidence: null,
    ...over,
  };
}

/** Similarity by commit-index distance: identical commits -> 1, further apart -> lower. */
const simByIndex: CodeDistance = (a, b) => {
  const ia = Number(a.replace("c", ""));
  const ib = Number(b.replace("c", ""));
  if (!Number.isFinite(ia) || !Number.isFinite(ib)) return null;
  const delta = Math.abs(ia - ib);
  return 1 / (1 + delta);
};

function assertAllNullable(values: Record<string, number | null>): void {
  for (const [name, v] of Object.entries(values)) {
    assert.ok(
      v === null || (typeof v === "number" && Number.isFinite(v)),
      `${name} must be null or finite, got ${String(v)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry has exactly 24 metrics in the documented kinds", () => {
  const specs = metricSpecs();
  assert.equal(specs.length, 24);
  const byKind: Record<MetricKind, number> = { unary: 0, binary: 0, region: 0, global: 0 };
  for (const s of specs) byKind[s.kind] += 1;
  assert.deepEqual(byKind, { unary: 3, binary: 7, region: 10, global: 4 });
  assert.equal(new Set(specs.map((s) => s.name)).size, 24);
  // stable order: kinds grouped in declared order
  const order = specs.map((s) => s.kind);
  const firstRegion = order.indexOf("region");
  assert.ok(order.lastIndexOf("binary") < firstRegion);
  assert.ok(order.lastIndexOf("region") < order.indexOf("global"));
  for (const s of specs) assert.ok(s.description.length > 0);
});

test("registry is a defensive copy", () => {
  const a = metricSpecs();
  a.pop();
  assert.equal(metricSpecs().length, 24);
});

// ---------------------------------------------------------------------------
// Safety / nullability
// ---------------------------------------------------------------------------

test("computing out of range or empty history never throws and yields all-null", () => {
  for (const [history, index] of [
    [[], 0],
    [[run(1, 10)], 5],
    [[run(1, 10)], -1],
    [[run(1, 10)], 1.5],
  ] as const) {
    const v = computeRowValues([...history], index);
    assertAllNullable(v);
    assert.equal(Object.keys(v).length, 24);
    assert.ok(Object.values(v).every((x) => x === null), `index ${index} must be all null`);
  }
});

test("first run: no parent metrics are null, unary metrics present", () => {
  const history = [run(1, 100)];
  const v = computeRowValues(history, 0);
  assert.equal(v["parent_gain"], null);
  assert.equal(v["parent_code_distance"], null);
  assert.equal(v["meaningful_relative_gain"], null);
  assert.equal(v["cycles"], 100);
  assert.equal(v["valid_attempt"], 1);
  assert.equal(v["parent_selection_concentration"], null);
  assert.equal(v["window_frontier_gain"], null);
  // globally computable even at run 0
  assert.equal(v["frontier_epoch_age_steps"], 0);
  assert.equal(v["frontier_improvement_count"], 1);
});

test("zero metric yields 0 or null, never NaN/Infinity", () => {
  const history = [run(1, 0), run(2, 0), run(3, 0)];
  for (let i = 0; i < history.length; i++) {
    const v = computeRowValues(history, i);
    assertAllNullable(v);
    assert.equal(v["cycles"], 0);
  }
  assert.equal(computeRowValues(history, 1)["frontier_relative_gap"], 0);
  assert.equal(computeRowValues(history, 1)["meaningful_relative_gain"], null);
});

test("duplicate timestamps and crash/checks_failed statuses are handled", () => {
  const history = [
    run(1, 10, { timestamp: 5_000 }),
    run(2, 8, { timestamp: 5_000, status: "crash" }),
    run(3, 6, { timestamp: 5_000, status: "checks_failed" }),
    run(4, 7, { timestamp: 5_000, status: "discard" }),
  ];
  for (let i = 0; i < history.length; i++) assertAllNullable(computeRowValues(history, i));
  assert.equal(computeRowValues(history, 1)["valid_attempt"], 0);
  assert.equal(computeRowValues(history, 3)["valid_attempt"], 1);
  assert.equal(computeRowValues(history, 1)["seconds_since_meaningful_improvement"], 0);
  // two of four runs in the window produced a usable measurement
  assert.equal(computeRowValues(history, 3)["window_valid_rate"], 0.5);
});

test("code distance absent -> all similarity metrics null", () => {
  const history = [run(1, 10), run(2, 9), run(3, 8)];
  for (let i = 0; i < history.length; i++) {
    const v = computeRowValues(history, i);
    assert.equal(v["parent_code_distance"], null);
    assert.equal(v["frontier_code_distance"], null);
    assert.equal(v["nearest_history_similarity"], null);
    assert.equal(v["window_redundancy_rate"], null);
  }
});

test("throwing or null-returning codeDistance is tolerated", () => {
  const throwing: CodeDistance = () => {
    throw new Error("git unavailable");
  };
  const returningNull: CodeDistance = () => null;
  const history = [run(1, 10), run(2, 9)];
  for (const fn of [throwing, returningNull]) {
    const v = computeRowValues(history, 1, { codeDistance: fn });
    assertAllNullable(v);
    assert.equal(v["parent_code_distance"], null);
    assert.equal(v["nearest_history_similarity"], null);
  }
});

// ---------------------------------------------------------------------------
// Unary + binary
// ---------------------------------------------------------------------------

test("parent gain respects direction and distance sign convention", () => {
  const history = [run(1, 10), run(2, 8)];
  const lower = computeRowValues(history, 1, { direction: "lower", codeDistance: simByIndex });
  assert.equal(lower["parent_gain"], 2);
  // simByIndex("c1","c2") = 1/(1+1) = 0.5, so distance = 0.5
  assert.equal(lower["parent_code_distance"], 0.5);
  const higherGain = computeRowValues(history, 1, { direction: "higher" })["parent_gain"];
  assert.equal(higherGain, -2);
  // identical commit -> distance 0
  const same = computeRowValues([run(1, 5), run(2, 5, { commit: "c1" })], 1, {
    codeDistance: simByIndex,
  });
  assert.equal(same["parent_code_distance"], 0);
});

test("frontier metrics: gap is zero at the frontier and grows for worse runs", () => {
  const history = [run(1, 10), run(2, 5), run(3, 8)];
  const v0 = computeRowValues(history, 0);
  const v1 = computeRowValues(history, 1);
  const v2 = computeRowValues(history, 2);
  assert.equal(v0["frontier_relative_gap"], 0);
  assert.equal(v1["frontier_relative_gap"], 0); // run 2 is the new frontier
  assert.equal(v2["frontier_relative_gap"], 3 / 8); // (8-5)/8
  assert.ok((v2["frontier_relative_gap"] ?? -1) > 0);
  // "higher" direction flips which run is the frontier
  const h1 = computeRowValues(history, 1, { direction: "higher" });
  assert.ok((h1["frontier_relative_gap"] ?? -1) > 0);
  const h2 = computeRowValues(history, 2, { direction: "higher" });
  assert.ok((h2["frontier_relative_gap"] ?? -1) > 0);
  assert.equal(computeRowValues(history, 0, { direction: "higher" })["frontier_relative_gap"], 0);
});

test("frontier_relative_gap is monotone: better score -> smaller gap", () => {
  const frontierMetric = 100;
  const scores = [110, 105, 101, 100];
  let previous = Number.POSITIVE_INFINITY;
  for (const score of scores) {
    // frontier fixed at 100 by earlier runs; the scored run is never the frontier
    const history = [run(1, frontierMetric), run(2, 100), run(3, score)];
    const v = computeRowValues(history, 2);
    const gap = v["frontier_relative_gap"];
    assert.ok(typeof gap === "number", "gap must be computable");
    assert.ok(gap <= previous + 1e-12, `gap ${gap} must not exceed ${previous}`);
    previous = gap;
  }
  const worse = computeRowValues([run(1, 100), run(2, 90), run(3, 150)], 2)["frontier_relative_gap"];
  const better = computeRowValues([run(1, 100), run(2, 90), run(3, 95)], 2)["frontier_relative_gap"];
  assert.ok(typeof worse === "number" && typeof better === "number" && worse > better);
});

test("nearest history similarity reports the closest earlier commit", () => {
  const history = [run(1, 10), run(2, 9), run(3, 8)];
  const v = computeRowValues(history, 2, { codeDistance: simByIndex });
  // c3 is closest to c2 (0.5) vs c1 (0.333...)
  assert.ok(Math.abs((v["nearest_history_similarity"] ?? 0) - 0.5) < 1e-12);
  assert.equal(computeRowValues(history, 0, { codeDistance: simByIndex })["nearest_history_similarity"], null);
});

test("gap_in_recent_step_units null without a positive improvement step", () => {
  const flat = [run(1, 10), run(2, 10), run(3, 12)];
  assert.equal(computeRowValues(flat, 1)["gap_in_recent_step_units"], null);
  const stepped = [run(1, 100), run(2, 90), run(3, 95)];
  const v = computeRowValues(stepped, 2);
  assert.ok(v["gap_in_recent_step_units"] !== null);
  assert.ok((v["gap_in_recent_step_units"] ?? 0) > 0);
});

test("recorded_change_count only from asi, never guessed", () => {
  const plain = [run(1, 10)];
  assert.equal(computeRowValues(plain, 0)["recorded_change_count"], null);
  const withAsi = [
    run(1, 10, { asi: { revisits_run: 2, hypothesis: "widen batch" }, description: "x" }),
  ];
  const v = computeRowValues(withAsi, 0)["recorded_change_count"];
  assert.equal(v, 4); // 2 revisits + hypothesis + non-empty description
});

// ---------------------------------------------------------------------------
// Region: window sizes 1, 2, 12, 30
// ---------------------------------------------------------------------------

function linearHistory(n: number, start = 100, step = -1): Run[] {
  return Array.from({ length: n }, (_, i) => run(i + 1, start + i * step));
}

test("window metrics need at least 2 runs in the window", () => {
  const one = linearHistory(1);
  const v1 = computeRowValues(one, 0);
  assert.equal(v1["frontier_relative_spread"], null);
  assert.equal(v1["window_frontier_gain"], null);
  assert.equal(v1["within_one_recent_step_rate"], null);
  assert.equal(v1["window_redundancy_rate"], null);
  // window_valid_rate only needs one run
  assert.equal(v1["window_valid_rate"], 1);

  const two = linearHistory(2);
  const v2 = computeRowValues(two, 1);
  assert.ok(v2["frontier_relative_spread"] !== null);
  // no pre-window frontier yet, so the window advance is not computable
  assert.equal(v2["window_frontier_gain"], null);
  // only one parent choice inside the window -> concentration needs >= 2 choices
  assert.equal(v2["parent_selection_concentration"], null);

  const four = linearHistory(4);
  assert.ok(computeRowValues(four, 3, { window: 2 })["window_frontier_gain"] !== null);
});

test("parent_selection_concentration: single repeated parent is 1", () => {
  const history = linearHistory(3);
  const v = computeRowValues(history, 1);
  // window [0,1]: only run 1 has a parent, so there is nothing to concentrate
  assert.equal(v["parent_selection_concentration"], null);
  const v3 = computeRowValues(history, 2);
  // window [0,2]: parents are 0 and 1 -> HHI = 0.5
  assert.ok(Math.abs((v3["parent_selection_concentration"] ?? 0) - 0.5) < 1e-12);
});

test("window=12 uses exactly the trailing 12 runs; window=30 spans all prior runs", () => {
  const history = linearHistory(30);
  const v12 = computeRowValues(history, 29, { window: 12 });
  const v30 = computeRowValues(history, 29, { window: 30 });
  const v1 = computeRowValues(history, 29, { window: 1 });
  // window=1 has a single element -> spread not computable
  assert.equal(v1["frontier_relative_spread"], null);
  // metric declines by 1 per run, so relative spreads stay constant but valid
  assert.ok(v12["frontier_relative_spread"] !== null);
  assert.ok(v30["root_relative_spread"] !== null);
  for (const v of [v1, v12, v30]) assertAllNullable(v);

  // a failure at index 5 is inside window=30 but outside window=12 (indices 18..29)
  const withOldCrash = history.map((r, i) =>
    i === 5 ? { ...r, status: "crash" as const } : r,
  );
  const w12 = computeRowValues(withOldCrash, 29, { window: 12 });
  const w30 = computeRowValues(withOldCrash, 29, { window: 30 });
  assert.equal(w12["window_valid_rate"], 1);
  assert.ok((w30["window_valid_rate"] ?? 1) < 1);
  assert.equal(w30["window_valid_rate"], 29 / 30);
  // failure metrics ignore the crash once it leaves the window
  assert.equal(w12["dominant_failure_signature_mass"], null);
  assert.equal(w30["dominant_failure_signature_mass"], 1);
});

test("window_valid_rate and window_frontier_conversion_rate are bounded in 0..1", () => {
  const history = linearHistory(15).map((r, i) =>
    i % 4 === 0 ? { ...r, status: "crash" as const, metric: 100 + i } : r,
  );
  for (let i = 0; i < history.length; i++) {
    const v = computeRowValues(history, i);
    for (const name of [
      "window_valid_rate",
      "window_frontier_conversion_rate",
      "within_one_recent_step_rate",
      "window_redundancy_rate",
      "dominant_failure_signature_mass",
      "repeated_failure_rate",
    ]) {
      const x = v[name];
      if (typeof x !== "number") continue;
      assert.ok(x >= 0 && x <= 1, `${name}=${x} must be in [0,1] at index ${i}`);
    }
  }
});

test("repeated failure signatures are counted by signature identity", () => {
  const history = [
    run(1, 100, { status: "crash", asi: { error: "OOM" } }),
    run(2, 100, { status: "checks_failed", asi: { error: "lint" } }),
    run(3, 100, { status: "crash", asi: { error: "OOM" } }),
  ];
  const v = computeRowValues(history, 2);
  assert.equal(v["dominant_failure_signature_mass"], 2 / 3);
  assert.equal(v["repeated_failure_rate"], 1 / 3); // only the second OOM repeats
});

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------

test("frontier epoch age grows until a meaningful improvement", () => {
  const history = [run(1, 100), run(2, 99), run(3, 98.5), run(4, 90)];
  assert.equal(computeRowValues(history, 0)["frontier_epoch_age_steps"], 0);
  // minGain default 2, so -1 and -0.5 do not move the frontier
  assert.equal(computeRowValues(history, 1)["frontier_epoch_age_steps"], 1);
  assert.equal(computeRowValues(history, 2)["frontier_epoch_age_steps"], 2);
  assert.equal(computeRowValues(history, 3)["frontier_epoch_age_steps"], 0);
  assert.equal(computeRowValues(history, 3, { minGain: 0.1 })["frontier_epoch_age_steps"], 0);
  assert.equal(computeRowValues(history, 2, { minGain: 0.1 })["frontier_epoch_age_steps"], 0);
});

test("seconds_since_meaningful_improvement reflects wall clock", () => {
  const history = [
    run(1, 100, { timestamp: 0 }),
    run(2, 101, { timestamp: 60_000 }),
    run(3, 102, { timestamp: 600_000 }),
  ];
  assert.equal(computeRowValues(history, 1)["seconds_since_meaningful_improvement"], 60);
  assert.equal(computeRowValues(history, 2)["seconds_since_meaningful_improvement"], 600);
  assert.equal(computeRowValues(history, 0)["seconds_since_meaningful_improvement"], 0);
});

test("best_descendant_metric walks inferred parent links", () => {
  const history = [run(1, 100), run(2, 80), run(3, 70), run(4, 95)];
  // runs 2,3 descend from 1; run 4 descends from 3
  assert.equal(computeRowValues(history, 0)["best_descendant_metric"], 70);
  assert.equal(computeRowValues(history, 2)["best_descendant_metric"], 70);
  assert.equal(computeRowValues(history, 3)["best_descendant_metric"], 95);
  assert.equal(
    computeRowValues(history, 0, { direction: "higher" })["best_descendant_metric"],
    100,
  );
});

test("segments reset parentage and the segment root", () => {
  const history = [
    run(1, 100, { segment: 1 }),
    run(2, 90, { segment: 1 }),
    run(3, 100, { segment: 2 }),
    run(4, 80, { segment: 2 }),
  ];
  assert.equal(computeRowValues(history, 2)["parent_gain"], null);
  assert.equal(computeRowValues(history, 3)["parent_gain"], 20);
  // improvements span segments; the frontier is global
  assert.ok(computeRowValues(history, 3)["frontier_relative_gap"] !== null);
});
describe("window_frontier_conversion_rate counts real advances", () => {
  const session = (): SessionSnapshot => ({
    name: "t",
    goal: "",
    metric_name: "nll",
    metric_unit: "",
    direction: "lower",
    baseline_metric: null,
    best_metric: null,
    run_count: 0,
  });

  function rowsFor(metrics: number[]): DashboardRow[] {
    const runs: Run[] = metrics.map((v, i) => ({
      run: i + 1,
      commit: `c${i + 1}`,
      metric: v,
      metrics: {},
      status: "keep",
      description: "",
      timestamp: 1_700_000_000_000 + i * 60_000,
      segment: 0,
      confidence: null,
    }));
    return buildRows(runs, session(), { window: metrics.length, minGain: 2 });
  }

  test("is 0 for a window where nothing advanced the frontier", () => {
    // All identical: every run is 'keep', but none moved the best value. The old
    // implementation returned 1.0 here.
    const rows = rowsFor([100, 100, 100, 100]);
    assert.equal(rows.at(-1)!.values["window_frontier_conversion_rate"], 0);
  });

  test("counts only runs that cleared the minimum gain", () => {
    // 100 -> 99 (gain 1, below minGain 2: not an advance) -> 95 (gain 5) -> 90 (gain 5)
    // The first run establishes the frontier and must not count.
    const rows = rowsFor([100, 99, 95, 90]);
    assert.equal(rows.at(-1)!.values["window_frontier_conversion_rate"], 2 / 4);
  });

  test("agrees with window_frontier_gain about whether anything happened", () => {
    const flat = rowsFor([42, 42, 42]).at(-1)!;
    assert.equal(flat.values["window_frontier_gain"], null);
    assert.equal(flat.values["window_frontier_conversion_rate"], 0);
  });
});

describe("repeated_failure_rate is per failed attempt", () => {
  test("does not shrink as a window fills with successes", () => {
    const mk = (i: number, status: Run["status"], desc: string): Run => ({
      run: i,
      commit: `c${i}`,
      metric: 10,
      metrics: {},
      status,
      description: desc,
      timestamp: 1_700_000_000_000 + i * 60_000,
      segment: 0,
      confidence: null,
    });
    // Two identical failures, six successes. Paper: 1 of 2 failed attempts repeats -> 0.5.
    // Dividing by window size would give 1/8.
    const runs = [
      mk(1, "checks_failed", "boom"),
      mk(2, "checks_failed", "boom"),
      mk(3, "keep", "ok"),
      mk(4, "keep", "ok"),
      mk(5, "keep", "ok"),
      mk(6, "keep", "ok"),
      mk(7, "keep", "ok"),
      mk(8, "keep", "ok"),
    ];
    const session: SessionSnapshot = {
      name: "t",
      goal: "",
      metric_name: "nll",
      metric_unit: "",
      direction: "lower",
      baseline_metric: null,
      best_metric: null,
      run_count: 0,
    };
    const rows = buildRows(runs, session, { window: 8, minGain: 2 });
    assert.equal(rows.at(-1)!.values["repeated_failure_rate"], 0.5);
  });
});

describe("recorded_change_count does not invent changes", () => {
  const ctx = { direction: "lower" as const, codeDistance: null, window: 12, minGain: 2 };
  const mk = (asi: Record<string, unknown>): Run => ({
    run: 1,
    commit: "c1",
    metric: 99,
    metrics: {},
    status: "keep",
    description: "",
    timestamp: 1_700_000_000_000,
    segment: 0,
    confidence: null,
    asi,
  });

  test("a seed alone contributes nothing", () => {
    // Summing every numeric asi field let `seed: 42` read as 42 changes.
    assert.equal(computeRowValues([mk({ seed: 42 })], 0, ctx).recorded_change_count, null);
  });

  test("an explicit change count is used", () => {
    assert.equal(computeRowValues([mk({ changes_made: 3 })], 0, ctx).recorded_change_count, 3);
  });

  test("no asi at all is null, not 1", () => {
    const r = { ...mk({}), asi: undefined };
    assert.equal(computeRowValues([r], 0, ctx).recorded_change_count, null);
  });
});
