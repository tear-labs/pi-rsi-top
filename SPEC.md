# rsi-top — implementation contract

Faithful, minimal reimplementation of the **RSI-top** method (Scaling Intelligence Lab,
Stanford; <https://rsi-top.github.io/>) as a Pi package that plugs into
`pi-autoresearch`'s hook system. No RSI-top source is public; this is built from the
published method description.

## What RSI-top is (from the page, verbatim claims)

- Long autoresearch runs suffer **exploration collapse**: proposals narrow onto one
  direction while the frontier stalls. In their runs the frontier is stalled **84%–92%**
  of wall-clock time.
- `htop` analogy: compress each trajectory into a **metric dashboard row** so agents can
  scan/sort/compare without loading trajectories; **unfold** (retrieve) only the few
  trajectories worth reading.
- Two stages: **(1)** before the run, metrics are designed and compiled to scripts;
  **(2)** during the run, each finished trajectory is scored in the background.
- **Stall detection**: a monitor watches the frontier. A stall is e.g. "at least 20
  minutes in which the best score improves by fewer than 2 cycles".
- **Intervention** on stall: pause native search, launch a **cohort** of agents, each
  - receives a **different random subset of the dashboard metrics** (default **15 of 25**),
  - proposes a **portfolio of directions with verbalized probabilities**,
  - is grounded in a **different lineage** of the shared search history,
  - **unfolds** only the trajectories it decides to read,
  then all proposals run **in parallel** and the native search resumes.
- Metric families: **unary** (trajectory alone), **binary** (trajectory vs parent /
  frontier / nearest earlier state), **region** (recent window), **global** (whole run).

## Host: pi-autoresearch hook contract (read from installed source, v-installed)

Host contract: `pi-autoresearch`'s hook runner (`extensions/pi-autoresearch/hooks.ts` in that
package). The shims in `hooks/` are written against its stdin envelope, 8 KB stdout budget,
and 30 s timeout; `src/hook.test.ts`-level coverage of the envelope lives in `test/e2e.test.ts`.

- `hooks.ts`: spawns `bash <cwd>/.auto/hooks/before.sh` (or `after.sh`), cwd = work dir,
  **30 s hard timeout**, stdout **≤ 8 KB** delivered to the agent as a **steer message**,
  empty stdout = silent, stderr + non-zero exit = error steer. Script must be executable.
- `paths.ts`: `.auto/{log.jsonl,prompt.md,ideas.md,checks.sh,measure.sh,config.json}`,
  hooks in `.auto/hooks/`. Entire `.auto/` survives auto-revert.
- `jsonl.ts` entry shapes:
  - config: `{"type":"config","name","metricName","metricUnit","bestDirection":"lower"|"higher"}`
  - run: `{"run":n,"commit":"abcdefg","metric":n,"metrics":{name:number},
    "status":"keep"|"discard"|"crash"|"checks_failed","description","timestamp",
    "segment":n,"confidence":number|null,"asi":{...}}`
- `before.sh` stdin: `{event:"before",cwd,next_run,last_run|null,session:{metric_name,
  metric_unit,direction,baseline_metric,best_metric,run_count,goal}}`
- `after.sh` stdin: `{event:"after",cwd,run_entry,session:{...same...}}`
- There is **no parent field** in run entries. Parentage must be inferred (see below).

## Architecture

```
bin/rsi-top.mjs          thin CLI entry (node >=22.6, runs TS directly)
src/types.ts             ALL shared types + DEFAULT_RSI_CONFIG   [OWNER: parent, frozen]
src/autoresearch.ts      parse .auto/log.jsonl -> Run[] + SessionSnapshot  [lane D]
src/paths.ts             .auto/rsi/* path helpers + atomic JSONL append   [lane D]
src/metrics.ts           metric registry (23 specs) + per-row compute      [lane A]
src/dashboard.ts         score trajectories -> DashboardRow, read/write dashboard.jsonl [lane A]
src/frontier.ts          best-so-far series, meaningful-improvement steps, epochs [lane B]
src/stall.ts             StallConfig -> StallState (stall detection)       [lane B]
src/diversity.ts         seeded PRNG, metric-subset sampling, verbalized-probability
                         direction portfolios, lineage-root selection      [lane C]
src/intervene.ts         CohortPlan + <=8KB steer text                     [lane C+E? -> lane E]
src/hook.ts              before/after hook payload -> stdout steer (SSOT) [lane D]
src/cli.ts               init|score|dashboard|check|intervene|install-hooks|report [lane E]
hooks/before.sh          shim -> node bin/rsi-top.mjs hook before          [lane E]
hooks/after.sh           shim -> node bin/rsi-top.mjs hook after           [lane E]
```

Rule: **one owner per file.** Never edit a file owned by another lane. Import only from
`src/types.ts` and your own files; if a lane needs another lane's function, code against
the signature in this spec and let the parent wire it.

## Interface signatures (frozen — no deviation without telling the parent)

```ts
// src/autoresearch.ts
export function parseLog(text: string): { runs: Run[]; session: SessionSnapshot };
export function readSession(workDir: string): { runs: Run[]; session: SessionSnapshot };
export function toHookSession(s: SessionSnapshot): HookSessionSnapshot;

// src/metrics.ts
export function metricSpecs(): MetricSpec[];                 // all 24, stable order
export function computeRowValues(history: Run[], index: number, ctx?: Partial<MetricContext>): Record<string, number | null>;

// src/dashboard.ts
export function buildRows(runs: Run[], session: SessionSnapshot, ctx?: Partial<MetricContext>): DashboardRow[];
export function appendRows(dashboardPath: string, rows: DashboardRow[]): void;  // idempotent by run#+segment
export function readRows(dashboardPath: string): DashboardRow[];
export function scoreAndAppend(workDir: string, runs: Run[], session: SessionSnapshot): DashboardRow[]; // returns newly appended rows

// src/frontier.ts
export interface FrontierPoint { run: number; metric: number; timestamp: number; segment: number; }
export function frontierSeries(runs: Run[], direction: "lower" | "higher"): FrontierPoint[];
export function improvementSteps(runs: Run[], direction: "lower" | "higher"): FrontierPoint[]; // strictly-improving points only
export function lastMeaningfulImprovement(runs: Run[], direction: "lower"|"higher", minGain: number): FrontierPoint | null;
export function frontierEpochAge(runs: Run[], direction: "lower"|"higher", minGain: number): number;

// src/stall.ts
export function detectStall(runs: Run[], session: SessionSnapshot, cfg?: StallConfig, now?: number): StallState;

// src/diversity.ts
export function makeRng(seed: number): () => number;                        // mulberry32, deterministic
export function sampleSubset<T>(items: T[], k: number, rng: () => number): T[];
export function verbalizedSample(directions: string[], k: number, rng: () => number): DirectionArm[]; // weights sum to 1, distinct
export function selectLineages(runs: Run[], arms: number, rng: () => number, codeDistance?: CodeDistance): number[];

// src/intervene.ts
export function buildCohortPlan(runs: Run[], session: SessionSnapshot, stall: StallState, cfg: RsiConfig, opts?: { seed?: number; epoch?: number; metrics?: MetricSpec[] }): CohortPlan;
export function renderSteer(plan: CohortPlan, runs: Run[], session: SessionSnapshot, stall: StallState): string; // MUST be <= 8192 bytes
export function unfoldRuns(runs: Run[], arm: CohortArm): Run[];

// src/hook.ts
export function handleBefore(payload: BeforeHookPayload, workDir: string): string; // stdout text ("" = silent)
export function handleAfter(payload: AfterHookPayload, workDir: string): string;
```

## Metric set (23, adapted from the paper's table of 25)

Kind `unary`: `cycles` (primary metric), `valid_attempt`, `recorded_change_count`.
Kind `binary`: `parent_gain`, `frontier_relative_gap`, `parent_code_distance`,
`frontier_code_distance`, `nearest_history_similarity`, `meaningful_relative_gain`,
`gap_in_recent_step_units`.
Kind `region` (default window = 12 trajectories): `frontier_relative_spread`,
`root_relative_spread`, `parent_selection_concentration`, `window_frontier_gain`,
`window_redundancy_rate`, `window_valid_rate`, `window_frontier_conversion_rate`,
`within_one_recent_step_rate`, `dominant_failure_signature_mass`, `repeated_failure_rate`.
Kind `global`: `seconds_since_meaningful_improvement`, `frontier_epoch_age_steps`,
`best_descendant_metric`.

Sign convention: every metric is **"higher is better unless documented otherwise"** or
explicitly documented in `MetricSpec.description`; distance/gap metrics are reported raw
and documented as "lower is better". `null` = not computable yet (e.g. run 0 has no
parent) — never `0` or `NaN`.

`parent_code_distance` / `frontier_code_distance` / `nearest_history_similarity` need a
`CodeDistance` function `(commitA: string, commitB: string) => number` in `0..1`
(1 = identical). Default implementation shells out to
`git diff --numstat <a> <b>` (added+deleted lines over total lines, clamped) and must be
**injectable** so tests never touch git. If unavailable → `null`.

`recorded_change_count`: from `asi` when present (`asi.revisits_run`, `asi.hypothesis`,
description length proxy) else `null`; document clearly.

## Diversity control (the part that must be faithful)

`sampleSubset`: uniform random k-of-n without replacement, driven by `makeRng(seed)`.
`verbalizedSample`: verbalized sampling over directions — draw k **distinct** directions,
weight each by `exp(log(share)/temperature)`-style renormalization; weights returned must
be positive and sum to 1 within 1e-9. Assert distinctness.
`selectLineages`: pick `arms` distinct run numbers spread across improvement epochs, prefer
*maximal distance* roots (greedy farthest-point over `codeDistance`, falling back to
epoch spread when the distance fn is absent).

## Acceptance criteria (the "make sure it works" bar)

1. `npm test` — `node --test test/*.test.ts` — green, ≥ 45 assertions across the 5 lanes.
2. `npm run typecheck` — `tsc --noEmit` — zero errors.
3. Determinism: same seed → byte-identical `CohortPlan` JSON.
4. `renderSteer` output ≤ 8192 bytes even with a 500-run history.
5. **End-to-end**: a fixture work dir with a realistic `.auto/log.jsonl` (≥ 40 runs,
   including a deliberate 25-minute stall) piped through the real
   `hooks/before.sh` and `hooks/after.sh` as executable scripts, asserting:
   - healthy run → silent (empty stdout);
   - stalled run → steer naming N arms, distinct metric subsets, probabilities summing to 1;
   - `after.sh` appends exactly one dashboard row and is idempotent on replay.
6. No network, no new runtime dependencies (Node stdlib only). TypeScript dev-only.

## Style

- Terse JSDoc on exports. No `any`. No `as` casts except narrowly with a comment.
- Pure functions in `src/`, side effects only in `dashboard.ts`, `paths.ts`, `cli.ts`.
- Errors: return `null`/throw `Error` with actionable messages; never silently swallow.
- Every file starts with a 1–3 line doc comment naming the paper concept it implements.
