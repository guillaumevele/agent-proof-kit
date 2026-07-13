import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("npm package includes ByteFence, CLI, MCP, docs, policies and proof artifacts", () => {
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(pack.status, 0, pack.stderr);

  const [result] = JSON.parse(pack.stdout);
  const files = new Set(result.files.map((file) => file.path));
  const packedFiles = new Map(result.files.map((file) => [file.path, file]));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  assert.equal(pkg.bin["agent-proof"], "bin/agent-proof.js");
  assert.equal(pkg.bin["agent-proof-mcp"], "bin/agent-proof-mcp.js");
  assert.equal(pkg.main, "./src/index.js");
  assert.notEqual(packedFiles.get("bin/agent-proof.js").mode & 0o111, 0);
  assert.notEqual(packedFiles.get("bin/agent-proof-mcp.js").mode & 0o111, 0);

  for (const path of [
    "CHANGELOG.md",
    "bin/agent-proof.js",
    "bin/agent-proof-mcp.js",
    "docs/integrations/mcp.md",
    "docs/integrations/trace-adapters.md",
    "docs/policy-packs.md",
    "docs/generated/gate-coverage.md",
    "docs/generated/proof-bundle.attestation.json",
    "docs/generated/proof-dashboard.html",
    "docs/dashboard.md",
    "docs/signatures.md",
    "examples/adapters/langgraph-stream.json",
    "examples/adapters/crewai-events.jsonl",
    "examples/adapters/autogen-run-stream.jsonl",
    "examples/policies/strict-corporate-policy.yaml",
    "examples/bytefence/corpus-v0.1.json",
    "examples/bytefence/cases/vibe-mixed-eol-out-of-scope/preimage.bin",
    "examples/bytefence/cases/vibe-mixed-eol-out-of-scope/candidate.bin",
    "adapters/vibe/README.md",
    "adapters/vibe/project/.vibe/tools/bytefence_apply.py",
    "scripts/bytefence/generate-corpus.js",
    "scripts/bytefence/reproduce-vibe-mixed-eol.js",
    "scripts/bytefence/benchmark.js",
    "policies/bytefence-default.json",
    "policies/default-policy.json",
    "policies/open-source-policy.json",
    "policies/strict-corporate-policy.json",
    "policies/high-stakes-policy.json",
    "schemas/agent-run.schema.json",
    "schemas/bytefence-intent-v0.1.schema.json",
    "schemas/bytefence-policy-v0.1.schema.json",
    "schemas/bytefence-statement-v0.1.schema.json",
    "schemas/policy.schema.json"
  ]) {
    assert.ok(files.has(path), `${path} should be included in npm pack`);
  }

  for (const path of files) {
    assert.equal(path.includes("/__pycache__/"), false, `${path} must not be packed`);
    assert.equal(/\.py[cod]$/u.test(path), false, `${path} must not be packed`);
  }
});

test("packed public API imports from a clean consumer", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-proof-pack-consumer-"));
  try {
    const pack = spawnSync(
      "npm",
      ["pack", "--json", "--pack-destination", temporaryRoot],
      {
        cwd: resolve("."),
        encoding: "utf8",
        timeout: 30_000
      }
    );
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const [{ filename }] = JSON.parse(pack.stdout);
    const consumer = join(temporaryRoot, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "agent-proof-consumer", private: true, type: "module" }, null, 2)}\n`
    );

    const install = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        join(temporaryRoot, filename)
      ],
      { cwd: consumer, encoding: "utf8", timeout: 60_000 }
    );
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const api = await import('agent-proof-kit'); if (typeof api.evaluateByteFence !== 'function') process.exit(1);"
      ],
      { cwd: consumer, encoding: "utf8", timeout: 30_000 }
    );
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
