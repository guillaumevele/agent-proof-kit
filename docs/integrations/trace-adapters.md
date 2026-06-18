# Trace Adapters

Agent Proof Kit does not require provider APIs. Public examples should be normalized into the local Agent Run contract before evaluation.

## Current Adapter

```bash
node bin/agent-proof.js normalize --input examples/synthetic-agent-events.jsonl --out docs/generated/normalized-agent-run.json
```

The JSONL adapter is deliberately small and deterministic. It preserves event order and fails with line numbers for invalid JSON.

## OpenAI Agents And OpenTelemetry Shape

The public fixture [examples/adapters/openai-agents-trace-shape.json](../../examples/adapters/openai-agents-trace-shape.json) is a synthetic shape reference only. It does not contain real traces.

OpenAI Agents tracing and OpenTelemetry both use trace/span concepts. Real traces can contain sensitive model inputs, outputs and tool-call data, so public normalization should redact before commit.

Official references:

- https://openai.github.io/openai-agents-python/tracing/
- https://openai.github.io/openai-agents-js/guides/tracing/
- https://opentelemetry.io/docs/concepts/signals/traces/
