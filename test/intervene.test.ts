/**
 * Cohort-plan wiring tests.
 *
 * The one thing this file guards: `buildCohortPlan` has a `codeDistance` option, and the
 * effectful callers (hook, CLI, extension) must actually pass it. When nobody passed it, the
 * lineage spread silently degraded to epoch spacing inside a git work tree while the README
 * claimed edit-distance ordering — a claim with no wiring behind it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCohortPlan } from "../src/intervene.ts";
import { codeDistanceFor } from "../src/code-distance.ts";
import { detectStall } from "../src/stall.ts";
import { DEFAULT_RSI_CONFIG, DEFAULT_STALL_CONFIG } from "../src/types.ts";
import type { CodeDistance, Run, SessionSnapshot } from "../src/types.ts";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function run(runId: number, commit: string, metric: number, timestamp: number, status: Run["status"] = "discard"): Run {
  return {
    run: runId,
    commit,
    metric,
    metrics: {},
    status,
    description: `run ${runId}`,
    timestamp,
    segment: 0,
    confidence: null,
  };
}

/** Four improvement epochs, each one a strictly better metric. */
function history(): Run[] {
  const base = 1_700_000_000_000;
  return [
    run(1, "aaa", 400, base + 0, "keep"),
    run(2, "bbb", 380, base + 60_000),
    run(3, "ccc", 360, base + 120_000, "keep"),
    run(4, "ddd", 340, base + 180_000),
    run(5, "eee", 320, base + 240_000, "keep"),
    run(6, "fff", 300, base + 300_000),
    run(7, "ggg", 280, base + 360_000, "keep"),
    run(8, "hhh", 260, base + 420_000),
  ];
}

function session(): SessionSnapshot {
  return {
    metric_name: "cycles",
    metric_unit: "",
    direction: "lower",
    baseline_metric: 400,
    best_metric: 260,
    run_count: 8,
    goal: "test",
    name: "test",
  };
}

/**
 * Only two improvement epochs (runs 1 and 5), so a 4-arm cohort is forced past the
 * "prefer distinct epoch heads" phase and into the pool where distance decides. With the
 * four-epoch `history()` above, cohortSize 4 is fully consumed by epoch heads and
 * `selectLineages` never consults the distance at all.
 */
function shallowHistory(): Run[] {
  const base = 1_700_000_000_000;
  return [
    run(1, "aaa", 400, base + 0, "keep"),
    run(2, "bbb", 395, base + 60_000),
    run(3, "ccc", 390, base + 120_000),
    run(4, "ddd", 385, base + 180_000),
    run(5, "eee", 320, base + 240_000, "keep"),
    run(6, "fff", 330, base + 300_000),
    run(7, "ggg", 335, base + 360_000),
    run(8, "hhh", 340, base + 420_000),
  ];
}

/** Similarity where commit letters are 1/7 of the way apart: "aaa" == index 0, "hhh" == 7. */
const letterDistance: CodeDistance = (a, b) => {
  const ia = a.charCodeAt(0) - 97;
  const ib = b.charCodeAt(0) - 97;
  return 1 - Math.abs(ia - ib) / 7;
};

function planFor(codeDistance?: CodeDistance | null, runs: Run[] = history()) {
  const stall = detectStall(runs, session(), DEFAULT_STALL_CONFIG, 1_700_000_000_000 + 3_600_000);
  return buildCohortPlan(runs, session(), stall, { ...DEFAULT_RSI_CONFIG, cohortSize: 4 }, {
    seed: 7,
    ...(codeDistance === undefined ? {} : { codeDistance }),
  });
}

test("codeDistanceFor returns null outside a git work tree and a function inside one", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-cd-"));
  try {
    assert.equal(codeDistanceFor(tmp), null, "a bare temp dir is not a git work tree");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.notEqual(codeDistanceFor(REPO), null, "the package repo itself is a git work tree");
});

test("baseline: without a code distance, lineages still come out distinct", () => {
  const plan = planFor();
  const roots = plan.arms.map((a) => a.lineage);
  assert.equal(roots.length, 4);
  assert.equal(new Set(roots).size, 4, "arms must not share a lineage root");
});

test("an injected code distance actually reaches lineage selection", () => {
  // Distance 0 between every pair forces farthest-point sampling to fall back to its
  // tie-break path, which is observably different from epoch spacing.
  const flat: CodeDistance = () => 1;
  const seen: Array<[string, string]> = [];
  const recording: CodeDistance = (a, b) => {
    seen.push([a, b]);
    return flat(a, b);
  };
  planFor(recording);
  assert.ok(seen.length > 0, "lineage selection must consult the injected code distance");
  for (const [a, b] of seen) {
    assert.ok(a.length > 0 && b.length > 0, "distance is queried with real commit ids");
  }
});

test("a null code distance is accepted and behaves like an absent one", () => {
  const withNull = planFor(null);
  const withUndefined = planFor();
  assert.deepEqual(
    withNull.arms.map((a) => a.lineage),
    withUndefined.arms.map((a) => a.lineage),
    "codeDistance: null must not change the plan",
  );
});

test("a real distance changes the chosen lineage roots", () => {
  const spread = planFor(letterDistance, shallowHistory()).arms.map((a) => a.lineage);
  const plain = planFor(undefined, shallowHistory()).arms.map((a) => a.lineage);
  assert.notDeepEqual(spread, plain, "a real distance must be able to change the selection");
  assert.equal(new Set(spread).size, spread.length, "roots stay distinct either way");
  // Farthest-point sampling from {aaa, eee} must reach for the far end of the letter line.
  assert.equal(spread[0], 1);
  assert.equal(spread[1], 5);
  assert.equal(spread[2], 8, "the run farthest from both roots wins the third slot");
  assert.ok(
    spread[3] === 3 || spread[3] === 7,
    "then the next farthest; 3 and 7 tie at distance 2/7, broken deterministically by the seed",
  );
});

test("the plan is deterministic for a fixed seed and distance", () => {
  assert.deepEqual(planFor(letterDistance, shallowHistory()), planFor(letterDistance, shallowHistory()));
});
