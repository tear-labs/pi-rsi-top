# pi-rsi-top

**RSI-top for `pi-autoresearch`**: a metric dashboard for your search history, a stall
monitor for your frontier, and diversity-controlled intervention cohorts that get a stalled
autoresearch run out of the valley it is stuck in.

An independent reimplementation of the method described in
[**RSI-top: Escaping exploration collapse in long-horizon autoresearch**](https://rsi-top.github.io/)
(Scaling Intelligence Lab, Stanford). That paper publishes a *method*, not code, so this
package is built from its published description — see
[Fidelity to the paper](#fidelity-to-the-paper) for exactly where it follows and where it
adapts.

```
$ rsi-top report --cwd ~/code/my-kernel-search
work dir     /home/lev/code/my-kernel-search
goal         Optimize the simulated-machine kernel
metric       cycles — lower is better
trajectories 46 (29 keep, 17 other)
baseline     1391   best 1198
dashboard    46 row(s) at .auto/rsi/dashboard.jsonl
frontier     1198 (run 42), epoch age 16
state        STALLED for 80 min — intervention recommended
```

## The problem it solves

Long autoresearch runs stall. Not because the model cannot improve, but because it stops
*trying anything else*: it keeps refining the same idea, and its own context keeps pulling
it back to that idea. The paper calls this **exploration collapse** and measures the
frontier as flat for **84–92%** of run wall-clock time.

The fix is not "try harder" and it is not "start over". It is to keep a compressed index of
every trajectory you have already run, and — when the frontier stops moving — launch a
cohort of agents that read *different* parts of that index and are pushed apart on purpose.
The `htop` analogy from the paper is the right one: nobody reads every log line to see what
a machine is doing. You get a dashboard, you scan it, then you open the two logs that
matter.

This package gives a `pi-autoresearch` run that dashboard.

## Install

```bash
pi install git:github.com/tear-labs/pi-rsi-top
```

That's it — one command, no npm publish, no build step. Pi clones the repo, installs
the extension, and adds it to `~/.pi/agent/settings.json`.

To try it for a single session without saving it:

```bash
pi -e git:github.com/tear-labs/pi-rsi-top
```

Then wire the hooks into a work dir:

```bash
cd ~/code/my-kernel-search
rsi-top init                     # writes .auto/rsi/config.json + .auto/hooks/{before,after}.sh
```

`rsi-top init` never overwrites an existing hook without `--force`.

## What it does on every iteration

`pi-autoresearch` runs `<workDir>/.auto/hooks/before.sh` before each iteration and
`after.sh` after it, piping a JSON payload on stdin and showing stdout (≤ 8 KB) to the
agent as a steer message.

| hook | what `pi-rsi-top` does |
| --- | --- |
| `after.sh` | **Scores the finished trajectory** into one dashboard row (background scoring — the paper's step 2). Silent, always. |
| `before.sh` | Refreshes the dashboard, asks the **stall monitor** whether the frontier is flat. Healthy run → prints nothing. Stalled run → prints the **intervention cohort** (arms, metric views, direction portfolios, lineages, trajectories to unfold) and records the plan. |

Two properties worth calling out, because they are what make it safe to install:

- **Silent unless stalled.** A healthy run sees no injected text at all, so the hook cannot
  perturb a search that is already working.
- **Fail-open.** A corrupt log, a missing file, or a bad payload yields no steer text and a
  zero exit code. It never fails the run it is attached to.

## The widget: the glance, always on screen

A dashboard you have to ask for is a dashboard nobody reads. When a run stalls, the
symptom is precisely that *it looks like it is working* — results keep landing, nothing
asks for help. So `pi-rsi-top` pins a bottom widget under the editor:

```
rsi-top │ cycles 1198 (run 42) │ STALLED 20m / 4 runs │ 46 runs, 29 keep │ epoch 4
last 24 ▸ ▁▂▃▄▅▅▆▇▇▇▇▇▇███████████
   40 keep              1199  ← 39         0
   41 keep              1199  ← 40         0
◆  42 discard           1198  ← 41         1
   43 keep              1198  ← 42         0
⚠ stall — /rsi-top intervene (or `pi-rsi-top intervene`) for a cohort
```

Three things make it worth the vertical space:

- **The sparkline inverts for `lower`-is-better metrics.** Glyph height always means
  *better*, never *numerically larger*, so cycles and val_bpb read the same way as
  accuracy. A flat window collapses to a row of identical blocks — which is the whole
  signal, visible without reading a number.
- **`◆` marks the run that set the frontier**, not every row sitting at the frontier
  value. After a 20-minute stall the last four rows are usually *all* equal to the best
  metric; flagging them all would say nothing about which trajectory got there first.
- **It repaints on `tool_result` and `turn_end`**, so it updates when `log_experiment`
  appends a trajectory and also when plain bash changes the log.

Rendered as a `string[]` rather than a component factory on purpose: factories are
**ignored in RPC mode**, which is how Pi Web drives the UI. A factory widget would be
invisible in the browser. This way the same renderer appears in the terminal and in
[Pi Web](https://github.com/agegr/pi-web).

```
/rsi-top hide             # this session only
/rsi-top show             # back on
```

Or from the environment, before launching pi:

```
RSI_TOP_WIDGET=0          # hide it everywhere
RSI_TOP_WIDGET_ROWS=0     # keep the status line, drop the trajectory table
```

## The dashboard

One row per trajectory, 24 metrics, written as newline-delimited JSON to
`.auto/rsi/dashboard.jsonl`. Read it with `rsi-top dashboard`:

```
$ rsi-top dashboard --cwd fixtures/stalled --limit 3
run  seg   status  metric  cycles  valid_attempt  parent_gain  frontier_relative_gap  ...
43     0     keep    1198    1198              1           0                    0  ...
44     0     keep    1198    1198              1           0                    0  ...
```

Metric families mirror the paper's table:

- **unary** — the trajectory on its own (`cycles`, `valid_attempt`, `recorded_change_count`).
- **binary** — against one reference: its parent, the frontier, or its nearest earlier
  state (`parent_gain`, `frontier_relative_gap`, `parent_code_distance`,
  `nearest_history_similarity`, `meaningful_relative_gain`, `gap_in_recent_step_units`, …).
- **region** — a trailing window of trajectories (`frontier_relative_spread`,
  `parent_selection_concentration`, `window_redundancy_rate`,
  `window_frontier_conversion_rate`, `dominant_failure_signature_mass`, …).
- **global** — the whole run (`seconds_since_meaningful_improvement`,
  `frontier_epoch_age_steps`, `best_descendant_metric`).

`null` means **not computable yet** (run 0 has no parent; a window of 1 has no spread) —
never `0`, never `NaN`. Confusing "zero" with "unknown" is how a dashboard starts lying.

Run `rsi-top metrics` for the full list with definitions.

## Stall detection

A stall is the paper's: **at least 20 minutes in which the best score improves by fewer
than 2 units**. Both are configurable, and both gates are respected literally — 20 minutes
*is* a stall, and a gain of exactly 2 *is* an improvement.

```jsonc
// .auto/rsi/config.json
{
  "enabled": true,
  "stall": {
    "minStallMs": 1200000,   // 20 min
    "minGain": 2,
    "ignoreFirstMs": 3600000, // ignore the first hour (the paper does)
    "minRuns": 12
  },
  "cohortSize": 4,
  "metricSubsetSize": 15,   // the paper's 15-of-25
  "portfolioSize": 5,
  "unfoldSize": 3,
  "temperature": 1,
  "seed": 0,                // 0 = derive a fresh seed per intervention
  "stateDir": ".auto/rsi"
}
```

`rsi-top check --json` prints the full `StallState` (frontier, frontier run, epoch age,
flat-for duration in ms and runs, and the reason it is *not* stalling).

## Diversity control

This is the paper's central contribution, so it is the part implemented most literally. On
a stall, the cohort's arms are pushed apart in **three independent ways**:

1. **Different dashboard view.** Each arm sees a different random subset of the metrics
   (`metricSubsetSize`, default 15 of 24). Arms that watch different signals rank the
   history differently, so they retrieve different trajectories and reach different
   conclusions.
2. **Verbalized probabilities.** Each arm proposes a *portfolio of directions* with
   probabilities, sampled **without replacement** and tail-sharpened — the rarer a
   direction, the more mass it gets. Probabilities are strictly positive and sum to 1.
   (Verbalized sampling, arXiv:2510.01171.)
3. **Different lineage.** Each arm is grounded in a different **epoch** of frontier
   improvement, chosen by greedy farthest-point sampling over improvement epochs, and may
   **unfold** only a small, arm-specific set of trajectories.

Everything is seeded. The same history, session, stall state, and config produce a
byte-identical plan — `rsi-top intervene --json` twice is the same JSON.

Sample steer (truncated):

```
## RSI-top: frontier stalled — exploration collapse likely

Frontier 1198 (run 42) has not moved by >= 2 (lower is better) for 80 min of wall clock
and 16 trajectories. Your recent proposals are probably narrowing onto one direction.

Do not keep refining the current idea. Below are 4 intervention arms, ...

### Arm 1/4
- Dashboard view (15 metrics): parent_gain, within_one_recent_step_rate, ...
- Lineage: run 45 (discard, metric 1198, abc013b) — ground your proposal in this
  trajectory's approach, not the frontier's.
- Direction portfolio: reduce cycles 44% | raise recorded_change_count 22% | ...
- Unfold only: run 45 (discard), run 42 (discard), run 39 (discard)
```

Steer text is hard-capped at the host's 8 KB stdout budget. When a cohort does not fit, it
drops whole arms and says so — it never emits a truncated sentence. The full plan is always
written to `.auto/rsi/interventions.jsonl`.

## CLI

```
rsi-top init        [--force]    create .auto/rsi/config.json and install the hooks
rsi-top score                    append dashboard rows for new trajectories
rsi-top dashboard   [--limit N] [--json]
rsi-top check       [--json]     print the stall state
rsi-top intervene   [--force] [--json]   build a cohort plan, print the steer
rsi-top report                   human summary of the run
rsi-top metrics                  list the 24 metrics
rsi-top hook <before|after>      read a hook payload on stdin (what the shims call)
```

Common flags: `--cwd DIR` (default `$PWD`), `--json`, `--force`.

## Fidelity to the paper

Faithful, deliberately:

- Background scoring of each finished trajectory into a compressed dashboard row, with
  selective *unfolding* of full trajectories rather than loading the whole history.
- Stall detection on the frontier with a wall-clock threshold and a minimum gain.
- The three-axis diversity control above, including the 15-metric random subset.
- Metric families (unary / binary / region / global) and the metric names from the paper's
  table where the underlying data exists.

Adapted, and why:

| Paper | Here | Why |
| --- | --- | --- |
| 25 metrics, designed per task by an LLM and compiled to scripts before the run | 24 hand-written metric specs, fixed | A task-specific metric-design step needs an LLM call at `init` time; this package keeps the runtime dependency-free (Node stdlib only). The 23 cover all four families. |
| Code distance from the actual implementations | `src/code-distance.ts` computes similarity as `1 / (1 + lines changed)` from `git diff --numstat`, exactly 1 for identical trees, memoized; `null` outside a git work tree | It orders trajectories by edit distance, which is what the lineage spread needs. It is not calibrated to "percent of the repo", and a run without commits honestly reports `null` rather than `0`. Metrics stay pure — distance is injected. |
| Interventions run proposals in parallel as their own trajectories | The steer text *asks* the agent to run one proposal per arm in parallel | The hook interface can steer, not fork. Parallel execution is the host's job (`pi-subagents` or similar). |
| Stall monitor runs continuously | Evaluated on each `before.sh` call | The host offers no timer; a per-iteration check has the same semantics and no background process. |

Two behaviours worth knowing that the paper does not specify:

- **Stale-log rule.** If the newest recorded run is more than 24 h old, the clock is pinned
  to that run. Without it, replaying an archived log months later would report every run as
  permanently stalled — including one whose final trajectory set a new frontier.
- **Fail-open hook.** Errors are reported on stderr; the steer channel stays empty.

## Tests

```bash
npm test          # node --test test/*.test.ts   (Node >= 22.6 strips types; no build step)
npm run typecheck # tsc --noEmit
```

The end-to-end tests spawn the **real** `hooks/before.sh` and `hooks/after.sh` against
committed fixtures — a 46-trajectory run with a deliberate 25-minute stall
(`fixtures/stalled`) and one that never stalls (`fixtures/healthy`) — and assert that the
healthy run produces *no* output, the stalled run produces a cohort with distinct metric
subsets and probabilities summing to 1, and `after.sh` is idempotent on replay.

Regenerate fixtures with `node fixtures/gen.mjs`. No network access; no runtime
dependencies.

## Layout

```
bin/rsi-top.mjs        CLI entry (Node >= 22.6, runs the .ts sources directly)
src/types.ts           shared types + defaults (frozen contract)
src/autoresearch.ts    parse .auto/log.jsonl -> Run[] + session snapshot
src/paths.ts           .auto/rsi/* paths, atomic JSON writes, JSONL append
src/metrics.ts         24 metric specs + per-row computation
src/code-distance.ts   git-backed CodeDistance (memoized), null outside a repo
src/dashboard.ts       build/read/append dashboard rows (idempotent)
src/frontier.ts        best-so-far series, meaningful-improvement steps, epochs
src/stall.ts           stall detection -> StallState
src/diversity.ts       seeded PRNG, metric-subset sampling, verbalized sampling, lineages
src/intervene.ts       CohortPlan + <= 8 KB steer text
src/hook.ts            before/after hook entry points
src/cli.ts             init | score | dashboard | check | intervene | report | metrics | hook
hooks/{before,after}.sh  shims installed into .auto/hooks/
```

## Prior art

The paper's own work is the method reference. Other systems have noticed the same collapse
and fixed it differently — Fork-and-Flush ("idea basins", forks into copies with empty
context), *Scaling Discovery Requires Forgetting* (periodic resets from the best candidate),
and Anthropic's Memento harness (fixed-timeout restarts with a short note). Those reset the
conversation and carry forward the workspace. This one keeps a structured index instead, so
an agent can choose what to remember.

## License

MIT.