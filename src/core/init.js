import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_CONFIG_VERSION, parseGuardConfig } from "./guard.js";
import { PROTECTED_CONFIG_PATH } from "./project-root.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const INIT_AGENTS = ["codex", "claude"];
const MARKER_START = "<!-- agent-proof-kit:start -->";
const MARKER_END = "<!-- agent-proof-kit:end -->";
const GUARD_TOOL_MATCHERS = {
  codex: "apply_patch|Bash|mcp__.*",
  claude: "Edit|Write|MultiEdit|NotebookEdit|Bash|mcp__.*"
};

// Plans the files `agent-proof init` would create or update. Nothing is written
// here; `applyInitPlan` performs the writes. Existing files are merged, never
// replaced, except for the marked agent-proof-kit block in AGENTS.md/CLAUDE.md.
export function planInit({ root, agents, protect, packageSpec, shell = "block-writes", force = false }) {
  const selected = normalizeAgents(agents);
  const config = parseGuardConfig(JSON.stringify({ version: GUARD_CONFIG_VERSION, protected: protect, shell }));
  const version = packageSpec ?? `agent-proof-kit@${readPackageVersion()}`;
  const hasLocalDependency = packageDeclaresKit(root);
  const guardCommand = hasLocalDependency
    ? "npx --no-install agent-proof guard"
    : `npx --yes --package ${version} agent-proof guard`;
  const mcpArgs = hasLocalDependency
    ? ["--no-install", "agent-proof-mcp"]
    : ["--yes", "--package", version, "agent-proof-mcp"];

  const operations = [];
  const push = (path, compute) => {
    const absolute = join(root, path);
    const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    const result = compute(current);
    if (result === null || result.content === current) {
      operations.push({ path, action: "keep", note: result?.note ?? "already configured" });
    } else {
      operations.push({ path, action: current === null ? "create" : "update", content: result.content, note: result.note });
    }
  };

  let effective = config;
  push(PROTECTED_CONFIG_PATH, (current) => {
    const content = `${JSON.stringify(config, null, 2)}\n`;
    if (current !== null && !force) {
      effective = parseGuardConfig(current);
      return { content: current, note: `existing protected paths kept: ${effective.protected.join(", ")} (use --force to replace)` };
    }
    return { content, note: `protects ${config.protected.join(", ")}` };
  });
  push(".bytefence/policy.json", (current) => current !== null ? null : { content: readFileSync(join(packageRoot, "policies/bytefence-default.json"), "utf8"), note: "default ByteFence policy" });
  push(".bytefence/intents/.gitkeep", (current) => current !== null ? null : { content: "", note: "private intents written by the agent" });
  push(".bytefence/receipts/.gitkeep", (current) => current !== null ? null : { content: "", note: "ByteFence receipts" });

  const protocol = renderProtocol(effective.protected);
  if (selected.includes("codex")) {
    push("AGENTS.md", (current) => upsertMarkedBlock(current, protocol));
    push(".codex/config.toml", (current) => {
      if (current && /^\s*\[mcp_servers\.agent_proof_kit\]/m.test(current)) return null;
      const block = [
        "[mcp_servers.agent_proof_kit]",
        'command = "npx"',
        `args = ${JSON.stringify(mcpArgs)}`,
        "startup_timeout_sec = 30",
        "required = true",
        'enabled_tools = ["agent_proof_status", "bytefence_check", "bytefence_apply"]',
        "",
        "[mcp_servers.agent_proof_kit.tools.bytefence_check]",
        'approval_mode = "approve"',
        "",
        "[mcp_servers.agent_proof_kit.tools.bytefence_apply]",
        'approval_mode = "approve"',
        ""
      ].join("\n");
      return { content: current ? `${current.replace(/\n*$/, "\n\n")}${block}` : block, note: "agent_proof_kit MCP server" };
    });
    push(".codex/hooks.json", (current) => mergeHooks(current, GUARD_TOOL_MATCHERS.codex, guardCommand));
  }
  if (selected.includes("claude")) {
    push("CLAUDE.md", (current) => upsertMarkedBlock(current, protocol));
    push(".mcp.json", (current) => {
      const parsed = parseJsonObject(current, ".mcp.json");
      parsed.mcpServers ??= {};
      if (parsed.mcpServers.agent_proof_kit) return null;
      parsed.mcpServers.agent_proof_kit = { command: "npx", args: mcpArgs };
      return { content: `${JSON.stringify(parsed, null, 2)}\n`, note: "agent_proof_kit MCP server" };
    });
    push(".claude/settings.json", (current) => mergeHooks(current, GUARD_TOOL_MATCHERS.claude, guardCommand));
  }

  return { root, agents: selected, protected: effective.protected, guardCommand, operations };
}

export function applyInitPlan(plan) {
  for (const operation of plan.operations) {
    if (operation.action === "keep") continue;
    const absolute = join(plan.root, operation.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, operation.content);
  }
}

export function renderInitSummary(plan, { dryRun }) {
  const lines = [dryRun ? "agent-proof init (dry run, nothing written)" : "agent-proof init"];
  for (const operation of plan.operations) {
    lines.push(`  ${operation.action.padEnd(6)} ${operation.path}${operation.note ? `  (${operation.note})` : ""}`);
  }
  lines.push("", "Next steps:");
  if (plan.agents.includes("codex")) {
    lines.push("  - Codex: start `codex` in this repository and trust the new hook with /hooks.",
      "    Untrusted project hooks do not run, including under `codex exec`.");
  }
  if (plan.agents.includes("claude")) {
    lines.push("  - Claude Code: approve the agent_proof_kit server from .mcp.json when prompted; /hooks lists the guard.");
  }
  lines.push("  - Commit the generated files so every contributor gets the same protection.");
  return `${lines.join("\n")}\n`;
}

function normalizeAgents(agents) {
  const list = (Array.isArray(agents) ? agents : [agents]).flatMap((item) => String(item ?? "").split(","))
    .map((item) => item.trim().toLowerCase()).filter(Boolean);
  const expanded = list.includes("all") ? [...INIT_AGENTS] : list;
  if (expanded.length === 0) throw new Error("Choose at least one agent: --agent codex, claude or all");
  for (const agent of expanded) {
    if (!INIT_AGENTS.includes(agent)) throw new Error(`Unsupported --agent value: ${agent}. Supported: codex, claude, all`);
  }
  return [...new Set(expanded)];
}

function mergeHooks(current, matcher, command) {
  const parsed = parseJsonObject(current, "hooks settings");
  parsed.hooks ??= {};
  parsed.hooks.PreToolUse ??= [];
  if (!Array.isArray(parsed.hooks.PreToolUse)) throw new Error("hooks.PreToolUse must be an array");
  const already = parsed.hooks.PreToolUse.some((entry) =>
    (entry?.hooks ?? []).some((hook) => typeof hook?.command === "string" && hook.command.includes("agent-proof guard")));
  if (already) return null;
  parsed.hooks.PreToolUse.push({
    matcher,
    hooks: [{ type: "command", command, timeout: 30 }]
  });
  return { content: `${JSON.stringify(parsed, null, 2)}\n`, note: "PreToolUse guard for protected paths" };
}

function parseJsonObject(current, label) {
  if (current === null || current.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(current);
  } catch (error) {
    throw new Error(`${label} is not valid JSON; fix it before running init (${error.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function upsertMarkedBlock(current, block) {
  const wrapped = `${MARKER_START}\n${block}${MARKER_END}\n`;
  if (current === null) return { content: wrapped, note: "ByteFence edit protocol" };
  const start = current.indexOf(MARKER_START);
  const end = current.indexOf(MARKER_END);
  if (start !== -1 && end > start) {
    const next = `${current.slice(0, start)}${wrapped}${current.slice(end + MARKER_END.length).replace(/^\n/, "")}`;
    if (next === current) return null;
    return { content: next, note: "ByteFence edit protocol refreshed" };
  }
  return { content: `${current.replace(/\n*$/, "\n\n")}${wrapped}`, note: "ByteFence edit protocol appended" };
}

export function renderProtocol(protectedPaths) {
  return `## Protected files (agent-proof-kit)

These paths must never be edited directly (no Edit/Write, apply_patch, shell
redirection or \`sed -i\`). A PreToolUse hook blocks direct writes:

${protectedPaths.map((path) => `- \`${path}\``).join("\n")}

To change one of them:

1. Pick the smallest \`oldText\` that occurs exactly once in the file (at most
   25% of the file under the default policy). Keep indentation and line endings.
2. Write a new intent file \`.bytefence/intents/<short-name>.json\`:

   \`\`\`json
   {
     "$schema": "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json",
     "operation": "exactReplace",
     "targetPath": "path/relative/to/repo",
     "encoding": "utf-8",
     "oldText": "exact old text",
     "newText": "exact new text",
     "expectedOccurrences": 1
   }
   \`\`\`

3. Call the \`bytefence_apply\` tool of the \`agent_proof_kit\` MCP server with
   \`intent_path\`, \`policy_path: ".bytefence/policy.json"\`, a repository
   \`workspace_id\` and a new \`receipt_path\` under \`.bytefence/receipts/\`.
4. Report \`status\`, \`exitCode\` and \`effectiveGuaranteeLevel\`. If the status is
   not \`allow\`, stop and explain the finding codes. Never fall back to a direct
   edit, and never retry after \`exitCode: 3\`.
`;
}

function readPackageVersion() {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
}

function packageDeclaresKit(root) {
  const path = join(root, "package.json");
  if (!existsSync(path)) return false;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return Boolean(manifest.dependencies?.["agent-proof-kit"] || manifest.devDependencies?.["agent-proof-kit"]);
  } catch {
    return false;
  }
}
