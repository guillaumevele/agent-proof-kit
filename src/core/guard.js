import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROTECTED_CONFIG_PATH } from "./project-root.js";

// PreToolUse guard shared by Claude Code and Codex CLI hooks.
//
// The guard only decides whether a tool call would write a protected path
// directly. Edits to protected paths are expected to go through the
// agent_proof_kit MCP server (`bytefence_apply`), which is never blocked here.

export const GUARD_CONFIG_VERSION = 1;
export const SHELL_MODES = ["block-writes", "off"];

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "shell", "exec_command", "local_shell"]);
const MCP_WRITE_WORDS = /(write|edit|create|move|rename|delete|remove|patch|replace|append|update|upload|put|save)/i;
const OWN_MCP_SERVER = /^mcp__agent[_-]proof[_-]kit__/;

// Shell fragments that can change file contents or directory entries.
const SHELL_WRITE_PATTERNS = [
  /(^|[^<>&0-9])>{1,2}(?!&)/, // redirection (not >&2 style fd dups)
  /\btee\b/,
  /\bsed\b[^|;&]*\s-[a-zA-Z]*i/,
  /\bperl\b[^|;&]*\s-[a-zA-Z]*i/,
  /\b(mv|cp|rm|rmdir|ln|install|truncate|dd|chmod|chown|touch|unlink|shred|rsync)\b/,
  /\bgit\s+(checkout|restore|reset|apply|am|mv|rm|stash|clean|merge|rebase|cherry-pick|revert|pull)\b/,
  /\b(python3?|node|ruby|perl|php|deno|bun)\b[^|;&]*\s(-c|-e|--eval)\b/,
  /\b(Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|Clear-Content)\b/i,
  /\bpatch\b/,
  /\bxargs\b/,
  /\bfind\b[^|;&]*\s-(delete|exec)\b/
];

// Files that define or evidence the protection itself. An agent that could edit
// them could switch the guard off, so they are always protected, both from
// direct writes (guard) and from bytefence_apply (MCP server).
export const GUARD_CONTROL_PATTERNS = [
  ".agent-proof/**",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  ".bytefence/policy.json",
  ".bytefence/receipts/**"
];

export function isGuardControlPath(relPath, platform = process.platform) {
  const caseInsensitive = platform === "darwin" || platform === "win32";
  return GUARD_CONTROL_PATTERNS.some((pattern) => compilePattern(pattern, caseInsensitive).test(relPath));
}

export class GuardConfigError extends Error {}

export function loadGuardConfig(root) {
  const path = join(root, PROTECTED_CONFIG_PATH);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new GuardConfigError(`cannot read ${PROTECTED_CONFIG_PATH}: ${error.message}`);
  }
  return parseGuardConfig(raw);
}

export function parseGuardConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GuardConfigError(`${PROTECTED_CONFIG_PATH} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GuardConfigError(`${PROTECTED_CONFIG_PATH} must be a JSON object`);
  }
  const allowed = new Set(["version", "protected", "shell"]);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new GuardConfigError(`${PROTECTED_CONFIG_PATH}: unknown key "${key}"`);
  }
  if (parsed.version !== GUARD_CONFIG_VERSION) {
    throw new GuardConfigError(`${PROTECTED_CONFIG_PATH}: "version" must be ${GUARD_CONFIG_VERSION}`);
  }
  if (!Array.isArray(parsed.protected) || parsed.protected.length === 0 ||
      !parsed.protected.every((item) => typeof item === "string" && item.trim() !== "")) {
    throw new GuardConfigError(`${PROTECTED_CONFIG_PATH}: "protected" must be a non-empty array of path patterns`);
  }
  for (const pattern of parsed.protected) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
      throw new GuardConfigError(`${PROTECTED_CONFIG_PATH}: pattern "${pattern}" must be relative and must not contain ".."`);
    }
  }
  const shell = parsed.shell ?? "block-writes";
  if (!SHELL_MODES.includes(shell)) {
    throw new GuardConfigError(`${PROTECTED_CONFIG_PATH}: "shell" must be one of ${SHELL_MODES.join(", ")}`);
  }
  return { version: GUARD_CONFIG_VERSION, protected: parsed.protected.map(normalizePattern), shell };
}

export function evaluateGuard(payload, { root, config, platform = process.platform }) {
  const toolName = String(payload?.tool_name ?? "");
  const input = payload?.tool_input ?? {};
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : root;
  const caseInsensitive = platform === "darwin" || platform === "win32";
  const patterns = [...new Set([...config.protected, ...GUARD_CONTROL_PATTERNS])];
  const matchers = patterns.map((pattern) => compilePattern(pattern, caseInsensitive));
  const isProtected = (relPath) => matchers.some((matcher) => matcher.test(relPath));
  const toRel = (candidate) => toRootRelative(candidate, cwd, root);

  if (OWN_MCP_SERVER.test(toolName)) {
    return allow(toolName, "agent_proof_kit MCP tools are the sanctioned write path");
  }

  if (FILE_TOOLS.has(toolName)) {
    const paths = [input.file_path, input.notebook_path, ...(Array.isArray(input.edits) ? input.edits.map((edit) => edit?.file_path) : [])]
      .filter((value) => typeof value === "string" && value);
    return decideForPaths(toolName, paths.map(toRel), isProtected);
  }

  if (toolName === "apply_patch") {
    const patch = typeof input.command === "string" ? input.command : typeof input.patch === "string" ? input.patch : "";
    const paths = extractPatchPaths(patch);
    if (paths.length === 0 && patch.trim() !== "") {
      return deny(toolName, [], "apply_patch input could not be parsed; refusing to guess which files it writes");
    }
    return decideForPaths(toolName, paths.map(toRel), isProtected);
  }

  if (SHELL_TOOLS.has(toolName)) {
    if (config.shell === "off") return allow(toolName, "shell checks disabled");
    const command = Array.isArray(input.command) ? input.command.join(" ") : String(input.command ?? "");
    if (!SHELL_WRITE_PATTERNS.some((pattern) => pattern.test(command))) {
      return allow(toolName, "no write-capable shell construct");
    }
    const hits = [
      ...shellMentions(command, config.protected, caseInsensitive, true),
      ...shellMentions(command, GUARD_CONTROL_PATTERNS, caseInsensitive, false)
    ];
    if (hits.length === 0) return allow(toolName, "write-capable command does not mention a protected path");
    return deny(toolName, hits, `shell command can write and mentions protected path(s): ${hits.join(", ")}`);
  }

  if (toolName.startsWith("mcp__") && MCP_WRITE_WORDS.test(toolName.split("__").pop() ?? "")) {
    const strings = collectStrings(input);
    const paths = strings.filter((value) => /[\\/.]/.test(value) && value.length < 4096).map(toRel);
    return decideForPaths(toolName, paths, isProtected);
  }

  return allow(toolName, "tool does not write files");
}

function decideForPaths(toolName, relPaths, isProtected) {
  const hits = [...new Set(relPaths.filter((relPath) => relPath !== null && isProtected(relPath)))];
  if (hits.length === 0) return allow(toolName, "no protected path");
  return deny(toolName, hits, `direct write to protected path(s): ${hits.join(", ")}`);
}

export function denialMessage(result) {
  const control = result.paths.length > 0 && result.paths.every((path) =>
    GUARD_CONTROL_PATTERNS.includes(path) || isGuardControlPath(path));
  if (control) {
    return [
      `agent-proof guard blocked ${result.tool}: ${result.reason}.`,
      "These files configure or evidence the guard itself. A human must change them outside the agent.",
      "Do not retry this edit with another tool."
    ].join(" ");
  }
  return [
    `agent-proof guard blocked ${result.tool}: ${result.reason}.`,
    "Protected files must be changed through ByteFence: write an exactReplace intent under",
    ".bytefence/intents/ and call the agent_proof_kit MCP tool bytefence_apply (see AGENTS.md or CLAUDE.md).",
    "Do not retry this edit with another tool."
  ].join(" ");
}

export function extractPatchPaths(patch) {
  const paths = [];
  for (const line of String(patch).split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/.exec(line);
    if (match) paths.push(match[1]);
  }
  return paths;
}

function toRootRelative(candidate, cwd, root) {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  const rel = relative(resolve(root), absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return rel === "" ? "." : null;
  return rel.split(sep).join("/");
}

function normalizePattern(pattern) {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function compilePattern(pattern, caseInsensitive = false) {
  const directory = pattern.endsWith("/");
  let body = "";
  const source = directory ? pattern.slice(0, -1) : pattern;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        body += "(?:.*/)?";
        index += 2;
      } else {
        body += ".*";
        index += 1;
      }
    } else if (char === "*") {
      body += "[^/]*";
    } else if (char === "?") {
      body += "[^/]";
    } else {
      body += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const hasGlob = /[*?]/.test(source);
  const suffix = directory || !hasGlob ? "(?:/.*)?" : "";
  return new RegExp(`^${body}${suffix}$`, caseInsensitive ? "i" : "");
}

// Basenames distinctive enough to match on their own for guard control files.
const DISTINCTIVE_CONTROL_BASENAMES = new Set(["protected.json", "hooks.json", ".mcp.json", "settings.local.json"]);

function shellMentions(command, patterns, caseInsensitive, matchBasenames) {
  const haystack = caseInsensitive ? command.toLowerCase() : command;
  const hits = [];
  for (const pattern of patterns) {
    // Use the longest literal fragment of the pattern as the needle, so that
    // "**/prod.env" is found by "prod.env" and "src/**" by "src".
    const literal = pattern.split(/[*?]/)
      .map((fragment) => fragment.replace(/^\/+|\/+$/g, ""))
      .sort((a, b) => b.length - a.length)[0] ?? "";
    if (!literal) {
      hits.push(pattern);
      continue;
    }
    const needle = caseInsensitive ? literal.toLowerCase() : literal;
    const base = needle.split("/").pop();
    const baseMatches = base && base.includes(".") && haystack.includes(base) &&
      (matchBasenames || DISTINCTIVE_CONTROL_BASENAMES.has(base));
    if (haystack.includes(needle) || baseMatches) {
      hits.push(pattern);
    }
  }
  return hits;
}

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, out));
  return out;
}

function allow(tool, reason) {
  return { decision: "allow", tool, paths: [], reason };
}

function deny(tool, paths, reason) {
  return { decision: "deny", tool, paths, reason };
}
