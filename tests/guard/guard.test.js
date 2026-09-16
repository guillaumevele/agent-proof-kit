import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GuardConfigError,
  compilePattern,
  evaluateGuard,
  extractPatchPaths,
  isGuardControlPath,
  parseGuardConfig
} from "../../src/core/guard.js";

const root = "/work/repo";
const config = parseGuardConfig(JSON.stringify({
  version: 1,
  protected: ["src/config.js", ".github/workflows/**", "secrets/", "**/prod.env"]
}));
const cli = resolve("bin/agent-proof.js");

function decide(payload, platform = "linux") {
  return evaluateGuard({ cwd: root, ...payload }, { root, config, platform });
}

test("glob patterns match files, directories and nested paths", () => {
  assert.equal(compilePattern("src/config.js").test("src/config.js"), true);
  assert.equal(compilePattern("src/config.js").test("src/config.jsx"), false);
  assert.equal(compilePattern(".github/workflows/**").test(".github/workflows/ci.yml"), true);
  assert.equal(compilePattern(".github/workflows/**").test(".github/workflows-old/ci.yml"), false);
  assert.equal(compilePattern("secrets/").test("secrets/a/b.txt"), true);
  assert.equal(compilePattern("**/prod.env").test("prod.env"), true);
  assert.equal(compilePattern("**/prod.env").test("deploy/eu/prod.env"), true);
  assert.equal(compilePattern("**/prod.env").test("deploy/notprod.env"), false);
  assert.equal(compilePattern("src/*.js").test("src/a/b.js"), false);
});

test("Claude Code file tools are denied only for protected paths", () => {
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: `${root}/src/config.js` } }).decision, "deny");
  assert.equal(decide({ tool_name: "Write", tool_input: { file_path: `${root}/src/other.js` } }).decision, "allow");
  assert.equal(decide({ tool_name: "MultiEdit", tool_input: { file_path: `${root}/secrets/token.txt` } }).decision, "deny");
  assert.equal(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: `${root}/.github/workflows/x.ipynb` } }).decision, "deny");
  assert.equal(decide({ tool_name: "Write", tool_input: { file_path: "/elsewhere/src/config.js" } }).decision, "allow");
});

test("path tricks do not escape the protected set", () => {
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: `${root}/src/../src/./config.js` } }).decision, "deny");
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: "src/config.js" }, cwd: root }).decision, "deny");
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: `${root}/SRC/Config.js` } }, "darwin").decision, "deny");
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: `${root}/SRC/Config.js` } }, "linux").decision, "allow");
});

test("Codex apply_patch headers are parsed relative to the hook cwd", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: docs/readme.md",
    "@@",
    "-a",
    "+b",
    "*** Update File: old/name.js",
    "*** Move to: src/config.js",
    "*** End Patch"
  ].join("\n");
  assert.deepEqual(extractPatchPaths(patch), ["docs/readme.md", "old/name.js", "src/config.js"]);
  const result = decide({ tool_name: "apply_patch", tool_input: { command: patch } });
  assert.equal(result.decision, "deny");
  assert.deepEqual(result.paths, ["src/config.js"]);

  const fromSubdir = decide({
    tool_name: "apply_patch",
    cwd: `${root}/src`,
    tool_input: { command: "*** Begin Patch\n*** Add File: config.js\n+x\n*** End Patch" }
  });
  assert.equal(fromSubdir.decision, "deny");
});

test("unparseable apply_patch input fails closed", () => {
  const result = decide({ tool_name: "apply_patch", tool_input: { command: "not a patch" } });
  assert.equal(result.decision, "deny");
});

test("shell commands are denied only when they can write and mention a protected path", () => {
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "cat src/config.js" } }).decision, "allow");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "npm test 2>&1" } }).decision, "allow");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "sed -i 's/a/b/' src/config.js" } }).decision, "deny");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "echo x >> secrets/key" } }).decision, "deny");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "cd src && perl -pi -e 's/a/b/' config.js" } }).decision, "deny");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "git checkout -- .github/workflows/ci.yml" } }).decision, "deny");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "echo x > build/out.txt" } }).decision, "allow");
});

test("shell checks can be switched off explicitly", () => {
  const off = parseGuardConfig(JSON.stringify({ version: 1, protected: ["src/config.js"], shell: "off" }));
  const result = evaluateGuard(
    { tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ src/config.js" }, cwd: root },
    { root, config: off, platform: "linux" }
  );
  assert.equal(result.decision, "allow");
});

test("guard control files are always protected", () => {
  for (const path of [".agent-proof/protected.json", ".codex/hooks.json", ".claude/settings.json", ".mcp.json", ".bytefence/receipts/a.json", ".bytefence/policy.json"]) {
    assert.equal(isGuardControlPath(path, "linux"), true, path);
    assert.equal(decide({ tool_name: "Write", tool_input: { file_path: `${root}/${path}` } }).decision, "deny", path);
  }
  assert.equal(decide({ tool_name: "Write", tool_input: { file_path: `${root}/.bytefence/intents/a.json` } }).decision, "allow");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "cd .codex && echo {} > hooks.json" } }).decision, "deny");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "cp a/config.toml b/settings.json" } }).decision, "allow");
});

test("MCP tools: agent_proof_kit is allowed, other write tools are checked", () => {
  assert.equal(decide({ tool_name: "mcp__agent_proof_kit__bytefence_apply", tool_input: { intent_path: ".bytefence/intents/a.json" } }).decision, "allow");
  assert.equal(decide({ tool_name: "mcp__filesystem__write_file", tool_input: { path: `${root}/src/config.js`, content: "x" } }).decision, "deny");
  assert.equal(decide({ tool_name: "mcp__filesystem__read_file", tool_input: { path: `${root}/src/config.js` } }).decision, "allow");
});

test("invalid guard configuration is rejected", () => {
  assert.throws(() => parseGuardConfig("{"), GuardConfigError);
  assert.throws(() => parseGuardConfig(JSON.stringify({ version: 1, protected: [] })), GuardConfigError);
  assert.throws(() => parseGuardConfig(JSON.stringify({ version: 1, protected: ["../x"] })), GuardConfigError);
  assert.throws(() => parseGuardConfig(JSON.stringify({ version: 1, protected: ["/etc/passwd"] })), GuardConfigError);
  assert.throws(() => parseGuardConfig(JSON.stringify({ version: 1, protected: ["a"], extra: true })), GuardConfigError);
  assert.throws(() => parseGuardConfig(JSON.stringify({ version: 1, protected: ["a"], shell: "sometimes" })), GuardConfigError);
});

function workspace(protectedJson) {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-guard-"));
  mkdirSync(join(dir, "src"));
  if (protectedJson !== undefined) {
    mkdirSync(join(dir, ".agent-proof"));
    writeFileSync(join(dir, ".agent-proof", "protected.json"), protectedJson);
  }
  return dir;
}

function runGuard(dir, payload, args = []) {
  return spawnSync(process.execPath, [cli, "guard", ...args], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8"
  });
}

test("guard CLI exits 2 with a stderr reason when it blocks", () => {
  const dir = workspace(JSON.stringify({ version: 1, protected: ["src/config.js"] }));
  const blocked = runGuard(dir, { tool_name: "Edit", tool_input: { file_path: join(dir, "src", "config.js") }, cwd: join(dir, "src") });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /blocked Edit: direct write to protected path\(s\): src\/config\.js/);
  assert.match(blocked.stderr, /bytefence_apply/);

  const allowed = runGuard(dir, { tool_name: "Edit", tool_input: { file_path: join(dir, "src", "other.js") }, cwd: dir });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stderr, "");
});

test("guard CLI is a no-op in uninitialized workspaces and fails closed on bad input", () => {
  const plain = workspace();
  assert.equal(runGuard(plain, { tool_name: "Edit", tool_input: { file_path: join(plain, "src", "a.js") }, cwd: plain }).status, 0);

  const dir = workspace(JSON.stringify({ version: 1, protected: ["src/config.js"] }));
  assert.equal(runGuard(dir, "not json", ["--root", dir]).status, 2);

  const broken = workspace("{ broken");
  const result = runGuard(broken, { tool_name: "Write", tool_input: { file_path: join(broken, "src", "x.js") }, cwd: broken });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not valid JSON/);
});
