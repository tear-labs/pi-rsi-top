/**
 * Widget rendering tests.
 *
 * The widget is a `string[]` handed straight to `setWidget`, so everything that can go
 * wrong is visible here: a line that overflows the budget, a missing value rendered as
 * `0`, a sparkline that points the wrong way for a lower-is-better metric, or a widget
 * that quietly disappears because the log was empty.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { renderWidget, sparkline } from "../src/widget.ts";
import { compact } from "../src/extension.ts";
import type { DashboardRow, Run, SessionSnapshot, StallState } from "../src/types.ts";

function run(runNo: number, metric: number, status: Run["status"] = "discard"): Run {
  return {
    run: runNo,
    commit: "HEAD",
    metric,
    metrics: {},
    status,
    description: `trajectory ${runNo}`,
    timestamp: 1_700_000_000_000 + runNo * 60_000,
    segment: 0,
    confidence: null,
  };
}

function session(direction: "lower" | "higher" = "lower"): SessionSnapshot {
  return {
    metric_name: "cycles",
    metric_unit: "cycles",
    direction,
    baseline_metric: 1391,
    best_metric: 1198,
    run_count: 0,
    goal: "Optimize the simulated-machine kernel",
    segment: 0,
    best_run: null,
    name: "kernel",
  } as SessionSnapshot;
}

function stall(over: Partial<StallState> = {}): StallState {
  return {
    stalled: false,
    stalledForMs: 60_000,
    stalledForRuns: 1,
    frontier: 1198,
    frontierRun: 42,
    epochAge: 2,
    reason: "improving",
    ...over,
  };
}

function row(runNo: number, metric: number, parent: number | null = null): DashboardRow {
  return {
    run: runNo,
    segment: 0,
    commit: "HEAD",
    metric,
    status: "discard",
    timestamp: 1_700_000_000_000 + runNo * 60_000,
    parent,
    values: { parent_gain: parent === null ? null : 3.5 },
  };
}

describe("sparkline", () => {
  it("returns nothing for an empty run list", () => {
    assert.equal(sparkline([], "lower"), "");
  });

  it("renders a perfectly flat window as all-floor blocks", () => {
    const runs = [run(1, 1200), run(2, 1200), run(3, 1200)];
    assert.equal(sparkline(runs, "lower"), "▁▁▁");
  });

  it("points up for a lower-is-better metric that is improving", () => {
    // 1300 -> 1200 is an improvement when lower is better, so the last cell must be tall.
    const runs = [run(1, 1300), run(2, 1250), run(3, 1200)];
    const spark = sparkline(runs, "lower");
    assert.equal(spark.length, 3);
    assert.equal(spark[0], "▁");
    assert.equal(spark[2], "█");
  });

  it("points down for a lower-is-better metric that is getting worse", () => {
    const runs = [run(1, 1200), run(2, 1250), run(3, 1300)];
    const spark = sparkline(runs, "lower");
    assert.equal(spark[0], "█");
    assert.equal(spark[2], "▁");
  });

  it("inverts the orientation for higher-is-better metrics", () => {
    const runs = [run(1, 0.5), run(2, 0.75), run(3, 1.0)];
    const spark = sparkline(runs, "higher");
    assert.equal(spark[0], "▁");
    assert.equal(spark[2], "█");
  });

  it("only describes the trailing span", () => {
    const runs = Array.from({ length: 40 }, (_, i) => run(i + 1, 1000 + i));
    assert.equal(sparkline(runs, "lower", 10).length, 10);
  });

  it("skips non-finite metrics rather than emitting a glyph for them", () => {
    const runs = [run(1, 1200), { ...run(2, Number.NaN) }, run(3, 1300)];
    assert.equal(sparkline(runs, "lower").length, 2);
  });
});

describe("renderWidget", () => {
  it("puts state, frontier, and flatness on the first line", () => {
    const [first] = renderWidget({
      runs: [run(1, 1200)],
      session: session(),
      stall: stall(),
      rows: [],
    });
    assert.ok(first);
    assert.match(first, /rsi-top/);
    assert.match(first, /cycles/);
    assert.match(first, /1198/);
    assert.match(first, /ok/);
  });

  it("says STALLED and points at the intervention command when stalled", () => {
    const lines = renderWidget({
      runs: [run(1, 1200)],
      session: session(),
      stall: stall({ stalled: true, stalledForMs: 20 * 60_000, stalledForRuns: 5 }),
      rows: [],
    });
    assert.ok(lines[0]);
    assert.match(lines[0], /STALLED/);
    assert.match(lines.join("\n"), /intervene/);
  });

  it("renders a missing frontier as an em dash, never as 0", () => {
    const [first] = renderWidget({
      runs: [run(1, 1200)],
      session: session(),
      stall: stall({ frontier: null, frontierRun: null }),
      rows: [],
    });
    assert.ok(first);
    assert.match(first, /—/);
    assert.ok(!/ 0 \(/.test(first));
  });

  it("keeps every line within the 96-column budget", () => {
    const runs = Array.from({ length: 30 }, (_, i) => run(i + 1, 1198 + i));
    const rows = runs.map((r) => row(r.run, r.metric, r.run - 1));
    const lines = renderWidget({
      runs,
      session: { ...session(), goal: "a very long goal string ".repeat(6) },
      stall: stall(),
      rows,
      tableRows: 5,
    });
    for (const line of lines) {
      assert.ok(line.length <= 96, `line is ${line.length} cols: ${line}`);
    }
  });

  it("falls back to the raw log when the dashboard has not been scored", () => {
    const lines = renderWidget({
      runs: [run(1, 1200, "keep"), run(2, 1210)],
      session: session(),
      stall: stall(),
      rows: [],
      tableRows: 2,
    });
    const joined = lines.join("\n");
    assert.match(joined, /keep/);
    assert.match(joined, /1210/);
  });

  it("shows the parent column from the scored dashboard when present", () => {
    const lines = renderWidget({
      runs: [run(1, 1200), run(2, 1210)],
      session: session(),
      stall: stall(),
      rows: [row(1, 1200), row(2, 1210, 1)],
      tableRows: 2,
    });
    const joined = lines.join("\n");
    assert.match(joined, /←/);
    assert.match(joined, /3\.500/);
  });

  it("marks the frontier row", () => {
    const rows = [row(41, 1205), row(42, 1198)];
    const lines = renderWidget({
      runs: [run(41, 1205), run(42, 1198)],
      session: session(),
      stall: stall({ frontier: 1198, frontierRun: 42 }),
      rows,
      tableRows: 2,
    });
    const frontierLine = lines.find((l) => l.startsWith("◆"));
    assert.ok(frontierLine, `expected a frontier marker; lines: ${lines.join(" | ")}`);
    assert.match(frontierLine, /1198/);
  });

  it("omits the table entirely when tableRows is 0", () => {
    const lines = renderWidget({
      runs: [run(1, 1200), run(2, 1210)],
      session: session(),
      stall: stall(),
      rows: [row(1, 1200), row(2, 1210)],
      tableRows: 0,
    });
    // status + sparkline only
    assert.equal(lines.length, 2);
  });

  it("still renders a status line when there are no runs to plot", () => {
    const lines = renderWidget({ runs: [], session: session(), stall: stall(), rows: [] });
    assert.ok(lines.length >= 1);
    assert.ok(lines[0]);
    assert.match(lines[0], /rsi-top/);
  });
});

describe("invalid trajectories", () => {
  // Real case from a live log: run 5 crashed and pi-autoresearch recorded `metric: 0`.
  // On a lower-is-better metric that is indistinguishable from a perfect result, so it
  // must be excluded from the sparkline and never printed as if it were measured.
  const crashed: Run = {
    run: 5,
    commit: "HEAD",
    metric: 0,
    metrics: {},
    status: "crash",
    description: "CRASH: joint whole-block local search",
    timestamp: 1_700_000_300_000,
    segment: 0,
    confidence: null,
  };

  it("does not plot a crash's placeholder metric", () => {
    const runs = [run(4, 6.881), crashed, run(6, 5.934)];
    const spark = sparkline(runs, "lower");
    assert.equal(spark.length, 2, "crash row should be dropped, not plotted");
  });

  it("does not let a crash's 0 flatten the scale", () => {
    const runs = [run(4, 6.881), crashed, run(6, 5.934)];
    const spark = sparkline(runs, "lower");
    // With the 0 included, 6.881 would be the floor and 5.934 the ceiling. Excluding it
    // keeps the orientation right: 6.881 is worse than 5.934 for a lower-is-better metric.
    assert.equal(spark[0], "▁");
    assert.equal(spark[1], "█");
  });

  it("prints an em dash instead of 0 for a crash's metric", () => {
    const lines = renderWidget({
      runs: [crashed],
      session: session(),
      stall: stall(),
      rows: [],
      tableRows: 1,
    });
    const row = lines.find((l) => l.includes("crash"));
    assert.ok(row, "expected the crash row");
    assert.match(row, /—/);
    assert.ok(!/\b0\b/.test(row.replace(/crash/, "")), `crash metric rendered as a number: ${row}`);
  });

  it("counts only plottable runs in the span note", () => {
    const runs = [run(4, 6.881), crashed, run(6, 5.934)];
    const lines = renderWidget({ runs, session: session(), stall: stall(), rows: [] });
    assert.match(lines.join("\n"), /last 2/);
  });

  it("treats checks_failed the same as crash", () => {
    const failed: Run = { ...crashed, run: 7, status: "checks_failed" };
    const runs = [run(6, 5.934), failed];
    assert.equal(sparkline(runs, "lower").length, 1);
  });
});

describe("pi web compact form", () => {
  // Pi Web renders a widget as a 108px trigger with the key as a heading, and only expands
  // the panel when the widget has 2-3 lines. A taller widget is a collapsed tab the user
  // cannot open, which made the whole thing invisible in the browser.
  const full = [
    "rsi-top \u2502 heldout_mean_nll 1.534 (run 1) \u2502 ok \u00b7 flat 0s \u2502 6 runs, 4 keep \u2502 epoch 6",
    "last 5 \u25b8 \u2588\u2585\u2582\u2581\u2582",
    "    4 discard          6.881",
    "    5 crash                \u2014",
    "    6 keep             5.934",
  ];

  it("fits in the 2-3 lines pi-web will open", () => {
    const out = compact(full);
    assert.ok(out.length >= 2 && out.length <= 3, `got ${out.length} lines`);
  });

  it("drops the key from the status line, since pi-web prints it as a heading", () => {
    assert.ok(!compact(full)[0]!.startsWith("rsi-top"), compact(full)[0]);
    assert.match(compact(full)[0]!, /heldout_mean_nll/);
  });

  it("keeps the sparkline, which is the fastest read", () => {
    assert.match(compact(full).join("\n"), /last 5 /);
  });

  it("promotes the stall warning into the third slot", () => {
    const stalled = [...full.slice(0, 2), "\u26a0 stall \u2014 /rsi-top intervene for a cohort", ...full.slice(2)];
    const out = compact(stalled);
    assert.ok(out.some((l) => l.startsWith("\u26a0")), `stall warning lost: ${out.join(" | ")}`);
  });

  it("tolerates a one-line widget", () => {
    assert.equal(compact([full[0]!]).length, 1);
  });
});
