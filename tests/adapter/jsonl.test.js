import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateAgentRun } from "../../src/core/evaluate-agent-run.js";
import { normalizeJsonlTrace } from "../../src/core/normalize-jsonl.js";
import { validateAgentRun, validatePolicy } from "../../src/core/validate-agent-run.js";

const jsonl = readFileSync("examples/synthetic-agent-events.jsonl", "utf8");
const policy = JSON.parse(readFileSync("policies/default-policy.json", "utf8"));

test("normalizes synthetic JSONL events into an agent run", () => {
  const run = normalizeJsonlTrace(jsonl);
  assert.equal(run.runId, "normalized-demo-run-001");
  assert.equal(run.synthetic, true);
  assert.equal(run.actions.length, 2);
  assert.equal(run.outputs.length, 1);
  assert.equal(run.evidence.length, 1);
});

test("normalization is deterministic", () => {
  const first = JSON.stringify(normalizeJsonlTrace(jsonl), null, 2);
  const second = JSON.stringify(normalizeJsonlTrace(jsonl), null, 2);
  assert.equal(first, second);
});

test("reports invalid JSONL line numbers", () => {
  assert.throws(() => normalizeJsonlTrace("{\"type\":\"session\"}\n{broken}\n"), /line 2/);
});

test("normalized JSONL output passes validation and release gates", () => {
  const run = normalizeJsonlTrace(jsonl);
  assert.equal(validateAgentRun(run).status, "pass");
  assert.equal(validatePolicy(policy).status, "pass");
  assert.equal(evaluateAgentRun(run, policy).status, "pass");
});
