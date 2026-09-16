import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyInitPlan, planInit } from "../../src/core/init.js";
import { parseGuardConfig } from "../../src/core/guard.js";

const cli = resolve("bin/agent-proof.js");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "agent-proof-init-"));
}

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

test("init --agent all creates a complete, valid setup", () => {
  const root = tempRoot();
  const result = spawnSync(process.execPath, [cli, "init", "--agent", "all", "--protect", "src/config.js,.github/workflows/**", "--root", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const config = parseGuardConfig(read(root, ".agent-proof/protected.json"));
  assert.deepEqual(config.protected, ["src/config.js", ".github/workflows/**"]);
  assert.ok(existsSync(join(root, ".bytefence/policy.json")));
  assert.ok(existsSync(join(root, ".bytefence/intents/.gitkeep")));
  assert.ok(existsSync(join(root, ".bytefence/receipts/.gitkeep")));

  const codexHooks = JSON.parse(read(root, ".codex/hooks.json"));
  assert.equal(codexHooks.hooks.PreToolUse[0].matcher, "apply_patch|Bash|mcp__.*");
  assert.equal(codexHooks.hooks.PreToolUse[0].hooks[0].command, `npx --yes --package agent-proof-kit@${version} agent-proof guard`);
  assert.match(read(root, ".codex/config.toml"), /\[mcp_servers\.agent_proof_kit\][\s\S]*required = true/);

  const claudeSettings = JSON.parse(read(root, ".claude/settings.json"));
  assert.equal(claudeSettings.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash|mcp__.*");
  assert.deepEqual(JSON.parse(read(root, ".mcp.json")).mcpServers.agent_proof_kit.args, ["--yes", "--package", `agent-proof-kit@${version}`, "agent-proof-mcp"]);

  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const text = read(root, file);
    assert.match(text, /agent-proof-kit:start/);
    assert.match(text, /`src\/config\.js`/);
    assert.match(text, /bytefence_apply/);
  }
});

test("init merges into existing files and is idempotent", () => {
  const root = tempRoot();
  writeFileSync(join(root, "AGENTS.md"), "# House rules\n\nRun tests before committing.\n");
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other-server" } } }));
  const settingsDir = join(root, ".claude");
  spawnSync("mkdir", ["-p", settingsDir]);
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash(npm test)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./lint.sh" }] }] }
  }));

  const first = planInit({ root, agents: ["all"], protect: ["src/config.js"] });
  applyInitPlan(first);

  assert.match(read(root, "AGENTS.md"), /^# House rules\n\nRun tests before committing\.\n\n<!-- agent-proof-kit:start -->/);
  assert.ok(JSON.parse(read(root, ".mcp.json")).mcpServers.other);
  const settings = JSON.parse(read(root, ".claude/settings.json"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  assert.equal(settings.hooks.PreToolUse.length, 2);

  const second = planInit({ root, agents: ["all"], protect: ["src/config.js"] });
  assert.deepEqual(second.operations.filter((operation) => operation.action !== "keep"), []);
});

test("init keeps an existing protected list unless --force", () => {
  const root = tempRoot();
  applyInitPlan(planInit({ root, agents: ["codex"], protect: ["a.txt"] }));
  const kept = planInit({ root, agents: ["codex"], protect: ["b.txt"] });
  assert.deepEqual(kept.protected, ["a.txt"]);
  assert.equal(kept.operations.find((operation) => operation.path === ".agent-proof/protected.json").action, "keep");

  const forced = planInit({ root, agents: ["codex"], protect: ["b.txt"], force: true });
  assert.deepEqual(forced.protected, ["b.txt"]);
  applyInitPlan(forced);
  assert.match(read(root, "AGENTS.md"), /`b\.txt`/);
  assert.doesNotMatch(read(root, "AGENTS.md"), /`a\.txt`/);
});

test("init uses the local dependency when the project already declares it", () => {
  const root = tempRoot();
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "agent-proof-kit": `^${version}` } }));
  const plan = planInit({ root, agents: ["claude"], protect: ["src/config.js"] });
  assert.equal(plan.guardCommand, "npx --no-install agent-proof guard");
});

test("init --dry-run writes nothing and invalid input is refused", () => {
  const root = tempRoot();
  const dry = spawnSync(process.execPath, [cli, "init", "--agent", "codex", "--protect", "src/config.js", "--root", root, "--dry-run"], { encoding: "utf8" });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /dry run, nothing written/);
  assert.equal(existsSync(join(root, ".agent-proof")), false);

  assert.throws(() => planInit({ root, agents: ["cursor"], protect: ["a"] }), /Unsupported --agent/);
  assert.throws(() => planInit({ root, agents: ["codex"], protect: ["../outside"] }), /must be relative/);
  writeFileSync(join(root, ".mcp.json"), "{ not json");
  assert.throws(() => planInit({ root, agents: ["claude"], protect: ["a"] }), /\.mcp\.json is not valid JSON/);
});
