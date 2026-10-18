/**
 * pi-rsi-top — Pi extension entry point.
 *
 * The RSI-top machinery is plain, dependency-free TypeScript, so it can run two ways:
 *
 * 1. As `.auto/hooks/{before,after}.sh` shell hooks inside a `pi-autoresearch` work dir
 *    (the zero-install path — see README).
 * 2. As this extension, which puts the same functions in front of the model as tools and
 *    the user as `/` commands, and can install the hooks for you.
 *
 * Both paths call the same code in `src/hook.ts`, `src/dashboard.ts`, and `src/intervene.ts`,
 * so behaviour cannot drift between them.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import process from "node:process";

import { loadConfig } from "./hook.ts";
import { detectStall } from "./stall.ts";
import { readSession } from "./autoresearch.ts";
import { buildCohortPlan, renderSteer } from "./intervene.ts";
import { buildRows, readRows, scoreAndAppend } from "./dashboard.ts";
import { metricSpecs } from "./metrics.ts";
import { dashboardPath } from "./paths.ts";
import { installHooks } from "./cli.ts";

/** The work dir the tools operate on. An explicit argument wins over the process cwd. */
function resolveWorkDir(explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  return process.cwd();
}

/** Table cell for a possibly-null metric value. Never prints `null` as `0`. */
function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3);
}

/** Parameters shared by every RSI-top tool: which work dir to read. */
const CHECK_PARAMS = Type.Object({
  workDir: Type.Optional(Type.String({ description: "Autoresearch work dir (default: cwd)" })),
});

type CheckDetails = {
  stalled: boolean;
  state: ReturnType<typeof detectStall>;
  plan: ReturnType<typeof buildCohortPlan> | null;
};

const checkTool = defineTool<typeof CHECK_PARAMS, CheckDetails>({
  name: "rsi_top_check",
  label: "RSI-top: check",
  description:
    "Check whether an autoresearch run's frontier has stalled (exploration collapse). Reads " +
    ".auto/log.jsonl from the work dir and returns the frontier, how long it has been flat, and " +
    "why. When stalled, also returns the intervention steer text.",
  parameters: CHECK_PARAMS,
  annotations: { readOnlyHint: true },
  async execute(_id, params) {
    const workDir = resolveWorkDir(params.workDir);
    const cfg = loadConfig(workDir);
    const { runs, session } = readSession(workDir);
    const state = detectStall(runs, session, cfg.stall);
    const head = [
      `runs: ${runs.length} — frontier ${fmt(state.frontier)} (run ${state.frontierRun ?? "—"})`,
      `flat for ${Math.round(state.stalledForMs / 60000)} min / ${state.stalledForRuns} runs, ` +
        `epoch age ${state.epochAge}`,
      `stalled: ${state.stalled} — ${state.reason}`,
    ];
    if (!state.stalled) {
      return {
        content: [{ type: "text", text: head.join("\n") }],
        details: { stalled: false, state, plan: null },
      };
    }
    const plan = buildCohortPlan(runs, session, state, cfg);
    head.push("", renderSteer(plan, runs, session, state, cfg));
    return {
      content: [{ type: "text", text: head.join("\n") }],
      details: { stalled: true, state, plan },
    };
  },
});

const dashboardTool = defineTool({
  name: "rsi_top_dashboard",
  label: "RSI-top: dashboard",
  description:
    "Read the RSI-top metric dashboard: one compressed row per finished trajectory with unary, " +
    "binary, region and global metrics (null = not computable yet, never 0). Use it to compare " +
    "trajectories without loading them. Newly finished trajectories are scored first.",
  parameters: Type.Object({
    workDir: Type.Optional(Type.String({ description: "Autoresearch work dir (default: cwd)" })),
    limit: Type.Optional(Type.Number({ description: "Rows to return, newest last (default 20)" })),
  }),
  annotations: { readOnlyHint: false, idempotentHint: true },
  async execute(_id, params) {
    const workDir = resolveWorkDir(params.workDir);
    const cfg = loadConfig(workDir);
    const { runs, session } = readSession(workDir);
    scoreAndAppend(workDir, runs, session);
    const rows = readRows(dashboardPath(workDir, cfg.stateDir));
    const limit = Math.max(1, Math.trunc(params.limit ?? 20));
    const shown = rows.slice(-limit);
    const specs = metricSpecs();
    const cols = specs.slice(0, 8);
    const header = ["run", "seg", "status", "metric", ...cols.map((m) => m.name)].join("\t");
    const body = shown.map((r) =>
      [r.run, r.segment, r.status, fmt(r.metric), ...cols.map((m) => fmt(r.values[m.name]))].join("\t"),
    );
    const note =
      `# ${rows.length} row(s) at ${dashboardPath(workDir, cfg.stateDir)}` +
      (shown.length < rows.length ? ` (showing last ${shown.length})` : "");
    return {
      content: [{ type: "text", text: [note, header, ...body].join("\n") }],
      details: { total: rows.length, shown: shown.length, rows: shown },
    };
  },
});

const interveneTool = defineTool({
  name: "rsi_top_intervene",
  label: "RSI-top: intervene",
  description:
    "Build a diversity-controlled intervention cohort for the current stall: each arm gets a " +
    "different random metric subset, a verbalized-probability direction portfolio, and a " +
    "different frontier epoch to ground itself in. Returns the steer text to follow. The plan " +
    "is appended to .auto/rsi/interventions.jsonl.",
  parameters: Type.Object({
    workDir: Type.Optional(Type.String({ description: "Autoresearch work dir (default: cwd)" })),
    seed: Type.Optional(
      Type.Number({ description: "Force a specific seed (default: derived from the search state)" }),
    ),
  }),
  annotations: { readOnlyHint: false },
  async execute(_id, params) {
    const workDir = resolveWorkDir(params.workDir);
    const cfg = loadConfig(workDir);
    const { runs, session } = readSession(workDir);
    const state = detectStall(runs, session, cfg.stall);
    const plan = buildCohortPlan(runs, session, state, cfg, { seed: params.seed });
    return {
      content: [{ type: "text", text: renderSteer(plan, runs, session, state, cfg) }],
      details: { plan },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(checkTool);
  pi.registerTool(dashboardTool);
  pi.registerTool(interveneTool);

  pi.registerCommand("rsi-top", {
    description: "RSI-top: `init` install hooks, `check` show the stall state, `intervene` emit a cohort",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "check";
      const workDir = process.cwd();

      if (sub === "init") {
        const writes = installHooks(workDir, { force: false });
        ctx.ui.notify(
          writes.length === 0
            ? "rsi-top: nothing to install (hooks and config already exist; rerun with --force to overwrite)"
            : `rsi-top: ${writes.join(", ")}`,
          "info",
        );
        return;
      }

      const cfg = loadConfig(workDir);
      const { runs, session } = readSession(workDir);
      const state = detectStall(runs, session, cfg.stall);

      if (sub === "intervene") {
        const plan = buildCohortPlan(runs, session, state, cfg);
        pi.sendUserMessage(renderSteer(plan, runs, session, state, cfg));
        return;
      }

      ctx.ui.notify(
        `rsi-top: ${state.stalled ? "STALLED" : "healthy"} — frontier ${fmt(state.frontier)} ` +
          `(run ${state.frontierRun ?? "—"}), flat ${Math.round(state.stalledForMs / 60000)} min. ` +
          state.reason,
        state.stalled ? "warning" : "info",
      );
    },
  });

  // Surface a stall at startup so it is visible without asking. Never throws: an extension
  // must not break a session, and the hooks fail open for the same reason.
  pi.on("session_start", async (_event, ctx) => {
    try {
      const workDir = process.cwd();
      const cfg = loadConfig(workDir);
      const { runs, session } = readSession(workDir);
      if (runs.length === 0) return;
      const state = detectStall(runs, session, cfg.stall);
      if (state.stalled) {
        ctx.ui.notify(
          `rsi-top: frontier stalled for ${Math.round(state.stalledForMs / 60000)} min — ` +
            `/rsi-top intervene`,
          "warning",
        );
      }
    } catch {
      // Fail open, exactly like the hooks.
    }
  });
}