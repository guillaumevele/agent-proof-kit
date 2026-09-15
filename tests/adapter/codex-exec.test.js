import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluateAgentRun } from "../../src/core/evaluate-agent-run.js";
import { exportTraceFixture, supportedTraceSources } from "../../src/core/trace-export.js";
import { validateAgentRun, validatePolicy } from "../../src/core/validate-agent-run.js";

const fixture = readFileSync("examples/adapters/codex-exec.jsonl", "utf8");
const codexPolicy = JSON.parse(readFileSync("policies/codex-exec-policy.json", "utf8"));
const strictPolicy = JSON.parse(readFileSync("policies/codex-bytefence-strict-policy.json", "utf8"));
const defaultPolicy = JSON.parse(readFileSync("policies/default-policy.json", "utf8"));
const intentSchema =
  "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json";

function exportCodex(text) {
  return exportTraceFixture(text, { source: "codex-exec-jsonl" }).run;
}

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

test("codex-exec-jsonl is a supported trace source", () => {
  assert.ok(supportedTraceSources.includes("codex-exec-jsonl"));
});

test("Codex policies match the public policy contract", () => {
  assert.equal(validatePolicy(codexPolicy).status, "pass");
  assert.equal(validatePolicy(strictPolicy).status, "pass");
});

test("exports a codex exec --json stream into a valid, non-synthetic run", () => {
  const run = exportCodex(fixture);
  assert.equal(run.runId, "codex-exec-0199a000-0000-7000-8000-000000000001");
  assert.equal(run.synthetic, false);
  assert.equal(run.agent.provider, "openai-codex");
  assert.equal(validateAgentRun(run).status, "pass");
  assert.deepEqual(
    run.actions.map((action) => [action.type, action.outcome]),
    [
      ["command", "completed"],
      ["write", "completed"],
      ["unmediated_write", "completed"]
    ]
  );
  const applyEvidence = run.evidence.find((item) => item.kind === "bytefence_apply_result");
  assert.equal(applyEvidence.result, "pass");
  assert.match(applyEvidence.excerpt, /effectiveGuaranteeLevel=CORE_PROVEN/);
  assert.ok(run.evidence.some((item) => item.kind === "codex_turn_completed"));
});

test("does not export reasoning, command output or MCP arguments", () => {
  const serialized = JSON.stringify(exportCodex(fixture));
  assert.doesNotMatch(serialized, /Synthetic reasoning summary/);
  assert.doesNotMatch(serialized, /Synthetic demo configuration/);
  assert.doesNotMatch(serialized, /receipts\/feature-flag\.json/);
  assert.doesNotMatch(serialized, /example\/codex-demo/);
});

test("export is deterministic", () => {
  assert.equal(JSON.stringify(exportCodex(fixture)), JSON.stringify(exportCodex(fixture)));
});

test("the Codex policy passes the fixture; the strict ByteFence policy blocks the direct patch", () => {
  const run = exportCodex(fixture);
  assert.equal(evaluateAgentRun(run, codexPolicy).status, "pass");

  const strict = evaluateAgentRun(run, strictPolicy);
  assert.equal(strict.status, "fail");
  assert.deepEqual(
    strict.findings.map((finding) => [finding.id, finding.evidence]),
    [["action.high_risk_without_approval", "unmediated_write -> docs/CHANGELOG-draft.md"]]
  );
});

test("the synthetic default policy fails closed on real Codex traces", () => {
  const result = evaluateAgentRun(exportCodex(fixture), defaultPolicy);
  assert.equal(result.status, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "fixture.not_synthetic"));
  assert.ok(result.findings.some((finding) => finding.id === "action.unknown_type"));
});

test("maps declined, failed, deleted and never-completed items conservatively", () => {
  const run = exportCodex(jsonl([
    { type: "thread.started", thread_id: "thread-edge" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "rm -rf build", aggregated_output: "", exit_code: null, status: "declined" } },
    { type: "item.completed", item: { id: "c2", type: "command_execution", command: "npm test", aggregated_output: "", exit_code: 1, status: "failed" } },
    { type: "item.completed", item: { id: "p1", type: "file_change", changes: [{ path: "old.txt", kind: "delete" }], status: "completed" } },
    { type: "item.started", item: { id: "c3", type: "command_execution", command: "sleep 100", aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "w1", type: "web_search", query: "private query text", action: { type: "search" } } },
    { type: "turn.failed", error: { message: "synthetic failure" } }
  ]));

  assert.deepEqual(
    run.actions.map((action) => [action.id, action.type, action.outcome]),
    [
      ["codex-command-1", "command", "refused"],
      ["codex-command-2", "command", "failed"],
      ["codex-file-change-1", "destructive", "completed"],
      ["codex-web-search-1", "network", "completed"],
      ["codex-command-3", "command", "incomplete"]
    ]
  );
  assert.doesNotMatch(JSON.stringify(run), /private query text/);
  assert.ok(run.evidence.some((item) => item.kind === "codex_turn_failed" && item.result === "fail"));

  const result = evaluateAgentRun(run, codexPolicy);
  assert.equal(result.status, "fail");
  const ids = result.findings.map((finding) => finding.id);
  assert.ok(ids.includes("action.critical_not_contained"));
  assert.ok(ids.includes("action.high_risk_without_approval"));
});

test("unrecognized Codex item types fail closed", () => {
  const run = exportCodex(jsonl([
    { type: "thread.started", thread_id: "thread-future" },
    { type: "item.completed", item: { id: "f1", type: "image_generation", status: "completed" } },
    { type: "item.completed", item: { id: "t1", type: "todo_list", items: [{ text: "private plan", completed: false }] } }
  ]));
  assert.deepEqual(run.actions.map((action) => action.type), ["codex_item:image-generation"]);
  assert.doesNotMatch(JSON.stringify(run), /private plan/);
  const result = evaluateAgentRun(run, codexPolicy);
  assert.equal(result.status, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "action.unknown_type"));
});

test("reports invalid JSONL line numbers", () => {
  assert.throws(
    () => exportCodex("{\"type\":\"thread.started\",\"thread_id\":\"x\"}\n{broken}\n"),
    /line 2/
  );
});

test("adapts real bytefence_apply MCP results for committed and refused edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-proof-codex-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".bytefence", "intents"), { recursive: true });
  mkdirSync(join(root, ".bytefence", "receipts"));
  writeFileSync(
    join(root, "src", "config.js"),
    "// Synthetic demo configuration.\nexport const config = {\n  service: \"example-api\",\n  retries: 2,\n  timeoutMs: 1000,\n  featureFlag: false,\n};\n"
  );
  copyFileSync(resolve("policies/bytefence-default.json"), join(root, ".bytefence", "policy.json"));
  const intent = (oldText, newText) => `${JSON.stringify({
    $schema: intentSchema,
    operation: "exactReplace",
    targetPath: "src/config.js",
    encoding: "utf-8",
    oldText,
    newText,
    expectedOccurrences: 1
  }, null, 2)}\n`;
  writeFileSync(join(root, ".bytefence", "intents", "allowed.json"), intent("featureFlag: false", "featureFlag: true"));
  writeFileSync(join(root, ".bytefence", "intents", "missing.json"), intent("does-not-exist", "x"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("bin/agent-proof-mcp.js")],
    env: { ...process.env, AGENT_PROOF_ROOT: root },
    stderr: "ignore"
  });
  const client = new Client({ name: "codex-adapter-test", version: "0.0.0" });
  await client.connect(transport);

  const events = [{ type: "thread.started", thread_id: "thread-live-mcp" }, { type: "turn.started" }];
  try {
    for (const name of ["allowed", "missing"]) {
      const args = {
        intent_path: `.bytefence/intents/${name}.json`,
        policy_path: ".bytefence/policy.json",
        workspace_id: "example/codex-adapter",
        receipt_path: `.bytefence/receipts/${name}.json`
      };
      const result = await client.callTool({ name: "bytefence_apply", arguments: args });
      events.push({
        type: "item.completed",
        item: {
          id: `mcp-${name}`,
          type: "mcp_tool_call",
          server: "agent_proof_kit",
          tool: "bytefence_apply",
          arguments: args,
          result: { content: result.content, structured_content: null },
          error: null,
          status: "completed"
        }
      });
    }
  } finally {
    await client.close();
  }
  events.push({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });

  assert.match(readFileSync(join(root, "src", "config.js"), "utf8"), /featureFlag: true/);
  const run = exportCodex(jsonl(events));
  assert.deepEqual(
    run.actions.map((action) => [action.target, action.type, action.outcome]),
    [
      ["bytefence:.bytefence/intents/allowed.json", "write", "completed"],
      ["bytefence:.bytefence/intents/missing.json", "write", "blocked"]
    ]
  );
  assert.equal(evaluateAgentRun(run, strictPolicy).status, "pass");
});
