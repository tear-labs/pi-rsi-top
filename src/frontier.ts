/**
 * Frontier tracking (RSI-top: https://rsi-top.github.io/).
 * Tracks best-so-far trajectory metrics, strictly improving steps, and
 * meaningful improvement epochs across autoresearch segments.
 */

import type { Direction, Run } from "./types.ts";

/** One point on the frontier trajectory. */
export interface FrontierPoint {
  run: number;
  metric: number;
  timestamp: number;
  segment: number;
}

/** Check if a metric value is finite and numeric. */
export function isValidMetric(metric: number): boolean {
  return typeof metric === "number" && Number.isFinite(metric);
}

/**
 * Check if a run is eligible to move the frontier.
 * Note: crash and checks_failed runs do not move the frontier.
 */
function isValidRun(run: Run): boolean {
  return (
    run.status !== "crash" &&
    run.status !== "checks_failed" &&
    isValidMetric(run.metric)
  );
}

/** Check if metricA is strictly better than metricB respecting direction. */
function isBetter(metricA: number, metricB: number, direction: Direction): boolean {
  return direction === "lower" ? metricA < metricB : metricA > metricB;
}

/** Compute improvement gain of metric relative to priorBest. Positive = better. */
function computeGain(metric: number, priorBest: number, direction: Direction): number {
  return direction === "lower" ? priorBest - metric : metric - priorBest;
}

/**
 * Best-so-far frontier value after each run (never worse than the previous point).
 * Respects segments: a segment reset restarts the frontier from scratch.
 * Crash and checks_failed runs do not move the frontier.
 *
 * @param runs History of autoresearch runs.
 * @param direction "lower" if smaller metric is better, else "higher".
 * @returns Array of FrontierPoint objects, one for each evaluated run once a valid baseline exists.
 */
export function frontierSeries(runs: Run[], direction: Direction): FrontierPoint[] {
  const result: FrontierPoint[] = [];
  if (runs.length === 0) return result;

  let currentSegment = -1;
  let currentBest: number | null = null;

  for (const r of runs) {
    if (r.segment !== currentSegment) {
      currentSegment = r.segment;
      currentBest = null;
    }

    if (isValidRun(r)) {
      if (currentBest === null || isBetter(r.metric, currentBest, direction)) {
        currentBest = r.metric;
      }
    }

    if (currentBest !== null) {
      result.push({
        run: r.run,
        metric: currentBest,
        timestamp: r.timestamp,
        segment: r.segment,
      });
    }
  }

  return result;
}

/**
 * Returns only the points that were strictly new bests.
 * Crash and checks_failed runs do not move the frontier.
 * Respects segments: a segment reset restarts the frontier.
 * When minGain is supplied (> 0), sub-minGain gains are skipped.
 *
 * @param runs History of autoresearch runs.
 * @param direction "lower" if smaller metric is better, else "higher".
 * @param minGain Minimum metric gain required over the prior frontier (default 0).
 * @returns Array of FrontierPoint objects representing strictly new bests.
 */
export function improvementSteps(
  runs: Run[],
  direction: Direction,
  minGain: number = 0
): FrontierPoint[] {
  const result: FrontierPoint[] = [];
  if (runs.length === 0) return result;

  let currentSegment = -1;
  let currentBest: number | null = null;

  for (const r of runs) {
    if (r.segment !== currentSegment) {
      currentSegment = r.segment;
      currentBest = null;
    }

    if (!isValidRun(r)) continue;

    if (currentBest === null) {
      currentBest = r.metric;
      result.push({
        run: r.run,
        metric: r.metric,
        timestamp: r.timestamp,
        segment: r.segment,
      });
    } else if (isBetter(r.metric, currentBest, direction)) {
      const gain = computeGain(r.metric, currentBest, direction);
      if (gain >= minGain) {
        currentBest = r.metric;
        result.push({
          run: r.run,
          metric: r.metric,
          timestamp: r.timestamp,
          segment: r.segment,
        });
      }
    }
  }

  return result;
}

/**
 * Finds the most recent improvement whose gain over the prior frontier is >= minGain.
 * Returns null when no run qualifies. Non-finite / zero-gain and crash runs never qualify.
 * Respects segments: evaluates improvements within the active (latest) segment.
 *
 * @param runs History of autoresearch runs.
 * @param direction "lower" if smaller metric is better, else "higher".
 * @param minGain Minimum metric gain required to count as a meaningful improvement.
 * @returns FrontierPoint of the most recent meaningful improvement, or null.
 */
export function lastMeaningfulImprovement(
  runs: Run[],
  direction: Direction,
  minGain: number
): FrontierPoint | null {
  if (runs.length === 0 || !Number.isFinite(minGain) || minGain <= 0) {
    return null;
  }

  const currentSegment = runs[runs.length - 1]!.segment;
  const segRuns = runs.filter((r) => r.segment === currentSegment);

  let priorFrontier: number | null = null;
  let lastMeaningful: FrontierPoint | null = null;

  for (const r of segRuns) {
    if (!isValidRun(r)) continue;

    if (priorFrontier === null) {
      priorFrontier = r.metric;
      continue;
    }

    if (isBetter(r.metric, priorFrontier, direction)) {
      const gain = computeGain(r.metric, priorFrontier, direction);
      if (gain >= minGain) {
        priorFrontier = r.metric;
        lastMeaningful = {
          run: r.run,
          metric: r.metric,
          timestamp: r.timestamp,
          segment: r.segment,
        };
      }
    }
  }

  return lastMeaningful;
}

/**
 * Number of runs since the last meaningful improvement in the active segment.
 * Returns 0 if it was the last run; equals total runs considered if there was none.
 *
 * @param runs History of autoresearch runs.
 * @param direction "lower" if smaller metric is better, else "higher".
 * @param minGain Minimum metric gain required for a meaningful improvement.
 * @returns Number of runs elapsed since the meaningful improvement.
 */
export function frontierEpochAge(
  runs: Run[],
  direction: Direction,
  minGain: number
): number {
  if (runs.length === 0) return 0;

  const currentSegment = runs[runs.length - 1]!.segment;
  const segRuns = runs.filter((r) => r.segment === currentSegment);

  const lastImp = lastMeaningfulImprovement(segRuns, direction, minGain);
  if (lastImp === null) {
    return segRuns.length;
  }

  const idx = segRuns.findIndex((r) => r.run === lastImp.run);
  if (idx === -1) {
    return segRuns.length;
  }

  return segRuns.length - 1 - idx;
}
