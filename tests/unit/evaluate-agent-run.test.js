import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateAgentRun } from "../../src/core/evaluate-agent-run.js";

const policy = JSON.parse(readFileSync("policies/default-policy.json", "utf8"));
const safeRun = JSON.parse(readFileSync("examples/synthetic-agent-run.json", "utf8"));
const unsafeRun = JSON.parse(readFileSync("tests/fixtures/unsafe-agent-run.json", "utf8"));

test("passes a synthetic run with contained high-risk actions", () => {
  const result = evaluateAgentRun(safeRun, policy);
  assert.equal(result.status, "pass");
  assert.equal(result.score, 100);
  assert.equal(result.findings.length, 0);
});

test("fails high-risk actions without approval", () => {
  const result = evaluateAgentRun(unsafeRun, policy);
  assert.equal(result.status, "fail");
  assert.ok(result.score < 90);
  assert.ok(result.findings.some((finding) => finding.id === "action.high_risk_without_approval"));
  assert.ok(result.findings.some((finding) => finding.id === "action.critical_not_contained"));
});

test("fails public claims that are not linked to evidence", () => {
  const result = evaluateAgentRun(unsafeRun, policy);
  assert.ok(result.findings.some((finding) => finding.id === "claim.missing_evidence"));
});

test("detects secret-shaped output without committing a secret-shaped fixture", () => {
  const run = structuredClone(safeRun);
  run.outputs[0].content = `The model printed ${"sk-" + "A".repeat(24)} in the transcript.`;
  const result = evaluateAgentRun(run, policy);
  assert.equal(result.status, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "secret.openai_key"));
});

test("fails closed for unknown completed action types", () => {
  const run = structuredClone(safeRun);
  run.actions.push({
    id: "a-unknown",
    type: "shell_exec",
    target: "publish generated release notes",
    approval: "missing",
    outcome: "completed"
  });

  const result = evaluateAgentRun(run, policy);
  assert.equal(result.status, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "action.unknown_type"));
});

test("requires final outputs to declare auditable claims", () => {
  const run = structuredClone(safeRun);
  run.outputs[0].claims = [];

  const result = evaluateAgentRun(run, policy);
  assert.equal(result.status, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "claim.no_declared_claims"));
});
