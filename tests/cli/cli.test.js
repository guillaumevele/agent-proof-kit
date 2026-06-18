import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/agent-proof.js");

test("prints help", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Deterministic release gates/);
});

test("verifies the safe fixture", () => {
  const result = runCli([
    "verify",
    "--input",
    "examples/synthetic-agent-run.json",
    "--policy",
    "policies/default-policy.json",
    "--format",
    "json"
  ]);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "pass");
  assert.equal(payload.score, 100);
});

test("returns a non-zero exit code for unsafe fixtures", () => {
  const result = runCli([
    "verify",
    "--input",
    "tests/fixtures/unsafe-agent-run.json",
    "--policy",
    "policies/default-policy.json"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL/);
});

test("scans a clean public directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-cli-clean-"));
  writeFileSync(join(dir, "README.md"), "Synthetic public file.\n");
  const result = runCli(["scan", "--path", dir, "--policy", "policies/default-policy.json"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PASS/);
});

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}
