// Runs every test-*.mjs in the repo root and exits non-zero if any failed.
//
// Not a test framework (see SPEC §9.2) — just a loop. Each test is a
// plain script that throws on a failed assertion, so "did it pass" is exactly
// "did it exit 0". Every test runs even after one fails, so a change that
// breaks several shows all of them in one go rather than one per re-run.
//
// Tests are discovered rather than listed, so a new test-*.mjs is picked up
// without also having to be registered here — the old failure mode where the
// wired-up suite and the actual suite drifted apart.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");
const tests = readdirSync(testsDir).filter((f) => /^test-.*\.mjs$/.test(f)).sort();

if (!tests.length) {
  console.error("No test-*.mjs files found — that is itself a failure.");
  process.exit(1);
}

const failed = [];
for (const test of tests) {
  const started = Date.now();
  const { status } = spawnSync(process.execPath, [test], { cwd: testsDir, stdio: "inherit" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (status !== 0) {
    failed.push(test);
    console.error(`✗ ${test} exited ${status} after ${secs}s\n`);
  }
}

console.log(
  failed.length
    ? `\n${failed.length} of ${tests.length} suites failed: ${failed.join(", ")}`
    : `\nAll ${tests.length} suites passed.`
);
process.exit(failed.length ? 1 : 0);
