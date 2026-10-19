/**
 * CLI argument handling.
 *
 * These started as a bug report against myself: `rsi-top --help` printed a *report* about
 * the current directory instead of the usage text, because `--help` parsed as a valueless
 * flag, the command defaulted to `report`, and the help branch never ran.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import * as path from "node:path";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "rsi-top.mjs");

function run(args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: "/tmp" });
}

describe("cli help", () => {
  it("prints usage for --help", () => {
    const out = run(["--help"]);
    assert.match(out, /Usage:/);
    assert.match(out, /rsi-top init/);
  });

  it("prints usage for -h", () => {
    assert.match(run(["-h"]), /Usage:/);
  });

  it("prints usage for the help subcommand", () => {
    assert.match(run(["help"]), /Usage:/);
  });

  it("does not emit a report when asked for help", () => {
    const out = run(["--help"]);
    // A report starts with this line; the usage text never does.
    assert.ok(!out.startsWith("work dir"), `help leaked a report:\n${out}`);
  });

  it("still reports when given no arguments at all", () => {
    assert.match(run([]), /work dir/);
  });

  it("exits non-zero on an unknown command", () => {
    assert.throws(() => run(["definitely-not-a-command"]));
  });
});
