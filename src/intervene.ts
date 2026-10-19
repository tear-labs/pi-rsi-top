/**
 * Diversity-controlled interventions (RSI-top §"Diversity control").
 *
 * When the frontier stalls, the native search pauses and a *cohort* of arms is launched.
 * Each arm differs from the others in three ways, which together are what lets the search
 * escape a valley instead of refining inside it:
 *   1. it sees a different random subset of the dashboard metrics,
 *   2. it proposes a portfolio of directions with verbalized probabilities,
 *   3. it is grounded in a different lineage of the shared history.
 * Proposals across arms are meant to run in parallel; the search then resumes.
 */

import type {
  CodeDistance,
  CohortArm,
  CohortPlan,
  DashboardRow,
  DirectionArm,
  MetricSpec,
  Direction,
  RsiConfig,
  Run,
  SessionSnapshot,
  StallState,
} from "./types.ts";
import { DEFAULT_RSI_CONFIG, STEER_MAX_BYTES } from "./types.ts";
import { metricSpecs } from "./metrics.ts";
import { buildRows } from "./dashboard.ts";
import { makeRng, sampleSubset, selectLineages, verbalizedSample } from "./diversity.ts";
import { improvementSteps } from "./frontier.ts";

/** Compress the whole history into dashboard rows (pure). */
function rowsFor(runs: Run[], session: SessionSnapshot): DashboardRow[] {
  return buildRows(runs, session, { direction: session.direction });
}

/**
 * Turn metric specs into *direction candidates*: a direction is a proposed fix that
 * targets one axis of the dashboard. The dashboard is what makes these comparable,
 * so the candidates are the metrics themselves, phrased as actions.
 */
export function directionCandidates(
  metrics: MetricSpec[],
  direction: Direction = "lower",
): string[] {
  return [...metrics]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => {
      // The metric set hardcodes `better` for the two metrics that simply *mirror* the
      // optimization objective: `cycles` (the primary metric) and `best_descendant_metric`
      // (a subtree's best primary value). On a higher-is-better run those two must flip, or
      // the steer tells the agent to "reduce cycles" — i.e. to lower its own score.
      const better =
        m.mirrorsObjective === true
          ? direction
          : m.better === "higher"
            ? "higher"
            : "lower";
      return better === "higher" ? `raise ${m.name}` : `reduce ${m.name}`;
    });
}

/** Short, arm-local view of the dashboard: only the metrics this arm can see. */
function describeRow(row: DashboardRow, metrics: string[]): string {
  const parts: string[] = [];
  for (const name of metrics) {
    const v = row.values[name];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    parts.push(`${name}=${formatNumber(v)}`);
  }
  return parts.length > 0 ? parts.join(" ") : `${metrics.length} metrics (no values yet)`;
}

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function pickSeed(cfg: RsiConfig, runs: Run[], session: SessionSnapshot, epoch: number, opts?: { seed?: number }): number {
  if (opts?.seed !== undefined) return opts.seed;
  if (cfg.seed !== 0) return cfg.seed;
  const last = runs[runs.length - 1];
  // Genuine diversity by default: the seed tracks the state of the search.
  return ((last?.timestamp ?? 0) ^ (runs.length * 2654435761) ^ (epoch * 40503)) >>> 0;
}

/**
 * Build the intervention cohort for a stalled search.
 * Deterministic: the same runs/session/stall/config/seed yields a byte-identical plan.
 */
export function buildCohortPlan(
  runs: Run[],
  session: SessionSnapshot,
  stall: StallState,
  cfg: RsiConfig,
  // `codeDistance: null` is the honest "not in a git work tree" signal from codeDistanceFor(),
  // so it is accepted here and treated exactly like an absent distance.
  opts?: { seed?: number; epoch?: number; metrics?: MetricSpec[]; codeDistance?: CodeDistance | null },
): CohortPlan {
  const metrics = opts?.metrics ?? metricSpecs();
  if (metrics.length === 0) throw new Error("buildCohortPlan: metric set is empty");
  const metricNames = metrics.map((m) => m.name);
  const epoch = opts?.epoch ?? (stall.frontierRun === null ? 0 : improvementSteps(runs, session.direction).length);
  const seed = pickSeed(cfg, runs, session, epoch, opts);
  const rng = makeRng(seed);

  const rows = rowsFor(runs, session);
  const candidates = directionCandidates(metrics, session.direction);
  const cohort = Math.max(1, Math.min(cfg.cohortSize, candidates.length));
  const subsetSize = Math.max(1, Math.min(cfg.metricSubsetSize, metricNames.length));
  const portfolioSize = Math.max(1, Math.min(cfg.portfolioSize, candidates.length));
  // Lineage spread uses code distance when the caller supplies it (the effectful layer can);
  // otherwise it falls back to evenly spaced improvement epochs, which is still distinct.
  const lineages = selectLineages(
    runs,
    cohort,
    rng,
    opts?.codeDistance ?? undefined,
    session.direction,
  );

  const arms: CohortArm[] = [];
  for (let index = 0; index < cohort; index += 1) {
    const seen = sampleSubset(metricNames, subsetSize, rng);
    // cfg.temperature is the paper's verbalized-sampling sharpness knob; it must reach the
    // sampler, otherwise the config key is dead and the tail is never sharpened.
    const portfolio: DirectionArm[] = verbalizedSample(candidates, portfolioSize, rng, cfg.temperature);
    const lineage = lineages[index] ?? null;
    arms.push({
      index,
      metrics: seen,
      portfolio,
      lineage,
      unfold: pickUnfold(rows, lineage, Math.max(0, cfg.unfoldSize), rng),
    });
  }

  const plan: CohortPlan = {
    id: `rsi-${seed.toString(16)}-${epoch}-${arms.length}`,
    epoch,
    seed,
    createdAt: rows[rows.length - 1]?.timestamp ?? 0,
    stalledForMs: stall.stalledForMs,
    stalledForRuns: stall.stalledForRuns,
    frontier: stall.frontier,
    frontierRun: stall.frontierRun,
    arms,
  };
  return plan;
}

/**
 * Choose trajectories this arm may unfold: its lineage root first, then the nearest
 * *failed* or non-improving trajectories around it (the ones that explain the valley),
 * then the frontier run. Distinct, in a deterministic order.
 */
function pickUnfold(rows: DashboardRow[], lineage: number | null, k: number, rng: () => number): number[] {
  if (k <= 0 || rows.length === 0) return [];
  const byRun = new Map<number, number>();
  rows.forEach((row, i) => byRun.set(row.run, i));
  const chosen: number[] = [];
  const add = (run: number | null): void => {
    if (run === null || chosen.includes(run)) return;
    if (chosen.length < k) chosen.push(run);
  };
  add(lineage);
  const anchor = lineage === null ? rows.length - 1 : (byRun.get(lineage) ?? rows.length - 1);
  // Nearest non-improving trajectories: they describe the stall, not the success.
  for (let d = 1; d <= rows.length && chosen.length < k; d += 1) {
    for (const i of [anchor - d, anchor + d]) {
      const row = rows[i];
      if (row && row.status !== "keep") add(row.run);
    }
  }
  // Fallback: a random recent trajectory so an arm always has something to read.
  if (chosen.length < k) {
    const recent = rows.slice(Math.max(0, rows.length - 24)).map((r) => r.run);
    for (const run of sampleSubset(recent, recent.length, rng)) add(run);
  }
  return chosen;
}

/** Trajectories an arm is allowed to read (its unfold set, lineage first). */
export function unfoldRuns(runs: Run[], arm: CohortArm): Run[] {
  const wanted = new Set(arm.unfold);
  const picked = runs.filter((r) => wanted.has(r.run));
  if (arm.lineage !== null && !wanted.has(arm.lineage)) {
    const root = runs.find((r) => r.run === arm.lineage);
    if (root) picked.unshift(root);
  }
  return picked;
}

function pct(p: number): string {
  return `${(p * 100).toFixed(0)}%`;
}

/**
 * Render the steer text delivered to the agent. Hard cap: STEER_MAX_BYTES (8 KB), because
 * pi-autoresearch truncates hook stdout there. Degrades by dropping arm detail, never by
 * emitting a truncated sentence.
 */
export function renderSteer(
  plan: CohortPlan,
  runs: Run[],
  session: SessionSnapshot,
  stall: StallState,
  cfg: RsiConfig = DEFAULT_RSI_CONFIG,
): string {
  const metrics = metricSpecs();
  const rows = rowsFor(runs, session);
  const byRun = new Map<number, DashboardRow>();
  for (const row of rows) byRun.set(row.run, row);

  const staleness = stall.stalledForMs >= 60_000
    ? `${Math.round(stall.stalledForMs / 60_000)} min`
    : `${Math.round(stall.stalledForMs / 1000)} s`;

  const header: string[] = [];
  // "Stalled" is the observation; "collapsed" is a hypothesis. The RSI-top paper is explicit
  // that a stall alone does not establish exploration collapse — a search can be flat because
  // the problem is nearly solved, or because the evaluator is noisy. Saying "collapse likely"
  // states as fact something we cannot see, and an agent will believe it.
  header.push("## RSI-top: frontier stalled — exploring that as possible exploration collapse");
  header.push("");
  header.push(
    `Frontier ${plan.frontier === null ? "(none)" : formatNumber(plan.frontier)}${
      plan.frontierRun === null ? "" : ` (run ${plan.frontierRun})`
    } has not moved by >= ${cfg.stall.minGain} (${session.direction} is better) for ${staleness} of wall clock ` +
      `and ${stall.stalledForRuns} trajectories.`,
  );
  header.push("");
  header.push(
    `A stall is not proof of collapse — the run may be near its ceiling, or the metric may be ` +
      `noisy. It is a reason to diversify, not a diagnosis. One symptom would be proposals ` +
      `narrowing onto a single direction; if you can see that in your recent attempts, treat ` +
      `collapse as likely.`,
  );
  header.push("");
  header.push(
    `Either way, do not keep refining the current idea. Below are ${plan.arms.length} intervention arms, each with a different ` +
      `dashboard view, a probability-weighted portfolio of directions, and its own lineage. ` +
      `Propose one change per arm and run them in parallel; do not let the arms read the same trajectories.`,
  );
  header.push("");

  const detailBudget = STEER_MAX_BYTES - 900;
  const armBlocks = plan.arms.map((arm) => renderArm(arm, byRun, plan));
  let body = "";
  let rendered = 0;
  for (const block of armBlocks) {
    if (Buffer.byteLength(header.join("\n") + body + block, "utf8") > detailBudget) {
      body += `\n(_remaining arms omitted for size; see .auto/rsi/interventions.jsonl for the full plan ${plan.id}._)\n`;
      break;
    }
    body += block;
    rendered += 1;
  }
  // The header counts arms before the byte budget has dropped any. With a long history and a
  // large cohort it said "Below are 24 intervention arms" and then printed 2, which reads as
  // a bug in the tool rather than a size limit.
  if (rendered < plan.arms.length) {
    header[header.length - 2] = header[header.length - 2]!.replace(
      `Below are ${plan.arms.length} intervention arms`,
      `Below are ${rendered} of ${plan.arms.length} intervention arms`,
    );
  }

  const footer = [
    "",
    `Dashboard: .auto/rsi/dashboard.jsonl (one row per trajectory; ${metrics.length} metrics). ` +
      `Plan id ${plan.id} (seed ${plan.seed}, epoch ${plan.epoch}).`,
    `When you have proposals, record them and resume the normal search loop.`,
    "",
  ].join("\n");

  let out = header.join("\n") + body + footer;
  if (Buffer.byteLength(out, "utf8") > STEER_MAX_BYTES) {
    // Last resort: hard byte clamp on a code-point boundary.
    out = Buffer.from(out, "utf8").subarray(0, STEER_MAX_BYTES - 8).toString("utf8").replace(/\uFFFD+$/, "");
    out += "\n(_cut_)\n";
  }
  return out;
}

function renderArm(arm: CohortArm, byRun: Map<number, DashboardRow>, plan: CohortPlan): string {
  const lines: string[] = [];
  const root = arm.lineage === null ? null : byRun.get(arm.lineage);
  lines.push(`### Arm ${arm.index + 1}/${plan.arms.length}`);
  lines.push(
    `- Dashboard view (${arm.metrics.length} metrics): ${arm.metrics.join(", ")}`,
  );
  if (root) {
    lines.push(
      `- Lineage: run ${root.run} (${root.status}, metric ${formatNumber(root.metric)}, ${root.commit}) — ` +
        `ground your proposal in this trajectory's approach, not the frontier's.`,
    );
  } else {
    lines.push(`- Lineage: none (no improvement epochs yet) — ground your proposal in the current frontier.`);
  }
  const portfolio = arm.portfolio.map((d) => `${d.direction} ${pct(d.probability)}`).join(" | ");
  lines.push(`- Direction portfolio: ${portfolio}`);
  if (arm.unfold.length > 0) {
    const unfold = arm.unfold
      .map((run) => {
        const row = byRun.get(run);
        return row ? `run ${row.run} (${row.status}, metric ${formatNumber(row.metric)})` : `run ${run}`;
      })
      .join(", ");
    lines.push(`- Unfold only: ${unfold}`);
  }
  const sample = root ?? byRun.get(arm.unfold[0] ?? -1);
  if (sample) lines.push(`- Observed: ${describeRow(sample, arm.metrics)}`);
  lines.push("");
  return lines.join("\n");
}
