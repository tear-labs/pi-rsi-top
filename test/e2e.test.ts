/**
 * Acceptance criterion 5: the real hook scripts, as executable files, against realistic
 * work dirs. Nothing is mocked — `hooks/before.sh` and `hooks/after.sh` are spawned with
 * the same stdin envelope pi-autoresearch uses, and their stdout is what the agent sees.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { readRows } from "../src/dashboard.ts";
import { metricSpecs } from "../src/metrics.ts";
import { STEER_MAX_BYTES } from "../src/types.ts";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BEFORE = path.join(REPO, "hooks", "before.sh");
const AFTER = path.join(REPO, "hooks", "after.sh");
const FIXTURES = path.join(REPO, "fixtures");

/** Copy a committed fixture into a temp dir so tests never mutate the repo. */
function tempWorkDir(fixture: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rsi-e2e-${fixture}-`));
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

interface HookResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runHook(script: string, payload: unknown, workDir: string, env?: Record<string, string>): HookResult {
  const result = spawnSync(script, [], {
    cwd: workDir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

/** The `before` envelope exactly as `hooks.ts` in pi-autoresearch builds it. */
function beforePayload(workDir: string, session: Record<string, unknown>, nextRun = 47): unknown {
  return { event: "before", cwd: workDir, next_run: nextRun, last_run: null, session };
}

function sessionFor(workDir: string): Record<string, unknown> {
  const text = fs.readFileSync(path.join(workDir, ".auto", "log.jsonl"), "utf8");
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // The fixture in 5e is deliberately corrupt; the hook must tolerate it too.
    }
  }
  const cfg = entries.find((e) => e["type"] === "config") ?? {};
  const runs = entries.filter((e) => e["type"] !== "config");
  const last = runs[runs.length - 1] as Record<string, unknown>;
  const metrics = runs.map((r) => r["metric"]).filter((m): m is number => typeof m === "number");
  return {
    metric_name: typeof cfg["metricName"] === "string" ? cfg["metricName"] : "metric",
    metric_unit: typeof cfg["metricUnit"] === "string" ? cfg["metricUnit"] : "",
    direction: "lower",
    baseline_metric: metrics[0] ?? null,
    best_metric: metrics.length > 0 ? Math.min(...metrics) : null,
    run_count: runs.length,
    goal: typeof cfg["name"] === "string" ? cfg["name"] : "",
    name: typeof cfg["name"] === "string" ? cfg["name"] : null,
    last_run: last,
  };
}

test("acceptance 5a: a healthy run produces no steer text at all", () => {
  const workDir = tempWorkDir("healthy");
  const session = sessionFor(workDir);
  const result = runHook(BEFORE, beforePayload(workDir, session), workDir);
  assert.equal(result.status, 0, `before.sh failed: ${result.stderr}`);
  assert.equal(result.stdout, "", "healthy run must stay silent");
});

test("acceptance 5b: a stalled run steers with a diverse cohort", () => {
  const workDir = tempWorkDir("stalled");
  const session = sessionFor(workDir);
  const result = runHook(BEFORE, beforePayload(workDir, session), workDir);
  assert.equal(result.status, 0, `before.sh failed: ${result.stderr}`);

  const steer = result.stdout;
  assert.notEqual(steer, "", "stalled run must steer");
  assert.ok(Buffer.byteLength(steer, "utf8") <= STEER_MAX_BYTES, "steer must fit the 8 KB hook budget");
  assert.match(steer, /RSI-top/);
  assert.match(steer, /stalled/i);

  // N arms are named, numbered 1..N.
  const arms = [...steer.matchAll(/### Arm (\d+)\/(\d+)/g)];
  assert.ok(arms.length >= 2, `expected a multi-arm cohort, saw ${arms.length}`);
  const total = Number(arms[0]?.[2]);
  assert.equal(arms.length, total, "every arm should be rendered when the steer fits");
  assert.deepEqual(
    arms.map((m) => Number(m[1])),
    Array.from({ length: total }, (_, i) => i + 1),
    "arms numbered consecutively from 1",
  );

  // Each arm has a distinct metric subset (the paper's diversity control).
  const views = [...steer.matchAll(/- Dashboard view \((\d+) metrics\): (.+)/g)].map((m) => m[2] ?? "");
  assert.equal(views.length, total);
  for (const view of views) {
    const names = view.split(", ");
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.ok(
        metricSpecs().some((spec) => spec.name === name),
        `${name} is not a real metric`,
      );
    }
  }
  assert.equal(new Set(views).size, views.length, "arms must not share the same dashboard view");

  // Every arm's portfolio probabilities sum to 1 (within float tolerance).
  const portfolios = [...steer.matchAll(/- Direction portfolio: (.+)/g)].map((m) => m[1] ?? "");
  assert.equal(portfolios.length, total);
  for (const portfolio of portfolios) {
    const probs = [...portfolio.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
    assert.ok(probs.length >= 2, "portfolio should carry more than one direction");
    const sum = probs.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) <= 1, `portfolio probabilities sum to ${sum}%, expected 100%`);
  }

  // Lineages: distinct roots, so arms are not grounded in the same trajectory.
  const lineages = [...steer.matchAll(/- Lineage: run (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(lineages.length >= 2);
  assert.equal(new Set(lineages).size, lineages.length, "lineage roots must be distinct");

  // The plan was persisted next to the dashboard.
  const plansFile = path.join(workDir, ".auto", "rsi", "interventions.jsonl");
  assert.ok(fs.existsSync(plansFile), "the plan should be recorded");
  const plans = fs
    .readFileSync(plansFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(plans.length, 1);
  const armsInPlan = plans[0]?.["arms"];
  assert.ok(Array.isArray(armsInPlan));
  assert.equal(armsInPlan.length, total);
});

test("acceptance 5c: after.sh appends exactly one row and is idempotent on replay", () => {
  const workDir = tempWorkDir("stalled");
  const session = sessionFor(workDir);
  const diffPaths = path.join(workDir, ".auto", "rsi", "dashboard.jsonl");

  // First: score the history that already exists, via the CLI-equivalent hook.
  const lastRun = session["last_run"] as Record<string, unknown>;
  const payload = { event: "after", cwd: workDir, run_entry: lastRun, session };
  const first = runHook(AFTER, payload, workDir);
  assert.equal(first.status, 0, `after.sh failed: ${first.stderr}`);
  assert.equal(first.stdout, "", "after.sh must be silent");

  const afterFirst = readRows(diffPaths);
  assert.ok(afterFirst.length > 0, "after.sh should have scored the history");
  const key = `${afterFirst[0]?.segment}:${afterFirst[0]?.run}`;
  const countForKey = (): number =>
    readRows(diffPaths).filter((row) => `${row.segment}:${row.run}` === key).length;
  assert.equal(countForKey(), 1);

  // Replay the identical payload three times: no duplicate rows.
  for (let i = 0; i < 3; i += 1) {
    const replay = runHook(AFTER, payload, workDir);
    assert.equal(replay.status, 0);
    assert.equal(replay.stdout, "");
  }
  assert.equal(countForKey(), 1, "replaying after.sh must not duplicate dashboard rows");
  assert.equal(readRows(diffPaths).length, afterFirst.length);
});

test("acceptance 5d: before.sh is idempotent for its own scoring side effect", () => {
  const workDir = tempWorkDir("stalled");
  const session = sessionFor(workDir);
  const payload = beforePayload(workDir, session);
  runHook(BEFORE, payload, workDir);
  const board = path.join(workDir, ".auto", "rsi", "dashboard.jsonl");
  const once = readRows(board).length;
  runHook(BEFORE, payload, workDir);
  runHook(BEFORE, payload, workDir);
  assert.equal(readRows(board).length, once, "repeated before.sh calls must not grow the dashboard");
});

test("acceptance 5e: a truncated/garbage history does not crash the hooks", () => {
  const workDir = tempWorkDir("stalled");
  const logFile = path.join(workDir, ".auto", "log.jsonl");
  const text = fs.readFileSync(logFile, "utf8");
  fs.writeFileSync(logFile, `${text}{"run": 47, "commit": "abc`, "utf8"); // truncated tail
  fs.appendFileSync(logFile, "\nnot json at all\n", "utf8");
  const session = sessionFor(workDir);
  const result = runHook(BEFORE, beforePayload(workDir, session), workDir);
  assert.equal(result.status, 0, `before.sh must tolerate a corrupt tail: ${result.stderr}`);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= STEER_MAX_BYTES);
});

test("acceptance 5f: an empty payload keeps the hook silent and non-fatal", () => {
  const workDir = tempWorkDir("stalled");
  const result = spawnSync(BEFORE, [], { cwd: workDir, input: "", encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, "an empty stdin must not fail the run");
  assert.equal(result.stdout ?? "", "");
});
