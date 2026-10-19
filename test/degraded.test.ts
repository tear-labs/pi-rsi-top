/**
 * A degraded evaluator: a trajectory that ships without a numeric metric.
 *
 * This is exactly the case the `NaN`-not-`0` rule exists to serve, and it had no end-to-end
 * coverage — which is how a `NaN` round-trip through `dashboard.jsonl` shipped and made a row
 * invisible to the dashboard *and* re-appended on every hook call, growing the file forever.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { parseLog } from "../src/autoresearch.ts";
import { buildRows, readRows, scoreAndAppend } from "../src/dashboard.ts";

const CONFIG = JSON.stringify({
  type: "config",
  name: "t",
  metricName: "nll",
  metricUnit: "",
  bestDirection: "lower",
});

/** A log where one trajectory lost its metric. */
const LOG = [
  CONFIG,
  JSON.stringify({ run: 1, commit: "c1", metric: 100, status: "keep", description: "", timestamp: 1 }),
  JSON.stringify({ run: 2, commit: "c2", status: "keep", description: "", timestamp: 2 }),
  JSON.stringify({ run: 3, commit: "c3", metric: 95, status: "keep", description: "", timestamp: 3 }),
].join("\n");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsi-top-degraded-"));
}

describe("a trajectory with no metric", () => {
  it("parses as NaN so it cannot take the frontier", () => {
    const { runs } = parseLog(LOG);
    assert.equal(runs.length, 3);
    assert.ok(Number.isNaN(runs[1]!.metric));
  });

  it("does not poison the session aggregates", () => {
    const { session } = parseLog(LOG);
    // Math.min over a NaN poisons the whole aggregate, and NaN serializes to null.
    assert.equal(session.baseline_metric, 100);
    assert.equal(session.best_metric, 95);
  });

  it("survives the dashboard round trip without duplicating rows", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), LOG);
    const { runs, session } = parseLog(LOG);

    scoreAndAppend(dir, runs, session);
    scoreAndAppend(dir, runs, session);
    scoreAndAppend(dir, runs, session);

    const dashPath = path.join(dir, ".auto", "rsi", "dashboard.jsonl");
    const lines = fs.readFileSync(dashPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 3, `dashboard grew to ${lines.length} lines across repeated scoring`);
    assert.equal(readRows(dashPath).length, 3, "every row must be readable back");
  });

  it("keeps the unusable row readable as NaN", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    const { runs, session } = parseLog(LOG);
    scoreAndAppend(dir, runs, session);
    const rows = readRows(path.join(dir, ".auto", "rsi", "dashboard.jsonl"));
    assert.ok(Number.isNaN(rows[1]!.metric), "a JSON null must read back as NaN, not be dropped");
  });

  it("is still scored, so its other metrics are visible", () => {
    const { runs, session } = parseLog(LOG);
    const rows = buildRows(runs, session, { direction: "lower" });
    assert.equal(rows.length, 3);
    // The metrics that do not need the primary value are still computable.
    assert.ok(rows[1]!.values["valid_attempt"] !== undefined);
  });
});
