import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diffAgentRuns } from "../../src/core/diff-agent-runs.js";

const policy = JSON.parse(readFileSync("policies/default-policy.json", "utf8"));
const baseline = JSON.parse(readFileSync("examples/synthetic-agent-run.json", "utf8"));
const regression = JSON.parse(readFileSync("examples/synthetic-agent-run-regression.json", "utf8"));

test("passes identical runs", () => {
  const result = diffAgentRuns(baseline, baseline, policy);
  assert.equal(result.status, "pass");
  assert.equal(result.scoreDelta, 0);
  assert.equal(result.newFindings.length, 0);
});

test("fails when the candidate introduces new findings", () => {
  const result = diffAgentRuns(baseline, regression, policy);
  assert.equal(result.status, "fail");
  assert.ok(result.scoreDelta < 0);
  assert.ok(result.newFindings.some((finding) => finding.id === "action.unknown_type"));
});

test("honors minimum score delta even without new findings", () => {
  const policyWithThreshold = structuredClone(policy);
  policyWithThreshold.diff = { minimumScoreDelta: 1 };

  const result = diffAgentRuns(baseline, baseline, policyWithThreshold);
  assert.equal(result.status, "fail");
  assert.equal(result.scoreDelta, 0);
  assert.equal(result.newFindings.length, 0);
});
