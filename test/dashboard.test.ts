import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appendRows, buildRows, readRows, scoreAndAppend } from "../src/dashboard.ts";
import { metricSpecs } from "../src/metrics.ts";
import type { DashboardRow, Run, SessionSnapshot } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const session: SessionSnapshot = {
  metric_name: "loss",
  metric_unit: "nats",
  direction: "lower",
  baseline_metric: null,
  best_metric: null,
  run_count: 0,
  goal: "minimize loss",
  name: "test-session",
};

function run(n: number, metric: number, over: Partial<Run> = {}): Run {
  return {
    run: n,
    commit: `abc000${n}`,
    metric,
    metrics: {},
    status: "keep",
    description: `run ${n}`,
    timestamp: 1_700_000_000_000 + n * 60_000,
    segment: 1,
    confidence: null,
    ...over,
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsi-dash-"));
}

// ---------------------------------------------------------------------------
// buildRows
// ---------------------------------------------------------------------------

test("buildRows emits one row per run with the full metric set", () => {
  const runs = [run(1, 10), run(2, 9), run(3, 8)];
  const rows = buildRows(runs, session);
  assert.equal(rows.length, 3);
  const names = metricSpecs().map((s) => s.name);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.values).sort(), [...names].sort());
    assert.equal(row.segment, 1);
  }
  assert.deepEqual(
    rows.map((r) => r.run),
    [1, 2, 3],
  );
  assert.deepEqual(
    rows.map((r) => r.commit),
    ["abc0001", "abc0002", "abc0003"],
  );
});

test("buildRows infers parent as the previous run in the same segment", () => {
  const runs = [
    run(1, 10, { segment: 1 }),
    run(2, 9, { segment: 1 }),
    run(3, 10, { segment: 2 }),
    run(4, 9, { segment: 2 }),
    run(5, 8, { segment: 2 }),
  ];
  const rows = buildRows(runs, session);
  assert.deepEqual(
    rows.map((r) => r.parent),
    [null, 1, null, 3, 4],
  );
  assert.equal(rows[2]?.values["parent_gain"], null);
  assert.equal(rows[3]?.values["parent_gain"], 1);
});

test("buildRows falls back to the session direction", () => {
  const runs = [run(1, 10), run(2, 12)];
  const lowerGain = buildRows(runs, { ...session, direction: "lower" })[1]?.values["parent_gain"];
  const higherGain = buildRows(runs, { ...session, direction: "higher" })[1]?.values["parent_gain"];
  assert.equal(lowerGain, -2);
  assert.equal(higherGain, 2);
});

test("buildRows honours an explicit direction override and window", () => {
  const runs = [run(1, 10), run(2, 12)];
  const rows = buildRows(runs, session, { direction: "higher", window: 2 });
  assert.equal(rows[1]?.values["parent_gain"], 2);
});

test("buildRows tolerates empty and malformed histories", () => {
  assert.deepEqual(buildRows([], session), []);
  const bad = [{ ...run(1, 10) }];
  const rows = buildRows(bad, session);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.parent, null);
});

// ---------------------------------------------------------------------------
// appendRows / readRows
// ---------------------------------------------------------------------------

test("appendRows creates parent directories and round-trips through readRows", () => {
  const dir = tmpDir();
  const file = path.join(dir, "nested", "deep", "dashboard.jsonl");
  const rows = buildRows([run(1, 10), run(2, 9)], session);
  appendRows(file, rows);
  assert.ok(fs.existsSync(file));
  const back = readRows(file);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], rows[0]);
  assert.deepEqual(back[1], rows[1]);
  // file is newline-delimited JSON, one row per line
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(JSON.parse(line));
});

test("appendRows is idempotent by (segment, run)", () => {
  const dir = tmpDir();
  const file = path.join(dir, "dashboard.jsonl");
  const rows = buildRows([run(1, 10), run(2, 9)], session);
  appendRows(file, rows);
  appendRows(file, rows);
  appendRows(file, rows);
  assert.equal(readRows(file).length, 2);
  // same run number in a different segment is a distinct row
  const otherSegment: DashboardRow = { ...rows[1]!, segment: 2, run: 2, parent: null };
  appendRows(file, [otherSegment]);
  assert.equal(readRows(file).length, 3);
});

test("appendRows deduplicates within a single batch too", () => {
  const dir = tmpDir();
  const file = path.join(dir, "dashboard.jsonl");
  const rows = buildRows([run(1, 10)], session);
  appendRows(file, [rows[0]!, rows[0]!]);
  assert.equal(readRows(file).length, 1);
});

test("readRows ignores blank and garbage lines and a truncated final line", () => {
  const dir = tmpDir();
  const file = path.join(dir, "dashboard.jsonl");
  const rows = buildRows([run(1, 10), run(2, 9)], session);
  const good = rows.map((r) => JSON.stringify(r));
  const text = [
    "",
    good[0],
    "   ",
    "not json at all",
    '{"run": "nope"}',
    good[1],
    '{"run":3,"segment":1,"commit":"abc0003","met', // torn write
  ].join("\n");
  fs.writeFileSync(file, text, "utf8");
  const parsed = readRows(file);
  assert.equal(parsed.length, 2);
  assert.deepEqual(
    parsed.map((r) => r.run),
    [1, 2],
  );
});

test("readRows returns [] for a missing file", () => {
  const dir = tmpDir();
  assert.deepEqual(readRows(path.join(dir, "does-not-exist.jsonl")), []);
});

test("readRows normalizes non-finite metric values to null", () => {
  const dir = tmpDir();
  const file = path.join(dir, "dashboard.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      run: 1,
      segment: 1,
      commit: "c1",
      metric: 5,
      status: "keep",
      timestamp: 1,
      parent: null,
      values: { cycles: 5, bad: null },
    }) + "\n",
    "utf8",
  );
  const [row] = readRows(file);
  assert.equal(row?.values["cycles"], 5);
  assert.equal(row?.values["bad"], null);
});

test("appendRows on a corrupt file keeps the valid history and appends", () => {
  const dir = tmpDir();
  const file = path.join(dir, "dashboard.jsonl");
  const rows = buildRows([run(1, 10)], session);
  fs.writeFileSync(file, "garbage\n" + JSON.stringify(rows[0]) + "\n", "utf8");
  appendRows(file, buildRows([run(1, 10), run(2, 9)], session));
  assert.equal(readRows(file).length, 2);
});

test("appendRows with an empty batch does not create the file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "dashboard.jsonl");
  appendRows(file, []);
  assert.equal(fs.existsSync(file), false);
});

// ---------------------------------------------------------------------------
// scoreAndAppend
// ---------------------------------------------------------------------------

test("scoreAndAppend writes to <workDir>/.auto/rsi/dashboard.jsonl and returns new rows", () => {
  const workDir = tmpDir();
  const runs = [run(1, 10), run(2, 9), run(3, 9.5)];
  const first = scoreAndAppend(workDir, runs, session);
  assert.equal(first.length, 3);
  const file = path.join(workDir, ".auto", "rsi", "dashboard.jsonl");
  assert.ok(fs.existsSync(file));
  assert.equal(readRows(file).length, 3);

  // replay is a no-op
  const second = scoreAndAppend(workDir, runs, session);
  assert.deepEqual(second, []);
  assert.equal(readRows(file).length, 3);
});

test("scoreAndAppend appends only the newly finished run", () => {
  const workDir = tmpDir();
  const runs = [run(1, 10), run(2, 9)];
  scoreAndAppend(workDir, runs, session);
  const withOneMore = [...runs, run(3, 8)];
  const appended = scoreAndAppend(workDir, withOneMore, session);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.run, 3);
  assert.equal(appended[0]?.parent, 2);
  const file = path.join(workDir, ".auto", "rsi", "dashboard.jsonl");
  assert.equal(readRows(file).length, 3);
});

test("scoreAndAppend is deterministic for a fixed history", () => {
  const a = tmpDir();
  const b = tmpDir();
  const runs = [run(1, 10), run(2, 9), run(3, 8)];
  scoreAndAppend(a, runs, session);
  scoreAndAppend(b, runs, session);
  const rel = path.join(".auto", "rsi", "dashboard.jsonl");
  assert.equal(fs.readFileSync(path.join(a, rel), "utf8"), fs.readFileSync(path.join(b, rel), "utf8"));
});