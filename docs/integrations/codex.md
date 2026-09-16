# Codex CLI Integration

Agent Proof Kit works with [Codex CLI](https://developers.openai.com/codex) in
two independent directions:

1. **During the run:** Codex calls the local `agent_proof_kit` MCP server, so
   edits to protected files go through ByteFence (`bytefence_apply`) and leave a
   verifiable receipt.
2. **After the run:** the `codex-exec-jsonl` trace adapter turns the
   `codex exec --json` event stream into an Agent Proof Kit run that CI can gate
   with a policy.

Both paths are local. The kit never calls a model provider; only Codex does.

## Evidence status

| Claim | Evidence |
| --- | --- |
| `examples/codex/config.toml` is a valid Codex MCP configuration | Accepted by `codex exec --strict-config` and resolved by `codex mcp get --json` on Codex CLI 0.153.4 (an unknown key is rejected by the same check). |
| Codex starts the MCP server from that configuration | With `required = true` pointing at `bin/agent-proof-mcp.js`, Codex CLI 0.153.4 completed the MCP handshake and started the thread; the same configuration with a broken server path aborted with `required MCP servers failed to initialize`. |
| The trace adapter matches the `codex exec --json` schema | Written against `codex-rs/exec/src/exec_events.rs` at tag `rust-v0.153.4`; the stream envelope (`thread.started`, `turn.started`, `item.completed`, `error`, `turn.failed`) was also observed from a real Codex CLI 0.153.4 run. |
| The adapter understands real `bytefence_apply` results | `tests/adapter/codex-exec.test.js` starts the MCP server, performs committed and refused applies, wraps the real tool results in Codex `mcp_tool_call` items and gates them. |
| `agent-proof init --agent codex` guard hook blocks `apply_patch` and shell writes to protected paths | Hook payload and decision handling follow `codex-rs/hooks` at `rust-v0.153.4` (`tool_input.command` carries the raw patch; exit 2 with a stderr reason blocks). Unit tests cover the decisions. Not yet exercised with a live Codex model run. |
| `examples/codex/run-demo.sh` checks target bytes, receipt and trace | The script's verification chain is exercised with a Codex stand-in. A recorded model-driven run is not yet checked in. |

Not claimed: that a given model always follows the `AGENTS.md` protocol, that
the MCP process is sandboxed, or that shell commands cannot write files.

## 1. Enable the MCP server

Merge [examples/codex/config.toml](../../examples/codex/config.toml) into
`~/.codex/config.toml` (or a trusted project's `.codex/config.toml`) and set
`AGENT_PROOF_ROOT` to the absolute repository path:

```toml
[mcp_servers.agent_proof_kit]
command = "npx"
args = ["--yes", "--package", "agent-proof-kit@0.7.0", "agent-proof-mcp"]
startup_timeout_sec = 30
required = true
enabled_tools = ["agent_proof_status", "bytefence_check", "bytefence_apply"]

[mcp_servers.agent_proof_kit.env]
AGENT_PROOF_ROOT = "/absolute/path/to/repository"
```

Check what Codex resolved:

```bash
codex mcp get agent_proof_kit --json
```

`required = true` makes Codex stop if the server cannot start, instead of
continuing without the ByteFence tools. `enabled_tools` keeps the model-facing surface to the status probe and the two
ByteFence tools. The optional-write tools of the server stay hidden.

`codex exec` cannot show approval prompts. The example pre-approves
`bytefence_apply`; remove that table if an interactive Codex session should ask
before each mediated write.

## 2. Tell Codex which files are protected

Copy the protocol in [examples/codex/AGENTS.md](../../examples/codex/AGENTS.md)
into the repository's `AGENTS.md` and list the protected paths. Codex then:

1. writes a private `exactReplace` intent under `.bytefence/intents/`,
2. calls `bytefence_apply` with a fresh receipt path,
3. reports `status`, `exitCode` and `effectiveGuaranteeLevel`, and never falls
   back to a direct edit or retries after an uncertain result.

Two details matter in practice and are spelled out in the protocol:

- The intent `$schema` URL is part of the contract and must match exactly.
- The default policy denies an `oldText` larger than 25% of the file, so a
  one-line change in a tiny file needs the smallest unique `oldText`.

## 2b. Block direct edits with the guard hook

`npx agent-proof-kit init --agent codex --protect "<paths>"` writes the MCP server,
the `AGENTS.md` protocol and a project `.codex/hooks.json` with a `PreToolUse`
guard on `apply_patch|Bash|mcp__.*`. Trust the hook once with `/hooks`; Codex
skips untrusted project hooks, including under `codex exec`. See
[Agent Guard](guard.md) for the rules and limits.

Hook enforcement in Codex has been reported as inconsistent across versions and
platforms ([openai/codex#27833](https://github.com/openai/codex/issues/27833)).
Keep the strict CI gate below even when the hook is installed.

## 3. Gate the run in CI

```bash
npm install --save-dev agent-proof-kit@0.7.0
codex exec --json "..." < /dev/null > codex-exec.jsonl
npx agent-proof export --from codex-exec-jsonl --input codex-exec.jsonl --out codex-run.json
npx agent-proof verify --input codex-run.json \
  --policy node_modules/agent-proof-kit/policies/codex-bytefence-strict-policy.json
```

`codex exec` also reads piped stdin, so redirect it from `/dev/null` in scripts.

The adapter maps Codex items as follows:

| Codex item | Agent Proof Kit action | Notes |
| --- | --- | --- |
| `command_execution` | `command` | Command text only. Output is not exported; risk is not inferred from the command. `declined` becomes `refused`. |
| `file_change` (`add`, `update`) | `unmediated_write` | One action per changed path. |
| `file_change` (`delete`) | `destructive` | Critical in every bundled policy unless approved. |
| `mcp_tool_call` `bytefence_apply` | `write` | `completed` only for `status: "allow"`, `exitCode: 0` and a persisted receipt; refused applies become `blocked`. |
| `mcp_tool_call` `bytefence_check` | `read` | |
| other `mcp_tool_call` | `mcp_tool` | Arguments are not exported. |
| `web_search` | `network` | The query is not exported. |
| `collab_tool_call` | `subagent` | Prompts are not exported. |
| `agent_message` | output on channel `codex` | |
| `turn.completed`, `turn.failed`, `error` | evidence | Token counts, or failing evidence with the error message. |
| `reasoning`, `todo_list` | not exported | |
| any other item type | `codex_item:<type>` | Not classified by any bundled policy, so the gate fails until a reviewer adds it. |

Items that start but never complete are exported with outcome `incomplete`.
Codex does not record approvals in the exec stream, so every action carries
`approval: "not_recorded"`.

Bundled policies:

| Policy | Purpose |
| --- | --- |
| [`policies/codex-exec-policy.json`](../../policies/codex-exec-policy.json) | Baseline for real Codex traces: web search, deletions and unknown item types fail; direct patches are medium risk. |
| [`policies/codex-bytefence-strict-policy.json`](../../policies/codex-bytefence-strict-policy.json) | Same, but any direct `file_change` fails the gate. Use it with the `AGENTS.md` protocol. |

Both set `requireSyntheticFixture: false` because a Codex trace is a real run.
The default synthetic policy fails such traces on purpose.

The exported run can still contain command lines and agent messages. Pass
private terms with `--redact-terms` and run `agent-proof scan` before
publishing it.

### Limits of the strict gate

The strict policy detects edits that Codex reports as `file_change`. A shell
command such as `sed -i` in a `workspace-write` sandbox changes files without a
`file_change` item. Pair the gate with a check that the protected paths in
`git diff` are covered by ByteFence receipts, or run Codex with a sandbox that
cannot write those paths.

## End-to-end demo

```bash
npm ci
examples/codex/run-demo.sh
```

The script creates a throwaway git workspace, asks `codex exec` to flip one
protected flag through the MCP server, then requires all three checks to pass:
the target equals the only authorized candidate, `bytefence-verify` returns
`verified`, and the exported trace passes the strict policy. It uses the normal
quota of the logged-in Codex account.

## References

- Codex MCP configuration: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Codex non-interactive mode and `--json`: https://learn.chatgpt.com/docs/non-interactive-mode
- Event schema: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/exec_events.rs
