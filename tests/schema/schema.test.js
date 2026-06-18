import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validateJsonSchema } from "../../src/core/json-schema-validator.js";
import { validateAgentRun, validatePolicy } from "../../src/core/validate-agent-run.js";

const safeRun = JSON.parse(readFileSync("examples/synthetic-agent-run.json", "utf8"));
const policy = JSON.parse(readFileSync("policies/default-policy.json", "utf8"));
const agentRunSchema = JSON.parse(readFileSync("schemas/agent-run.schema.json", "utf8"));
const policySchema = JSON.parse(readFileSync("schemas/policy.schema.json", "utf8"));

test("validates the public run fixture", () => {
  const result = validateAgentRun(safeRun);
  assert.equal(result.status, "pass");
  assert.equal(result.findings.length, 0);
});

test("validates the default policy", () => {
  const result = validatePolicy(policy);
  assert.equal(result.status, "pass");
  assert.equal(result.findings.length, 0);
});

test("validates every bundled policy pack", () => {
  const policyPaths = readdirSync("policies")
    .filter((file) => file.endsWith(".json"))
    .map((file) => `policies/${file}`)
    .sort();

  for (const path of policyPaths) {
    const result = validatePolicy(JSON.parse(readFileSync(path, "utf8")));
    assert.equal(result.status, "pass", path);
    assert.equal(result.findings.length, 0, path);
  }
});

test("reports precise paths for invalid runs", () => {
  const run = structuredClone(safeRun);
  delete run.runId;
  run.actions[0].outcome = "";

  const result = validateAgentRun(run);
  assert.equal(result.status, "fail");
  assert.ok(result.findings.some((finding) => finding.location === "$.runId"));
  assert.ok(result.findings.some((finding) => finding.location === "$.actions[0].outcome"));
});

test("rejects unknown policy risk levels", () => {
  const invalid = structuredClone(policy);
  invalid.actionRisk.read = "trusted";

  const result = validatePolicy(invalid);
  assert.equal(result.status, "fail");
  assert.ok(result.findings.some((finding) => finding.location === "$.actionRisk.read"));
});

test("executes the checked-in agent-run JSON schema directly", () => {
  assert.equal(validateJsonSchema(safeRun, agentRunSchema).length, 0);

  const invalid = structuredClone(safeRun);
  invalid.schemaVersion = 0;
  invalid.actions[0].id = "";
  const issues = validateJsonSchema(invalid, agentRunSchema);
  assert.ok(issues.some((issue) => issue.location === "$.schemaVersion"));
  assert.ok(issues.some((issue) => issue.location === "$.actions[0].id"));
});

test("executes the checked-in policy JSON schema directly", () => {
  assert.equal(validateJsonSchema(policy, policySchema).length, 0);

  const invalid = structuredClone(policy);
  invalid.minimumScore = 101;
  invalid.actionRisk.read = "trusted";
  const issues = validateJsonSchema(invalid, policySchema);
  assert.ok(issues.some((issue) => issue.location === "$.minimumScore"));
  assert.ok(issues.some((issue) => issue.location === "$.actionRisk.read"));
});
