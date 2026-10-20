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
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import process from "node:process";

import { loadConfig } from "./hook.ts";
import { detectStall } from "./stall.ts";
import { readSession } from "./autoresearch.ts";
import { buildCohortPlan, renderSteer } from "./intervene.ts";
import { codeDistanceFor } from "./code-distance.ts";
import { buildRows, readRows, scoreAndAppend } from "./dashboard.ts";
import { metricSpecs } from "./metrics.ts";
import { dashboardPath } from "./paths.ts";
import { installHooks } from "./cli.ts";
import { renderWidget } from "./widget.ts";

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
    const plan = buildCohortPlan(runs, session, state, cfg, {
      codeDistance: codeDistanceFor(workDir),
    });
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
    const plan = buildCohortPlan(runs, session, state, cfg, {
      seed: params.seed,
      codeDistance: codeDistanceFor(workDir),
    });
    return {
      content: [{ type: "text", text: renderSteer(plan, runs, session, state, cfg) }],
      details: { plan },
    };
  },
});

/** Widget key. One key, so a second refresh replaces rather than stacks. */
const WIDGET_KEY = "rsi-top";

/**
 * The one widget config knob that is worth an environment variable rather than a file:
 * how much of the screen the glance costs. `RSI_TOP_WIDGET_ROWS=0` keeps the status line
 * and drops the trajectory table; `RSI_TOP_WIDGET=0` hides the widget entirely.
 */
const WIDGET_TABLE_ROWS = (() => {
  const raw = process.env["RSI_TOP_WIDGET_ROWS"];
  if (raw === undefined) return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

/** Runtime visibility, toggled by `/rsi-top hide` and `/rsi-top show` for this session. */
let widgetVisible = process.env["RSI_TOP_WIDGET"] !== "0";

/**
 * Where the widget reads from, when that is not the process cwd.
 *
 * Pi is usually opened in the chat's working directory, which is often NOT the directory an
 * autoresearch run lives in. Without this, the widget is empty in every session that is not
 * started inside the run itself — and `/rsi-top show` still claimed it was shown. Set by
 * `/rsi-top show <dir>` or `RSI_TOP_CWD`.
 */
let widgetWorkDir: string | undefined = process.env["RSI_TOP_CWD"];

/**
 * Reset the session-scoped widget state (visibility and work dir) to its env-derived default.
 *
 * Only for tests: these two variables are module state on purpose (they must outlive a single
 * extension event), which means otherwise one test's `hide` silently changes the next test's
 * starting point. Exported rather than reached into, so the reset stays in sync with the state.
 */
export function resetWidgetState(): void {
  widgetVisible = process.env["RSI_TOP_WIDGET"] !== "0";
  widgetWorkDir = process.env["RSI_TOP_CWD"];
}

/** Why the widget has nothing to draw. Returned so `show` can tell the truth. */
type WidgetOutcome = { shown: true; lines: number } | { shown: false; reason: string };

/**
 * Pi Web renders an extension widget as a fixed 108px trigger in a row, and only expands the
 * panel for a widget whose line count is `> 1 && <= 3` (see pi-web's widget component: it
 * picks its initial open panel with `lines.length > 1 && lines.length <= 3`). Anything taller
 * is a collapsed, unopenable tab. So the *same* widget has to be a different shape depending
 * on where it is being drawn.
 */
const WEB_MAX_LINES = 3;

/**
 * Collapse the full widget into something Pi Web can actually show.
 *
 * The status line is the part that must survive; the sparkline is the second-most
 * informative. The per-trajectory table is what gets dropped, because it is the only part
 * that needs more than three lines to say anything.
 */
export function compact(lines: string[], max = WEB_MAX_LINES): string[] {
  const [status = "", spark] = lines;
  // Pi Web prints the widget key as a heading directly above the content, so a status line
  // beginning "rsi-top │ " repeats it. Dropping the prefix buys ~10 characters of width for
  // the metric name, which is the part a reader actually needs.
  const head: string[] = [status.replace(/^rsi-top │ /, "")];
  if (spark !== undefined) head.push(spark);
  // A stall warning is the one line worth more than the table; put it in the third slot.
  const warn = lines.find((l) => l.startsWith("⚠"));
  if (warn && head.length < max) head.push(warn);
  return head.slice(0, max);
}

/**
 * Recompute and repaint the widget, or clear it when there is nothing to show.
 *
 * Fail-open like everything else here: a widget must never be able to break a session, so
 * any error clears the widget instead of surfacing. Reads are cheap (a JSONL scan plus the
 * scored dashboard), but they still run only on events, never per frame.
 */
function refreshWidget(ctx: Pick<ExtensionContext, "ui" | "mode">): WidgetOutcome {
  try {
    if (!widgetVisible) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return { shown: false, reason: "hidden (`/rsi-top show` to bring it back)" };
    }
    const workDir = widgetWorkDir ?? process.cwd();
    const cfg = loadConfig(workDir);
    const { runs, session } = readSession(workDir);
    if (runs.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return {
        shown: false,
        reason: `no autoresearch log in ${workDir} — run \`rsi-top init\` there, or \`/rsi-top show <dir>\``,
      };
    }
    const stall = detectStall(runs, session, cfg.stall);
    const rows = readRows(dashboardPath(workDir, cfg.stateDir));
    const full = renderWidget({ runs, session, stall, rows, tableRows: WIDGET_TABLE_ROWS });
    // Web gets the compact form (see WEB_MAX_LINES); the TUI has room for the table.
    const lines = ctx.mode === "rpc" ? compact(full) : full;
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
    return { shown: true, lines: lines.length };
  } catch (err) {
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // Nothing left to do; the session must survive a widget failure.
    }
    return { shown: false, reason: `error reading ${widgetWorkDir ?? process.cwd()}: ${(err as Error).message}` };
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(checkTool);
  pi.registerTool(dashboardTool);
  pi.registerTool(interveneTool);

  pi.registerCommand("rsi-top", {
    description:
      "RSI-top: `init` install hooks, `check` stall state, `intervene` emit a cohort, `show`/`hide` the widget",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "check";
      const rest = (args ?? "").trim().split(/\s+/).slice(1).join(" ");
      const workDir = resolveWorkDir(rest.trim() || undefined);

      if (sub === "hide" || sub === "show") {
        widgetVisible = sub === "show";
        if (sub === "show" && rest.trim() !== "") widgetWorkDir = resolveWorkDir(rest.trim());
        const outcome = refreshWidget(ctx);
        // Report what actually happened. `show` used to say "widget shown" while it was
        // clearing the widget because this directory had no log.
        ctx.ui.notify(
          outcome.shown
            ? `rsi-top: widget shown (${outcome.lines} line${outcome.lines === 1 ? "" : "s"}) from ${widgetWorkDir ?? process.cwd()}`
            : `rsi-top: widget NOT shown — ${outcome.reason}`,
          outcome.shown ? "info" : "warning",
        );
        return;
      }

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
        const plan = buildCohortPlan(runs, session, state, cfg, {
          codeDistance: codeDistanceFor(workDir),
        });
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
    const outcome = refreshWidget(ctx);
    // A silent empty widget is indistinguishable from a broken extension. Say why once, at
    // startup, and only when the user has not deliberately hidden it.
    if (!outcome.shown && widgetVisible && outcome.reason.startsWith("no autoresearch log")) {
      ctx.ui.notify(`rsi-top: idle — ${outcome.reason}`, "info");
    }
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

  // Repaint after anything that can change the log. `tool_result` covers the case that
  // actually matters — `log_experiment` appending a trajectory — while `turn_end` catches
  // changes made by plain bash (a hook run, a hand-edited JSONL, a reverted commit).
  pi.on("tool_result", async (_event, ctx) => {
    refreshWidget(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    refreshWidget(ctx);
  });
}