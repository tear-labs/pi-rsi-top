/**
 * Work-dir and state path resolution for rsi-top (RSI-top infrastructure).
 *
 * Mirrors pi-autoresearch's file-layout rule: the `.auto/` folder is current,
 * the flat `autoresearch.*` files are legacy read-only fallbacks.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { RsiConfig } from "./types.ts";
import { DEFAULT_RSI_CONFIG } from "./types.ts";

const AUTO_DIR = ".auto";
const DEFAULT_STATE_DIR: string = DEFAULT_RSI_CONFIG.stateDir;

/** Current-layout session files; any one of them means "we are on the `.auto/` layout". */
const CURRENT_SESSION_FILES = [
  "log.jsonl",
  "prompt.md",
  "ideas.md",
  "checks.sh",
  "measure.sh",
  "config.json",
] as const;

const LEGACY_LOG_FILE = "autoresearch.jsonl";

/** Resolve the work dir to an absolute path, failing loudly when it is not a directory. */
export function resolveWorkDir(cwd: string): string {
  const abs = path.resolve(cwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(
      `rsi-top: work dir "${abs}" does not exist. Run \`rsi-top init\` there, or pass a real directory.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`rsi-top: work dir "${abs}" is not a directory.`);
  }
  return abs;
}

/** `<workDir>/.auto`. */
export function autoDir(workDir: string): string {
  return path.join(path.resolve(workDir), AUTO_DIR);
}

function resolveStateDir(workDir: string, stateDir?: string): string {
  const rel = stateDir ?? DEFAULT_STATE_DIR;
  return path.resolve(workDir, rel);
}

/** `<workDir>/<stateDir>` with `stateDir` defaulting to `.auto/rsi`. */
export function rsiDir(workDir: string, stateDir?: string): string {
  return resolveStateDir(workDir, stateDir);
}

/** Host layout rule: any current `.auto/` artifact wins, else a legacy flat log. */
function currentLayoutExists(workDir: string): boolean {
  const auto = autoDir(workDir);
  for (const file of CURRENT_SESSION_FILES) {
    if (fs.existsSync(path.join(auto, file))) return true;
  }
  return fs.existsSync(path.join(auto, "hooks"));
}

/** Effective log path: `.auto/log.jsonl`, or the legacy `autoresearch.jsonl` when only it exists. */
export function logPath(workDir: string): string {
  const current = path.join(autoDir(workDir), "log.jsonl");
  if (currentLayoutExists(workDir)) return current;
  const legacy = path.join(path.resolve(workDir), LEGACY_LOG_FILE);
  return fs.existsSync(legacy) ? legacy : current;
}

/** `<stateDir>/dashboard.jsonl`. */
export function dashboardPath(workDir: string, stateDir?: string): string {
  return path.join(resolveStateDir(workDir, stateDir), "dashboard.jsonl");
}

/** `<stateDir>/interventions.jsonl`. */
export function plansPath(workDir: string, stateDir?: string): string {
  return path.join(resolveStateDir(workDir, stateDir), "interventions.jsonl");
}

/** `<stateDir>/config.json`. */
export function configPath(workDir: string, stateDir?: string): string {
  return path.join(resolveStateDir(workDir, stateDir), "config.json");
}

/** `mkdir -p` for a directory path. */
export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Read JSON, falling back on any read/parse error. Tolerant by design. */
export function readJsonFile<T>(p: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Write JSON via a sibling temp file + rename, so readers never see a partial file. */
export function writeJsonAtomic(p: string, value: unknown): void {
  const dir = path.dirname(p);
  ensureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(p)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup; the original error is the one worth reporting
    }
    throw err;
  }
}

/** Append values as one JSON object per line, creating parent directories first. */
export function appendJsonl(p: string, values: unknown[]): void {
  if (values.length === 0) return;
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, values.map((v) => JSON.stringify(v)).join("\n") + "\n", "utf-8");
}
