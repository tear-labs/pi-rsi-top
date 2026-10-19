import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { parseLog, readSession, toHookSession } from "../src/autoresearch.ts";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function line(value: unknown): string {
  return JSON.stringify(value);
}

const config = (over: Record<string, unknown> = {}) =>
  line({ type: "config", name: "exp", metricName: "cycles", metricUnit: "s", bestDirection: "lower", ...over });

const runEntry = (over: Record<string, unknown> = {}) =>
  line({
    run: 1,
    commit: "abcdef1",
    metric: 100,
    metrics: { cycles: 100, latency_ms: 12 },
    status: "keep",
    description: "d",
    timestamp: 1_700_000_000_000,
    segment: 0,
    confidence: 0.5,
    asi: { hypothesis: "h" },
    ...over,
  });

describe("parseLog: realistic multi-segment log", () => {
  const text = [
    config({ name: "first-session", metricName: "cycles", bestDirection: "lower" }),
    runEntry({ run: 1, metric: 100, status: "keep" }),
    runEntry({ run: 2, metric: 90, status: "keep" }),
    runEntry({ run: 3, metric: 95, status: "discard" }),
    config({ name: "second-session", metricName: "tokens", bestDirection: "higher" }),
    runEntry({ run: 4, metric: 10, status: "keep" }),
    runEntry({ run: 5, metric: 40, status: "keep" }),
    runEntry({ run: 6, metric: 30, status: "crash" }),
    "",
  ].join("\n");

  const { runs, session } = parseLog(text);

  it("keeps one Run per run entry", () => {
    assert.equal(runs.length, 6);
    assert.equal(session.run_count, 6);
  });

  it("assigns segments at config boundaries", () => {
    assert.deepEqual(
      runs.map((r) => r.segment),
      [0, 0, 0, 1, 1, 1],
    );
  });

  it("uses the first config name and the last config metric settings", () => {
    assert.equal(session.name, "first-session");
    assert.equal(session.goal, "first-session");
    assert.equal(session.metric_name, "tokens");
    assert.equal(session.metric_unit, "s");
    assert.equal(session.direction, "higher");
  });

  it("computes baseline and best over the current segment only", () => {
    assert.equal(session.baseline_metric, 10);
    assert.equal(session.best_metric, 40);
  });

  it("preserves run fields", () => {
    const first = runs[0]!;
    assert.equal(first.run, 1);
    assert.equal(first.commit, "abcdef1");
    assert.equal(first.confidence, 0.5);
    assert.deepEqual(first.asi, { hypothesis: "h" });
    assert.deepEqual(first.metrics, { cycles: 100, latency_ms: 12 });
  });

  it("handles consecutive config entries before any runs without incrementing segment", () => {
    const multiConfigStart = [
      config({ name: "cfg1", metricName: "m1" }),
      config({ name: "cfg2", metricName: "m2" }),
      runEntry({ run: 1, metric: 10 }),
    ].join("\n");
    const parsed = parseLog(multiConfigStart);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0]!.segment, 0);
    assert.equal(parsed.session.name, "cfg1");
    assert.equal(parsed.session.metric_name, "m2");
  });

  it("isolates current segment metrics when the second segment has no kept runs", () => {
    const text2 = [
      config({ metricName: "cycles", bestDirection: "lower" }),
      runEntry({ run: 1, metric: 10, status: "keep" }),
      config({ metricName: "cycles", bestDirection: "lower" }),
      runEntry({ run: 2, metric: 25, status: "discard" }),
      runEntry({ run: 3, metric: 30, status: "crash" }),
    ].join("\n");
    const parsed = parseLog(text2);
    assert.equal(parsed.runs.length, 3);
    assert.equal(parsed.session.baseline_metric, 25);
    assert.equal(parsed.session.best_metric, null);
  });
});

describe("parseLog: tolerance", () => {
  it("skips a truncated final line", () => {
    const truncated = '{"run":2,"commit":"abc';
    const text = [config(), runEntry({ run: 1 }), truncated].join("\n");
    const { runs, session } = parseLog(text);
    assert.equal(runs.length, 1);
    assert.equal(session.run_count, 1);
  });

  it("skips garbage lines and unknown entry types", () => {
    const text = [config(), "not json at all", line({ type: "hook", stage: "before" }), runEntry({ run: 1 })].join("\n");
    const { runs } = parseLog(text);
    assert.equal(runs.length, 1);
  });

  it("skips run entries without a numeric run number", () => {
    const text = [config(), line({ commit: "abc", metric: 1 }), runEntry({ run: 7 })].join("\n");
    const { runs, session } = parseLog(text);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.run, 7);
    assert.equal(session.run_count, 1);
  });

  it("drops non-numeric secondary metrics and non-object metrics", () => {
    const text = [
      config(),
      runEntry({ run: 1, metrics: { cycles: 5, bad: "x", nan: null, obj: { a: 1 } } }),
      runEntry({ run: 2, metrics: "nope" }),
    ].join("\n");
    const { runs } = parseLog(text);
    assert.deepEqual(runs[0]!.metrics, { cycles: 5 });
    assert.deepEqual(runs[1]!.metrics, {});
  });

  it("tolerates missing optional fields without inventing a metric", () => {
    const { runs } = parseLog(line({ run: 1 }));
    const r = runs[0]!;
    assert.equal(r.commit, "");
    // A missing metric must NOT become 0: on a lower-is-better metric that would be the best
    // possible score, would take the frontier, and would reset the stall clock.
    assert.ok(Number.isNaN(r.metric), `expected NaN, got ${r.metric}`);
    // An unrecognized status must not default to `keep`, the one frontier-eligible status.
    assert.equal(r.status, "discard");
    assert.equal(r.description, "");
    assert.equal(r.timestamp, 0);
    assert.equal(r.confidence, null);
    assert.equal(r.asi, undefined);
  });

  it("returns empty state for empty text", () => {
    const { runs, session } = parseLog("");
    assert.deepEqual(runs, []);
    assert.equal(session.name, null);
    assert.equal(session.metric_name, "metric");
    assert.equal(session.metric_unit, "");
    assert.equal(session.direction, "lower");
    assert.equal(session.baseline_metric, null);
    assert.equal(session.best_metric, null);
    assert.equal(session.run_count, 0);
    assert.equal(session.goal, "");
  });

  it("handles log with no config entry", () => {
    const { runs, session } = parseLog(runEntry({ run: 1, metric: 50 }));
    assert.equal(runs.length, 1);
    assert.equal(session.name, null);
    assert.equal(session.goal, "");
    assert.equal(session.metric_name, "metric");
    assert.equal(session.direction, "lower");
    assert.equal(session.baseline_metric, 50);
    assert.equal(session.best_metric, 50);
  });

  it("is pure (same input, same output)", () => {
    const text = config() + "\n" + runEntry({ run: 1 });
    assert.deepEqual(parseLog(text), parseLog(text));
  });
});

describe("parseLog: metric semantics", () => {
  it("ignores discard/crash/checks_failed runs for best_metric", () => {
    const text = [
      config(),
      runEntry({ run: 1, metric: 50, status: "keep" }),
      runEntry({ run: 2, metric: 1, status: "discard" }),
      runEntry({ run: 3, metric: 2, status: "crash" }),
      runEntry({ run: 4, metric: 3, status: "checks_failed" }),
    ].join("\n");
    const { session } = parseLog(text);
    assert.equal(session.best_metric, 50);
    assert.equal(session.baseline_metric, 50);
  });

  it("falls back to the segment's first run for baseline when nothing was kept", () => {
    const text = [config(), runEntry({ run: 1, metric: 8, status: "discard" })].join("\n");
    const { session } = parseLog(text);
    assert.equal(session.baseline_metric, 8);
    assert.equal(session.best_metric, null);
  });

  it("honours direction higher for best_metric", () => {
    const text = [
      config({ bestDirection: "higher" }),
      runEntry({ run: 1, metric: 5 }),
      runEntry({ run: 2, metric: 12 }),
      runEntry({ run: 3, metric: 99, status: "crash" }),
    ].join("\n");
    const { session } = parseLog(text);
    assert.equal(session.direction, "higher");
    assert.equal(session.best_metric, 12);
    assert.equal(session.baseline_metric, 5);
  });

  it("defaults direction to lower for unknown values", () => {
    const { session } = parseLog(config({ bestDirection: "sideways" }));
    assert.equal(session.direction, "lower");
  });
});

describe("toHookSession", () => {
  it("returns exactly the seven host fields in host order", () => {
    const { session } = parseLog(config() + "\n" + runEntry({ run: 1 }));
    const hook = toHookSession(session);
    assert.deepEqual(Object.keys(hook), [
      "metric_name",
      "metric_unit",
      "direction",
      "baseline_metric",
      "best_metric",
      "run_count",
      "goal",
    ]);
    assert.equal(hook.metric_name, "cycles");
    assert.equal(hook.metric_unit, "s");
    assert.equal(hook.direction, "lower");
    assert.equal(hook.baseline_metric, 100);
    assert.equal(hook.best_metric, 100);
    assert.equal(hook.run_count, 1);
    assert.equal(hook.goal, "exp");
  });
});

describe("readSession", () => {
  it("returns an empty snapshot when the log is missing", () => {
    const dir = mkTmp();
    const { runs, session } = readSession(dir);
    assert.deepEqual(runs, []);
    assert.equal(session.run_count, 0);
    assert.equal(session.name, null);
  });

  it("reads the current .auto/log.jsonl layout", () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".auto", "log.jsonl"),
      [config({ name: "cur" }), runEntry({ run: 1, metric: 42 })].join("\n") + "\n",
    );
    const { runs, session } = readSession(dir);
    assert.equal(runs.length, 1);
    assert.equal(session.name, "cur");
    assert.equal(session.best_metric, 42);
  });

  it("reads the legacy flat autoresearch.jsonl layout", () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, "autoresearch.jsonl"),
      [config({ name: "legacy" }), runEntry({ run: 1, metric: 7 })].join("\n") + "\n",
    );
    const { runs, session } = readSession(dir);
    assert.equal(runs.length, 1);
    assert.equal(session.name, "legacy");
    assert.equal(session.best_metric, 7);
  });

  it("does not fall back to legacy when .auto layout is present", () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".auto", "prompt.md"), "prompt");
    fs.writeFileSync(
      path.join(dir, "autoresearch.jsonl"),
      [config({ name: "legacy" }), runEntry({ run: 1, metric: 99 })].join("\n") + "\n",
    );
    const { runs, session } = readSession(dir);
    assert.deepEqual(runs, []);
    assert.equal(session.run_count, 0);
    assert.equal(session.name, null);
  });
});
