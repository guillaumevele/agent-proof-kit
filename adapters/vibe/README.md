# ByteFence adapter for Mistral Vibe

This adapter exposes one explicit Vibe project tool, `bytefence_apply`. The
tool accepts a unique UTF-8 `old_text`/`new_text` replacement and delegates the
complete protected-file transaction to `agent-proof bytefence-apply` without a
shell. It does not override Vibe's built-in `edit` tool.

The pinned target is `mistral-vibe==2.19.1`, upstream commit
`30792a4cac2c2e5173c6b5a98739fbbf36324545`, on Python 3.12 or later. Vibe's
project-tool and hook APIs are internal or experimental surfaces, so
compatibility is checked explicitly.

## Install the project profile

1. Install the pinned Vibe release and make the reviewed `python3` and
   `agent-proof` executables available on `PATH`.
2. Copy the contents of `project/.vibe/` to the protected project's `.vibe/`.
3. Replace `replace-with-stable-project-id` in `.vibe/config.toml` with a stable,
   non-sensitive workspace identifier.
4. Run the checker with the Python interpreter used by Vibe and the deployed
   project root, from the same environment and `VIBE_HOME` that will launch
   Vibe:
   `python3 /path/to/check_compatibility.py --project-root /path/to/project`.
5. Launch the protected profile without Vibe `--add-dir`, `--enabled-tools` or
   `--disabled-tools` overrides. Trust the project only after reviewing the
   copied files.

Use a dedicated, reviewed `VIBE_HOME` for this profile. Its `hooks.toml` and
`agents/*.toml` must be absent, and its `tools/` must not introduce any allowed
tool-name collision. If `VIBE_HOME/.env` exists, it must be an ordinary regular
file no larger than 1 MiB. It may contain no assignments, or exactly one
non-empty `MISTRAL_API_KEY` assignment; keep every other launch variable outside
that file.

The example profile uses an exact `enabled_tools` allowlist, an explicit empty
`tool_paths`, empty `mcp_servers` and `connectors`, and disables connector
discovery. It disables the configuration orchestrator, fixes agent discovery to
an empty `agent_paths`, enables only the builtin `default` profile and rejects
external agent TOMLs. The pinned builtin default profile disables
`exit_plan_mode`, leaving exactly eight model-facing tools. The profile excludes
native `edit`, `write_file`, `bash`, `task` and remote tools. In Vibe 2.19.1,
`task` constructs a new subagent loop from loaded configuration and can expose a
scratchpad described as writable without permission prompts, so it is not part
of the protected profile. Adding any tool requires a new mutation-surface
review. The strict `before_tool` hook is a second guard for the declared side
doors; it is not the transaction.

The reviewed `skill` implementation only loads skill text and lists files; it
does not execute the skill. `web_fetch` performs HTTP(S) GET requests and
`web_search` calls Mistral's remote web-search API. They remain open-world
network surfaces, but the reviewed 2.19.1 implementations do not write the
local project filesystem.

## Data flow

`bytefence_apply` creates a private intent in the operating-system temporary
directory, containing the raw source fragments supplied to the tool. It uses
mode 0600 on POSIX and the platform `tempfile` defaults elsewhere. It passes that
private path to the broker and attempts to remove it on handled exit or
cancellation. A `SIGKILL` or process crash bypasses that cleanup and can leave
the intent for operating-system or operator removal. The broker alone writes the
protected target and the receipt. The adapter creates missing receipt
directory components under the configured root (mode 0700 on POSIX), validates
them with `lstat`, and rejects symlink traversal or any pre-existing final path,
including a dangling symlink. Broker stdout and stderr are discarded so source
fragments cannot be reflected into the model through this adapter. The tool
returns only status, receipt path and receipt SHA-256.

On broker exit `0`, the adapter reports `committed-and-receipted` only after a
fresh regular receipt remains stable while it is hashed with a 4 MiB read bound.
This confirms the receipt artifact's existence and digest; it does not
semantically reverify the ByteFence Statement. The underlying apply receipt
declares mediation evidence, but its effective guarantee remains `CORE_PROVEN`
by default while `mediationEnvironmentTrusted` is false.

The tool bounds `target_path` at 4096 characters, `workspace_id` at 1024 and
each source fragment at 65,536 characters before creating the temporary intent.
These are memory guards only; the broker's UTF-8 byte limits remain the
authorization rule.

Exit code 3 is surfaced as `committed-unreceipted`. Timeouts, unknown exit codes
and a successful exit without a fresh receipt are treated as unknown commit
states and must not be retried automatically. Cancellation stops the child
process, but a broker cancelled after its rename may already have committed;
inspect the target and receipt before any retry.

## Compatibility and fallback

`check_compatibility.py --project-root <path>` validates the observed deployed
copy, not just the installed Vibe version. It imports and validates the project
tool, checks its fixed security configuration while allowing `workspace_id` to
vary, checks the exact project-tool inventory, allowlist, empty `tool_paths`,
disabled remote sources, agent settings and hook settings, then validates the
effective runtime through Vibe's own models. For a trusted project, Vibe selects
the project `config.toml` instead of merging the user config; the checker
requires that exact selected path and effective configuration. User and
additional-directory hooks are nevertheless composed separately, and user or
project agent files can shadow builtin profiles, so every external hook entry
and agent TOML invalidates this profile.

The checker applies the pinned builtin `default` agent and asks Vibe 2.19.1's
actual `ToolManager` to resolve all nine configured names across builtins, the
project and the current `VIBE_HOME/tools`. Every name must have exactly one
variant, the selected class's origin and SHA-256 must match
`adapter-manifest.json`, and the resulting eight model-facing names must be
exact. It also rejects every non-empty process `VIBE_*` variable except
`VIBE_HOME`, plus non-empty `PYTHONPATH`, `PYTHONHOME`, `NODE_OPTIONS`,
`BASH_ENV`, `ENV`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` and
`DYLD_LIBRARY_PATH`. It safely inspects the selected home's `.env`; symlinks,
special files, oversized or unparsable files, an empty `MISTRAL_API_KEY`, or any
other key fail closed. It has three outcomes:

- exit 0, `protected-explicit-tool`: exact 2.19.1 target and the complete
  observed profile contract match;
- exit 1, `explicit-tool-only-fallback`: the reviewed explicit broker class is
  still selected, but a protected-only condition such as the exact Vibe version,
  another allowed class variant, project-tool inventory or adapter-code digest
  is not established;
- exit 2, `unsupported`: the required project-tool API is absent, the local
  selection context cannot be established, the effective config, hooks,
  environment or agent contract differs, or the reviewed `bytefence_apply`
  class is not the class Vibe selects.

The checker does not authenticate the manifest itself and cannot prove that the
deployed files remain unchanged after the probe. It imports the deployed project
tool during validation, so run it only against a profile that has already been
reviewed; it is not a sandbox for untrusted Python. Relevant environment
overrides are reported by name and invalidate the supported modes. The checker
cannot infer a future Vibe `--add-dir`: pass each observed directory to the
checker with `--add-dir <path>` for diagnostics, but any such directory is
deliberately outside this protected profile and is unsupported.

Vibe 2.19.1 can rank same-name tool variants through `selection_priority`, but
this adapter deliberately does not replace `edit`. The checker never relies on
that ranking for an allowed name: a project, user, configured-path or observed
additional-directory collision invalidates the profile even when the reviewed
class would otherwise win. A collision on `bytefence_apply` is unsupported,
because the explicit broker name no longer identifies the reviewed class.

## Security boundary

`before_tool` can deny before a tool body runs. `after_tool` runs after side
effects and is audit-only; it cannot roll back a mutation. The receipt carries
the byte-integrity evidence, not the hook event.

This profile does not claim a universal session sandbox. Alternate agents,
changed allowlists, newly enabled connectors, IDEs, direct filesystem access and
non-cooperating same-user processes remain outside its boundary. A bare receipt
authenticates neither its producer nor the mediation environment and therefore
remains effectively `CORE_PROVEN` by default. The configured hook commands
resolve `python3` through `PATH`, and the broker command resolves `agent-proof`
through `PATH`. The checker verifies those command strings but does not attest
the executables they resolve to. `PATH`, the Vibe/checker Python interpreter and
the ByteFence broker are therefore explicit roots of trust; a successful
compatibility report does not promote the effective guarantee above
`CORE_PROVEN`. A deployment that pins an absolute verified executable must
review and update its local manifest contract together; the checked-in manifest
will intentionally reject that change instead of silently blessing it.
