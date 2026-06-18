# Agent Proof Kit

[![Verify](https://github.com/guillaumevele/agent-proof-kit/actions/workflows/verify.yml/badge.svg)](https://github.com/guillaumevele/agent-proof-kit/actions/workflows/verify.yml)

Deterministic release gates for AI-agent runs. The kit evaluates a synthetic agent trace, checks safety and provenance invariants, scans the public repository surface, and generates a Markdown proof report.

It is intentionally narrow: no provider account, no API key, no network call, no private project data.

## 30-Second Review

```bash
npm run verify
node bin/agent-proof.js verify --input examples/synthetic-agent-run.json --policy policies/default-policy.json
node bin/agent-proof.js scan --path . --policy policies/default-policy.json
```

Expected output:

```text
PASS score=100 findings=0 run=demo-agent-run-001
PASS files=... findings=0
```

## What It Proves

- The CLI can replay a versioned synthetic agent run.
- High-risk actions are blocked unless explicit approval exists.
- Public claims must link to evidence.
- Credential-shaped values and private terms are detected before publishing.
- The generated report is reproducible and checked in CI.

## What It Does Not Claim

- It does not certify a model, vendor, user workflow, or production system.
- It does not replace threat modeling, red-team work, or manual review.
- It does not benchmark model quality.
- It does not require or inspect private repositories.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run test:unit` | Unit tests for policy evaluation and public-surface scanning. |
| `npm run test:cli` | End-to-end CLI behavior on safe and unsafe fixtures. |
| `npm run scan:leaks` | Repository scan for secret-shaped values and configured private terms. |
| `npm run report:generate` | Regenerates `docs/generated/sample-agent-proof-report.md`. |
| `npm run report:verify` | Fails when the generated report is stale. |
| `npm run verify` | Runs the full local and CI gate. |

## Example

```bash
node bin/agent-proof.js verify \
  --input examples/synthetic-agent-run.json \
  --policy policies/default-policy.json \
  --format markdown
```

Generated proof: [docs/generated/sample-agent-proof-report.md](docs/generated/sample-agent-proof-report.md)

## Policy Surface

The default policy checks:

- synthetic fixture marker
- decision trace presence
- evidence coverage for claims
- high-risk action containment
- secret-shaped values
- optional private term list

Policies are JSON files so teams can tune risk categories, score thresholds, and private terms without changing the CLI.

## Public Boundary

All examples are synthetic and use reserved domains such as `example.com`. The repository is designed to be reviewed publicly without exposing any private app, customer, user trace, prompt, token, or production workflow.

See [docs/public-boundary.md](docs/public-boundary.md).

## Project Map

```text
bin/agent-proof.js                 CLI entry point
src/core/evaluate-agent-run.js     deterministic policy engine
src/core/public-safety-scan.js     repository surface scanner
src/report/markdown-report.js      proof report renderer
examples/                          synthetic agent traces
policies/                          JSON policy gates
tests/                             unit and CLI tests
docs/generated/                    reproducible proof report
```

## Roadmap

- JSONL trace adapter for common coding-agent logs.
- SARIF export for code-scanning ingestion.
- Optional MCP adapter once the protocol integration is verified against primary docs.
- GitHub Action wrapper for one-line adoption in other repositories.

## License

MIT
