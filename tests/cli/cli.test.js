import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/agent-proof.js");
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

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

test("compiles YAML policy DSL", () => {
  const result = runCli([
    "compile-policy",
    "--input",
    "examples/policies/strict-corporate-policy.yaml"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, "example-strict-corporate-yaml-policy");
  assert.equal(payload.gates.requireEvidenceForClaims, true);
});

test("applies YAML policy DSL during verification", () => {
  const result = runCli([
    "verify",
    "--input",
    "examples/synthetic-agent-run.json",
    "--policy",
    "examples/policies/strict-corporate-policy.yaml",
    "--format",
    "json"
  ]);
  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.policyId, "example-strict-corporate-yaml-policy");
  assert.ok(payload.findings.some((finding) => finding.id === "action.high_risk_without_approval"));
});

test("normalizes JSONL traces", () => {
  const result = runCli(["normalize", "--input", "examples/synthetic-agent-events.jsonl"]);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runId, "normalized-demo-run-001");
});

test("exports JSONL traces with redaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-export-"));
  const inputPath = join(dir, "events.jsonl");
  writeFileSync(inputPath, [
    JSON.stringify({
      event: "session",
      runId: "redacted-demo-run",
      subject: "Export test",
      synthetic: true,
      agent: { name: "Demo", provider: "synthetic" }
    }),
    JSON.stringify({
      event: "action",
      id: "a1",
      type: "read",
      target: "secret-client-plan.md",
      approval: "not_required",
      outcome: "completed"
    }),
    JSON.stringify({
      event: "output",
      id: "o1",
      channel: "final",
      content: "secret-client approved the synthetic fixture.",
      claims: []
    }),
    JSON.stringify({
      event: "evidence",
      id: "e1",
      kind: "command",
      result: "pass"
    })
  ].join("\n"));

  const result = runCli([
    "export",
    "--from",
    "agent-proof-jsonl",
    "--input",
    inputPath,
    "--redact-terms",
    "secret-client"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runId, "redacted-demo-run");
  assert.match(payload.actions[0].target, /\[redacted-term-1\]/);
  assert.match(payload.outputs[0].content, /\[redacted-term-1\]/);
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

test("writes a Markdown report", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-report-"));
  const outPath = join(dir, "report.md");
  const result = runCli([
    "report",
    "--input",
    "examples/synthetic-agent-run.json",
    "--policy",
    "policies/default-policy.json",
    "--out",
    outPath
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(outPath, "utf8"), /^# Agent Proof Report/);
});

test("writes a proof bundle with current package metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-bundle-"));
  writeFileSync(join(dir, "README.md"), "Public synthetic fixture only.\n");
  const outPath = join(dir, "proof-bundle.json");
  const result = runCli([
    "bundle",
    "--input",
    "examples/synthetic-agent-run.json",
    "--policy",
    "policies/default-policy.json",
    "--scan-path",
    dir,
    "--out",
    outPath
  ]);
  assert.equal(result.status, 0, result.stderr);
  const bundle = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(bundle.tool.version, packageVersion);
  assert.match(bundle.metadata.command, /^agent-proof bundle /);
  assert.ok(Number.isFinite(Date.parse(bundle.generatedAt)));
});

test("signs and verifies a proof bundle attestation", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-sign-"));
  const outPath = join(dir, "attestation.json");
  const sign = runCli([
    "sign-bundle",
    "--bundle",
    "docs/generated/proof-bundle.json",
    "--out",
    outPath
  ]);
  assert.equal(sign.status, 0, sign.stderr);
  const attestation = JSON.parse(readFileSync(outPath, "utf8"));
  assert.match(attestation.digest.value, /^[a-f0-9]{64}$/);

  const verify = runCli([
    "verify-bundle-signature",
    "--bundle",
    "docs/generated/proof-bundle.json",
    "--signature",
    outPath
  ]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /PASS digest=match signature=not_present/);
});

test("writes a local proof dashboard", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-dashboard-"));
  const outPath = join(dir, "dashboard.html");
  const result = runCli([
    "dashboard",
    "--bundle",
    "docs/generated/proof-bundle.json",
    "--coverage",
    "docs/generated/gate-coverage.md",
    "--attestation",
    "docs/generated/proof-bundle.attestation.json",
    "--out",
    outPath
  ]);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(outPath, "utf8");
  assert.match(html, /Agent Proof Dashboard/);
  assert.match(html, /Gate Coverage Matrix/);
});

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}
