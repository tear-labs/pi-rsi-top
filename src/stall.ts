/**
 * Stall detection (RSI-top: https://rsi-top.github.io/).
 * Monitors the autoresearch frontier to detect exploration collapse when the
 * best score stalls for an extended wall-clock duration without meaningful gain.
 */

import {
  DEFAULT_STALL_CONFIG,
  type Run,
  type SessionSnapshot,
  type StallConfig,
  type StallState,
} from "./types.ts";
import { frontierEpochAge, lastMeaningfulImprovement } from "./frontier.ts";

/**
 * A log whose newest run is older than this is treated as archived, not live, so the
 * stall clock is pinned to that last run. Without it, replaying a finished or committed
 * log reports a permanent stall — including one whose final trajectory set a new frontier.
 */
export const STALE_LOG_MS = 24 * 60 * 60_000;

/**
 * Detects whether the search frontier has stalled according to StallConfig.
 *
 * Rules:
 * - Not stalled when: fewer than cfg.minRuns runs; total elapsed time from the
 *   first run's timestamp is under cfg.ignoreFirstMs (warm-up window); or no run
 *   has a usable metric yet.
 * - Stalled when the frontier has not improved by at least cfg.minGain for
 *   >= cfg.minStallMs of wall clock since the last meaningful improvement. When
 *   there has never been a meaningful improvement, measures from the expiry of
 *   ignoreFirstMs.
 * - Always populates frontier, frontierRun, epochAge, stalledForMs, and
 *   stalledForRuns even when stalled === false.
 * - If the last meaningful improvement is in the future relative to now (bad clock),
 *   stalledForMs is clamped to 0 and reported as stalled: false.
 *
 * @param runs History of autoresearch runs.
 * @param session Session snapshot containing metric direction and metadata.
 * @param cfg Stall configuration (defaults to DEFAULT_STALL_CONFIG).
 * @param now Current timestamp in milliseconds (defaults to Date.now()).
 * @returns StallState describing whether search has stalled and relevant frontier metrics.
 */
export function detectStall(
  runs: Run[],
  session: SessionSnapshot,
  cfg: StallConfig = DEFAULT_STALL_CONFIG,
  now?: number
): StallState {
  const rawTime = now ?? Date.now();

  // Stale-log rule: never let an archived log look like an ongoing stall. The newest run
  // pins the clock, so a run that finished months ago is scored as of its own last entry.
  const newest = runs.reduce((acc, r) => (r.timestamp > acc ? r.timestamp : acc), Number.NEGATIVE_INFINITY);
  const currentTime =
    Number.isFinite(newest) && rawTime - newest > STALE_LOG_MS ? newest : rawTime;

  if (runs.length === 0) {
    return {
      stalled: false,
      stalledForMs: 0,
      stalledForRuns: 0,
      frontier: null,
      frontierRun: null,
      epochAge: 0,
      reason: `Fewer than ${cfg.minRuns} runs (have 0)`,
    };
  }

  const currentSegment = runs[runs.length - 1]!.segment;
  const segRuns = runs.filter((r) => r.segment === currentSegment);

  // Compute frontier and frontierRun within the active segment
  let frontier: number | null = null;
  let frontierRun: number | null = null;

  for (const r of segRuns) {
    if (
      r.status !== "crash" &&
      r.status !== "checks_failed" &&
      typeof r.metric === "number" &&
      Number.isFinite(r.metric)
    ) {
      if (
        frontier === null ||
        (session.direction === "lower"
          ? r.metric < frontier
          : r.metric > frontier)
      ) {
        frontier = r.metric;
        frontierRun = r.run;
      }
    }
  }

  const lastImp = lastMeaningfulImprovement(segRuns, session.direction, cfg.minGain);
  const epochAge = frontierEpochAge(segRuns, session.direction, cfg.minGain);
  const stalledForRuns = epochAge;

  const firstRun = segRuns[0]!;
  let stalledForMs = 0;

  if (lastImp !== null) {
    stalledForMs = currentTime - lastImp.timestamp;
  } else {
    // When there has never been a meaningful improvement, measure from the expiry of ignoreFirstMs
    stalledForMs = currentTime - (firstRun.timestamp + cfg.ignoreFirstMs);
  }

  // Never produce negative durations
  if (stalledForMs < 0) {
    stalledForMs = 0;
  }

  // Gate 1: fewer than cfg.minRuns
  if (segRuns.length < cfg.minRuns) {
    return {
      stalled: false,
      stalledForMs,
      stalledForRuns,
      frontier,
      frontierRun,
      epochAge,
      reason: `Fewer than ${cfg.minRuns} runs (have ${segRuns.length})`,
    };
  }

  // Gate 2: total elapsed time from the first run's timestamp is under cfg.ignoreFirstMs
  const elapsed = currentTime - firstRun.timestamp;
  if (elapsed < cfg.ignoreFirstMs) {
    return {
      stalled: false,
      stalledForMs,
      stalledForRuns,
      frontier,
      frontierRun,
      epochAge,
      reason: `Within warm-up window (${Math.max(0, elapsed)}ms < ${cfg.ignoreFirstMs}ms)`,
    };
  }

  // Gate 3: no run has a usable metric yet
  if (frontier === null) {
    return {
      stalled: false,
      stalledForMs,
      stalledForRuns,
      frontier,
      frontierRun,
      epochAge,
      reason: "No run has a usable metric yet",
    };
  }

  // Gate 4: last meaningful improvement is in the future relative to now (clock skew)
  if (lastImp !== null && lastImp.timestamp > currentTime) {
    return {
      stalled: false,
      stalledForMs: 0,
      stalledForRuns,
      frontier,
      frontierRun,
      epochAge,
      reason: "Clock skew: last meaningful improvement is in the future",
    };
  }

  // Stall check: flat for >= cfg.minStallMs
  if (stalledForMs >= cfg.minStallMs) {
    return {
      stalled: true,
      stalledForMs,
      stalledForRuns,
      frontier,
      frontierRun,
      epochAge,
      reason: "",
    };
  }

  return {
    stalled: false,
    stalledForMs,
    stalledForRuns,
    frontier,
    frontierRun,
    epochAge,
    reason: `Not stalled: flat for ${stalledForMs}ms (< ${cfg.minStallMs}ms)`,
  };
}
