/**
 * Shared types for rsi-top. FROZEN: owned by the parent orchestrator.
 * Lanes import from here and never edit this file.
 *
 * Vocabulary follows the RSI-top paper (rsi-top.github.io): a *trajectory* is one
 * autoresearch iteration (reasoning + actions + eval logs), the *frontier* is the best
 * score so far, the *dashboard* is one metric row per trajectory, *unfolding* means
 * retrieving a full trajectory, and an *intervention* is a diverse cohort launched
 * when the frontier stalls.
 */

// ---------------------------------------------------------------------------
// Autoresearch input shapes (mirrors pi-autoresearch extensions/pi-autoresearch/jsonl.ts)
// ---------------------------------------------------------------------------

export type RunStatus = "keep" | "discard" | "crash" | "checks_failed";
export type Direction = "lower" | "higher";

/** One trajectory as recorded in `.auto/log.jsonl`. */
export interface Run {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: RunStatus;
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

/** Session snapshot, exactly as pi-autoresearch hands it to hooks. */
export interface HookSessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: Direction;
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export interface SessionSnapshot extends HookSessionSnapshot {
  /** Session name from the config entry, if any. */
  name: string | null;
}

export interface BeforeHookPayload {
  event: "before";
  cwd: string;
  next_run: number;
  last_run: Record<string, unknown> | null;
  session: HookSessionSnapshot;
}

export interface AfterHookPayload {
  event: "after";
  cwd: string;
  run_entry: Record<string, unknown>;
  session: HookSessionSnapshot;
}

export type HookPayload = BeforeHookPayload | AfterHookPayload;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type MetricKind = "unary" | "binary" | "region" | "global";

export interface MetricSpec {
  name: string;
  kind: MetricKind;
  /** One line, shown in the dashboard header and in steer text. */
  description: string;
  /** "higher" = larger value is a better trajectory signal. */
  better: "higher" | "lower";
}

/** Optional injected context so pure metric computation never touches disk or git. */
export interface MetricContext {
  direction: Direction;
  /** Normalized similarity in 0..1 (1 = identical); null when unavailable. */
  codeDistance: CodeDistance | null;
  /** Trailing window size for region metrics. */
  window: number;
  /** Minimum metric gain counted as a meaningful frontier step. */
  minGain: number;
}

/** Returns 0..1 similarity (1 = identical). Must be pure w.r.t. invocation order. */
export type CodeDistance = (commitA: string, commitB: string) => number | null;

/** One dashboard row: a compressed trajectory. */
export interface DashboardRow {
  run: number;
  segment: number;
  commit: string;
  /** Authoritative metric for this trajectory (not necessarily the best). */
  metric: number;
  status: RunStatus;
  timestamp: number;
  /** Inferred parent run number, or null for the first run of a segment. */
  parent: number | null;
  values: Record<string, number | null>;
}

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

export interface StallConfig {
  /** Wall-clock ms the frontier must stay flat before a stall. Default 20 min. */
  minStallMs: number;
  /** Improvement smaller than this does not count as a frontier move. Default 2. */
  minGain: number;
  /** Ignore stalls before this much elapsed run time. Default 1 h. */
  ignoreFirstMs: number;
  /** Minimum trajectories before any stall can be reported. Default 12. */
  minRuns: number;
}

export interface StallState {
  stalled: boolean;
  /** Wall-clock ms since the last meaningful improvement. */
  stalledForMs: number;
  /** Trajectories elapsed since the last meaningful improvement. */
  stalledForRuns: number;
  /** Best metric observed (frontier value). */
  frontier: number | null;
  /** Run number that set the current best. */
  frontierRun: number | null;
  /** Trailing runs in the current epoch (since the last meaningful improvement). */
  epochAge: number;
  /** Free-form reason, populated when stalled === false. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Diversity control
// ---------------------------------------------------------------------------

/** A direction an intervention agent may pursue, with its verbalized probability. */
export interface DirectionArm {
  direction: string;
  probability: number;
}

/** One member of the intervention cohort. */
export interface CohortArm {
  /** 0-based cohort index. */
  index: number;
  /** Metric names this arm is allowed to see (its random subset). */
  metrics: string[];
  /** Directions with verbalized probabilities; must sum to 1. */
  portfolio: DirectionArm[];
  /** Run number this arm is grounded in (its lineage root). */
  lineage: number | null;
  /** Run numbers this arm may unfold. */
  unfold: number[];
}

export interface CohortPlan {
  /** Stable identity for this intervention. */
  id: string;
  epoch: number;
  seed: number;
  createdAt: number;
  stalledForMs: number;
  stalledForRuns: number;
  frontier: number | null;
  frontierRun: number | null;
  arms: CohortArm[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RsiConfig {
  enabled: boolean;
  stall: StallConfig;
  /** Number of arms in the intervention cohort. */
  cohortSize: number;
  /** How many dashboard metrics each arm sees (paper default: 15 of 25). */
  metricSubsetSize: number;
  /** How many candidate directions each arm verbalizes probabilities over. */
  portfolioSize: number;
  /** How many trajectories each arm may unfold. */
  unfoldSize: number;
  /** Softmax temperature for verbalized sampling (higher = flatter). */
  temperature: number;
  /** Seed; 0 = derive from run_count + timestamp for genuine diversity. */
  seed: number;
  /** Directory for rsi state, relative to the work dir. */
  stateDir: string;
}

export const DEFAULT_STALL_CONFIG: StallConfig = {
  minStallMs: 20 * 60_000,
  minGain: 2,
  ignoreFirstMs: 60 * 60_000,
  minRuns: 12,
};

export const DEFAULT_RSI_CONFIG: RsiConfig = {
  enabled: true,
  stall: DEFAULT_STALL_CONFIG,
  cohortSize: 4,
  metricSubsetSize: 15,
  portfolioSize: 5,
  unfoldSize: 3,
  temperature: 1,
  seed: 0,
  stateDir: ".auto/rsi",
};

/** Hard cap on hook stdout; pi-autoresearch truncates at 8 KB. */
export const STEER_MAX_BYTES = 8192;
