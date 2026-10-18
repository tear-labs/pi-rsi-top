/**
 * Metric dashboard computation for RSI-top (Scaling Intelligence Lab, Stanford).
 * Implements trajectory feature compression: mapping each autoresearch trajectory
 * into a multi-family metric row (unary, binary, region, global) so agents can scan,
 * compare, and detect frontier stalls without loading full trajectory transcripts.
 */

import type {
  CodeDistance,
  Direction,
  MetricContext,
  MetricSpec,
  Run,
} from "./types.ts";

/** Default context values when optional context properties are omitted. */
const DEFAULT_DIRECTION: Direction = "lower";
const DEFAULT_WINDOW = 12;
const DEFAULT_MIN_GAIN = 2;

// Local helper duplicated to avoid importing from src/frontier.ts (owned by lane B, written concurrently).
function isBetter(a: number, b: number, direction: Direction): boolean {
  return direction === "lower" ? a < b : a > b;
}

// Local helper duplicated to compute directional metric gain (positive = improvement).
function metricGain(newer: number, older: number, direction: Direction): number {
  return direction === "lower" ? older - newer : newer - older;
}

/** Static array of all 24 metric specifications in stable order. */
const ALL_METRIC_SPECS: readonly MetricSpec[] = [
  // --- Unary metrics (trajectory alone) ---
  {
    name: "cycles",
    kind: "unary",
    description: "Primary metric value for this trajectory (clock cycles or objective score)",
    better: "lower",
  },
  {
    name: "valid_attempt",
    kind: "unary",
    description: "Whether this trajectory passed checks and completed eval (1 = valid, 0 = crash/checks_failed)",
    better: "higher",
  },
  {
    name: "recorded_change_count",
    kind: "unary",
    description: "Number of distinct code changes or hypotheses recorded in trajectory memory",
    better: "higher",
  },

  // --- Binary metrics (trajectory vs parent / frontier / nearest earlier state) ---
  {
    name: "parent_gain",
    kind: "binary",
    description: "Metric improvement over parent trajectory (positive = improvement)",
    better: "higher",
  },
  {
    name: "frontier_relative_gap",
    kind: "binary",
    description: "Relative performance gap between this trajectory and prior frontier (lower is better)",
    better: "lower",
  },
  {
    name: "parent_code_distance",
    kind: "binary",
    description: "Normalized code distance to parent commit (1 - similarity, lower is better)",
    better: "lower",
  },
  {
    name: "frontier_code_distance",
    kind: "binary",
    description: "Normalized code distance to current frontier commit (1 - similarity, lower is better)",
    better: "lower",
  },
  {
    name: "nearest_history_similarity",
    kind: "binary",
    description: "Maximum code similarity to any prior trajectory in history",
    better: "higher",
  },
  {
    name: "meaningful_relative_gain",
    kind: "binary",
    description: "Relative metric gain over prior frontier for meaningful improvements (>= minGain)",
    better: "higher",
  },
  {
    name: "gap_in_recent_step_units",
    kind: "binary",
    description: "Distance to frontier normalized by recent step size or minGain (lower is better)",
    better: "lower",
  },

  // --- Region metrics (trailing window) ---
  {
    name: "frontier_relative_spread",
    kind: "region",
    description: "Spread of valid metrics across trailing window relative to the frontier",
    better: "higher",
  },
  {
    name: "root_relative_spread",
    kind: "region",
    description: "Spread of valid window metrics relative to the segment root metric",
    better: "higher",
  },
  {
    name: "parent_selection_concentration",
    kind: "region",
    description: "Herfindahl concentration index of parent choices in trailing window (lower is more diverse)",
    better: "lower",
  },
  {
    name: "window_frontier_gain",
    kind: "region",
    description: "Total frontier improvement achieved across trailing window over pre-window frontier",
    better: "higher",
  },
  {
    name: "window_redundancy_rate",
    kind: "region",
    description: "Fraction of window trajectories revisiting past runs or repeating near-identical code",
    better: "lower",
  },
  {
    name: "window_valid_rate",
    kind: "region",
    description: "Fraction of window trajectories that completed evaluation without crashing",
    better: "higher",
  },
  {
    name: "window_frontier_conversion_rate",
    kind: "region",
    description: "Fraction of window trajectories that successfully advanced the frontier",
    better: "higher",
  },
  {
    name: "within_one_recent_step_rate",
    kind: "region",
    description: "Fraction of window trajectories within one step unit (minGain) of the frontier",
    better: "higher",
  },
  {
    name: "dominant_failure_signature_mass",
    kind: "region",
    description: "Share of failing window trajectories matching the most common failure mode",
    better: "lower",
  },
  {
    name: "repeated_failure_rate",
    kind: "region",
    description: "Rate of repeated failing trajectory signatures across trailing window",
    better: "lower",
  },

  // --- Global metrics (whole run) ---
  {
    name: "seconds_since_meaningful_improvement",
    kind: "global",
    description: "Elapsed wall-clock seconds since last meaningful frontier improvement (>= minGain)",
    better: "lower",
  },
  {
    name: "frontier_epoch_age_steps",
    kind: "global",
    description: "Number of trajectories elapsed since last meaningful frontier improvement",
    better: "lower",
  },
  {
    name: "best_descendant_metric",
    kind: "global",
    description: "Best authoritative metric observed among subtree trajectories rooted at this run",
    better: "lower",
  },
  {
    name: "frontier_improvement_count",
    kind: "global",
    description: "Cumulative count of strictly improving frontier milestones up to this trajectory",
    better: "higher",
  },
];

/**
 * Returns a defensive copy of the stable list of all 24 dashboard metric specifications,
 * grouped strictly by kind (unary, binary, region, global).
 */
export function metricSpecs(): MetricSpec[] {
  return [...ALL_METRIC_SPECS];
}

/** Safely calls the injected code distance function, tolerating exceptions and invalid returns. */
function safeCodeDist(fn: CodeDistance | null, a: string, b: string): number | null {
  if (!fn || !a || !b) return null;
  try {
    const res = fn(a, b);
    return typeof res === "number" && Number.isFinite(res) ? Math.max(0, Math.min(1, res)) : null;
  } catch {
    return null;
  }
}

/**
 * Derives recorded change count from `run.asi` when present, else returns null.
 * Counts numeric `revisits_run`, hypothesis, and description signal without guessing.
 */
function extractChangeCount(run: Run): number | null {
  if (!run.asi || typeof run.asi !== "object") {
    return null;
  }
  const asi = run.asi;
  if (typeof asi["change_count"] === "number" && Number.isFinite(asi["change_count"])) {
    return asi["change_count"];
  }
  if (typeof asi["recorded_change_count"] === "number" && Number.isFinite(asi["recorded_change_count"])) {
    return asi["recorded_change_count"];
  }
  if (Array.isArray(asi["changes"])) {
    return asi["changes"].length;
  }

  let count = 0;
  if (typeof asi["revisits_run"] === "number" && Number.isFinite(asi["revisits_run"])) {
    count += asi["revisits_run"];
  } else if (asi["revisits_run"] != null) {
    count += 1;
  }

  if (typeof asi["hypothesis"] === "string" && asi["hypothesis"].trim().length > 0) {
    count += 1;
  }

  if (typeof run.description === "string" && run.description.trim().length > 0) {
    count += 1;
  }

  for (const [k, v] of Object.entries(asi)) {
    if (k === "revisits_run" || k === "hypothesis") continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      count += v;
    } else if (v !== null && v !== undefined && v !== "") {
      count += 1;
    }
  }

  return count > 0 ? count : 1;
}

/**
 * Computes all 24 dashboard row metric values for the trajectory at `index` in `history`.
 * Must never throw for any combination of history, index, duplicate timestamps,
 * crash statuses, or zero metrics. Returns null for non-computable metrics.
 */
export function computeRowValues(
  history: Run[],
  index: number,
  ctx?: Partial<MetricContext>
): Record<string, number | null> {
  const specs = ALL_METRIC_SPECS;
  const emptyRow: Record<string, number | null> = {};
  for (const spec of specs) {
    emptyRow[spec.name] = null;
  }

  if (!Array.isArray(history) || index < 0 || index >= history.length || !Number.isInteger(index)) {
    return emptyRow;
  }

  const currentRun = history[index];
  if (!currentRun) {
    return emptyRow;
  }

  const direction: Direction = ctx?.direction ?? DEFAULT_DIRECTION;
  const windowSize: number = Math.max(1, ctx?.window ?? DEFAULT_WINDOW);
  const minGain: number = ctx?.minGain ?? DEFAULT_MIN_GAIN;
  const codeDist: CodeDistance | null = ctx?.codeDistance ?? null;

  const currentSegment = currentRun.segment;
  const isCurrentValid =
    (currentRun.status === "keep" || currentRun.status === "discard") &&
    Number.isFinite(currentRun.metric);

  // Segment runs up to and including current trajectory
  const segmentRunsUpToCurrent: Run[] = [];
  for (let i = 0; i <= index; i++) {
    const r = history[i];
    if (r && r.segment === currentSegment) {
      segmentRunsUpToCurrent.push(r);
    }
  }

  // Prior run in the same segment (inferred parent)
  const parentRun: Run | null =
    index > 0 && history[index - 1] && history[index - 1]!.segment === currentSegment
      ? history[index - 1]!
      : null;

  // Prior valid runs in the same segment (strictly before current trajectory)
  const priorValidRunsInSegment: Run[] = [];
  for (let i = 0; i < segmentRunsUpToCurrent.length - 1; i++) {
    const r = segmentRunsUpToCurrent[i];
    if (r && (r.status === "keep" || r.status === "discard") && Number.isFinite(r.metric)) {
      priorValidRunsInSegment.push(r);
    }
  }

  // Prior frontier up to (but not including) current trajectory
  let priorFrontierMetric: number | null = null;
  let priorFrontierRun: Run | null = null;
  for (const r of priorValidRunsInSegment) {
    if (priorFrontierMetric === null || isBetter(r.metric, priorFrontierMetric, direction)) {
      priorFrontierMetric = r.metric;
      priorFrontierRun = r;
    }
  }

  // Current frontier up to and including current trajectory
  let currentFrontierMetric = priorFrontierMetric;
  if (isCurrentValid) {
    if (currentFrontierMetric === null || isBetter(currentRun.metric, currentFrontierMetric, direction)) {
      currentFrontierMetric = currentRun.metric;
    }
  }

  // Track frontier improvements and meaningful improvements across segment
  let segmentF: number | null = null;
  let lastMeaningfulTimestamp: number | null = null;
  let epochAge = 0;
  let improvementCount = 0;
  const stepGains: number[] = [];

  for (const r of segmentRunsUpToCurrent) {
    if (r.status !== "keep" && r.status !== "discard") {
      epochAge++;
      continue;
    }
    if (!Number.isFinite(r.metric)) {
      epochAge++;
      continue;
    }

    if (segmentF === null) {
      segmentF = r.metric;
      lastMeaningfulTimestamp = r.timestamp;
      epochAge = 0;
      improvementCount = 1;
    } else {
      const g = metricGain(r.metric, segmentF, direction);
      if (g > 0) {
        stepGains.push(g);
        improvementCount++;
        segmentF = r.metric;
        if (g >= minGain) {
          lastMeaningfulTimestamp = r.timestamp;
          epochAge = 0;
        } else {
          epochAge++;
        }
      } else {
        epochAge++;
      }
    }
  }

  const values: Record<string, number | null> = {};

  // ==========================================
  // 1. Unary metrics
  // ==========================================

  values["cycles"] = isCurrentValid ? currentRun.metric : null;

  values["valid_attempt"] =
    currentRun.status === "keep" || currentRun.status === "discard" ? 1 : 0;

  values["recorded_change_count"] = extractChangeCount(currentRun);

  // ==========================================
  // 2. Binary metrics
  // ==========================================

  if (
    parentRun &&
    isCurrentValid &&
    (parentRun.status === "keep" || parentRun.status === "discard") &&
    Number.isFinite(parentRun.metric)
  ) {
    values["parent_gain"] = metricGain(currentRun.metric, parentRun.metric, direction);
  } else {
    values["parent_gain"] = null;
  }

  // frontier_relative_gap: 0 at frontier or better; (metric - frontier)/metric when worse
  if (isCurrentValid && currentFrontierMetric !== null) {
    if (direction === "lower") {
      if (currentRun.metric <= currentFrontierMetric) {
        values["frontier_relative_gap"] = 0;
      } else {
        const denom = Math.abs(currentRun.metric) > 0 ? Math.abs(currentRun.metric) : 1;
        values["frontier_relative_gap"] = (currentRun.metric - currentFrontierMetric) / denom;
      }
    } else {
      if (currentRun.metric >= currentFrontierMetric) {
        values["frontier_relative_gap"] = 0;
      } else {
        const denom = Math.abs(currentFrontierMetric) > 0 ? Math.abs(currentFrontierMetric) : 1;
        values["frontier_relative_gap"] = (currentFrontierMetric - currentRun.metric) / denom;
      }
    }
  } else {
    values["frontier_relative_gap"] = null;
  }

  if (codeDist && parentRun && currentRun.commit && parentRun.commit) {
    const sim = safeCodeDist(codeDist, currentRun.commit, parentRun.commit);
    values["parent_code_distance"] = sim !== null ? 1 - sim : null;
  } else {
    values["parent_code_distance"] = null;
  }

  if (codeDist && priorFrontierRun && currentRun.commit && priorFrontierRun.commit) {
    const sim = safeCodeDist(codeDist, currentRun.commit, priorFrontierRun.commit);
    values["frontier_code_distance"] = sim !== null ? 1 - sim : null;
  } else {
    values["frontier_code_distance"] = null;
  }

  if (codeDist && currentRun.commit) {
    let maxSim: number | null = null;
    for (let i = 0; i < index; i++) {
      const prev = history[i];
      if (prev && prev.commit) {
        const sim = safeCodeDist(codeDist, currentRun.commit, prev.commit);
        if (sim !== null) {
          if (maxSim === null || sim > maxSim) {
            maxSim = sim;
          }
        }
      }
    }
    values["nearest_history_similarity"] = maxSim;
  } else {
    values["nearest_history_similarity"] = null;
  }

  if (isCurrentValid && priorFrontierMetric !== null) {
    const g = metricGain(currentRun.metric, priorFrontierMetric, direction);
    if (g >= minGain) {
      const denom = Math.abs(priorFrontierMetric) > 0 ? Math.abs(priorFrontierMetric) : 1;
      values["meaningful_relative_gain"] = g / denom;
    } else {
      values["meaningful_relative_gain"] = null;
    }
  } else {
    values["meaningful_relative_gain"] = null;
  }

  if (isCurrentValid && priorFrontierMetric !== null && stepGains.length > 0) {
    const rawGap =
      direction === "lower"
        ? Math.max(0, currentRun.metric - priorFrontierMetric)
        : Math.max(0, priorFrontierMetric - currentRun.metric);
    const recentGains = stepGains.slice(-windowSize);
    const avgRecentGain =
      recentGains.length > 0
        ? recentGains.reduce((a, b) => a + b, 0) / recentGains.length
        : minGain;
    const stepUnit = avgRecentGain > 0 ? avgRecentGain : minGain;
    values["gap_in_recent_step_units"] = rawGap / (stepUnit > 0 ? stepUnit : 1);
  } else {
    values["gap_in_recent_step_units"] = null;
  }

  // ==========================================
  // 3. Region metrics (trailing window)
  // ==========================================

  const windowRuns = segmentRunsUpToCurrent.slice(-windowSize);
  const validInWindow = windowRuns.filter(
    (r) => (r.status === "keep" || r.status === "discard") && Number.isFinite(r.metric)
  );

  // window_valid_rate computes for any window >= 1
  values["window_valid_rate"] =
    windowRuns.length > 0 ? validInWindow.length / windowRuns.length : null;

  if (windowRuns.length < 2) {
    values["frontier_relative_spread"] = null;
    values["root_relative_spread"] = null;
    values["parent_selection_concentration"] = null;
    values["window_frontier_gain"] = null;
    values["window_redundancy_rate"] = null;
    values["window_frontier_conversion_rate"] = null;
    values["within_one_recent_step_rate"] = null;
    values["dominant_failure_signature_mass"] = null;
    values["repeated_failure_rate"] = null;
  } else {
    if (validInWindow.length >= 2 && currentFrontierMetric !== null) {
      const mean =
        validInWindow.reduce((acc, r) => acc + r.metric, 0) / validInWindow.length;
      const variance =
        validInWindow.reduce((acc, r) => acc + (r.metric - mean) ** 2, 0) /
        validInWindow.length;
      const std = Math.sqrt(variance);
      const denom =
        Math.abs(currentFrontierMetric) > 0 ? Math.abs(currentFrontierMetric) : 1;
      values["frontier_relative_spread"] = std / denom;
    } else {
      values["frontier_relative_spread"] = null;
    }

    const rootRun = segmentRunsUpToCurrent[0];
    if (validInWindow.length >= 2 && rootRun && Number.isFinite(rootRun.metric)) {
      const mean =
        validInWindow.reduce((acc, r) => acc + r.metric, 0) / validInWindow.length;
      const variance =
        validInWindow.reduce((acc, r) => acc + (r.metric - mean) ** 2, 0) /
        validInWindow.length;
      const std = Math.sqrt(variance);
      const denom = Math.abs(rootRun.metric) > 0 ? Math.abs(rootRun.metric) : 1;
      values["root_relative_spread"] = std / denom;
    } else {
      values["root_relative_spread"] = null;
    }

    const parentCounts = new Map<number, number>();
    let totalWithParent = 0;
    for (const r of windowRuns) {
      const rIdx = history.indexOf(r);
      const p =
        rIdx > 0 && history[rIdx - 1] && history[rIdx - 1]!.segment === r.segment
          ? history[rIdx - 1]!.run
          : null;
      if (p !== null) {
        parentCounts.set(p, (parentCounts.get(p) ?? 0) + 1);
        totalWithParent++;
      }
    }
    if (totalWithParent >= 2) {
      let hhi = 0;
      for (const count of parentCounts.values()) {
        const share = count / totalWithParent;
        hhi += share * share;
      }
      values["parent_selection_concentration"] = hhi;
    } else {
      values["parent_selection_concentration"] = null;
    }

    const winStartIndex = segmentRunsUpToCurrent.indexOf(windowRuns[0]!);
    const priorToWin = segmentRunsUpToCurrent
      .slice(0, winStartIndex)
      .filter((r) => (r.status === "keep" || r.status === "discard") && Number.isFinite(r.metric));

    if (priorToWin.length > 0 && validInWindow.length > 0) {
      let startFrontier = priorToWin[0]!.metric;
      for (const r of priorToWin) {
        if (isBetter(r.metric, startFrontier, direction)) startFrontier = r.metric;
      }

      let endFrontier = startFrontier;
      for (const r of validInWindow) {
        if (isBetter(r.metric, endFrontier, direction)) endFrontier = r.metric;
      }
      values["window_frontier_gain"] = Math.max(0, metricGain(endFrontier, startFrontier, direction));
    } else {
      values["window_frontier_gain"] = null;
    }

    if (codeDist === null) {
      values["window_redundancy_rate"] = null;
    } else {
      let redundantCount = 0;
      for (let w = 0; w < windowRuns.length; w++) {
        const r = windowRuns[w]!;
        let isRedundant = false;
        if (r.asi && r.asi["revisits_run"] != null) {
          isRedundant = true;
        }
        if (!isRedundant && r.commit) {
          for (let prevW = 0; prevW < w; prevW++) {
            const prevR = windowRuns[prevW]!;
            if (prevR.commit === r.commit) {
              isRedundant = true;
              break;
            }
            if (prevR.commit) {
              const sim = safeCodeDist(codeDist, r.commit, prevR.commit);
              if (sim !== null && sim >= 0.99) {
                isRedundant = true;
                break;
              }
            }
          }
        }
        if (isRedundant) redundantCount++;
      }
      values["window_redundancy_rate"] = redundantCount / windowRuns.length;
    }

    const keptCount = windowRuns.filter((r) => r.status === "keep").length;
    values["window_frontier_conversion_rate"] = keptCount / windowRuns.length;

    if (validInWindow.length >= 2 && currentFrontierMetric !== null) {
      const withinCount = validInWindow.filter(
        (r) => Math.abs(r.metric - currentFrontierMetric!) <= minGain
      ).length;
      values["within_one_recent_step_rate"] = withinCount / validInWindow.length;
    } else {
      values["within_one_recent_step_rate"] = null;
    }

    const failedRuns = windowRuns.filter((r) => r.status !== "keep");
    if (failedRuns.length === 0) {
      values["dominant_failure_signature_mass"] = null;
      values["repeated_failure_rate"] = 0;
    } else {
      const sigCounts = new Map<string, number>();
      const seenSignatures = new Set<string>();
      let repeatedCount = 0;

      for (const r of failedRuns) {
        const errorSig =
          typeof r.asi?.["error"] === "string"
            ? r.asi["error"]
            : typeof r.asi?.["rollback_reason"] === "string"
              ? r.asi["rollback_reason"]
              : `${r.status}:${r.description.slice(0, 30)}`;

        sigCounts.set(errorSig, (sigCounts.get(errorSig) ?? 0) + 1);

        if (seenSignatures.has(errorSig)) {
          repeatedCount++;
        } else {
          seenSignatures.add(errorSig);
        }
      }

      let maxCount = 0;
      for (const count of sigCounts.values()) {
        if (count > maxCount) maxCount = count;
      }
      values["dominant_failure_signature_mass"] = maxCount / failedRuns.length;
      values["repeated_failure_rate"] = repeatedCount / windowRuns.length;
    }
  }

  // ==========================================
  // 4. Global metrics
  // ==========================================

  if (lastMeaningfulTimestamp !== null) {
    values["seconds_since_meaningful_improvement"] = Math.max(
      0,
      (currentRun.timestamp - lastMeaningfulTimestamp) / 1000
    );
  } else {
    values["seconds_since_meaningful_improvement"] = null;
  }

  values["frontier_epoch_age_steps"] = lastMeaningfulTimestamp !== null ? epochAge : null;

  values["frontier_improvement_count"] = improvementCount > 0 ? improvementCount : null;

  // best_descendant_metric: best metric in subtree rooted at currentRun (including currentRun)
  const descendantRunNumbers = new Set<number>();
  descendantRunNumbers.add(currentRun.run);

  const subtreeMetrics: number[] = [];
  if (isCurrentValid) {
    subtreeMetrics.push(currentRun.metric);
  }

  for (let j = index + 1; j < history.length; j++) {
    const candidate = history[j]!;
    const candidateParent =
      j > 0 && history[j - 1] && history[j - 1]!.segment === candidate.segment
        ? history[j - 1]!.run
        : null;

    const revisits =
      typeof candidate.asi?.["revisits_run"] === "number"
        ? candidate.asi["revisits_run"]
        : null;

    const isDescendant =
      (candidateParent !== null && descendantRunNumbers.has(candidateParent)) ||
      (revisits !== null && descendantRunNumbers.has(revisits));

    if (isDescendant) {
      descendantRunNumbers.add(candidate.run);
      if (
        (candidate.status === "keep" || candidate.status === "discard") &&
        Number.isFinite(candidate.metric)
      ) {
        subtreeMetrics.push(candidate.metric);
      }
    }
  }

  if (subtreeMetrics.length > 0) {
    let bestDesc = subtreeMetrics[0]!;
    for (const m of subtreeMetrics) {
      if (isBetter(m, bestDesc, direction)) bestDesc = m;
    }
    values["best_descendant_metric"] = bestDesc;
  } else {
    values["best_descendant_metric"] = null;
  }

  return values;
}
