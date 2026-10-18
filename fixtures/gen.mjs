#!/usr/bin/env node
/**
 * Regenerate the test fixtures. Not needed at runtime — the generated JSONL is committed
 * so the end-to-end test is fully deterministic and has no clock dependency.
 *
 *   node fixtures/gen.mjs
 *
 * Fixtures:
 *   fixtures/stalled/.auto/log.jsonl   — 46 trajectories, a 25-minute stall after run 30
 *   fixtures/healthy/.auto/log.jsonl   — 46 trajectories, still improving (never stalled)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const START = Date.parse("2026-03-02T09:00:00.000Z");
const MIN = 60_000;

function write(dir, entries) {
  const target = path.join(ROOT, dir, ".auto");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "log.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  console.log(`${dir}: ${entries.length} entries`);
}

function config(goal, metricName = "cycles") {
  return {
    type: "config",
    name: goal,
    metricName,
    metricUnit: "",
    bestDirection: "lower",
  };
}

/**
 * @param {number} runs number of trajectories
 * @param {(run: number) => number} metricOf
 */
function build(runs, metricOf) {
  const entries = [config("Optimize the simulated-machine kernel")];
  // Setup work before the first recorded iteration: this is the hour the paper ignores.
  let t = START;
  for (let run = 1; run <= runs; run += 1) {
    // 4 minutes per iteration; from run 31 onwards each one takes 5 minutes, which is
    // what makes the wall clock exceed the 20-minute stall threshold.
    t += (run > 30 ? 5 : 4) * MIN;
    const metric = metricOf(run);
    const status = run === 17 ? "crash" : run === 23 ? "checks_failed" : run % 3 === 0 ? "discard" : "keep";
    entries.push({
      run,
      commit: (0xabc0000 + run * 7).toString(16).slice(0, 7),
      metric,
      metrics: { cycles: metric, wall_ms: 1200 + run * 13 },
      status,
      description: `attempt ${run}: ${run % 5 === 0 ? "reorder loop nest" : "tune tile size"}`,
      timestamp: t,
      segment: 0,
      confidence: run % 4 === 0 ? null : 0.5 + (run % 5) / 10,
      asi: {
        hypothesis: `tile=${2 ** (run % 6)} reduces cache misses`,
        revisits_run: run > 34 ? 29 : null,
      },
    });
  }
  return entries;
}

// Stalled: fast early progress, then the frontier crawls by 1 cycle at a time. The last
// 16 trajectories gain < 2 cycles in total, over 25+ minutes of wall clock.
const stalled = build(46, (run) => {
  if (run <= 20) return 1400 - run * 9;
  if (run <= 30) return 1220 - (run - 20) * 2;
  return 1200 - Math.floor((run - 30) / 6); // 1200,1200,1200,1200,1200,1200,1199,...
});

// Healthy: keeps making >= 2-cycle gains throughout, so it must never steer.
const healthy = build(46, (run) => 1400 - run * 12);

write("stalled", stalled);
write("healthy", healthy);
