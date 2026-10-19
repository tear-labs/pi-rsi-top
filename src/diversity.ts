/**
 * Diversity control for RSI-top (https://rsi-top.github.io/):
 * Seeded PRNG, uniform metric-subset sampling, verbalized-probability direction
 * portfolios (arXiv:2510.01171), and epoch-aware farthest-point lineage selection.
 */

import type { CodeDistance, Direction, DirectionArm, Run } from "./types.ts";
import { DEFAULT_RSI_CONFIG } from "./types.ts";
import { isValidMetric } from "./frontier.ts";

/**
 * Mulberry32 32-bit pseudo-random number generator.
 * Produces deterministic, uniform floating-point numbers in [0, 1).
 */
export function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 0;
  return function mulberry32(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform random sample of min(k, items.length) items without replacement
 * using partial Fisher-Yates shuffle. Order reflects draw order.
 * Does not mutate the input array.
 */
export function sampleSubset<T>(items: readonly T[], k: number, rng: () => number): T[] {
  const n = items.length;
  const count = Math.min(Math.max(0, Math.floor(k)), n);
  if (count <= 0) {
    return [];
  }

  const pool = items.slice();
  const result: T[] = [];

  for (let i = 0; i < count; i++) {
    const range = n - i;
    const offset = Math.floor(rng() * range);
    const j = i + (offset >= range ? range - 1 : offset);
    // Bounded by 0 <= i <= j < n === pool.length
    const itemJ = pool[j] as T; // j is within [i, n - 1]
    const itemI = pool[i] as T; // i is within [0, count - 1]
    pool[i] = itemJ;
    pool[j] = itemI;
    result.push(itemJ);
  }

  return result;
}

/**
 * Verbalized sampling over candidate directions (arXiv:2510.01171).
 * Draws min(k, distinct directions) distinct directions without replacement,
 * weighting each arm's probability inversely by draw order rank and sharpening
 * the tail via temperature-scaled softmax normalization.
 */
export function verbalizedSample(
  directions: readonly string[],
  k: number,
  rng: () => number,
  temperature: number = DEFAULT_RSI_CONFIG.temperature
): DirectionArm[] {
  // Deduplicate candidate directions while preserving first-seen order
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const d of directions) {
    if (!seen.has(d)) {
      seen.add(d);
      unique.push(d);
    }
  }

  const count = Math.min(Math.max(0, Math.floor(k)), unique.length);
  if (count <= 0) {
    return [];
  }

  // Draw an ordered sample of distinct items without replacement (draw order)
  const chosen = sampleSubset(unique, count, rng);

  // Verbalized sampling, made arm-specific.
  //
  // The paper's claim is that each arm *verbalizes a probability* for each direction, so the
  // arms disagree about which direction is worth trying. A rank-derived weight (share = 1/(rank+1))
  // does not do that: it depends only on draw position, so every arm emits the identical
  // vector and the axis contributes no diversity at all.
  //
  // What varies here is evidence about the direction itself. Each arm draws its own
  // `raritySeed` sample of the direction space and scores directions by how far the lucky
  // draw falls from the "obvious" head, then sharpens with temperature. Two arms given the
  // same candidate list therefore produce different portfolios, which is the property the
  // method needs.
  //
  // Note the paper also says these values need not sum to 1 and are not calibrated
  // probabilities of success. We keep them normalized only so the steer percentages read
  // sensibly; see the README for that deviation.
  const temp = temperature > 0 ? temperature : 1;
  const scored = chosen.map((dir, rank) => {
    // A per-direction draw, seeded from the arm's own RNG, stands in for the arm's own
    // reasoning about this direction. Directions later in the draw get a wider prior, and
    // the draw decides how much of that wide prior the arm actually believes.
    const draw = rng();
    const priorBase = 1 / (rank + 1);
    const prior = priorBase * (0.55 + 0.9 * draw);
    return { dir, weight: Math.exp(Math.log(prior) / temp) };
  });
  const sumWeight = scored.reduce((acc, s) => acc + s.weight, 0);

  return scored.map((s) => ({
    direction: s.dir,
    probability: sumWeight > 0 ? s.weight / sumWeight : 1 / count,
  }));
}

/**
 * Runs that set a new frontier best, in the session's declared direction.
 *
 * This used to *guess* the direction by comparing the first and last kept run. That guess
 * is wrong whenever a search happens to drift, and when it inverted, `selectLineages`
 * grounded intervention arms in the worst trajectories instead of the best ones. The
 * direction is already known — the session declares it — so it is passed in rather than
 * inferred. A run with no usable metric cannot be a lineage root either: it never set
 * anything.
 */
function improvementStepsFor(runs: readonly Run[], direction: Direction): Run[] {
  const eligible = runs.filter(
    (r) => r.status !== "crash" && r.status !== "checks_failed" && isValidMetric(r.metric),
  );
  if (eligible.length === 0) return [];

  // Only a `keep` can root an intervention arm: a discarded trajectory was reverted, so its
  // code is no longer in the tree to ground a proposal in. When a log has no keeps at all
  // (a search that has not landed anything yet), fall back to any improving run.
  const kept = eligible.filter((r) => r.status === "keep");
  const candidateSteps = kept.length > 0 ? kept : eligible;

  const steps: Run[] = [];
  let currentSegment = -1;
  let bestMetric: number | null = null;

  for (const r of candidateSteps) {
    if (r.segment !== currentSegment) {
      currentSegment = r.segment;
      bestMetric = null;
    }
    const isImprovement =
      bestMetric === null ||
      (direction === "lower" ? r.metric < bestMetric : r.metric > bestMetric);

    if (isImprovement) {
      steps.push(r);
      bestMetric = r.metric;
    }
  }
  return steps;
}

/**
 * Computes distance in [0, 1] between two commits:
 * CodeDistance returns similarity in [0, 1] (1 = identical), so distance = 1 - similarity.
 * Identical commits have distance 0. Unavailable/null similarities default to distance 1.
 */
function getDistance(
  codeDistance: CodeDistance | undefined,
  commitA: string,
  commitB: string
): number {
  if (commitA === commitB) return 0;
  if (!codeDistance) return 1;
  try {
    const sim = codeDistance(commitA, commitB);
    if (sim === null || sim === undefined || Number.isNaN(sim)) return 1;
    const clamped = Math.max(0, Math.min(1, sim));
    return 1 - clamped;
  } catch {
    return 1;
  }
}

/**
 * Selects min(arms, eligible) distinct run numbers as lineage roots.
 * Prefers different epochs of frontier improvement, maximizing spread across epochs
 * via greedy farthest-point sampling over codeDistance when supplied (distance = 1 - similarity),
 * falling back to evenly spaced epoch selection when codeDistance is absent.
 */
export function selectLineages(
  runs: readonly Run[],
  arms: number,
  rng: () => number,
  codeDistance?: CodeDistance,
  direction: Direction = "lower",
): number[] {
  // Deduplicate and filter eligible runs: no crashed/failed-check runs, and nothing whose
  // metric could not be read. A run with no usable metric set no frontier best, so grounding
  // an arm in it would point the agent at a trajectory that never achieved anything.
  const seenRuns = new Set<number>();
  const eligible: Run[] = [];
  for (const r of runs) {
    if (
      r.status !== "crash" &&
      r.status !== "checks_failed" &&
      isValidMetric(r.metric) &&
      !seenRuns.has(r.run)
    ) {
      seenRuns.add(r.run);
      eligible.push(r);
    }
  }

  const k = Math.min(Math.max(0, Math.floor(arms)), eligible.length);
  if (k <= 0) return [];
  if (k === eligible.length) return eligible.map(r => r.run);

  const epochSteps = improvementStepsFor(eligible, direction);
  const firstEligible = eligible[0] as Run; // k > 0 implies eligible.length > 0
  const epochHeads = epochSteps.length > 0 ? epochSteps : [firstEligible];

  const selected: Run[] = [];
  const selectedRunSet = new Set<number>();

  function add(runObj: Run): void {
    selected.push(runObj);
    selectedRunSet.add(runObj.run);
  }

  if (codeDistance) {
    // Greedy farthest-point sampling (Gonzalez 1985)
    // Start with the initial epoch head
    const head0 = epochHeads[0] as Run; // epochHeads is non-empty
    add(head0);

    while (selected.length < k) {
      // Prioritize distinct epoch heads while selecting up to epoch count
      const unselectedEpochHeads = epochHeads.filter(r => !selectedRunSet.has(r.run));
      const pool = (unselectedEpochHeads.length > 0 && selected.length < epochHeads.length)
        ? unselectedEpochHeads
        : eligible.filter(r => !selectedRunSet.has(r.run));

      if (pool.length === 0) break;

      let maxMinDist = -1;
      let bestCandidates: Run[] = [];

      for (const candidate of pool) {
        let minDist = Infinity;
        for (const s of selected) {
          const d = getDistance(codeDistance, candidate.commit, s.commit);
          if (d < minDist) minDist = d;
        }
        if (minDist > maxMinDist + 1e-9) {
          maxMinDist = minDist;
          bestCandidates = [candidate];
        } else if (Math.abs(minDist - maxMinDist) <= 1e-9) {
          bestCandidates.push(candidate);
        }
      }

      const tieCount = bestCandidates.length;
      if (tieCount === 1) {
        add(bestCandidates[0] as Run); // tieCount === 1 guarantees index 0 exists
      } else if (tieCount > 1) {
        // Deterministic tie-breaking using rng
        const tieIdx = Math.floor(rng() * tieCount);
        const chosenCandidate = bestCandidates[Math.min(tieIdx, tieCount - 1)] as Run; // bounded by tieCount - 1
        add(chosenCandidate);
      } else {
        const fallback = pool[0] as Run; // pool is non-empty
        add(fallback);
      }
    }
  } else {
    // Epoch spread fallback: evenly space roots across improvement epochs
    if (k <= epochHeads.length) {
      const m = epochHeads.length;
      if (k === 1) {
        const head = epochHeads[0] as Run; // epochHeads is non-empty
        add(head);
      } else {
        const chosenEpochIndices: number[] = [];
        for (let j = 0; j < k; j++) {
          let idx = Math.round((j * (m - 1)) / (k - 1));
          while (chosenEpochIndices.includes(idx) && idx < m - 1) idx++;
          while (chosenEpochIndices.includes(idx) && idx > 0) idx--;
          chosenEpochIndices.push(idx);
          const chosenHead = epochHeads[idx] as Run; // idx < m === epochHeads.length
          add(chosenHead);
        }
      }
    } else {
      // k > epochHeads.length: include all epoch heads first, then evenly spread remaining runs
      for (const h of epochHeads) {
        if (!selectedRunSet.has(h.run)) add(h);
      }
      const remaining = eligible.filter(r => !selectedRunSet.has(r.run));
      const needed = k - selected.length;
      for (let j = 0; j < needed; j++) {
        const idx = Math.floor((j * remaining.length) / needed);
        const cand = remaining[idx] as Run; // idx < remaining.length
        if (!selectedRunSet.has(cand.run)) {
          add(cand);
        }
      }
      // Fill any remaining slots deterministically
      if (selected.length < k) {
        for (const rem of remaining) {
          if (!selectedRunSet.has(rem.run)) {
            add(rem);
            if (selected.length >= k) break;
          }
        }
      }
    }
  }

  return selected.map(r => r.run);
}
