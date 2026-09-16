import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const intentSchema =
  "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json";

function initializedWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "agent-proof-guard-mcp-"));
  for (const dir of ["src", ".agent-proof", ".bytefence/intents", ".bytefence/receipts", "packages/app"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, ".agent-proof", "protected.json"), JSON.stringify({ version: 1, protected: ["src/config.js"] }));
  copyFileSync(resolve("policies/bytefence-default.json"), join(root, ".bytefence", "policy.json"));
  copyFileSync(resolve("policies/bytefence-default.json"), join(root, ".bytefence", "intents", "loose-policy.json"));
  writeFileSync(join(root, "src", "config.js"), "// Synthetic demo configuration.\nexport const config = {\n  retries: 2,\n  timeoutMs: 1000,\n  featureFlag: false,\n};\n");
  const intent = (targetPath, oldText, newText) => `${JSON.stringify({
    $schema: intentSchema, operation: "exactReplace", targetPath, encoding: "utf-8", oldText, newText, expectedOccurrences: 1
  })}\n`;
  writeFileSync(join(root, ".bytefence", "intents", "flag.json"), intent("src/config.js", "featureFlag: false", "featureFlag: true"));
  writeFileSync(join(root, ".bytefence", "intents", "unprotect.json"), intent(".agent-proof/protected.json", "src/config.js", "nothing.js"));
  return root;
}

async function connect(cwd) {
  const env = { ...process.env };
  delete env.AGENT_PROOF_ROOT;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("bin/agent-proof-mcp.js")],
    cwd,
    env,
    stderr: "ignore"
  });
  const client = new Client({ name: "guard-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function apply(client, intent, policy = ".bytefence/policy.json", receipt = intent) {
  return client.callTool({
    name: "bytefence_apply",
    arguments: {
      intent_path: `.bytefence/intents/${intent}.json`,
      policy_path: policy,
      workspace_id: "example/guard-mcp",
      receipt_path: `.bytefence/receipts/${receipt}.json`
    }
  });
}

test("the MCP server finds the initialized root from a subdirectory", async () => {
  const root = initializedWorkspace();
  const client = await connect(join(root, "packages", "app"));
  try {
    const result = await apply(client, "flag");
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).status, "allow");
    assert.match(readFileSync(join(root, "src", "config.js"), "utf8"), /featureFlag: true/);
  } finally {
    await client.close();
  }
});

test("bytefence_apply refuses to rewrite guard configuration", async () => {
  const root = initializedWorkspace();
  const client = await connect(root);
  try {
    const result = await apply(client, "unprotect");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /guard configuration or evidence/);
    assert.match(readFileSync(join(root, ".agent-proof", "protected.json"), "utf8"), /src\/config\.js/);
  } finally {
    await client.close();
  }
});

test("bytefence_apply refuses a substitute policy in a guarded workspace", async () => {
  const root = initializedWorkspace();
  const client = await connect(root);
  try {
    const result = await apply(client, "flag", ".bytefence/intents/loose-policy.json");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /policy_path must be \.bytefence\/policy\.json/);
    assert.match(readFileSync(join(root, "src", "config.js"), "utf8"), /featureFlag: false/);
  } finally {
    await client.close();
  }
});
