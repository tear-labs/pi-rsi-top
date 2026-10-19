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

describe("the hook fails open", () => {
  function hook(payload: string): { code: number; stderr: string } {
    try {
      const stderr = execFileSync(process.execPath, [BIN, "hook", "before"], {
        input: payload,
        encoding: "utf8",
        cwd: "/tmp",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, stderr };
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      return { code: e.status ?? 1, stderr: e.stderr ?? "" };
    }
  }

  it("exits 0 on an unknown event", () => {
    // Throwing here would make the host report the *search* as broken.
    const r = hook(JSON.stringify({ event: "sideways" }));
    assert.equal(r.code, 0);
  });

  it("exits 0 on an unparseable payload", () => {
    assert.equal(hook("{not json").code, 0);
  });

  it("exits 0 on an empty payload", () => {
    assert.equal(hook("").code, 0);
  });

  it("exits 0 on a JSON array", () => {
    assert.equal(hook(JSON.stringify([1, 2, 3])).code, 0);
  });
});
