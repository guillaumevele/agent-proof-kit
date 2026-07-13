import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validateJsonSchema } from "../../src/core/json-schema-validator.js";
import { parseByteFencePolicy } from "../../src/core/bytefence-contract.js";
import { compilePolicyDefinition, loadPolicyFile, readPolicyDefinition } from "../../src/core/policy-loader.js";
import { validateAgentRun, validatePolicy } from "../../src/core/validate-agent-run.js";

const safeRun = JSON.parse(readFileSync("examples/synthetic-agent-run.json", "utf8"));
const policy = JSON.parse(readFileSync("policies/default-policy.json", "utf8"));
const agentRunSchema = JSON.parse(readFileSync("schemas/agent-run.schema.json", "utf8"));
const policySchema = JSON.parse(readFileSync("schemas/policy.schema.json", "utf8"));
const byteFencePolicySchema = JSON.parse(
  readFileSync("schemas/bytefence-policy-v0.1.schema.json", "utf8")
);

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
    const bytes = readFileSync(path);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed.$schema === byteFencePolicySchema.$id) {
      assert.deepEqual(validateJsonSchema(parsed, byteFencePolicySchema), [], path);
      assert.doesNotThrow(() => parseByteFencePolicy(bytes), path);
      continue;
    }

    assert.equal(parsed.$schema, undefined, `Unsupported policy schema in ${path}`);
    const result = validatePolicy(parsed);
    assert.equal(result.status, "pass", path);
    assert.equal(result.findings.length, 0, path);
  }
});

test("compiles YAML policy DSL into the public policy contract", () => {
  const policy = loadPolicyFile("examples/policies/strict-corporate-policy.yaml");
  assert.equal(policy.id, "example-strict-corporate-yaml-policy");
  assert.equal(policy.minimumScore, 96);
  assert.equal(policy.maxScannedFileBytes, 256000);
  assert.equal(policy.gates.requireSyntheticFixture, true);
  assert.equal(policy.actionRisk.write, "high");
  assert.deepEqual(policy.privateTerms, ["internal-codename"]);
  assert.equal(validatePolicy(policy).status, "pass");
  assert.equal(validateJsonSchema(policy, policySchema).length, 0);
});

test("compiles raw policy objects without YAML-only fields", () => {
  const policy = compilePolicyDefinition(readPolicyDefinition("policies/open-source-policy.json"));
  assert.equal(policy.id, "open-source-agent-policy");
  assert.equal(policy.minimumScore, 85);
  assert.equal(validatePolicy(policy).status, "pass");
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
