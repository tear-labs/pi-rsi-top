import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Run, SessionSnapshot, StallConfig } from "../src/types.ts";
import { DEFAULT_STALL_CONFIG } from "../src/types.ts";
import { detectStall } from "../src/stall.ts";

function makeSession(direction: "lower" | "higher" = "lower"): SessionSnapshot {
  return {
    name: "test-session",
    metric_name: "latency",
    metric_unit: "ms",
    direction,
    baseline_metric: 100,
    best_metric: 90,
    run_count: 0,
    goal: "optimize latency",
  };
}

function makeRun(overrides: Partial<Run> & { run: number; metric: number }): Run {
  return {
    commit: "abc1234",
    metrics: {},
    status: "keep",
    description: `test run ${overrides.run}`,
    timestamp: 1_000_000 + overrides.run * 60_000,
    segment: 0,
    confidence: null,
    ...overrides,
  };
}

describe("detectStall - empty and minimal history", () => {
  it("handles empty history without throwing", () => {
    const session = makeSession();
    const result = detectStall([], session, DEFAULT_STALL_CONFIG, 1_000_000);

    assert.equal(result.stalled, false);
    assert.equal(result.stalledForMs, 0);
    assert.equal(result.stalledForRuns, 0);
    assert.equal(result.frontier, null);
    assert.equal(result.frontierRun, null);
    assert.equal(result.epochAge, 0);
    assert.match(result.reason, /Fewer than 12 runs/);
  });

  it("handles single-run history without throwing", () => {
    const session = makeSession();
    const runs = [makeRun({ run: 0, metric: 100, timestamp: 1_000_000 })];
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, 1_000_000);

    assert.equal(result.stalled, false);
    assert.equal(result.stalledForMs, 0);
    assert.equal(result.stalledForRuns, 1);
    assert.equal(result.frontier, 100);
    assert.equal(result.frontierRun, 0);
    assert.equal(result.epochAge, 1);
    assert.match(result.reason, /Fewer than 12 runs/);
  });
});

describe("detectStall - Gate 1: minRuns", () => {
  it("does not report stall when runs count is below minRuns even after hours", () => {
    const session = makeSession();
    // 11 runs (minRuns = 12)
    const runs: Run[] = [];
    for (let i = 0; i < 11; i++) {
      runs.push(makeRun({ run: i, metric: 100, timestamp: 1_000_000 + i * 60_000 }));
    }
    // now is 3 hours later
    const now = 1_000_000 + 3 * 3600_000;
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, false);
    assert.equal(result.stalledForRuns, 11);
    assert.equal(result.epochAge, 11);
    assert.equal(result.frontier, 100);
    assert.equal(result.frontierRun, 0);
    assert.match(result.reason, /Fewer than 12 runs \(have 11\)/);
  });

  it("passes minRuns gate exactly at minRuns = 12", () => {
    const session = makeSession();
    const runs: Run[] = [];
    for (let i = 0; i < 12; i++) {
      runs.push(makeRun({ run: i, metric: 100, timestamp: 1_000_000 + i * 60_000 }));
    }
    // now is 85 minutes later: warm-up (60m) + stall (20m) = 80m. At 85m it stalls.
    const now = 1_000_000 + 85 * 60_000;
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, true);
    assert.equal(result.reason, "");
    assert.equal(result.frontier, 100);
    assert.equal(result.frontierRun, 0);
  });
});

describe("detectStall - Gate 2: ignoreFirstMs (warm-up window)", () => {
  it("ignores stalls during the first hour even if flat for > 20 minutes", () => {
    const session = makeSession();
    const runs: Run[] = [];
    // 15 runs within 40 minutes, flat from run 2 (at 10m) to run 14 (at 40m)
    for (let i = 0; i < 15; i++) {
      runs.push(makeRun({ run: i, metric: i === 0 ? 100 : i === 1 ? 90 : 90, timestamp: 1_000_000 + i * 2 * 60_000 }));
    }
    // now is 50 minutes after first run (under 60m warm-up)
    const now = 1_000_000 + 50 * 60_000;
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, false);
    assert.match(result.reason, /Within warm-up window/);
    // Frontier and run metrics are still populated
    assert.equal(result.frontier, 90);
    assert.equal(result.frontierRun, 1);
  });

  it("tests off-by-one timing around ignoreFirstMs boundary", () => {
    const session = makeSession();
    const t0 = 1_000_000;
    const ignoreFirstMs = 60 * 60_000; // 3_600_000
    const runs: Run[] = [];
    // Run 0 at t0, run 1 at t0 + 10m (meaningful improvement: 100 -> 90)
    runs.push(makeRun({ run: 0, metric: 100, timestamp: t0 }));
    runs.push(makeRun({ run: 1, metric: 90, timestamp: t0 + 10 * 60_000 }));
    for (let i = 2; i < 15; i++) {
      runs.push(makeRun({ run: i, metric: 90, timestamp: t0 + 10 * 60_000 + (i - 1) * 60_000 }));
    }

    // 1 ms before ignoreFirstMs expires: elapsed = 3_599_999
    const resUnder = detectStall(runs, session, DEFAULT_STALL_CONFIG, t0 + ignoreFirstMs - 1);
    assert.equal(resUnder.stalled, false);
    assert.match(resUnder.reason, /Within warm-up window/);

    // Exactly at ignoreFirstMs: elapsed = 3_600_000. Flat since run 1 (10m), so flat for 50m >= 20m.
    const resExact = detectStall(runs, session, DEFAULT_STALL_CONFIG, t0 + ignoreFirstMs);
    assert.equal(resExact.stalled, true);
    assert.equal(resExact.reason, "");
  });
});

describe("detectStall - Gate 3: usable metric", () => {
  it("does not stall if all runs crashed or failed checks even after hours", () => {
    const session = makeSession();
    const t0 = 1_000_000;
    const runs: Run[] = [];
    for (let i = 0; i < 15; i++) {
      runs.push(
        makeRun({
          run: i,
          metric: 0,
          status: i % 2 === 0 ? "crash" : "checks_failed",
          timestamp: t0 + i * 5 * 60_000,
        })
      );
    }
    const now = t0 + 3 * 3600_000; // 3 hours later
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, false);
    assert.equal(result.frontier, null);
    assert.equal(result.frontierRun, null);
    assert.match(result.reason, /No run has a usable metric yet/);
  });
});

describe("detectStall - Timing and stall arithmetic with meaningful improvement", () => {
  it("accurately reports stall duration and run count arithmetic", () => {
    const session = makeSession("lower");
    const t0 = 1_000_000;
    const runs: Run[] = [];
    runs.push(makeRun({ run: 0, metric: 100, timestamp: t0 }));
    // Meaningful improvement at run 3 (metric 95, gain 5 >= 2), timestamp t0 + 15m
    runs.push(makeRun({ run: 1, metric: 99, timestamp: t0 + 5 * 60_000 })); // gain 1 < 2
    runs.push(makeRun({ run: 2, metric: 102, timestamp: t0 + 10 * 60_000 })); // worse
    runs.push(makeRun({ run: 3, metric: 95, timestamp: t0 + 15 * 60_000 })); // meaningful!
    // Runs 4..14 flat or worse
    for (let i = 4; i < 15; i++) {
      runs.push(makeRun({ run: i, metric: 95, timestamp: t0 + 15 * 60_000 + (i - 3) * 2 * 60_000 }));
    }

    // Now at t0 + 60m: flat since run 3 (at t0 + 15m), so stalled for 45 minutes
    const now = t0 + 60 * 60_000;
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, true);
    assert.equal(result.stalledForMs, 45 * 60_000);
    assert.equal(result.stalledForRuns, 11); // runs 4..14 = 11 runs since run 3
    assert.equal(result.epochAge, 11);
    assert.equal(result.frontier, 95);
    assert.equal(result.frontierRun, 3);
  });

  it("tests off-by-one timing for minStallMs threshold", () => {
    const session = makeSession("lower");
    const t0 = 1_000_000;
    const minStallMs = 20 * 60_000; // 1_200_000
    const runs: Run[] = [];
    // First run at t0
    runs.push(makeRun({ run: 0, metric: 100, timestamp: t0 }));
    // Meaningful improvement at run 1 at t0 + 50m (metric 90)
    const impTimestamp = t0 + 50 * 60_000;
    runs.push(makeRun({ run: 1, metric: 90, timestamp: impTimestamp }));
    for (let i = 2; i < 14; i++) {
      runs.push(makeRun({ run: i, metric: 90, timestamp: impTimestamp + (i - 1) * 60_000 }));
    }

    // Warm-up expires at t0 + 60m. Stall requires impTimestamp + 20m = t0 + 70m.
    // 1 ms before minStallMs threshold:
    const tUnder = impTimestamp + minStallMs - 1;
    const resUnder = detectStall(runs, session, DEFAULT_STALL_CONFIG, tUnder);
    assert.equal(resUnder.stalled, false);
    assert.equal(resUnder.stalledForMs, minStallMs - 1);
    assert.match(resUnder.reason, /flat for 1199999ms \(< 1200000ms\)/);

    // Exactly at minStallMs threshold:
    const tExact = impTimestamp + minStallMs;
    const resExact = detectStall(runs, session, DEFAULT_STALL_CONFIG, tExact);
    assert.equal(resExact.stalled, true);
    assert.equal(resExact.stalledForMs, minStallMs);
    assert.equal(resExact.reason, "");

    // 1 ms past minStallMs threshold:
    const tOver = impTimestamp + minStallMs + 1;
    const resOver = detectStall(runs, session, DEFAULT_STALL_CONFIG, tOver);
    assert.equal(resOver.stalled, true);
    assert.equal(resOver.stalledForMs, minStallMs + 1);
  });
});

describe("detectStall - Timing when there has NEVER been a meaningful improvement", () => {
  it("measures stall from the expiry of ignoreFirstMs", () => {
    const session = makeSession("lower");
    const t0 = 1_000_000;
    const ignoreFirstMs = 60 * 60_000;
    const minStallMs = 20 * 60_000;

    // 15 runs, baseline = 100, all other runs have metric 100 (gain = 0 < 2)
    const runs: Run[] = [];
    for (let i = 0; i < 15; i++) {
      runs.push(makeRun({ run: i, metric: 100, timestamp: t0 + i * 2 * 60_000 }));
    }

    // At t0 + 70m (10m after ignoreFirstMs expiry): flat for 10m < 20m
    const res70 = detectStall(runs, session, DEFAULT_STALL_CONFIG, t0 + 70 * 60_000);
    assert.equal(res70.stalled, false);
    assert.equal(res70.stalledForMs, 10 * 60_000);
    assert.equal(res70.stalledForRuns, 15);
    assert.equal(res70.epochAge, 15);
    assert.match(res70.reason, /flat for 600000ms \(< 1200000ms\)/);

    // 1 ms before 80m (expiry + minStallMs - 1ms):
    const tUnder = t0 + ignoreFirstMs + minStallMs - 1;
    const resUnder = detectStall(runs, session, DEFAULT_STALL_CONFIG, tUnder);
    assert.equal(resUnder.stalled, false);
    assert.equal(resUnder.stalledForMs, minStallMs - 1);

    // Exactly at 80m (expiry + minStallMs):
    const tExact = t0 + ignoreFirstMs + minStallMs;
    const resExact = detectStall(runs, session, DEFAULT_STALL_CONFIG, tExact);
    assert.equal(resExact.stalled, true);
    assert.equal(resExact.stalledForMs, minStallMs);
    assert.equal(resExact.reason, "");
    assert.equal(resExact.stalledForRuns, 15);
  });
});

describe("detectStall - Clock skew and negative duration clamping", () => {
  it("clamps stalledForMs to 0 and reports stalled: false if improvement is in the future", () => {
    const session = makeSession("lower");
    const t0 = 1_000_000;
    const runs: Run[] = [];
    runs.push(makeRun({ run: 0, metric: 100, timestamp: t0 }));
    for (let i = 1; i < 15; i++) {
      // Future timestamp on the improvement run
      runs.push(makeRun({ run: i, metric: 80, timestamp: t0 + 5000 * 60_000 }));
    }

    const now = t0 + 120 * 60_000; // now is before the run's future timestamp
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, false);
    assert.equal(result.stalledForMs, 0);
    assert.match(result.reason, /Clock skew/);
  });
});

describe("detectStall - direction 'higher'", () => {
  it("correctly identifies stall when direction is 'higher'", () => {
    const session = makeSession("higher");
    const t0 = 1_000_000;
    const runs: Run[] = [];
    runs.push(makeRun({ run: 0, metric: 50, timestamp: t0 }));
    // Meaningful improvement at run 1 at t0 + 20m (+25 >= 2)
    runs.push(makeRun({ run: 1, metric: 75, timestamp: t0 + 20 * 60_000 }));
    for (let i = 2; i < 15; i++) {
      runs.push(makeRun({ run: i, metric: 70, timestamp: t0 + 20 * 60_000 + (i - 1) * 60_000 })); // worse (< 75)
    }

    // At t0 + 65m: warm-up (60m) passed, flat since run 1 (at 20m) for 45m >= 20m
    const now = t0 + 65 * 60_000;
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, true);
    assert.equal(result.frontier, 75);
    assert.equal(result.frontierRun, 1);
    assert.equal(result.stalledForMs, 45 * 60_000);
    assert.equal(result.stalledForRuns, 13);
  });
});

describe("detectStall - crash and checks_failed do not reset stall timer", () => {
  it("does not reset stall timer when crash or checks_failed occur with zero/better metric", () => {
    const session = makeSession("lower");
    const t0 = 1_000_000;
    const runs: Run[] = [];
    runs.push(makeRun({ run: 0, metric: 100, timestamp: t0 }));
    runs.push(makeRun({ run: 1, metric: 90, timestamp: t0 + 10 * 60_000 })); // meaningful (+10 >= 2)
    for (let i = 2; i < 11; i++) {
      runs.push(makeRun({ run: i, metric: 90, timestamp: t0 + 10 * 60_000 + (i - 1) * 60_000 }));
    }
    // Run 11 crashes at t0 + 30m with metric 0
    runs.push(makeRun({ run: 11, metric: 0, status: "crash", timestamp: t0 + 30 * 60_000 }));
    // Run 12 checks_failed at t0 + 40m with metric 0
    runs.push(makeRun({ run: 12, metric: 0, status: "checks_failed", timestamp: t0 + 40 * 60_000 }));

    // Now at t0 + 60m: flat since run 1 (at 10m) for 50m >= 20m
    const now = t0 + 60 * 60_000;
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, true);
    assert.equal(result.frontier, 90);
    assert.equal(result.frontierRun, 1);
    assert.equal(result.stalledForMs, 50 * 60_000);
  });
});

describe("detectStall - segment reset behavior", () => {
  it("evaluates stall within the active segment only", () => {
    const session = makeSession("lower");
    const t0 = 1_000_000;
    const runs: Run[] = [];
    // Segment 0: 20 runs, ran for 2 hours and stalled
    for (let i = 0; i < 20; i++) {
      runs.push(makeRun({ run: i, metric: 100, timestamp: t0 + i * 5 * 60_000, segment: 0 }));
    }
    // Segment 1 starts at t0 + 120m with 3 runs (under minRuns)
    const tSeg1 = t0 + 120 * 60_000;
    runs.push(makeRun({ run: 20, metric: 200, timestamp: tSeg1, segment: 1 }));
    runs.push(makeRun({ run: 21, metric: 199, timestamp: tSeg1 + 2 * 60_000, segment: 1 }));
    runs.push(makeRun({ run: 22, metric: 198, timestamp: tSeg1 + 4 * 60_000, segment: 1 }));

    const now = tSeg1 + 10 * 60_000;
    const result = detectStall(runs, session, DEFAULT_STALL_CONFIG, now);

    assert.equal(result.stalled, false);
    assert.equal(result.frontier, 198);
    assert.equal(result.frontierRun, 22);
    assert.match(result.reason, /Fewer than 12 runs \(have 3\)/);
  });
});
