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

test("validates run and policy fixtures", () => {
  const result = runCli([
    "validate",
    "--input",
    "examples/synthetic-agent-run.json",
    "--policy",
    "policies/default-policy.json",
    "--format",
    "json"
  ]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "pass");
});

test("normalizes JSONL traces", () => {
  const result = runCli(["normalize", "--input", "examples/synthetic-agent-events.jsonl"]);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runId, "normalized-demo-run-001");
});

test("diff returns a non-zero exit code for regressions", () => {
  const result = runCli([
    "diff",
    "--base",
    "examples/synthetic-agent-run.json",
    "--candidate",
    "examples/synthetic-agent-run-regression.json",
    "--policy",
    "policies/default-policy.json"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL/);
});

test("emits SARIF for unsafe verification", () => {
  const result = runCli([
    "verify",
    "--input",
    "examples/synthetic-agent-run-regression.json",
    "--policy",
    "policies/default-policy.json",
    "--format",
    "sarif"
  ]);
  assert.equal(result.status, 1);
  const sarif = JSON.parse(result.stdout);
  assert.equal(sarif.version, "2.1.0");
  assert.ok(sarif.runs[0].results.length > 0);
});

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}
