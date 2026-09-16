# Agent Guard

`agent-proof guard` is a `PreToolUse` hook for Claude Code and Codex CLI. It
blocks tool calls that would write a protected path directly, so the only way to
change those files is the `bytefence_apply` MCP tool.

## Set up

```bash
npx agent-proof-kit init --agent claude --protect "src/config.js,.github/workflows/**"
npx agent-proof-kit init --agent codex  --protect "src/config.js"
npx agent-proof-kit init --agent all    --protect "infra/**" --dry-run
```

`init` creates or merges, and never silently replaces:

| File | Agent | Content |
| --- | --- | --- |
| `.agent-proof/protected.json` | all | Protected path patterns (kept if it exists, unless `--force`) |
| `.bytefence/policy.json`, `.bytefence/intents/`, `.bytefence/receipts/` | all | Default ByteFence policy and folders |
| `CLAUDE.md` / `AGENTS.md` | claude / codex | Edit protocol between `agent-proof-kit` markers |
| `.claude/settings.json` | claude | `PreToolUse` hook, merged with existing hooks and permissions |
| `.mcp.json` | claude | `agent_proof_kit` MCP server |
| `.codex/hooks.json` | codex | `PreToolUse` hook |
| `.codex/config.toml` | codex | `agent_proof_kit` MCP server, `required = true` |

Running `init` twice changes nothing. If the project already lists
`agent-proof-kit` as a dependency, the hooks call `npx --no-install`; otherwise
they pin the installed version with `npx --yes --package`.

After `init`:

- **Claude Code** asks you to approve the project MCP server. `/hooks` shows the guard.
- **Codex CLI** runs project hooks only after you trust them with `/hooks`.
  Untrusted hooks do not run, including under `codex exec`.

## `protected.json`

```json
{
  "version": 1,
  "protected": ["src/config.js", ".github/workflows/**", "secrets/", "**/prod.env"],
  "shell": "block-writes"
}
```

- Patterns are relative to the directory that contains `.agent-proof/`.
  `*` stays within one path segment, `**` crosses segments, a trailing `/`
  protects a directory. `..` and absolute patterns are rejected.
- Matching is case-insensitive on macOS and Windows.
- `shell: "off"` disables the shell heuristic below.
- An invalid file blocks the matched tool calls until a human fixes it.

## What is blocked

| Tool | Rule |
| --- | --- |
| Claude Code `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `file_path` / `notebook_path` is protected |
| Codex `apply_patch` | Any `*** Add/Update/Delete File:` or `*** Move to:` path is protected, resolved from the hook `cwd`. Unparseable patches are blocked. |
| `Bash` (both), `PowerShell` | The command contains a write-capable construct (`>`, `tee`, `sed -i`, `perl -i`, `mv`, `cp`, `rm`, `git checkout`/`restore`/`apply`, `python -c`, `node -e`, `Set-Content`, ...) **and** mentions a protected path or its file name |
| Other MCP tools whose name contains write, edit, create, move, delete, patch... | A string argument resolves to a protected path |
| `agent_proof_kit` MCP tools | Always allowed: they are the sanctioned path |

The guard always protects its own control files as well: `.agent-proof/**`,
`.codex/hooks.json`, `.codex/config.toml`, `.claude/settings.json`,
`.claude/settings.local.json`, `.mcp.json`, `.bytefence/policy.json` and
`.bytefence/receipts/**`.

When a workspace has been initialized, the MCP server adds two rules to
`bytefence_apply`: the intent may not target one of those control files, and
`policy_path` must be `.bytefence/policy.json`. An agent therefore cannot use the
sanctioned path to remove a protection or to bring its own looser policy.

A blocked call exits with code 2 and a reason on stderr, which both Claude Code
and Codex feed back to the model.

## Limits

- The shell rule is a heuristic. A command that writes a protected file without
  naming it (a script file, a variable, `find -exec` on a parent directory) can
  pass. Pair the guard with the strict CI gate and review.
- Hooks run only where the host runs them: untrusted Codex hooks, disabled
  hooks, or an agent started outside the repository are not covered.
- The guard does not sandbox processes or network access.
- Workspaces without `.agent-proof/protected.json` are ignored, so a global
  hook installation is harmless elsewhere.
