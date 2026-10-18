import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "../src/types.ts";
import {
  frontierEpochAge,
  frontierSeries,
  improvementSteps,
  lastMeaningfulImprovement,
} from "../src/frontier.ts";

function makeRun(overrides: Partial<Run> & { run: number; metric: number }): Run {
  return {
    commit: "abc1234",
    metrics: {},
    status: "keep",
    description: `test run ${overrides.run}`,
    timestamp: 1000 + overrides.run * 60_000,
    segment: 0,
    confidence: null,
    ...overrides,
  };
}

describe("frontierSeries", () => {
  it("returns empty array for empty history", () => {
    assert.deepEqual(frontierSeries([], "lower"), []);
    assert.deepEqual(frontierSeries([], "higher"), []);
  });

  it("handles a single valid run", () => {
    const runs = [makeRun({ run: 0, metric: 100, timestamp: 5000, segment: 0 })];
    const series = frontierSeries(runs, "lower");
    assert.equal(series.length, 1);
    assert.deepEqual(series[0], {
      run: 0,
      metric: 100,
      timestamp: 5000,
      segment: 0,
    });
  });

  it("maintains a monotone non-increasing frontier when direction is 'lower'", () => {
    const runs = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 105 }), // worse
      makeRun({ run: 2, metric: 95 }),  // better
      makeRun({ run: 3, metric: 95 }),  // equal
      makeRun({ run: 4, metric: 90 }),  // better
      makeRun({ run: 5, metric: 92 }),  // worse
    ];

    const series = frontierSeries(runs, "lower");
    assert.equal(series.length, 6);
    assert.deepEqual(
      series.map((p) => p.metric),
      [100, 100, 95, 95, 90, 90]
    );
    assert.deepEqual(
      series.map((p) => p.run),
      [0, 1, 2, 3, 4, 5]
    );
  });

  it("maintains a monotone non-decreasing frontier when direction is 'higher'", () => {
    const runs = [
      makeRun({ run: 0, metric: 50 }),
      makeRun({ run: 1, metric: 45 }), // worse
      makeRun({ run: 2, metric: 60 }), // better
      makeRun({ run: 3, metric: 60 }), // equal
      makeRun({ run: 4, metric: 55 }), // worse
      makeRun({ run: 5, metric: 75 }), // better
    ];

    const series = frontierSeries(runs, "higher");
    assert.equal(series.length, 6);
    assert.deepEqual(
      series.map((p) => p.metric),
      [50, 50, 60, 60, 60, 75]
    );
    assert.deepEqual(
      series.map((p) => p.run),
      [0, 1, 2, 3, 4, 5]
    );
  });

  it("ensures crash and checks_failed runs do not move the frontier", () => {
    const runs = [
      makeRun({ run: 0, metric: 100, status: "keep" }),
      makeRun({ run: 1, metric: 50, status: "crash" }), // better metric but crashed
      makeRun({ run: 2, metric: 40, status: "checks_failed" }), // better metric but checks failed
      makeRun({ run: 3, metric: 90, status: "keep" }),
    ];

    const series = frontierSeries(runs, "lower");
    assert.equal(series.length, 4);
    assert.equal(series[0]!.metric, 100);
    assert.equal(series[1]!.metric, 100); // crash did not move frontier
    assert.equal(series[2]!.metric, 100); // checks_failed did not move frontier
    assert.equal(series[3]!.metric, 90);  // valid keep moved frontier
  });

  it("skips non-finite metrics when updating frontier", () => {
    const runs = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: Number.NaN }),
      makeRun({ run: 2, metric: Number.NEGATIVE_INFINITY }),
      makeRun({ run: 3, metric: 85 }),
    ];

    const series = frontierSeries(runs, "lower");
    assert.equal(series.length, 4);
    assert.equal(series[0]!.metric, 100);
    assert.equal(series[1]!.metric, 100);
    assert.equal(series[2]!.metric, 100);
    assert.equal(series[3]!.metric, 85);
  });

  it("does not emit frontier points before the first valid run in a segment", () => {
    const runs = [
      makeRun({ run: 0, metric: 0, status: "crash" }),
      makeRun({ run: 1, metric: 0, status: "checks_failed" }),
      makeRun({ run: 2, metric: 100, status: "keep" }),
      makeRun({ run: 3, metric: 95, status: "keep" }),
    ];

    const series = frontierSeries(runs, "lower");
    assert.equal(series.length, 2);
    assert.equal(series[0]!.run, 2);
    assert.equal(series[0]!.metric, 100);
    assert.equal(series[1]!.run, 3);
    assert.equal(series[1]!.metric, 95);
  });

  it("resets the frontier when segment changes", () => {
    const runs = [
      makeRun({ run: 0, metric: 100, segment: 0 }),
      makeRun({ run: 1, metric: 90, segment: 0 }),
      // Segment reset to segment 1: baseline restarts at 200 (worse than segment 0's 90)
      makeRun({ run: 2, metric: 200, segment: 1 }),
      makeRun({ run: 3, metric: 210, segment: 1 }), // worse
      makeRun({ run: 4, metric: 180, segment: 1 }), // improvement within segment 1
    ];

    const series = frontierSeries(runs, "lower");
    assert.equal(series.length, 5);
    assert.deepEqual(
      series.map((p) => ({ run: p.run, metric: p.metric, segment: p.segment })),
      [
        { run: 0, metric: 100, segment: 0 },
        { run: 1, metric: 90, segment: 0 },
        { run: 2, metric: 200, segment: 1 },
        { run: 3, metric: 200, segment: 1 },
        { run: 4, metric: 180, segment: 1 },
      ]
    );
  });
});

describe("improvementSteps", () => {
  it("returns empty array for empty runs", () => {
    assert.deepEqual(improvementSteps([], "lower"), []);
  });

  it("returns initial point for single run", () => {
    const runs = [makeRun({ run: 0, metric: 100 })];
    const steps = improvementSteps(runs, "lower");
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.run, 0);
    assert.equal(steps[0]!.metric, 100);
  });

  it("returns only strictly improving points for direction 'lower'", () => {
    const runs = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 105 }), // worse
      makeRun({ run: 2, metric: 100 }), // equal (not strict)
      makeRun({ run: 3, metric: 95 }),  // strictly new best
      makeRun({ run: 4, metric: 95 }),  // equal
      makeRun({ run: 5, metric: 80 }),  // strictly new best
    ];

    const steps = improvementSteps(runs, "lower");
    assert.equal(steps.length, 3);
    assert.deepEqual(
      steps.map((s) => s.run),
      [0, 3, 5]
    );
    assert.deepEqual(
      steps.map((s) => s.metric),
      [100, 95, 80]
    );
  });

  it("returns only strictly improving points for direction 'higher'", () => {
    const runs = [
      makeRun({ run: 0, metric: 10 }),
      makeRun({ run: 1, metric: 8 }),   // worse
      makeRun({ run: 2, metric: 10 }),  // equal
      makeRun({ run: 3, metric: 15 }),  // strictly new best
      makeRun({ run: 4, metric: 12 }),  // worse
      makeRun({ run: 5, metric: 20 }),  // strictly new best
    ];

    const steps = improvementSteps(runs, "higher");
    assert.equal(steps.length, 3);
    assert.deepEqual(
      steps.map((s) => s.run),
      [0, 3, 5]
    );
    assert.deepEqual(
      steps.map((s) => s.metric),
      [10, 15, 20]
    );
  });

  it("skips sub-minGain gains when minGain is provided", () => {
    const runs = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 99 }), // gain = 1 < 2 -> skipped
      makeRun({ run: 2, metric: 97 }), // gain = 3 >= 2 over 100 -> kept
      makeRun({ run: 3, metric: 96 }), // gain = 1 < 2 over 97 -> skipped
      makeRun({ run: 4, metric: 94 }), // gain = 3 >= 2 over 97 -> kept
    ];

    const steps = improvementSteps(runs, "lower", 2);
    assert.equal(steps.length, 3);
    assert.deepEqual(
      steps.map((s) => s.run),
      [0, 2, 4]
    );
    assert.deepEqual(
      steps.map((s) => s.metric),
      [100, 97, 94]
    );
  });

  it("never includes crash or checks_failed runs", () => {
    const runs = [
      makeRun({ run: 0, metric: 100, status: "keep" }),
      makeRun({ run: 1, metric: 50, status: "crash" }),
      makeRun({ run: 2, metric: 30, status: "checks_failed" }),
      makeRun({ run: 3, metric: 90, status: "keep" }),
    ];

    const steps = improvementSteps(runs, "lower");
    assert.equal(steps.length, 2);
    assert.deepEqual(
      steps.map((s) => s.run),
      [0, 3]
    );
  });

  it("resets improvement steps on segment change", () => {
    const runs = [
      makeRun({ run: 0, metric: 100, segment: 0 }),
      makeRun({ run: 1, metric: 90, segment: 0 }),
      makeRun({ run: 2, metric: 300, segment: 1 }), // new baseline in segment 1
      makeRun({ run: 3, metric: 250, segment: 1 }), // improvement in segment 1
    ];

    const steps = improvementSteps(runs, "lower");
    assert.equal(steps.length, 4);
    assert.deepEqual(
      steps.map((s) => ({ run: s.run, metric: s.metric, segment: s.segment })),
      [
        { run: 0, metric: 100, segment: 0 },
        { run: 1, metric: 90, segment: 0 },
        { run: 2, metric: 300, segment: 1 },
        { run: 3, metric: 250, segment: 1 },
      ]
    );
  });
});

describe("lastMeaningfulImprovement", () => {
  it("returns null for empty runs", () => {
    assert.equal(lastMeaningfulImprovement([], "lower", 2), null);
  });

  it("returns null for single run history (no prior frontier)", () => {
    const runs = [makeRun({ run: 0, metric: 100 })];
    assert.equal(lastMeaningfulImprovement(runs, "lower", 2), null);
  });

  it("returns null when all runs crashed or failed checks", () => {
    const runs = [
      makeRun({ run: 0, metric: 100, status: "crash" }),
      makeRun({ run: 1, metric: 50, status: "checks_failed" }),
    ];
    assert.equal(lastMeaningfulImprovement(runs, "lower", 2), null);
  });

  it("returns null when all improvements are sub-minGain", () => {
    const runs = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 99 }), // gain 1 < 2
      makeRun({ run: 2, metric: 99 }), // gain 0
      makeRun({ run: 3, metric: 105 }), // worse
    ];
    assert.equal(lastMeaningfulImprovement(runs, "lower", 2), null);
  });

  it("returns the most recent meaningful improvement", () => {
    const runs = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 95 }), // meaningful (+5 >= 2)
      makeRun({ run: 2, metric: 90 }), // meaningful (+5 >= 2)
      makeRun({ run: 3, metric: 89 }), // sub-minGain (+1 < 2)
      makeRun({ run: 4, metric: 92 }), // worse
    ];

    const result = lastMeaningfulImprovement(runs, "lower", 2);
    assert.notEqual(result, null);
    assert.equal(result!.run, 2);
    assert.equal(result!.metric, 90);
  });

  it("checks exact threshold boundary for minGain", () => {
    const runsUnder = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 98.001 }), // gain = 1.999 < 2
    ];
    assert.equal(lastMeaningfulImprovement(runsUnder, "lower", 2), null);

    const runsExact = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 98.0 }), // gain = 2.0 === 2
    ];
    const exactRes = lastMeaningfulImprovement(runsExact, "lower", 2);
    assert.notEqual(exactRes, null);
    assert.equal(exactRes!.run, 1);
  });

  it("works with direction 'higher'", () => {
    const runs = [
      makeRun({ run: 0, metric: 10 }),
      makeRun({ run: 1, metric: 11 }), // gain 1 < 2
      makeRun({ run: 2, metric: 15 }), // gain 4 >= 2 (meaningful)
      makeRun({ run: 3, metric: 14 }), // worse
    ];

    const result = lastMeaningfulImprovement(runs, "higher", 2);
    assert.notEqual(result, null);
    assert.equal(result!.run, 2);
    assert.equal(result!.metric, 15);
  });

  it("ignores improvements from older segments if current segment has none", () => {
    const runs = [
      makeRun({ run: 0, metric: 100, segment: 0 }),
      makeRun({ run: 1, metric: 80, segment: 0 }), // meaningful in segment 0
      makeRun({ run: 2, metric: 200, segment: 1 }), // new baseline in segment 1
      makeRun({ run: 3, metric: 205, segment: 1 }), // worse in segment 1
    ];

    const result = lastMeaningfulImprovement(runs, "lower", 2);
    assert.equal(result, null);
  });

  it("returns meaningful improvement within current segment", () => {
    const runs = [
      makeRun({ run: 0, metric: 100, segment: 0 }),
      makeRun({ run: 1, metric: 80, segment: 0 }),
      makeRun({ run: 2, metric: 200, segment: 1 }),
      makeRun({ run: 3, metric: 180, segment: 1 }), // meaningful in segment 1
    ];

    const result = lastMeaningfulImprovement(runs, "lower", 2);
    assert.notEqual(result, null);
    assert.equal(result!.run, 3);
    assert.equal(result!.segment, 1);
  });
});

describe("frontierEpochAge", () => {
  it("returns 0 for empty runs", () => {
    assert.equal(frontierEpochAge([], "lower", 2), 0);
  });

  it("returns total runs when there was no meaningful improvement", () => {
    const single = [makeRun({ run: 0, metric: 100 })];
    assert.equal(frontierEpochAge(single, "lower", 2), 1);

    const flat = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 100 }),
      makeRun({ run: 2, metric: 100 }),
    ];
    assert.equal(frontierEpochAge(flat, "lower", 2), 3);
  });

  it("returns 0 if meaningful improvement was the last run", () => {
    const runs = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 90 }),
    ];
    assert.equal(frontierEpochAge(runs, "lower", 2), 0);
  });

  it("returns elapsed runs since the meaningful improvement", () => {
    const runs = [
      makeRun({ run: 0, metric: 100 }),
      makeRun({ run: 1, metric: 90 }), // meaningful improvement
      makeRun({ run: 2, metric: 92 }), // +1 run
      makeRun({ run: 3, metric: 91 }), // +2 runs
      makeRun({ run: 4, metric: 95 }), // +3 runs
    ];
    assert.equal(frontierEpochAge(runs, "lower", 2), 3);
  });

  it("counts runs within current segment only", () => {
    const runs = [
      makeRun({ run: 0, metric: 100, segment: 0 }),
      makeRun({ run: 1, metric: 90, segment: 0 }),
      makeRun({ run: 2, metric: 200, segment: 1 }),
      makeRun({ run: 3, metric: 190, segment: 1 }), // meaningful in seg 1
      makeRun({ run: 4, metric: 195, segment: 1 }), // +1 run in seg 1
    ];
    assert.equal(frontierEpochAge(runs, "lower", 2), 1);
  });
});
