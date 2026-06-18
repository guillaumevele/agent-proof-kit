# Trace Adapters

Agent Proof Kit does not require provider APIs. Public examples should be normalized into the local Agent Run contract before evaluation.

## Current Adapter

```bash
node bin/agent-proof.js normalize --input examples/synthetic-agent-events.jsonl --out docs/generated/normalized-agent-run.json
```

The JSONL adapter is deliberately small and deterministic. It preserves event order and fails with line numbers for invalid JSON.

For onboarding a repository, prefer the `export` command. It normalizes a supported trace source into the Agent Proof Kit fixture contract and can redact configured terms before writing the result:

```bash
node bin/agent-proof.js export \
  --from agent-proof-jsonl \
  --input examples/synthetic-agent-events.jsonl \
  --redact-terms internal-codename,customer-name \
  --out agent-run.synthetic.json
```

Supported `--from` values:

| Source | Status | Notes |
| --- | --- | --- |
| `agent-proof-jsonl` | Stable | JSONL events using the documented `session`, `objective`, `input`, `action`, `output` and `evidence` event types. |
| `generic-jsonl` | Stable alias | Same parser as `agent-proof-jsonl`, useful when a team exports equivalent fields from its own trace system. |
| `langgraph-stream` | Stable fixture adapter | Normalizes LangGraph `stream()` update chunks shaped as node-name to update payload objects. |
| `crewai-events` | Stable fixture adapter | Normalizes CrewAI event-listener records such as crew kickoff, agent execution completed and crew completion events. |
| `autogen-run-stream` | Stable fixture adapter | Normalizes Microsoft AutoGen `run_stream()` messages and final `TaskResult` records. |

The exporter is synthetic-first. It does not promise to sanitize arbitrary production logs by itself; pass known private terms through `--redact-terms`, review the output, and run `agent-proof scan` before committing a fixture.

## MCP Workflow

The MCP server exposes the same workflow through `agent_proof_export_trace`. Assistants can normalize a JSONL trace, redact terms, write the fixture under the workspace root, then immediately run `agent_proof_verify_run`.

## Framework Adapter Fixtures

Checked-in synthetic fixtures cover the supported framework surfaces:

- [LangGraph stream fixture](../../examples/adapters/langgraph-stream.json)
- [CrewAI events fixture](../../examples/adapters/crewai-events.jsonl)
- [AutoGen run_stream fixture](../../examples/adapters/autogen-run-stream.jsonl)

The adapters are intentionally conservative. They map observed framework execution records into low-risk
Agent Proof Kit actions, evidence items and synthetic outputs. They do not infer hidden tool calls or
sanitize arbitrary production logs by themselves.

Official references used to define the supported surfaces:

- LangGraph streaming: https://docs.langchain.com/oss/python/langgraph/streaming
- CrewAI event listeners: https://docs.crewai.com/en/concepts/event-listener
- AutoGen agent run_stream: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html
- AutoGen team run_stream: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html

## OpenAI Agents And OpenTelemetry Shape

The public fixture [examples/adapters/openai-agents-trace-shape.json](../../examples/adapters/openai-agents-trace-shape.json) is a synthetic shape reference only. It does not contain real traces.

OpenAI Agents tracing and OpenTelemetry both use trace/span concepts. Real traces can contain sensitive model inputs, outputs and tool-call data, so public normalization should redact before commit.

LlamaIndex Workflows and native OpenTelemetry are intentionally kept on the roadmap until their trace
shapes are verified against current public docs or fixtures. The supported path today is to export one of
the documented framework surfaces above, run `agent-proof export`, then verify the generated fixture.

Official references:

- https://openai.github.io/openai-agents-python/tracing/
- https://openai.github.io/openai-agents-js/guides/tracing/
- https://opentelemetry.io/docs/concepts/signals/traces/
