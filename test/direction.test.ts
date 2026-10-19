/**
 * The optimization direction is declared by the session, and it has to reach every place
 * that reasons about "better".
 *
 * Three separate bugs lived here:
 *  - `directionCandidates` hardcoded `reduce cycles` from `MetricSpec.better`, so a
 *    higher-is-better run was steered to lower its own score.
 *  - lineage selection *guessed* the direction from first-vs-last kept run. When the guess
 *    inverted, intervention arms were grounded in the worst trajectories, not the best.
 *  - a run with no metric could be a lineage root.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildCohortPlan, directionCandidates, renderSteer } from "../src/intervene.ts";
import { metricSpecs } from "../src/metrics.ts";
import { detectStall } from "../src/stall.ts";
import { selectLineages } from "../src/diversity.ts";
import { DEFAULT_RSI_CONFIG, DEFAULT_STALL_CONFIG, type Run, type SessionSnapshot } from "../src/types.ts";

const BASE = 1_700_000_000_000;

function run(i: number, metric: number, status: Run["status"] = "keep"): Run {
  return {
    run: i,
    commit: `c${i}`,
    metric,
    metrics: {},
    status,
    description: "",
    timestamp: BASE + i * 60_000,
    segment: 0,
    confidence: null,
  };
}

function session(direction: "lower" | "higher"): SessionSnapshot {
  return {
    name: "t",
    goal: "",
    metric_name: direction === "higher" ? "accuracy" : "nll",
    metric_unit: "",
    direction,
    baseline_metric: null,
    best_metric: null,
    run_count: 0,
  };
}

describe("direction reaches steer text", () => {
  it("mirrors the objective for cycles in a higher-is-better run", () => {
    const higher = directionCandidates(metricSpecs(), "higher");
    assert.ok(higher.includes("raise cycles"), `got: ${higher.join(", ")}`);
    const lower = directionCandidates(metricSpecs(), "lower");
    assert.ok(lower.includes("reduce cycles"), `got: ${lower.join(", ")}`);
  });

  it("mirrors the objective for best_descendant_metric too", () => {
    assert.ok(directionCandidates(metricSpecs(), "higher").includes("raise best_descendant_metric"));
    assert.ok(directionCandidates(metricSpecs(), "lower").includes("reduce best_descendant_metric"));
  });

  it("never tells a higher-is-better run to reduce its primary metric", () => {
    const runs = [1, 2, 3, 4, 5].map((i) => run(i, 0.8 + i * 0.01));
    const s = session("higher");
    const stall = detectStall(runs, s, DEFAULT_STALL_CONFIG, BASE + 5 * 60_000);
    const plan = buildCohortPlan(runs, s, stall, { ...DEFAULT_RSI_CONFIG, cohortSize: 2 });
    const dirs = plan.arms.flatMap((a) => a.portfolio.map((p) => p.direction));
    assert.ok(!dirs.includes("reduce cycles"), `steer asked to reduce the score: ${dirs.join(" | ")}`);
  });
});

describe("lineage selection follows the declared direction", () => {
  it("picks the improving runs on a higher-is-better metric", () => {
    // Strictly ascending: every run is a new best when higher is better, none when lower.
    const runs = [1, 2, 3, 4].map((i) => run(i, 10 * i));
    assert.deepEqual(
      selectLineages(runs, 4, () => 0.5, undefined, "higher").sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
  });

  it("does not invert when the run happens to drift", () => {
    // The old heuristic compared first-vs-last kept run. Here the last keep is *worse* than
    // the first on a higher-is-better metric, which is exactly the case that inverted it.
    const runs = [run(1, 90), run(2, 50), run(3, 40)];
    const picked = selectLineages(runs, 2, () => 0.5, undefined, "higher");
    // Run 1 is the only run that set a best on `higher`; it must be among the roots.
    assert.ok(picked.includes(1), `expected run 1 as a root, got ${JSON.stringify(picked)}`);
  });

  it("excludes runs with no usable metric from lineage roots", () => {
    const runs = [run(1, 10), run(2, Number.NaN), run(3, 5)];
    const picked = selectLineages(runs, 3, () => 0.5, undefined, "lower");
    assert.ok(!picked.includes(2), `a NaN-metric run became a lineage root: ${JSON.stringify(picked)}`);
  });
});

describe("steer text does not overclaim", () => {
  const runs = [1, 2, 3, 4, 5].map((i) => run(i, 100 - i));
  const s = session("lower");
  const stall = detectStall(runs, s, DEFAULT_STALL_CONFIG, BASE + 9 * 60000);
  const steer = renderSteer(
    buildCohortPlan(runs, s, stall, DEFAULT_RSI_CONFIG),
    runs,
    s,
    stall,
  );

  it("does not assert that collapse has happened", () => {
    // The paper is explicit that a stall alone does not establish exploration collapse.
    assert.ok(
      !/collapse likely/i.test(steer),
      "steer states collapse as a likely fact rather than a hypothesis",
    );
  });

  it("carries the caveat that a stall is not proof", () => {
    assert.match(steer, /not proof of collapse/i);
  });

  it("still tells the agent to diversify", () => {
    assert.match(steer, /do not keep refining the current idea/i);
  });
});

describe("each arm gets its own probability vector", () => {
  it("does not emit the same portfolio probabilities for every arm", () => {
    // The axis this checks is the paper's "verbalized probability": each arm states how
    // likely each direction is to help. A rank-derived weight made every arm emit the
    // identical vector (44/22/15/11/9), which is a type error dressed as diversity.
    const runs = Array.from({ length: 40 }, (_, i) => run(i + 1, 1391 - i * 4));
    const s = session("lower");
    const stall = detectStall(runs, s, DEFAULT_STALL_CONFIG, BASE + 40 * 60_000);
    const plan = buildCohortPlan(runs, s, stall, { ...DEFAULT_RSI_CONFIG, cohortSize: 4 });

    const vectors = plan.arms.map((a) =>
      a.portfolio.map((p) => `${p.direction}:${p.probability.toFixed(4)}`).join(","),
    );
    assert.equal(new Set(vectors).size, vectors.length, "every arm must have a distinct vector");
  });

  it("keeps probabilities inside [0,1] and normalized", () => {
    const runs = Array.from({ length: 20 }, (_, i) => run(i + 1, 100 - i));
    const s = session("lower");
    const stall = detectStall(runs, s, DEFAULT_STALL_CONFIG, BASE + 20 * 60_000);
    const plan = buildCohortPlan(runs, s, stall, DEFAULT_RSI_CONFIG);
    for (const arm of plan.arms) {
      const total = arm.portfolio.reduce((acc, p) => acc + p.probability, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `probabilities sum to ${total}`);
      for (const p of arm.portfolio) assert.ok(p.probability > 0 && p.probability <= 1);
    }
  });
});
