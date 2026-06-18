import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diffAgentRuns } from "../../src/core/diff-agent-runs.js";
import { evaluateAgentRun } from "../../src/core/evaluate-agent-run.js";
import { renderSarif } from "../../src/report/sarif-report.js";

const policy = JSON.parse(readFileSync("policies/default-policy.json", "utf8"));
const safeRun = JSON.parse(readFileSync("examples/synthetic-agent-run.json", "utf8"));
const regression = JSON.parse(readFileSync("examples/synthetic-agent-run-regression.json", "utf8"));

test("renders empty SARIF for passing runs", () => {
  const result = evaluateAgentRun(safeRun, policy);
  const sarif = JSON.parse(renderSarif(result));
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].tool.driver.name, "agent-proof-kit");
  assert.equal(sarif.runs[0].results.length, 0);
});

test("renders SARIF results for failing runs", () => {
  const result = evaluateAgentRun(regression, policy);
  const sarif = JSON.parse(renderSarif(result, { defaultArtifact: "examples/synthetic-agent-run-regression.json" }));
  assert.equal(sarif.version, "2.1.0");
  assert.ok(sarif.runs[0].results.length > 0);
  const hit = sarif.runs[0].results.find((item) => item.ruleId === "action.unknown_type");
  assert.equal(hit.level, "error");
  assert.equal(hit.locations[0].physicalLocation.artifactLocation.uri, "examples/synthetic-agent-run-regression.json");
});

test("renders SARIF for diff regressions", () => {
  const diff = diffAgentRuns(safeRun, regression, policy, {
    candidatePath: "examples/synthetic-agent-run-regression.json"
  });
  const sarif = JSON.parse(renderSarif({ findings: diff.newFindings }, { defaultArtifact: diff.candidate.inputPath }));
  assert.equal(sarif.version, "2.1.0");
  const hit = sarif.runs[0].results.find((item) => item.ruleId === "action.unknown_type");
  assert.equal(hit.locations[0].physicalLocation.artifactLocation.uri, "examples/synthetic-agent-run-regression.json");
});
