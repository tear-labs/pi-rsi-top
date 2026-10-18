/**
 * Hook entry points (RSI-top step 3–5): the host's `before.sh` / `after.sh` call these.
 *
 * `before` = the pre-run gate. It refreshes the dashboard, asks the stall monitor whether
 * the frontier is flat, and — only when it is — emits the intervention cohort as a steer
 * message. `after` = background scoring: one dashboard row for the trajectory that just
 * finished. Both return "" to stay silent, which the host treats as "nothing to say".
 */

import path from "node:path";
import process from "node:process";

import type {
  AfterHookPayload,
  BeforeHookPayload,
  HookPayload,
  RsiConfig,
  Run,
  SessionSnapshot,
  StallConfig,
} from "./types.ts";
import { DEFAULT_RSI_CONFIG, DEFAULT_STALL_CONFIG } from "./types.ts";
import { readSession, toHookSession } from "./autoresearch.ts";
import { appendJsonl, configPath, ensureDir, plansPath, readJsonFile, rsiDir } from "./paths.ts";
import { dashboardPathFor, scoreAndAppend } from "./dashboard.ts";
import { detectStall } from "./stall.ts";
import { buildCohortPlan, renderSteer } from "./intervene.ts";

/** Merge a partial on-disk config over the defaults, ignoring unknown/garbage keys. */
export function loadConfig(workDir: string): RsiConfig {
  const raw = readJsonFile<Record<string, unknown>>(configPath(workDir), {});
  const partialStall = isRecord(raw["stall"]) ? raw["stall"] : {};
  const stall: StallConfig = {
    minStallMs: num(partialStall["minStallMs"], DEFAULT_STALL_CONFIG.minStallMs),
    minGain: num(partialStall["minGain"], DEFAULT_STALL_CONFIG.minGain),
    ignoreFirstMs: num(partialStall["ignoreFirstMs"], DEFAULT_STALL_CONFIG.ignoreFirstMs),
    minRuns: num(partialStall["minRuns"], DEFAULT_STALL_CONFIG.minRuns),
  };
  return {
    enabled: bool(raw["enabled"], DEFAULT_RSI_CONFIG.enabled),
    stall,
    cohortSize: num(raw["cohortSize"], DEFAULT_RSI_CONFIG.cohortSize),
    metricSubsetSize: num(raw["metricSubsetSize"], DEFAULT_RSI_CONFIG.metricSubsetSize),
    portfolioSize: num(raw["portfolioSize"], DEFAULT_RSI_CONFIG.portfolioSize),
    unfoldSize: num(raw["unfoldSize"], DEFAULT_RSI_CONFIG.unfoldSize),
    temperature: num(raw["temperature"], DEFAULT_RSI_CONFIG.temperature),
    seed: num(raw["seed"], DEFAULT_RSI_CONFIG.seed),
    stateDir: typeof raw["stateDir"] === "string" ? raw["stateDir"] : DEFAULT_RSI_CONFIG.stateDir,
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function num(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

function bool(x: unknown, fallback: boolean): boolean {
  return typeof x === "boolean" ? x : fallback;
}

/**
 * Union of the log on disk and anything the host already told us, preferring the log
 * (it is authoritative) but never losing runs the host reports that we have not read yet.
 */
function mergeHistory(workDir: string, reported?: Run): { runs: Run[]; session: SessionSnapshot } {
  const fromDisk = readSession(workDir);
  if (!reported) return fromDisk;
  const known = new Set(fromDisk.runs.map((r) => `${r.segment}:${r.run}`));
  if (known.has(`${reported.segment}:${reported.run}`)) return fromDisk;
  const runs = [...fromDisk.runs, reported].sort(
    (a, b) => a.segment - b.segment || a.run - b.run,
  );
  return { runs, session: fromDisk.session };
}

/**
 * Wall clock for stall detection. `RSI_TOP_NOW` (ms since epoch) pins it so the committed
 * fixtures can be tested without depending on the day the tests run.
 */
export function hookNow(): number {
  const override = process.env["RSI_TOP_NOW"];
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

/** Coerce the host's `run_entry` object into a `Run`, or null when it is unusable. */
export function toRun(entry: Record<string, unknown> | null | undefined): Run | null {
  if (!isRecord(entry)) return null;
  const run = entry["run"];
  const metric = entry["metric"];
  if (typeof run !== "number" || !Number.isFinite(run)) return null;
  if (typeof metric !== "number" || !Number.isFinite(metric)) return null;
  const status = entry["status"];
  const metricsRaw = entry["metrics"];
  const metrics: Record<string, number> = {};
  if (isRecord(metricsRaw)) {
    for (const [k, v] of Object.entries(metricsRaw)) {
      if (typeof v === "number" && Number.isFinite(v)) metrics[k] = v;
    }
  }
  const asi = entry["asi"];
  const confidence = entry["confidence"];
  const candidate: Run = {
    run,
    commit: typeof entry["commit"] === "string" ? entry["commit"] : "",
    metric,
    metrics,
    status:
      status === "keep" || status === "discard" || status === "crash" || status === "checks_failed"
        ? status
        : "discard",
    description: typeof entry["description"] === "string" ? entry["description"] : "",
    timestamp:
      typeof entry["timestamp"] === "number" && Number.isFinite(entry["timestamp"])
        ? entry["timestamp"]
        : Date.now(),
    segment: typeof entry["segment"] === "number" && Number.isFinite(entry["segment"]) ? entry["segment"] : 0,
    confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null,
  };
  if (isRecord(asi)) candidate.asi = asi;
  return candidate;
}

/**
 * Pre-run hook. Returns the steer text ("" = stay silent).
 * Side effects: refreshes the dashboard, records the plan when an intervention fires.
 */
export function handleBefore(payload: BeforeHookPayload, workDir: string): string {
  const cfg = loadConfig(workDir);
  const { runs, session } = readSession(workDir);
  if (runs.length === 0) return "";

  // Background scoring: keep the dashboard current before anyone reads it.
  try {
    scoreAndAppend(workDir, runs, session);
  } catch {
    // Scoring must never block the run; the next call retries.
  }
  if (!cfg.enabled) return "";

  const stall = detectStall(runs, session, cfg.stall, hookNow());
  if (!stall.stalled) return "";

  const plan = buildCohortPlan(runs, session, stall, cfg);
  try {
    ensureDir(rsiDir(workDir, cfg.stateDir));
    appendJsonl(plansPath(workDir, cfg.stateDir), [plan]);
  } catch {
    // Persisting the plan is best-effort; the steer text is the deliverable.
  }
  return renderSteer(plan, runs, session, stall, cfg);
}

/**
 * Post-run hook. Scores the finished trajectory into the dashboard (idempotent) and
 * stays silent — RSI-top never interrupts a healthy run.
 */
export function handleAfter(payload: AfterHookPayload, workDir: string): string {
  const reported = toRun(payload.run_entry ?? null);
  const { runs, session } = mergeHistory(workDir, reported ?? undefined);
  if (runs.length === 0) return "";
  try {
    scoreAndAppend(workDir, runs, session);
  } catch {
    // Silent by contract: stderr from the shim reports failures, not the steer channel.
  }
  return "";
}

/** Dispatch on `payload.event`; used by the CLI and the shims. */
export function handleHook(raw: unknown, workDir: string): string {
  if (!isRecord(raw)) throw new Error("rsi-top hook: payload is not a JSON object");
  const event = raw["event"];
  if (event === "before") return handleBefore(raw as unknown as BeforeHookPayload, workDir);
  if (event === "after") return handleAfter(raw as unknown as AfterHookPayload, workDir);
  const payload = raw as Partial<HookPayload>;
  throw new Error(`rsi-top hook: unknown event "${String(payload.event)}" (expected "before" or "after")`);
}

/** Absolute dashboard path for diagnostics/CLI output. */
export function dashboardFile(workDir: string, cfg: RsiConfig): string {
  return path.join(rsiDir(workDir, cfg.stateDir), "dashboard.jsonl");
}

/** Re-export so the CLI can print the exact session block the host will pass. */
export { toHookSession };
