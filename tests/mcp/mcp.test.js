import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const serverPath = resolve("bin/agent-proof-mcp.js");

test("MCP server exposes practical proof workflow tools", async () => {
  const client = await connectClient();
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "agent_proof_compile_policy",
      "agent_proof_create_bundle",
      "agent_proof_diff_runs",
      "agent_proof_export_trace",
      "agent_proof_read_artifact",
      "agent_proof_render_dashboard",
      "agent_proof_scan_surface",
      "agent_proof_sign_bundle",
      "agent_proof_status",
      "agent_proof_verify_bundle_signature",
      "agent_proof_verify_run"
    ]);
  } finally {
    await client.close();
  }
});

test("MCP server verifies the bundled safe run", async () => {
  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "agent_proof_verify_run",
      arguments: {
        response_format: "json"
      }
    });
    const payload = JSON.parse(textContent(result));
    assert.equal(payload.status, "pass");
    assert.equal(payload.score, 100);
    assert.equal(payload.runId, "demo-agent-run-001");
  } finally {
    await client.close();
  }
});

test("MCP server scans the workspace with extra private terms", async () => {
  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "agent_proof_scan_surface",
      arguments: {
        scan_path: "examples",
        private_terms: ["needle-private-term"],
        response_format: "json"
      }
    });
    const payload = JSON.parse(textContent(result));
    assert.equal(payload.status, "pass");
    assert.equal(payload.rootPath, "examples");
  } finally {
    await client.close();
  }
});

test("MCP server reports diff regressions", async () => {
  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "agent_proof_diff_runs",
      arguments: {
        response_format: "json"
      }
    });
    const payload = JSON.parse(textContent(result));
    assert.equal(payload.status, "fail");
    assert.ok(payload.newFindings.some((finding) => finding.id === "action.unknown_type"));
  } finally {
    await client.close();
  }
});

test("MCP server exports a JSONL trace fixture with redactions", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-proof-mcp-export-"));
  const tracePath = join(workspace, "events.jsonl");
  writeSyntheticJsonlTrace(tracePath);
  const client = await connectClient(workspace);
  try {
    const result = await client.callTool({
      name: "agent_proof_export_trace",
      arguments: {
        input: "events.jsonl",
        redact_terms: ["sensitive-codename"],
        write_path: "fixtures/exported-agent-run.json",
        response_format: "json"
      }
    });
    const payload = JSON.parse(textContent(result));
    assert.equal(payload.source, "agent-proof-jsonl");
    assert.equal(payload.writtenTo, "fixtures/exported-agent-run.json");
    assert.equal(payload.redactedTerms, 2);
    assert.match(payload.run.actions[0].target, /\[redacted-term-1\]/);
    assert.ok(statSync(join(workspace, "fixtures", "exported-agent-run.json")).isFile());
  } finally {
    await client.close();
  }
});

test("MCP server exports a framework trace fixture", async () => {
  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "agent_proof_export_trace",
      arguments: {
        from: "langgraph-stream",
        input: "examples/adapters/langgraph-stream.json",
        response_format: "json"
      }
    });
    const payload = JSON.parse(textContent(result));
    assert.equal(payload.source, "langgraph-stream");
    assert.equal(payload.run.runId, "langgraph-stream-demo-001");
    assert.ok(payload.run.actions.length > 0);
  } finally {
    await client.close();
  }
});

test("MCP server compiles a YAML policy and writes JSON output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-proof-mcp-policy-"));
  const client = await connectClient(workspace);
  try {
    const result = await client.callTool({
      name: "agent_proof_compile_policy",
      arguments: {
        write_path: "policies/compiled-policy.json",
        response_format: "json"
      }
    });
    const payload = JSON.parse(textContent(result));
    assert.equal(payload.writtenTo, "policies/compiled-policy.json");
    assert.equal(payload.policy.id, "example-strict-corporate-yaml-policy");
    assert.ok(statSync(join(workspace, "policies", "compiled-policy.json")).isFile());
  } finally {
    await client.close();
  }
});

test("MCP server can write a proof bundle inside the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-proof-mcp-workspace-"));
  const client = await connectClient(workspace);
  try {
    const result = await client.callTool({
      name: "agent_proof_create_bundle",
      arguments: {
        scan_path: ".",
        write_path: "artifacts/proof-bundle.json",
        response_format: "json"
      }
    });
    const payload = JSON.parse(textContent(result));
    assert.equal(payload.writtenTo, "artifacts/proof-bundle.json");
    assert.equal(payload.bundle.status, "pass");
    const written = join(workspace, "artifacts", "proof-bundle.json");
    assert.ok(statSync(written).isFile());
    assert.equal(JSON.parse(readFileSync(written, "utf8")).tool.name, "agent-proof-kit");
  } finally {
    await client.close();
  }
});

test("MCP server signs, verifies and renders proof artifacts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-proof-mcp-proof-"));
  const client = await connectClient(workspace);
  try {
    const sign = await client.callTool({
      name: "agent_proof_sign_bundle",
      arguments: {
        write_path: "artifacts/proof-bundle.attestation.json",
        response_format: "json"
      }
    });
    const signed = JSON.parse(textContent(sign));
    assert.equal(signed.writtenTo, "artifacts/proof-bundle.attestation.json");
    assert.match(signed.attestation.digest.value, /^[a-f0-9]{64}$/);

    const verify = await client.callTool({
      name: "agent_proof_verify_bundle_signature",
      arguments: {
        attestation: "artifacts/proof-bundle.attestation.json",
        response_format: "json"
      }
    });
    const verified = JSON.parse(textContent(verify));
    assert.equal(verified.result.status, "pass");
    assert.equal(verified.result.digestMatches, true);

    const dashboard = await client.callTool({
      name: "agent_proof_render_dashboard",
      arguments: {
        attestation: "artifacts/proof-bundle.attestation.json",
        write_path: "artifacts/proof-dashboard.html",
        response_format: "json"
      }
    });
    const rendered = JSON.parse(textContent(dashboard));
    assert.equal(rendered.writtenTo, "artifacts/proof-dashboard.html");
    assert.ok(rendered.bytes > 1000);
    assert.match(readFileSync(join(workspace, "artifacts", "proof-dashboard.html"), "utf8"), /Agent Proof Dashboard/);
  } finally {
    await client.close();
  }
});

test("MCP server refuses paths outside the workspace root", async () => {
  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "agent_proof_scan_surface",
      arguments: {
        scan_path: "../",
        response_format: "json"
      }
    });
    assert.equal(result.isError, true);
    assert.match(textContent(result), /must stay under workspace root/);
  } finally {
    await client.close();
  }
});

test("MCP server reads checked-in generated artifacts", async () => {
  const client = await connectClient();
  try {
    const result = await client.callTool({
      name: "agent_proof_read_artifact",
      arguments: {
        artifact: "gate_coverage",
        response_format: "json"
      }
    });
    const payload = JSON.parse(textContent(result));
    assert.equal(payload.path, "docs/generated/gate-coverage.md");
    assert.match(payload.content, /Gate Coverage Matrix/);
  } finally {
    await client.close();
  }
});

async function connectClient(workspaceRoot = resolve(".")) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      AGENT_PROOF_ROOT: workspaceRoot
    }
  });
  const client = new Client({
    name: "agent-proof-mcp-test",
    version: "1.0.0"
  });
  await client.connect(transport);
  return client;
}

function textContent(result) {
  return result.content.map((item) => item.text ?? "").join("\n");
}

function writeSyntheticJsonlTrace(path) {
  const lines = [
    {
      event: "session",
      runId: "mcp-export-demo-run",
      subject: "MCP export test",
      synthetic: true,
      agent: { name: "MCP Export Agent", provider: "synthetic" }
    },
    {
      event: "action",
      id: "a1",
      type: "read",
      target: "sensitive-codename-plan.md",
      approval: "not_required",
      outcome: "completed"
    },
    {
      event: "output",
      id: "o1",
      channel: "final",
      content: "sensitive-codename was converted into a synthetic fixture.",
      claims: []
    },
    {
      event: "evidence",
      id: "e1",
      kind: "command",
      result: "pass"
    }
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}
