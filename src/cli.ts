/**
 * `rsi-top` CLI. Side effects live here (and in `paths.ts` / `dashboard.ts`); the method
 * modules stay pure so they can be tested without touching disk.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { RsiConfig, Run, SessionSnapshot } from "./types.ts";
import { DEFAULT_RSI_CONFIG, DEFAULT_STALL_CONFIG } from "./types.ts";
import { readSession } from "./autoresearch.ts";
import {
  appendJsonl,
  autoDir,
  configPath,
  dashboardPath,
  ensureDir,
  plansPath,
  resolveWorkDir,
  rsiDir,
  writeJsonAtomic,
} from "./paths.ts";
import { metricSpecs } from "./metrics.ts";
import { buildRows, readRows, scoreAndAppend } from "./dashboard.ts";
import { detectStall } from "./stall.ts";
import { buildCohortPlan, renderSteer } from "./intervene.ts";
import { codeDistanceFor } from "./code-distance.ts";
import { hookNow, loadConfig } from "./hook.ts";

const USAGE = `rsi-top — metric dashboard + stall detection + diversity-controlled interventions
for pi-autoresearch runs (RSI-top method).

Usage:
  rsi-top init        [--cwd DIR] [--force]      create .auto/rsi/{config.json}, install hooks
  rsi-top score       [--cwd DIR]                append dashboard rows for new trajectories
  rsi-top dashboard   [--cwd DIR] [--limit N] [--json]
  rsi-top check       [--cwd DIR] [--json]       print stall state
  rsi-top intervene   [--cwd DIR] [--force] [--json]   build a cohort plan and print the steer
  rsi-top report      [--cwd DIR]                human summary of the run + dashboard
  rsi-top metrics                                list the metric set
  rsi-top hook <before|after>                    read hook payload JSON on stdin (host entry)

Options:
  --cwd DIR    work dir (default: $PWD)
  --json       machine-readable output where supported
`;

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    positional.push(arg);
  }
  const [command = "report", ...rest] = positional;
  return { command, positional: rest, flags };
}

/**
 * A bare `--help` / `-h` anywhere means help. Without this, `--help` is parsed as a flag
 * with no command, the command defaults to `report`, and asking for help silently prints a
 * report about the current directory instead.
 */
function wantsHelp(argv: string[]): boolean {
  return argv.some((a) => a === "--help" || a === "-h");
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagNumber(args: Args, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function workDirOf(args: Args): string {
  return resolveWorkDir(flagString(args, "cwd") ?? process.cwd());
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

function fmt(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (Number.isInteger(x)) return String(x);
  if (Math.abs(x) >= 100) return x.toFixed(1);
  return x.toFixed(3);
}

function ensureState(workDir: string, cfg: RsiConfig): void {
  ensureDir(rsiDir(workDir, cfg.stateDir));
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * Install the hook shims (and the config, unless already present) into `workDir`'s `.auto`.
 * Shared by `rsi-top init` and the extension's `/rsi-top init`, so both write identical files.
 * Returns the relative paths actually written; an empty list means nothing changed.
 */
export function installHooks(workDir: string, opts?: { force?: boolean }): string[] {
  const force = opts?.force ?? false;
  const cfg = loadConfig(workDir);
  ensureState(workDir, cfg);
  const written: string[] = [];

  const cfgFile = configPath(workDir, cfg.stateDir);
  if (!fs.existsSync(cfgFile) || force) {
    writeJsonAtomic(cfgFile, cfg);
    written.push(path.relative(workDir, cfgFile));
  }

  const hooksDir = path.join(autoDir(workDir), "hooks");
  ensureDir(hooksDir);
  const pkgRoot = packageRoot();
  for (const event of ["before", "after"] as const) {
    const target = path.join(hooksDir, `${event}.sh`);
    if (fs.existsSync(target) && !force) continue;
    const body = `#!/usr/bin/env bash
# Installed by rsi-top. The host pipes the hook payload on stdin and shows stdout
# (<= 8 KB) to the agent as a steer message.
exec node "${path.join(pkgRoot, "bin", "rsi-top.mjs")}" hook ${event}
`;
    fs.writeFileSync(target, body, { mode: 0o755 });
    written.push(path.relative(workDir, target));
  }
  return written;
}

/** Package root, resolved from this module so a symlinked install still finds `bin/`. */
function packageRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

function cmdInit(workDir: string, cfg: RsiConfig, force: boolean): void {
  const written = installHooks(workDir, { force });
  if (written.length === 0) {
    console.log("nothing to install — .auto/rsi/config.json and .auto/hooks already exist (use --force)");
  }
  for (const file of written) console.log(`wrote ${file}`);
}

function cmdScore(workDir: string): void {
  const cfg = loadConfig(workDir);
  const { runs, session } = readSession(workDir);
  const fresh = scoreAndAppend(workDir, runs, session);
  console.log(`scored ${fresh.length} new row(s); ${readRows(dashboardPath(workDir, cfg.stateDir)).length} total`);
}

function cmdDashboard(workDir: string, cfg: RsiConfig, limit: number | undefined, json: boolean): void {
  const rows = readRows(dashboardPath(workDir, cfg.stateDir));
  const shown = limit === undefined ? rows : rows.slice(-limit);
  if (json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (shown.length === 0) {
    console.log("dashboard is empty — run `rsi-top score` first");
    return;
  }
  const specs = metricSpecs();
  const keys = specs.map((s) => s.name);
  const labels = uniqueShortNames(keys);
  const head = ["run", "seg", "status", "metric", ...labels];
  const table: string[][] = [head];
  for (const row of shown) {
    table.push([
      String(row.run),
      String(row.segment),
      row.status,
      fmt(row.metric),
      ...keys.map((k) => fmt(row.values[k])),
    ]);
  }
  console.log(renderTable(table));
  console.log(`\n${shown.length} row(s), ${keys.length} metrics. .auto/rsi/dashboard.jsonl`);
  console.log("legend: " + specs.map((s, i) => `${labels[i]}=${s.name}`).join("  "));
}

/**
 * Short, *unique* column labels. Starts from the last underscore-separated part and grows
 * the label with preceding parts until it no longer collides (`gain`, `parent_gain`, ...).
 */
function uniqueShortNames(names: string[]): string[] {
  const split = names.map((n) => n.split("_"));
  const labels = split.map((parts) => parts[parts.length - 1] ?? "");
  for (let round = 0; round < 8; round += 1) {
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    let changed = false;
    for (let i = 0; i < labels.length; i += 1) {
      if ((counts.get(labels[i] ?? "") ?? 0) < 2) continue;
      const parts = split[i] ?? [];
      const take = Math.min(parts.length, (labels[i] ?? "").split("_").length + 1);
      const next = parts.slice(Math.max(0, parts.length - take)).join("_");
      if (next !== labels[i]) {
        labels[i] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Guarantee uniqueness even for pathological names.
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label}${n}`;
  });
}

function renderTable(rows: string[][]): string {
  const width = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, i) =>
          i === 0 ? (cell ?? "").padEnd(width[i] ?? 0) : (cell ?? "").padStart(width[i] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
}

function cmdCheck(workDir: string, cfg: RsiConfig, json: boolean): void {
  const { runs, session } = readSession(workDir);
  const stall = detectStall(runs, session, cfg.stall, hookNow());
  if (json) {
    console.log(JSON.stringify({ session, stall, runs: runs.length }, null, 2));
    return;
  }
  const mins = Math.round(stall.stalledForMs / 60_000);
  console.log(`runs: ${runs.length}   frontier: ${fmt(stall.frontier)} (run ${stall.frontierRun ?? "—"})`);
  console.log(`epoch age: ${stall.epochAge}   flat for: ${mins} min / ${stall.stalledForRuns} runs`);
  console.log(stall.stalled ? "STALLED — an intervention would fire" : `ok — ${stall.reason}`);
}

function cmdIntervene(workDir: string, cfg: RsiConfig, force: boolean, json: boolean): void {
  const { runs, session } = readSession(workDir);
  if (runs.length === 0) throw new Error("rsi-top: no runs yet; nothing to intervene on");
  const stall = detectStall(runs, session, cfg.stall, hookNow());
  if (!stall.stalled && !force) {
    console.log(`not stalled — ${stall.reason}\n(use --force to build a plan anyway)`);
    return;
  }
  const plan = buildCohortPlan(runs, session, stall, cfg, {
    codeDistance: codeDistanceFor(workDir),
  });
  ensureState(workDir, cfg);
  appendJsonl(plansPath(workDir, cfg.stateDir), [plan]);
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const steer = renderSteer(plan, runs, session, stall, cfg);
  console.log(steer);
  console.error(`\n[plan ${plan.id} appended to .auto/rsi/interventions.jsonl; steer = ${Buffer.byteLength(steer, "utf8")} bytes]`);
}

function cmdReport(workDir: string, cfg: RsiConfig): void {
  const { runs, session } = readSession(workDir);
  const rows = readRows(dashboardPath(workDir, cfg.stateDir));
  const stall = detectStall(runs, session, cfg.stall, hookNow());
  const kept = runs.filter((r) => r.status === "keep").length;
  console.log(`work dir     ${workDir}`);
  console.log(`goal         ${session.goal || "(unset)"}`);
  console.log(`metric       ${session.metric_name}${session.metric_unit ? ` (${session.metric_unit})` : ""} — ${session.direction} is better`);
  console.log(`trajectories ${runs.length} (${kept} keep, ${runs.length - kept} other)`);
  console.log(`baseline     ${fmt(session.baseline_metric)}   best ${fmt(session.best_metric)}`);
  console.log(`dashboard    ${rows.length} row(s) at .auto/rsi/dashboard.jsonl`);
  console.log(`frontier     ${fmt(stall.frontier)} (run ${stall.frontierRun ?? "—"}), epoch age ${stall.epochAge}`);
  console.log(
    stall.stalled
      ? `state        STALLED for ${Math.round(stall.stalledForMs / 60_000)} min — intervention recommended`
      : `state        ok — ${stall.reason}`,
  );
}

function cmdMetrics(): void {
  const specs = metricSpecs();
  const byKind = new Map<string, typeof specs>();
  for (const spec of specs) {
    const list = byKind.get(spec.kind) ?? [];
    list.push(spec);
    byKind.set(spec.kind, list);
  }
  for (const [kind, list] of byKind) {
    console.log(`\n${kind} (${list.length})`);
    for (const spec of list) console.log(`  ${spec.name.padEnd(34)} ${spec.better === "higher" ? "↑" : "↓"}  ${spec.description}`);
  }
  console.log(`\n${specs.length} metrics`);
}

async function cmdHook(event: string, workDir: string): Promise<number> {
  const raw = await readStdin();
  if (raw.trim() === "") {
    process.stderr.write("rsi-top hook: empty payload on stdin\n");
    return 0; // silent: an empty payload is not an error the agent should see
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`rsi-top hook: could not parse payload — ${(err as Error).message}\n`);
    return 0;
  }
  const { handleHook } = await import("./hook.ts");
  const payload = parsed as Record<string, unknown>;
  // Fail-open, as documented: a hook must never be able to fail the run it is attached to.
  // `handleHook` throws on a payload that is not an object or carries an unknown event, and
  // an uncaught throw here would exit non-zero with an error on stderr — which the host
  // surfaces as if the *search* had broken.
  let out: string;
  try {
    out = handleHook({ ...payload, event: payload["event"] ?? event }, workDir);
  } catch (err) {
    process.stderr.write(`rsi-top hook: ${err instanceof Error ? err.message : String(err)}\n`);
    return 0;
  }
  if (out !== "") process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }

  const args = parseArgs(argv);
  const json = args.flags.has("json");
  const force = args.flags.has("force");

  if (args.command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (args.command === "metrics") {
    cmdMetrics();
    return 0;
  }
  if (args.command === "hook") {
    const [event] = args.positional;
    if (event !== "before" && event !== "after") throw new Error("rsi-top hook: expected `before` or `after`");
    return cmdHook(event, workDirOf(args));
  }

  const workDir = workDirOf(args);
  const cfg = loadConfig(workDir);

  switch (args.command) {
    case "init":
      cmdInit(workDir, cfg, force);
      return 0;
    case "score":
      cmdScore(workDir);
      return 0;
    case "dashboard":
      cmdDashboard(workDir, cfg, flagNumber(args, "limit"), json);
      return 0;
    case "check":
      cmdCheck(workDir, cfg, json);
      return 0;
    case "intervene":
      cmdIntervene(workDir, cfg, force, json);
      return 0;
    case "report":
      cmdReport(workDir, cfg);
      return 0;
    default:
      console.error(`rsi-top: unknown command "${args.command}"\n`);
      console.error(USAGE);
      return 2;
  }
}

export const DEFAULTS = { rsi: DEFAULT_RSI_CONFIG, stall: DEFAULT_STALL_CONFIG };

export type { RsiConfig, Run, SessionSnapshot, buildRows };
