/**
 * The persistent bottom widget.
 *
 * Why this exists: the tool and `/rsi-top` both require the user to *ask*. A stall is
 * exactly the situation where nobody asks — the run looks like it is working. So the
 * one thing worth pinning to the screen is a few lines that make "the frontier has not
 * moved in 20 minutes" impossible to miss while typing.
 *
 * Two constraints shape the implementation:
 *
 *   - `setWidget` accepts either a component factory or a `string[]`. The factory gets
 *     the theme and the wide-character-correct width, but is **ignored in RPC mode** —
 *     which is how Pi Web drives the UI. A factory would therefore be invisible in the
 *     browser. So the widget is a `string[]`: one renderer that shows up in the TUI and
 *     in Pi Web alike.
 *   - Because it is a `string[]` there is no theme to colour with and no width handed
 *     to us. Structure has to come from box-drawing characters and a block sparkline,
 *     and lines have to be short enough to survive truncation. `MAX_LINE` is the budget.
 */

import type { DashboardRow, Run, SessionSnapshot, StallState } from "./types.ts";

/** Hard budget per line. Short enough to survive truncation on an 80-column terminal
 * and narrow enough that Pi Web's widget panel does not wrap it mid-table. */
const MAX_LINE = 96;

/** Sparkline cells. The metric is shown relative to the window, not in absolute units. */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface WidgetInput {
  runs: Run[];
  session: SessionSnapshot;
  stall: StallState;
  rows: DashboardRow[];
  /** Sparkline width, and therefore roughly the visual weight of the widget. */
  span?: number;
  /** Rows of the recent-trajectory table to include under the sparkline. */
  tableRows?: number;
}

/** Metric formatting shared with the CLI: never render a missing value as `0`. */
function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3);
}

/** Human elapsed time, at most two units: "3h12m", "20m", "45s". */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}

/** Truncate on display columns, not bytes, so the sparkline and CJK names both survive. */
function clip(line: string, max = MAX_LINE): string {
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Map the trailing `span` metric values onto block glyphs.
 *
 * The scale is the *window's* min/max rather than the session's, deliberately: a search
 * that is improving looks like it is improving, and a search that is flat for the whole
 * window looks flat even if the absolute numbers are large. A flat window renders as a
 * row of identical blocks, which is the signal we want the eye to catch.
 */
export function sparkline(runs: Run[], direction: "lower" | "higher", span = 24): string {
  const values = runs
    .slice(-span)
    .map((r) => r.metric)
    .filter((v) => Number.isFinite(v));
  if (values.length === 0) return "";

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A perfectly flat window has no range to normalise against; all-floor is correct here
  // because "nothing moved" is exactly what it should look like.
  if (hi === lo) return BLOCKS[0].repeat(values.length);

  return values
    .map((v) => {
      const t = (v - lo) / (hi - lo);
      // Higher-is-better reads as progress upward; invert for lower-is-better so the
      // glyph height always means "better", not "numerically larger".
      const idx = direction === "lower" ? (1 - t) : t;
      const clamped = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(idx * (BLOCKS.length - 1))));
      return BLOCKS[clamped];
    })
    .join("");
}

/** The single line that has to be readable at a glance: state, frontier, how long flat. */
function statusLine(input: WidgetInput): string {
  const { stall, session, runs } = input;
  const kept = runs.filter((r) => r.status === "keep").length;
  const label = session.metric_name || "metric";

  const state = stall.stalled
    ? `STALLED ${fmtDuration(stall.stalledForMs)} / ${stall.stalledForRuns} runs`
    : `ok · flat ${fmtDuration(stall.stalledForMs)}`;

  return clip(
    `rsi-top │ ${label} ${fmt(stall.frontier)} (run ${stall.frontierRun ?? "—"}) │ ${state}` +
      ` │ ${runs.length} runs, ${kept} keep │ epoch ${stall.epochAge}`,
  );
}

/** Recent trajectories as a compact table, newest last. */
function tableLines(input: WidgetInput, limit: number): string[] {
  if (limit <= 0) return [];
  const rows = input.rows.length > 0 ? input.rows.slice(-limit) : [];

  // Without a scored dashboard, fall back to the raw log so the widget is still useful
  // before `rsi-top init` has ever scored a trajectory.
  if (rows.length === 0) {
    return input.runs
      .slice(-limit)
      .map((r) =>
        clip(`  ${String(r.run).padStart(3)} ${r.status.padEnd(12)} ${fmt(r.metric).padStart(9)}`),
      );
  }

  const frontierRun = input.stall.frontierRun;
  return rows.map((row) => {
    // Mark the run that *set* the frontier, not every row sitting at the frontier value.
    // After a long stall the last four rows are typically all equal to the best metric, and
    // flagging all of them says nothing about which trajectory got there first.
    const mark = frontierRun !== null && row.run === frontierRun ? "◆" : " ";
    const status = String(row.status).padEnd(12);
    const parent = row.parent === null ? "  —" : String(row.parent).padStart(3);
    return clip(
      `${mark} ${String(row.run).padStart(3)} ${status} ${fmt(row.metric).padStart(9)}` +
        `  ←${parent}  ${fmt(row.values["parent_gain"]).padStart(8)}`,
    );
  });
}

/**
 * Build the widget lines.
 *
 * Deliberately fixed at four lines plus the optional table: this sits under the editor
 * during normal work, so it has to earn its vertical space every single turn. The full
 * table lives in `rsi_top_dashboard` and `/rsi-top`; this is the glance.
 */
export function renderWidget(input: WidgetInput): string[] {
  const span = input.span ?? 24;
  const tableRows = input.tableRows ?? 0;

  const spark = sparkline(input.runs, input.session.direction, span);
  const spanNote = spark ? `last ${Math.min(span, input.runs.length)}` : "";
  const scale = spark ? `${spanNote} ▸ ${spark}` : "";

  const lines: string[] = [statusLine(input)];
  if (scale) lines.push(clip(scale));
  lines.push(...tableLines(input, tableRows));

  if (input.stall.stalled) {
    lines.push(clip("⚠ stall — /rsi-top intervene (or `pi-rsi-top intervene`) for a cohort"));
  }

  return lines;
}
