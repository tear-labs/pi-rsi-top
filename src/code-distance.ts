/**
 * Code-distance for the dashboard's `*_code_distance`, `nearest_history_similarity`, and
 * `window_redundancy_rate` metrics.
 *
 * The paper measures how far apart two trajectories' implementations are. There is no
 * universal way to do that, so this is an explicit, documented choice rather than a
 * pretence of precision:
 *
 *   1. If the two commits have the same tree hash, similarity is exactly 1 (no git diff
 *      needed — the identical case is also the one the metrics threshold at 0.99).
 *   2. Otherwise `git diff --numstat <a> <b>` yields the number of lines added and deleted.
 *      Similarity is `1 / (1 + changed)`: monotone, exactly 1 for identical trees, and it
 *      decays as more lines change. It is *not* calibrated to a percentage of the repo, so
 *      it orders trajectories by edit distance rather than reporting "37% different".
 *
 * Everything is memoized per instance, and any failure (not a git repo, unknown commit,
 * missing git binary) returns `null` — a metric that cannot be computed must read as
 * unknown, never as 0.
 */

import { execFileSync } from "node:child_process";

import type { CodeDistance } from "./types.ts";

const GIT_TIMEOUT_MS = 2_000;

/** Runs a git command in `cwd`, returning trimmed stdout or null on any failure. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** True when `cwd` is inside a git work tree. */
export function isGitWorkTree(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/**
 * Builds a memoized `CodeDistance` for commits in the repo containing `cwd`.
 * Returns `null` when `cwd` is not a git work tree, so callers can pass it straight
 * into `MetricContext` without special-casing.
 */
export function createGitCodeDistance(cwd: string): CodeDistance | null {
  if (!isGitWorkTree(cwd)) return null;

  const pairCache = new Map<string, number | null>();
  const treeCache = new Map<string, string | null>();

  /** Tree hash of a commit, or null when the commit is unknown. */
  const treeOf = (commit: string): string | null => {
    const cached = treeCache.get(commit);
    if (cached !== undefined) return cached;
    const tree = git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]);
    treeCache.set(commit, tree);
    return tree;
  };

  /** Lines added + deleted between two commits, or null when they cannot be diffed. */
  const changedLines = (a: string, b: string): number | null => {
    const out = git(cwd, ["diff", "--numstat", a, b]);
    if (out === null) return null;
    if (out === "") return 0;
    let total = 0;
    for (const line of out.split("\n")) {
      if (line.trim() === "") continue;
      const [added, deleted] = line.split("\t");
      // Binary files report "-" for both counts; they still differ, so count them as 1.
      const add = added === "-" ? 1 : Number(added);
      const del = deleted === "-" ? 1 : Number(deleted);
      if (!Number.isFinite(add) || !Number.isFinite(del)) return null;
      total += add + del;
    }
    return total;
  };

  return (commitA: string, commitB: string): number | null => {
    if (!commitA || !commitB) return null;
    if (commitA === commitB) return 1;

    const key = commitA < commitB ? `${commitA}..${commitB}` : `${commitB}..${commitA}`;
    const cached = pairCache.get(key);
    if (cached !== undefined) return cached;

    let similarity: number | null = null;
    const treeA = treeOf(commitA);
    const treeB = treeOf(commitB);
    if (treeA === null || treeB === null) {
      similarity = null;
    } else if (treeA === treeB) {
      similarity = 1;
    } else {
      const changed = changedLines(commitA, commitB);
      similarity = changed === null ? null : 1 / (1 + changed);
    }

    pairCache.set(key, similarity);
    return similarity;
  };
}