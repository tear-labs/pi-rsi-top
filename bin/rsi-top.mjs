#!/usr/bin/env node
/**
 * Thin CLI shim. Node >= 22.6 strips TypeScript types at runtime, so the `.ts` sources in
 * `src/` are executed directly — no build step, no bundler, no dependencies.
 */
import process from "node:process";

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1] ?? 0);
if (major < 22 || (major === 22 && minor < 6)) {
  process.stderr.write(
    `rsi-top needs Node >= 22.6 (type stripping); found ${process.version}.\n`,
  );
  process.exit(1);
}

const { main } = await import("../src/cli.ts");
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`rsi-top: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
