/**
 * Autoresearch log ingestion (RSI-top stage 2 input).
 *
 * Mirrors pi-autoresearch's `reconstructJsonlState` semantics so every scored
 * trajectory matches what the host itself sees: config entries open a new
 * segment, run entries are the raw trajectories.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Direction, HookSessionSnapshot, Run, RunStatus, SessionSnapshot } from "./types.ts";

const DEFAULT_METRIC_NAME = "metric";
const DEFAULT_METRIC_UNIT = "";
const DEFAULT_DIRECTION: Direction = "lower";

const CURRENT_SESSION_FILES = [
  "log.jsonl",
  "prompt.md",
  "ideas.md",
  "checks.sh",
  "measure.sh",
  "config.json",
] as const;

type JsonObject = Record<string, unknown>;

function isObjectRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Non-empty lines, exactly as the host splits them (`text.split("\n").filter(Boolean)`). */
function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

function parseEntry(line: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isConfigEntry(entry: JsonObject): boolean {
  return entry.type === "config";
}

function isRunEntry(entry: JsonObject): boolean {
  return typeof entry.run === "number";
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {};
  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    if (typeof metric === "number") metrics[name] = metric;
  }
  return metrics;
}

/**
 * A missing or non-numeric `metric` becomes `NaN`, not `0`.
 *
 * This is load-bearing. `frontier.ts`'s `isValidMetric` already rejects non-finite values,
 * so `NaN` makes the run ineligible to move the frontier — which is exactly right for a
 * trajectory whose evaluator did not report a number. Coercing it to `0` instead would make
 * it the *best possible* result on a lower-is-better metric: it would win the frontier and,
 * because winning resets the epoch clock, silently blind the stall monitor.
 *
 * Formatters render `NaN` as an em dash (`cli.ts`, `widget.ts`, `extension.ts`, and
 * `intervene.ts`'s steer text). `dashboard.jsonl` stores it as JSON `null`, which `readRows`
 * maps back to `NaN`.
 */
function metricFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function statusFrom(value: unknown): RunStatus {
  if (value === "keep") return "keep";
  if (value === "discard") return "discard";
  if (value === "crash") return "crash";
  if (value === "checks_failed") return "checks_failed";
  // An unrecognized status must not default to `keep`. `keep` is the one status that can
  // move the frontier, so assuming it turns a malformed entry into a candidate winner.
  // `hook.ts` already resolves unknown statuses to `discard`; match that.
  return "discard";
}

function directionFrom(value: unknown): Direction {
  return value === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function asiFrom(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function runFrom(entry: JsonObject, segment: number): Run {
  const run: Run = {
    run: typeof entry.run === "number" ? entry.run : 0,
    commit: typeof entry.commit === "string" ? entry.commit : "",
    metric: metricFrom(entry.metric),
    metrics: metricMapFrom(entry.metrics),
    status: statusFrom(entry.status),
    description: typeof entry.description === "string" ? entry.description : "",
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
    segment,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
  };
  const asi = asiFrom(entry.asi);
  if (asi !== undefined) run.asi = asi;
  return run;
}

interface ParseState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: Direction;
  currentSegment: number;
  results: Run[];
}

function emptyState(): ParseState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentSegment: 0,
    results: [],
  };
}

/** Host rule: the first config entry that carries a string name wins; later ones do not. */
function trackName(state: ParseState, entry: JsonObject): void {
  if (state.name === null && typeof entry.name === "string") state.name = entry.name;
}

function updateConfig(state: ParseState, entry: JsonObject): void {
  if (typeof entry.metricName === "string") state.metricName = entry.metricName;
  if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
  state.bestDirection = directionFrom(entry.bestDirection);
}

/** Host rule: the very first config keeps segment 0; each later config after a run bumps it. */
function nextSegment(state: ParseState, segment: number): number {
  if (state.results.length === 0) return segment;
  return segment + 1;
}

function currentSegmentRuns(runs: Run[], segment: number): Run[] {
  return runs.filter((run) => run.segment === segment);
}

/**
 * Baseline: first kept run of the current segment, else the segment's first run.
 *
 * Skips runs with no usable metric. A single `NaN` here would poison the whole aggregate
 * (`Math.min(...)` returns NaN), and the session snapshot is serialized to JSON where NaN
 * becomes `null` — the host would then be told there is no baseline at all.
 */
function baselineMetric(runs: Run[], segment: number): number | null {
  const current = currentSegmentRuns(runs, segment);
  const firstKept = current.find((run) => run.status === "keep" && Number.isFinite(run.metric));
  if (firstKept !== undefined) return firstKept.metric;
  const first = current.find((run) => Number.isFinite(run.metric));
  return first !== undefined ? first.metric : null;
}

/** Best: optimal metric across kept runs of the current segment only. */
function bestMetric(runs: Run[], segment: number, direction: Direction): number | null {
  const kept = currentSegmentRuns(runs, segment)
    .filter((run) => run.status === "keep" && Number.isFinite(run.metric))
    .map((run) => run.metric);
  if (kept.length === 0) return null;
  return direction === "lower" ? Math.min(...kept) : Math.max(...kept);
}

/**
 * Parse `.auto/log.jsonl` text into trajectories plus a session snapshot.
 * Pure. Tolerates blanks, garbage, truncated tails, unknown types, and missing fields.
 */
export function parseLog(text: string): { runs: Run[]; session: SessionSnapshot } {
  const state = emptyState();
  let segment = 0;
  let sawConfig = false;

  for (const line of nonEmptyLines(text)) {
    const entry = parseEntry(line);
    if (!entry) continue;

    if (isConfigEntry(entry)) {
      if (!sawConfig) {
        trackName(state, entry);
        sawConfig = true;
      }
      updateConfig(state, entry);
      segment = nextSegment(state, segment);
      state.currentSegment = segment;
      continue;
    }

    if (!isRunEntry(entry)) continue;
    state.results.push(runFrom(entry, segment));
  }

  const { results } = state;
  const session: SessionSnapshot = {
    name: state.name,
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: baselineMetric(results, state.currentSegment),
    best_metric: bestMetric(results, state.currentSegment, state.bestDirection),
    run_count: results.length,
    goal: state.name ?? "",
  };

  return { runs: results, session };
}

function findLogPath(workDir: string): string {
  const auto = path.join(path.resolve(workDir), ".auto");
  let hasCurrentLayout = false;
  if (fs.existsSync(path.join(auto, "hooks"))) {
    hasCurrentLayout = true;
  } else {
    for (const file of CURRENT_SESSION_FILES) {
      if (fs.existsSync(path.join(auto, file))) {
        hasCurrentLayout = true;
        break;
      }
    }
  }

  const currentLog = path.join(auto, "log.jsonl");
  if (hasCurrentLayout) return currentLog;

  const legacyLog = path.join(path.resolve(workDir), "autoresearch.jsonl");
  if (fs.existsSync(legacyLog)) return legacyLog;

  return currentLog;
}

/** Read and parse the work dir's log; a missing file yields an empty snapshot, never a throw. */
export function readSession(workDir: string): { runs: Run[]; session: SessionSnapshot } {
  try {
    const file = findLogPath(workDir);
    const text = fs.readFileSync(file, "utf-8");
    return parseLog(text);
  } catch {
    return parseLog("");
  }
}

/** Project a session snapshot onto exactly the seven fields pi-autoresearch's hooks expect. */
export function toHookSession(s: SessionSnapshot): HookSessionSnapshot {
  return {
    metric_name: s.metric_name,
    metric_unit: s.metric_unit,
    direction: s.direction,
    baseline_metric: s.baseline_metric,
    best_metric: s.best_metric,
    run_count: s.run_count,
    goal: s.goal,
  };
}
