/**
 * Dashboard row generation, scoring, and persistence for RSI-top.
 * Implements the "htop" compressed dashboard: building per-trajectory summary rows,
 * performing idempotent newline-delimited JSON append to `.auto/rsi/dashboard.jsonl`,
 * and tolerant parsing that survives corrupt or truncated lines.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { computeRowValues } from "./metrics.ts";
import { codeDistanceFor } from "./code-distance.ts";
import type {
  DashboardRow,
  MetricContext,
  Run,
  RunStatus,
  SessionSnapshot,
} from "./types.ts";

/** Type guard verifying that a value is one of the valid RunStatus literals. */
function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "keep" ||
    value === "discard" ||
    value === "crash" ||
    value === "checks_failed"
  );
}

/** Type guard verifying that an object is a Record<string, number | null>. */
function isMetricRecord(value: unknown): value is Record<string, number | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const v of Object.values(value)) {
    if (v !== null && typeof v !== "number") {
      return false;
    }
  }
  return true;
}

/**
 * Builds dashboard rows for all runs in `runs`.
 * Parent is inferred as the previous run in the same segment (null for the first of a segment).
 * Row metric values are computed using `computeRowValues`.
 */
export function buildRows(
  runs: Run[],
  session: SessionSnapshot,
  ctx?: Partial<MetricContext>
): DashboardRow[] {
  const effectiveCtx: Partial<MetricContext> = {
    direction: session.direction,
    ...ctx,
  };

  const rows: DashboardRow[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    const parent =
      i > 0 && runs[i - 1] && runs[i - 1]!.segment === r.segment
        ? runs[i - 1]!.run
        : null;

    const values = computeRowValues(runs, i, effectiveCtx);
    rows.push({
      run: r.run,
      segment: r.segment,
      commit: r.commit,
      metric: r.metric,
      status: r.status,
      timestamp: r.timestamp,
      parent,
      values,
    });
  }
  return rows;
}

/**
 * Tolerantly reads dashboard rows from a JSONL file.
 * Returns an empty array if the file is missing.
 * Skips blank lines, non-JSON lines, and lines missing required dashboard fields.
 */
export function readRows(dashboardPath: string): DashboardRow[] {
  if (!fs.existsSync(dashboardPath)) {
    return [];
  }

  let content = "";
  try {
    content = fs.readFileSync(dashboardPath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const rows: DashboardRow[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const record = parsed as Record<string, unknown>; // Narrowing parsed JSON object
      if (
        typeof record["run"] !== "number" ||
        typeof record["segment"] !== "number" ||
        typeof record["commit"] !== "string" ||
        // `NaN` is the *intended* representation of "the evaluator reported no number", and
        // JSON has no NaN — `JSON.stringify` writes it as `null`. Accepting null here keeps
        // such a row readable, so it is not re-appended on every hook call forever.
        (record["metric"] !== null && typeof record["metric"] !== "number") ||
        !isRunStatus(record["status"]) ||
        typeof record["timestamp"] !== "number" ||
        (record["parent"] !== null && typeof record["parent"] !== "number") ||
        !isMetricRecord(record["values"])
      ) {
        continue;
      }

      rows.push({
        run: record["run"],
        segment: record["segment"],
        commit: record["commit"],
        metric: record["metric"] === null ? Number.NaN : record["metric"],
        status: record["status"],
        timestamp: record["timestamp"],
        parent: record["parent"],
        values: record["values"],
      });
    } catch {
      // Corrupt / truncated line ignored per specification
      continue;
    }
  }

  return rows;
}

/**
 * Appends dashboard rows to a newline-delimited JSON file.
 * Creates parent directories if needed.
 * Idempotent by `(segment, run)`: existing rows are not duplicated.
 */
export function appendRows(dashboardPath: string, rows: DashboardRow[]): void {
  const existingRows = readRows(dashboardPath);
  const existingKeys = new Set(existingRows.map((r) => `${r.segment}:${r.run}`));

  const toAppend: DashboardRow[] = [];
  for (const r of rows) {
    const key = `${r.segment}:${r.run}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      toAppend.push(r);
    }
  }

  if (toAppend.length === 0) {
    return;
  }

  const parentDir = path.dirname(dashboardPath);
  fs.mkdirSync(parentDir, { recursive: true });

  const payload = toAppend.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(dashboardPath, payload, "utf-8");
}

/**
 * Computes dashboard rows for `runs` and appends any unrecorded rows to
 * `<workDir>/.auto/rsi/dashboard.jsonl`.
 * Returns only the rows that were newly appended.
 */
export function scoreAndAppend(
  workDir: string,
  runs: Run[],
  session: SessionSnapshot
): DashboardRow[] {
  const dashPath = path.join(workDir, ".auto", "rsi", "dashboard.jsonl");
  // Code distance needs git, so it is resolved here (the effectful layer) and injected
  // into the pure metric computation. Outside a git work tree this is null and the four
  // commit-derived metrics honestly read as unknown.
  const codeDistance = codeDistanceFor(workDir);
  const existingRows = readRows(dashPath);
  const existingKeys = new Set(existingRows.map((r) => `${r.segment}:${r.run}`));

  const allRows = buildRows(runs, session, { codeDistance });
  const newlyAppended: DashboardRow[] = [];

  for (const r of allRows) {
    const key = `${r.segment}:${r.run}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      newlyAppended.push(r);
    }
  }

  if (newlyAppended.length > 0) {
    appendRows(dashPath, newlyAppended);
  }

  return newlyAppended;
}

/** Resolves the default or configured path to `dashboard.jsonl`. */
export function dashboardPathFor(workDir: string, stateDir?: string): string {
  const rel = stateDir ? stateDir : path.join(".auto", "rsi");
  return path.join(workDir, rel, "dashboard.jsonl");
}

