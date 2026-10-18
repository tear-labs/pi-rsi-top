/**
 * Tests for diversity control (Lane C): PRNG, subset sampling,
 * verbalized sampling (arXiv:2510.01171), and epoch-aware farthest-point lineage selection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CodeDistance, Run } from "../src/types.ts";
import {
  makeRng,
  sampleSubset,
  verbalizedSample,
  selectLineages,
} from "../src/diversity.ts";

/** Helper to build synthetic Run entries for tests. */
function makeRun(
  runNumber: number,
  commit: string,
  metric: number,
  status: Run["status"] = "keep",
  segment: number = 0
): Run {
  return {
    run: runNumber,
    commit,
    metric,
    metrics: { cycles: metric },
    status,
    description: `test run ${runNumber}`,
    timestamp: 1000 + runNumber * 60_000,
    segment,
    confidence: 1,
  };
}

describe("makeRng", () => {
  it("produces deterministic floats in [0, 1) across thousands of draws", () => {
    const rng = makeRng(12345);
    for (let i = 0; i < 5000; i++) {
      const val = rng();
      assert.ok(val >= 0, `val ${val} must be >= 0`);
      assert.ok(val < 1, `val ${val} must be < 1`);
      assert.ok(!Number.isNaN(val), "val must not be NaN");
    }
  });

  it("produces identical sequences for identical seeds (determinism)", () => {
    for (const seed of [0, 1, 42, 999999, 0x7fffffff, -42]) {
      const rng1 = makeRng(seed);
      const rng2 = makeRng(seed);
      for (let i = 0; i < 50; i++) {
        assert.equal(rng1(), rng2(), `seed ${seed} failed determinism at draw ${i}`);
      }
    }
  });

  it("produces different initial draws for distinct seeds", () => {
    const draws = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const rng = makeRng(seed);
      draws.add(rng());
    }
    assert.ok(draws.size >= 18, `expected >= 18 distinct initial values, got ${draws.size}`);
  });

  it("handles seed 0 without degenerate zeroes or NaN", () => {
    const rng = makeRng(0);
    const vals = [rng(), rng(), rng(), rng()];
    assert.ok(vals.every(v => v >= 0 && v < 1 && !Number.isNaN(v)));
    assert.notEqual(vals[0], vals[1]);
  });
});

describe("sampleSubset", () => {
  const items = Array.from({ length: 30 }, (_, i) => `item_${i}`);

  it("handles edge cases for k and empty items", () => {
    const rng = makeRng(42);
    assert.deepEqual(sampleSubset(items, 0, rng), []);
    assert.deepEqual(sampleSubset(items, -1, rng), []);
    assert.deepEqual(sampleSubset(items, -100, rng), []);
    assert.deepEqual(sampleSubset([], 5, rng), []);

    const single = sampleSubset(items, 1, rng);
    assert.equal(single.length, 1);
    assert.ok(items.includes(single[0] as string));

    const full = sampleSubset(items, items.length + 10, rng);
    assert.equal(full.length, items.length);
    assert.equal(new Set(full).size, items.length);
  });

  it("never mutates the original items array", () => {
    const original = ["a", "b", "c", "d", "e"];
    const copy = original.slice();
    const rng = makeRng(99);
    sampleSubset(original, 3, rng);
    assert.deepEqual(original, copy);
  });

  it("guarantees no duplicates over 200 random draws", () => {
    const rng = makeRng(777);
    for (let draw = 0; draw < 200; draw++) {
      const k = 1 + (draw % 25);
      const sample = sampleSubset(items, k, rng);
      assert.equal(sample.length, k, `draw ${draw} length mismatch`);
      const unique = new Set(sample);
      assert.equal(unique.size, k, `draw ${draw} contained duplicates`);
    }
  });

  it("satisfies determinism with identical seeds", () => {
    const sample1 = sampleSubset(items, 15, makeRng(2026));
    const sample2 = sampleSubset(items, 15, makeRng(2026));
    assert.deepEqual(sample1, sample2);
  });

  it("produces different subsets across 20 distinct seeds", () => {
    const uniqueSubsets = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const sample = sampleSubset(items, 15, makeRng(seed));
      uniqueSubsets.add(JSON.stringify(sample));
    }
    assert.ok(uniqueSubsets.size >= 18, `expected >= 18 unique subsets, got ${uniqueSubsets.size}`);
  });
});

describe("verbalizedSample", () => {
  const directions = [
    "quantize_weights",
    "fuse_attention_kernels",
    "increase_batch_size",
    "enable_torch_compile",
    "tune_learning_rate",
    "prune_sparse_layers",
  ];

  it("sums probabilities to 1 within 1e-9 across 100 seeds", () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = makeRng(seed);
      const k = 2 + (seed % 5);
      const arms = verbalizedSample(directions, k, rng);
      const sum = arms.reduce((acc, a) => acc + a.probability, 0);
      assert.ok(
        Math.abs(sum - 1.0) < 1e-9,
        `seed ${seed}: sum ${sum} deviated from 1 by ${Math.abs(sum - 1.0)}`
      );
    }
  });

  it("ensures all returned probabilities are strictly positive (> 0)", () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = makeRng(seed * 31);
      const arms = verbalizedSample(directions, 4, rng);
      assert.equal(arms.length, 4);
      for (const arm of arms) {
        assert.ok(arm.probability > 0, `arm ${arm.direction} had probability <= 0: ${arm.probability}`);
      }
    }
  });

  it("returns distinct direction values in all arms", () => {
    const rng = makeRng(42);
    const arms = verbalizedSample(directions, 5, rng);
    const names = arms.map(a => a.direction);
    assert.equal(new Set(names).size, arms.length);

    // Also handles input directions with duplicates
    const dups = ["kernel_opt", "kernel_opt", "quantize", "quantize", "lr_sweep"];
    const armsDup = verbalizedSample(dups, 3, rng);
    const dupNames = armsDup.map(a => a.direction);
    assert.equal(new Set(dupNames).size, armsDup.length);
  });

  it("clamps properly when k > directions.length and on edge cases", () => {
    const rng = makeRng(88);
    const clamped = verbalizedSample(["a", "b", "c"], 10, rng);
    assert.equal(clamped.length, 3);
    assert.deepEqual(new Set(clamped.map(a => a.direction)), new Set(["a", "b", "c"]));

    assert.deepEqual(verbalizedSample(["a", "b"], 0, rng), []);
    assert.deepEqual(verbalizedSample(["a", "b"], -5, rng), []);
    assert.deepEqual(verbalizedSample([], 3, rng), []);
  });

  it("allocates more total probability mass to rare directions than the common one on average", () => {
    // 1 common direction and 4 rare directions
    const candidateDirs = [
      "common_baseline",
      "rare_hypothesis_1",
      "rare_hypothesis_2",
      "rare_hypothesis_3",
      "rare_hypothesis_4",
    ];

    let totalCommonMass = 0;
    let totalRareMass = 0;
    const trials = 500;

    for (let s = 0; s < trials; s++) {
      const rng = makeRng(s);
      const arms = verbalizedSample(candidateDirs, 3, rng);
      for (const arm of arms) {
        if (arm.direction === "common_baseline") {
          totalCommonMass += arm.probability;
        } else {
          totalRareMass += arm.probability;
        }
      }
    }

    const avgCommon = totalCommonMass / trials;
    const avgRare = totalRareMass / trials;

    assert.ok(
      avgRare > avgCommon,
      `expected rare mass (${avgRare}) > common mass (${avgCommon})`
    );
    assert.ok(avgRare > 0.65, `expected rare mass > 0.65, got ${avgRare}`);
    assert.ok(avgCommon < 0.35, `expected common mass < 0.35, got ${avgCommon}`);
  });

  it("is deterministic: identical seeds produce identical DirectionArm arrays", () => {
    const arms1 = verbalizedSample(directions, 4, makeRng(9999));
    const arms2 = verbalizedSample(directions, 4, makeRng(9999));
    assert.deepEqual(arms1, arms2);
  });

  it("sharpens probabilities with low temperature and flattens with high temperature", () => {
    const rng1 = makeRng(55);
    const rng2 = makeRng(55);
    const sharp = verbalizedSample(directions, 4, rng1, 0.2);
    const flat = verbalizedSample(directions, 4, rng2, 5.0);

    // Rank 0 item gets much higher probability under low temperature (sharpened)
    const sharpTop = sharp[0]?.probability ?? 0;
    const flatTop = flat[0]?.probability ?? 0;
    assert.ok(sharpTop > flatTop, `sharp top (${sharpTop}) must be > flat top (${flatTop})`);
  });
});

describe("selectLineages", () => {
  // Construct a synthetic history with 3 distinct improvement epochs:
  // Epoch 0: Run 0 (keep, metric 100) -> Runs 1..4 (discard, metric 105)
  // Epoch 1: Run 5 (keep, metric 80)  -> Runs 6..9 (discard, metric 85)
  // Epoch 2: Run 10 (keep, metric 50) -> Runs 11..14 (discard, metric 55)
  const syntheticRuns: Run[] = [
    makeRun(0, "c0_epoch0", 100, "keep"),
    makeRun(1, "c1", 105, "discard"),
    makeRun(2, "c2", 108, "discard"),
    makeRun(3, "c3", 104, "discard"),
    makeRun(4, "c4", 106, "discard"),

    makeRun(5, "c5_epoch1", 80, "keep"),
    makeRun(6, "c6", 82, "discard"),
    makeRun(7, "c7", 84, "discard"),
    makeRun(8, "c8", 81, "discard"),
    makeRun(9, "c9", 83, "discard"),

    makeRun(10, "c10_epoch2", 50, "keep"),
    makeRun(11, "c11", 52, "discard"),
    makeRun(12, "c12", 53, "discard"),
    makeRun(13, "c13", 51, "discard"),
    makeRun(14, "c14", 54, "discard"),
  ];

  it("guarantees distinct run numbers (no duplicates) and respects arms clamping", () => {
    const rng = makeRng(1);
    const lineages = selectLineages(syntheticRuns, 4, rng);
    assert.equal(lineages.length, 4);
    assert.equal(new Set(lineages).size, 4);

    // Arms clamping edge cases
    assert.deepEqual(selectLineages(syntheticRuns, 0, rng), []);
    assert.deepEqual(selectLineages(syntheticRuns, -3, rng), []);
    assert.deepEqual(selectLineages([], 5, rng), []);

    // arms > runs.length clamps to eligible run count
    const clamped = selectLineages(syntheticRuns, 100, rng);
    assert.equal(clamped.length, syntheticRuns.length);
    assert.equal(new Set(clamped).size, syntheticRuns.length);
  });

  it("filters out crashed and checks_failed runs from lineage candidates", () => {
    const runsWithCrashes: Run[] = [
      makeRun(0, "c0", 100, "keep"),
      makeRun(1, "c1_crash", 90, "crash"),
      makeRun(2, "c2_failed", 80, "checks_failed"),
      makeRun(3, "c3", 70, "keep"),
    ];
    const rng = makeRng(2);
    const chosen = selectLineages(runsWithCrashes, 4, rng);
    assert.equal(chosen.length, 2); // only run 0 and run 3 are eligible
    assert.ok(!chosen.includes(1), "must not include crash run 1");
    assert.ok(!chosen.includes(2), "must not include checks_failed run 2");
    assert.deepEqual(new Set(chosen), new Set([0, 3]));
  });

  it("spreads picks across 3 improvement epochs when codeDistance is absent", () => {
    const rng = makeRng(42);

    // arms = 3: selects all 3 epoch heads (runs 0, 5, 10)
    const threeEpochs = selectLineages(syntheticRuns, 3, rng);
    assert.equal(threeEpochs.length, 3);
    assert.ok(threeEpochs.includes(0), "must include epoch 0 root (run 0)");
    assert.ok(threeEpochs.includes(5), "must include epoch 1 root (run 5)");
    assert.ok(threeEpochs.includes(10), "must include epoch 2 root (run 10)");

    // arms = 2: selects 2 roots spread across the epoch extremes (epoch 0 and epoch 2)
    const twoEpochs = selectLineages(syntheticRuns, 2, rng);
    assert.equal(twoEpochs.length, 2);
    assert.ok(twoEpochs.includes(0), "must spread to epoch 0 root");
    assert.ok(twoEpochs.includes(10), "must spread to epoch 2 root");

    // arms = 1: selects 1 valid root
    const oneEpoch = selectLineages(syntheticRuns, 1, rng);
    assert.equal(oneEpoch.length, 1);
    assert.ok(oneEpoch[0] === 0 || oneEpoch[0] === 10);

    // arms = 5: selects all 3 epoch heads + 2 additional distinct eligible runs
    const fiveArms = selectLineages(syntheticRuns, 5, rng);
    assert.equal(fiveArms.length, 5);
    assert.equal(new Set(fiveArms).size, 5);
    assert.ok(fiveArms.includes(0), "must include epoch 0 head");
    assert.ok(fiveArms.includes(5), "must include epoch 1 head");
    assert.ok(fiveArms.includes(10), "must include epoch 2 head");
  });

  it("exhibits farthest-point behavior when synthetic codeDistance is injected", () => {
    // 3 runs with known similarity / code distance:
    // commit_A: baseline
    // commit_B: small variation of A (similarity 0.9 => distance 0.1)
    // commit_C: completely divergent branch from A (similarity 0.1 => distance 0.9)
    const runs: Run[] = [
      makeRun(0, "commit_A", 100, "keep"),
      makeRun(1, "commit_B", 85, "keep"),
      makeRun(2, "commit_C", 70, "keep"),
    ];

    const syntheticDistance: CodeDistance = (a: string, b: string) => {
      if (a === b) return 1.0;
      if ((a === "commit_A" && b === "commit_B") || (a === "commit_B" && b === "commit_A")) {
        return 0.9; // close in code (dist = 0.1)
      }
      if ((a === "commit_A" && b === "commit_C") || (a === "commit_C" && b === "commit_A")) {
        return 0.1; // far in code (dist = 0.9)
      }
      if ((a === "commit_B" && b === "commit_C") || (a === "commit_C" && b === "commit_B")) {
        return 0.15; // far in code (dist = 0.85)
      }
      return 0.5;
    };

    const rng = makeRng(101);
    // Selecting 2 lineages: starting from commit_A (run 0), farthest point MUST pick commit_C (run 2) over commit_B (run 1)
    const selected = selectLineages(runs, 2, rng, syntheticDistance);
    assert.equal(selected.length, 2);
    assert.ok(selected.includes(0), "must include initial root (run 0 / commit_A)");
    assert.ok(
      selected.includes(2),
      "farthest-point sampling must choose run 2 (commit_C, dist 0.9) over run 1 (commit_B, dist 0.1)"
    );
    assert.ok(!selected.includes(1), "run 1 (closer commit) must not be chosen when arms = 2");
  });

  it("is fully deterministic for identical seeds and inputs", () => {
    const syntheticDistance: CodeDistance = (a: string, b: string) => (a === b ? 1.0 : 0.4);
    const result1 = selectLineages(syntheticRuns, 4, makeRng(777), syntheticDistance);
    const result2 = selectLineages(syntheticRuns, 4, makeRng(777), syntheticDistance);
    assert.deepEqual(result1, result2);
  });
});
