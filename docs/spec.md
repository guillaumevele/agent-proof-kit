# Agent Run Contract

Agent Proof Kit uses a small vendor-neutral contract for public agent-run fixtures.

Authoritative schemas:

- [schemas/agent-run.schema.json](../schemas/agent-run.schema.json)
- [schemas/policy.schema.json](../schemas/policy.schema.json)

## Agent Run

Required top-level fields:

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Contract version. |
| `runId` | Stable run identifier. |
| `subject` | Human-readable run subject. |
| `synthetic` | Must be `true` for public examples unless the policy explicitly relaxes it. |
| `actions` | Ordered agent actions. |
| `outputs` | Agent outputs and declared claims. |
| `evidence` | Reproducible proof referenced by claims. |

Final outputs should declare public claims in `outputs[].claims[]`. Each claim should reference an `evidence[].id`.

## Policy

The policy maps action types to risk levels:

```json
{
  "actionRisk": {
    "read": "low",
    "write": "medium",
    "network": "high",
    "destructive": "critical"
  }
}
```

Unknown completed action types fail closed. This is intentional: a renamed tool should not bypass a release gate.

## JSONL Adapter

The JSONL adapter accepts synthetic events with an `event` discriminator:

```jsonl
{"event":"session","runId":"normalized-demo-run-001","synthetic":true}
{"event":"action","id":"a1","type":"read","target":"fixtures/demo.md","approval":"not_required","outcome":"completed"}
```

`event` identifies the trace event. `type` remains available for action classification.
