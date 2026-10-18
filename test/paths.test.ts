import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import {
  appendJsonl,
  autoDir,
  configPath,
  dashboardPath,
  ensureDir,
  logPath,
  plansPath,
  readJsonFile,
  resolveWorkDir,
  rsiDir,
  writeJsonAtomic,
} from "../src/paths.ts";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveWorkDir", () => {
  it("returns an absolute directory path", () => {
    const dir = mkTmp();
    const resolved = resolveWorkDir(dir);
    assert.equal(path.isAbsolute(resolved), true);
    assert.equal(fs.realpathSync(resolved), fs.realpathSync(dir));
  });

  it("resolves relative paths against cwd", () => {
    const rel = path.relative(process.cwd(), mkTmp());
    assert.equal(resolveWorkDir(rel), path.resolve(rel));
  });

  it("throws an actionable error for a missing directory", () => {
    const missing = path.join(mkTmp(), "nope");
    assert.throws(() => resolveWorkDir(missing), /does not exist/);
  });

  it("throws for a file path", () => {
    const dir = mkTmp();
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    assert.throws(() => resolveWorkDir(file), /not a directory/);
  });
});

describe("layout paths", () => {
  it("defaults to .auto/log.jsonl with no layout on disk", () => {
    const dir = mkTmp();
    assert.equal(logPath(dir), path.join(dir, ".auto", "log.jsonl"));
  });

  it("returns .auto/log.jsonl when the current layout exists", () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".auto", "prompt.md"), "p");
    assert.equal(logPath(dir), path.join(dir, ".auto", "log.jsonl"));
  });

  it("falls back to a legacy flat autoresearch.jsonl", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "autoresearch.jsonl"), "");
    assert.equal(logPath(dir), path.join(dir, "autoresearch.jsonl"));
  });

  it("prefers the current layout over a stale legacy file", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "autoresearch.jsonl"), "");
    fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), "");
    assert.equal(logPath(dir), path.join(dir, ".auto", "log.jsonl"));
  });

  it("treats an existing .auto/hooks dir as the current layout", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "autoresearch.jsonl"), "");
    fs.mkdirSync(path.join(dir, ".auto", "hooks"), { recursive: true });
    assert.equal(logPath(dir), path.join(dir, ".auto", "log.jsonl"));
  });

  it("builds .auto and rsi paths", () => {
    const dir = mkTmp();
    assert.equal(autoDir(dir), path.join(dir, ".auto"));
    assert.equal(rsiDir(dir), path.join(dir, ".auto", "rsi"));
    assert.equal(dashboardPath(dir), path.join(dir, ".auto", "rsi", "dashboard.jsonl"));
    assert.equal(plansPath(dir), path.join(dir, ".auto", "rsi", "interventions.jsonl"));
    assert.equal(configPath(dir), path.join(dir, ".auto", "rsi", "config.json"));
  });

  it("honours a custom stateDir, relative to the work dir", () => {
    const dir = mkTmp();
    assert.equal(rsiDir(dir, "state"), path.join(dir, "state"));
    assert.equal(dashboardPath(dir, "state"), path.join(dir, "state", "dashboard.jsonl"));
    assert.equal(configPath(dir, "custom/x"), path.join(dir, "custom", "x", "config.json"));
  });
});

describe("ensureDir", () => {
  it("creates nested directories and is idempotent", () => {
    const dir = mkTmp();
    const nested = path.join(dir, "a", "b", "c");
    ensureDir(nested);
    assert.equal(fs.statSync(nested).isDirectory(), true);
    ensureDir(nested);
    assert.equal(fs.statSync(nested).isDirectory(), true);
  });
});

describe("readJsonFile", () => {
  it("returns the fallback when the file is missing", () => {
    const dir = mkTmp();
    assert.deepEqual(readJsonFile(path.join(dir, "x.json"), { a: 1 }), { a: 1 });
  });

  it("returns the fallback for invalid JSON", () => {
    const dir = mkTmp();
    const file = path.join(dir, "x.json");
    fs.writeFileSync(file, "{ not json");
    assert.equal(readJsonFile(file, "fallback"), "fallback");
  });

  it("returns the fallback for JSON null", () => {
    const dir = mkTmp();
    const file = path.join(dir, "x.json");
    fs.writeFileSync(file, "null");
    assert.equal(readJsonFile(file, 7), 7);
  });

  it("returns parsed content when valid", () => {
    const dir = mkTmp();
    const file = path.join(dir, "x.json");
    fs.writeFileSync(file, JSON.stringify({ cohortSize: 4 }));
    const got = readJsonFile<{ cohortSize: number }>(file, { cohortSize: 0 });
    assert.equal(got.cohortSize, 4);
  });
});

describe("writeJsonAtomic", () => {
  it("writes JSON and leaves no .tmp file behind", () => {
    const dir = mkTmp();
    const file = path.join(dir, "deep", "state.json");
    writeJsonAtomic(file, { ok: true, n: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { ok: true, n: 2 });
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("overwrites an existing file atomically", () => {
    const dir = mkTmp();
    const file = path.join(dir, "s.json");
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).v, 2);
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
    );
  });

  it("cleans up tmp file on write failure", () => {
    const dir = mkTmp();
    const file = path.join(dir, "bad.json");
    // Object with circular reference throws on JSON.stringify
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    assert.throws(() => writeJsonAtomic(file, circular));
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

describe("appendJsonl", () => {
  it("creates nested directories and writes one JSON object per line", () => {
    const dir = mkTmp();
    const file = path.join(dir, "a", "b", "rows.jsonl");
    appendJsonl(file, [{ run: 1 }, { run: 2 }]);
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), { run: 1 });
    assert.deepEqual(JSON.parse(lines[1]!), { run: 2 });
  });

  it("appends rather than truncating across calls", () => {
    const dir = mkTmp();
    const file = path.join(dir, "rows.jsonl");
    appendJsonl(file, [{ run: 1 }]);
    appendJsonl(file, [{ run: 2 }]);
    const lines = fs.readFileSync(file, "utf-8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
  });

  it("is a no-op for an empty array", () => {
    const dir = mkTmp();
    const file = path.join(dir, "rows.jsonl");
    appendJsonl(file, []);
    assert.equal(fs.existsSync(file), false);
  });
});
