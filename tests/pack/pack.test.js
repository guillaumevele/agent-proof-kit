import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("npm package includes CLI, MCP server, docs, policies and proof artifacts", () => {
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(pack.status, 0, pack.stderr);

  const [result] = JSON.parse(pack.stdout);
  const files = new Set(result.files.map((file) => file.path));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  assert.equal(pkg.bin["agent-proof"], "./bin/agent-proof.js");
  assert.equal(pkg.bin["agent-proof-mcp"], "./bin/agent-proof-mcp.js");

  for (const path of [
    "bin/agent-proof.js",
    "bin/agent-proof-mcp.js",
    "docs/integrations/mcp.md",
    "docs/integrations/trace-adapters.md",
    "docs/policy-packs.md",
    "docs/generated/gate-coverage.md",
    "policies/default-policy.json",
    "policies/open-source-policy.json",
    "policies/strict-corporate-policy.json",
    "policies/high-stakes-policy.json",
    "schemas/agent-run.schema.json",
    "schemas/policy.schema.json"
  ]) {
    assert.ok(files.has(path), `${path} should be included in npm pack`);
  }
});
