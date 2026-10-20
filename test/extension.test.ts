/**
 * Widget visibility reporting.
 *
 * Regression suite for a bug the user hit in practice: `/rsi-top show` replied "widget
 * shown" in a directory with no autoresearch log, while the extension was simultaneously
 * calling `setWidget(key, undefined)` to *clear* it. The reply was a lie, and the widget's
 * silence was indistinguishable from a broken extension.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import extension, { compact, resetWidgetState } from "../src/extension.ts";

const tmpDirs: string[] = [];

function mkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-top-ext-"));
  tmpDirs.push(dir);
  return dir;
}

/** A directory containing a real, parseable autoresearch log with one kept run. */
function writeLog(dir: string, runs = 3): void {
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  const lines: string[] = [
    JSON.stringify({
      type: "config",
      name: "t",
      metricName: "nll",
      metricUnit: "",
      bestDirection: "lower",
    }),
  ];
  for (let i = 1; i <= runs; i += 1) {
    lines.push(
      JSON.stringify({
        run: i,
        commit: `c${i}`,
        metric: 2 - i * 0.1,
        status: "keep",
        description: "d",
        timestamp: 1_700_000_000_000 + i * 60_000,
      }),
    );
  }
  fs.writeFileSync(path.join(dir, ".auto", "log.jsonl"), `${lines.join("\n")}\n`);
}

function emptyDir(): string {
  const dir = mkdir();
  fs.mkdirSync(path.join(dir, ".auto"), { recursive: true });
  return dir;
}

/** Minimal ExtensionAPI stand-in: records commands and events so they can be invoked. */
function fakePi(): {
  pi: Parameters<typeof extension>[0];
  commands: Map<string, (args: string, ctx: FakeCtx) => Promise<void>>;
  events: Map<string, (event: unknown, ctx: FakeCtx) => Promise<void>>;
} {
  const commands = new Map<string, (args: string, ctx: FakeCtx) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: FakeCtx) => Promise<void>>();
  const pi = {
    registerTool: () => {},
    registerCommand: (name: string, spec: { handler: (a: string, c: FakeCtx) => Promise<void> }) => {
      commands.set(name, spec.handler);
    },
    on: (name: string, handler: (e: unknown, c: FakeCtx) => Promise<void>) => {
      events.set(name, handler);
    },
    sendUserMessage: () => {},
  } as unknown as Parameters<typeof extension>[0];
  return { pi, commands, events };
}

interface FakeCtx {
  mode: "tui" | "rpc";
  cwd: string;
  ui: {
    setWidget: (key: string, lines: string[] | undefined, opts?: unknown) => void;
    notify: (message: string, level?: string) => void;
  };
  widgets: Map<string, string[] | undefined>;
  notices: string[];
}

function fakeCtx(cwd: string, mode: "tui" | "rpc" = "rpc"): FakeCtx {
  const widgets = new Map<string, string[] | undefined>();
  const notices: string[] = [];
  return {
    mode,
    cwd,
    widgets,
    notices,
    ui: {
      setWidget: (key, lines) => {
        widgets.set(key, lines);
      },
      notify: (message) => {
        notices.push(message);
      },
    },
  };
}

/** The extension reads `process.cwd()`; point it at a test dir for the duration of a call. */
function inDir<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

/**
 * Visibility and work dir are module state that deliberately outlives one event, so every
 * test has to start from the same place: otherwise the `hide` test switches the widget off
 * for whatever runs after it.
 */
function setUp(): { pi: Parameters<typeof extension>[0]; commands: ReturnType<typeof fakePi>["commands"]; events: ReturnType<typeof fakePi>["events"] } {
  resetWidgetState();
  const { pi, commands, events } = fakePi();
  extension(pi);
  return { pi, commands, events };
}

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("/rsi-top show", () => {
  it("draws the widget when the cwd has a log", () => {
    const { commands } = setUp();
    const dir = mkdir();
    writeLog(dir);
    const ctx = fakeCtx(dir);
    inDir(dir, () => commands.get("rsi-top")?.("show", ctx));
    const lines = ctx.widgets.get("rsi-top");
    assert.ok(Array.isArray(lines) && lines.length > 0, `expected widget lines, got ${lines}`);
    assert.match(String(lines[0]), /nll/);
  });

  it("says NOT shown when the cwd has no log, instead of claiming success", () => {
    const { commands } = setUp();
    const dir = emptyDir();
    const ctx = fakeCtx(dir);
    inDir(dir, () => commands.get("rsi-top")?.("show", ctx));
    assert.equal(ctx.widgets.get("rsi-top"), undefined);
    const notice = ctx.notices.join("\n");
    assert.match(notice, /NOT shown/);
    assert.match(notice, /no autoresearch log/);
    // The message must name the directory it looked in, otherwise the user cannot act on it.
    assert.ok(notice.includes(dir), `notice should name ${dir}: ${notice}`);
  });

  it("hides the widget on `hide`", () => {
    const { commands } = setUp();
    const dir = mkdir();
    writeLog(dir);
    const ctx = fakeCtx(dir);
    inDir(dir, () => {
      commands.get("rsi-top")?.("show", ctx);
      commands.get("rsi-top")?.("hide", ctx);
    });
    assert.equal(ctx.widgets.get("rsi-top"), undefined);
  });
});

describe("session_start", () => {
  it("explains the empty widget once when there is no log", async () => {
    const { events } = setUp();
    const dir = emptyDir();
    const ctx = fakeCtx(dir);
    await inDir(dir, () => events.get("session_start")?.({}, ctx));
    assert.match(ctx.notices.join("\n"), /rsi-top: idle — no autoresearch log/);
  });

  it("stays quiet when the log exists", async () => {
    const { events } = setUp();
    const dir = mkdir();
    writeLog(dir);
    const ctx = fakeCtx(dir);
    await inDir(dir, () => events.get("session_start")?.({}, ctx));
    assert.deepEqual(ctx.notices, []);
  });
});

describe("compact (Pi Web shape)", () => {
  it("keeps the status and sparkline and drops the table", () => {
    const out = compact([
      "rsi-top │ nll 1.5 (run 3) │ ok · flat 0s │ 3 runs, 3 keep │ epoch 3",
      "last 3 ▸ █▅▂",
      "◆  1 keep     1.900",
      "   2 keep     1.800",
      "   3 keep     1.700",
    ]);
    assert.equal(out.length, 2);
    // Pi Web prints the key as a heading, so the prefix is redundant there.
    assert.equal(out[0], "nll 1.5 (run 3) │ ok · flat 0s │ 3 runs, 3 keep │ epoch 3");
    assert.equal(out[1], "last 3 ▸ █▅▂");
  });

  it("promotes a stall warning into the third line", () => {
    const out = compact([
      "rsi-top │ nll 1.5 (run 3) │ STALLED 20m / 4 runs │ 3 runs, 3 keep │ epoch 3",
      "last 3 ▸ ▁▁▁",
      "   3 keep     1.500",
      "⚠ stall — /rsi-top intervene",
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[2], "⚠ stall — /rsi-top intervene");
  });

  it("never exceeds Pi Web's auto-open ceiling of 3 lines", () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    assert.ok(compact(many).length <= 3);
  });
});
