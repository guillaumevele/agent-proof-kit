# Agent Proof Kit

[![Verify](https://github.com/guillaumevele/agent-proof-kit/actions/workflows/verify.yml/badge.svg)](https://github.com/guillaumevele/agent-proof-kit/actions/workflows/verify.yml)
[![npm](https://img.shields.io/npm/v/agent-proof-kit.svg)](https://www.npmjs.com/package/agent-proof-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Deterministic release gates for AI-agent runs. The kit validates a public agent-run contract, evaluates safety and provenance invariants, scans the repository surface, exports SARIF, produces a proof bundle, and can run as a GitHub Action.

It is intentionally narrow: no provider account, no API key, no network call, no private project data.

Maturity: every gate runs in CI (currently green) against the synthetic fixtures in this repo. It is designed and tested against those fixtures, not yet used in production.

## Install

```bash
npm install -g agent-proof-kit          # provides `agent-proof` and `agent-proof-mcp`
# or run without installing:
npx agent-proof verify --input examples/synthetic-agent-run.json --policy policies/default-policy.json
```

## 30-Second Review

```bash
npm run verify
node bin/agent-proof.js verify --input examples/synthetic-agent-run.json --policy policies/default-policy.json
node bin/agent-proof.js diff --base examples/synthetic-agent-run.json --candidate examples/synthetic-agent-run-regression.json --policy policies/default-policy.json
node bin/agent-proof.js verify --input examples/synthetic-agent-run-regression.json --policy policies/default-policy.json --format sarif
node bin/agent-proof.js export --from langgraph-stream --input examples/adapters/langgraph-stream.json --redact-terms internal-codename --out agent-run.synthetic.json
```

Expected output:

```text
PASS score=100 findings=0 run=demo-agent-run-001
FAIL scoreDelta=-40 newFindings=2
```

## What It Proves

- The CLI can replay a versioned synthetic agent run.
- Agent-run and policy files match a documented JSON contract.
- High-risk actions are blocked unless explicit approval exists.
- Public claims must link to evidence.
- Unknown action types fail closed until the policy classifies them.
- Oversized unscanned files fail the public-surface scan instead of being skipped silently.
- Generated Markdown, SARIF and JSON proof bundles are reproducible and checked in CI.
- LangGraph, CrewAI and AutoGen trace shapes can be converted into synthetic fixtures before publication.
- Proof bundles can be attested with a canonical digest and optional RSA signature.
- Every public gate is mapped to implementation files, verification paths and generated proof.

## What It Does Not Claim

- It does not certify a model, vendor, user workflow, or production system.
- It does not replace threat modeling, red-team work, or manual review.
- It does not benchmark model quality.
- It does not require or inspect private repositories.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run test:unit` | Unit tests for policy evaluation and public-surface scanning. |
| `npm run test:schema` | Contract validation tests for agent runs and policies. |
| `npm run test:adapter` | JSONL trace normalization tests. |
| `npm run test:diff` | Baseline versus candidate regression tests. |
| `npm run test:sarif` | SARIF 2.1.0 export tests. |
| `npm run test:cli` | End-to-end CLI behavior on safe and unsafe fixtures. |
| `npm run test:mcp` | MCP stdio workflow tests. |
| `npm run test:signature` | Proof-bundle digest and RSA signature tests. |
| `npm run test:dashboard` | Local HTML dashboard rendering tests. |
| `npm run test:pack` | `npm pack` smoke test for the packaged CLI binary. |
| `npm run scan:leaks` | Repository scan for secret-shaped values and configured private terms. |
| `npm run report:generate` | Regenerates `docs/generated/sample-agent-proof-report.md`. |
| `npm run report:verify` | Fails when the generated report is stale. |
| `npm run artifacts:generate` | Regenerates JSON, SARIF and proof-bundle artifacts. |
| `npm run artifacts:verify` | Validates generated machine artifacts, freshness and local path hygiene without rewriting them. |
| `npm run coverage:generate` | Regenerates the gate coverage matrix. |
| `npm run coverage:verify` | Fails when the gate coverage matrix is stale or references missing files. |
| `npm run refresh` | Regenerates all checked-in generated artifacts. |
| `npm run verify` | Runs the full local and CI gate. |

## Example

```bash
node bin/agent-proof.js verify \
  --input examples/synthetic-agent-run.json \
  --policy policies/default-policy.json \
  --format markdown
```

Generated proof: [docs/generated/sample-agent-proof-report.md](docs/generated/sample-agent-proof-report.md)

Machine-readable artifacts:

- [Proof bundle JSON](docs/generated/proof-bundle.json)
- [SARIF export](docs/generated/sample-agent-proof.sarif)
- [Normalized JSONL trace](docs/generated/normalized-agent-run.json)
- [Regression diff](docs/generated/sample-agent-run-diff.json)
- [Gate coverage matrix](docs/generated/gate-coverage.md)
- [Proof bundle attestation](docs/generated/proof-bundle.attestation.json)
- [Local proof dashboard](docs/generated/proof-dashboard.html)

## GitHub Action

```yaml
- uses: guillaumevele/agent-proof-kit@v0.4.0
  with:
    input: examples/synthetic-agent-run.json
    policy: policies/default-policy.json
    report: agent-proof-report.md
    sarif: agent-proof-results.sarif
```

See [docs/integrations/github-action.md](docs/integrations/github-action.md).

## MCP Server

Agent Proof Kit also ships a local stdio MCP server so assistants can run the release gates without memorizing CLI flags:

```json
{
  "mcpServers": {
    "agent-proof-kit": {
      "command": "npx",
      "args": ["--yes", "--package", "agent-proof-kit", "agent-proof-mcp"],
      "env": {
        "AGENT_PROOF_ROOT": "/path/to/repository"
      }
    }
  }
}
```

Available MCP tools cover status, policy compilation, trace export, run verification, public-surface scan, run diff, proof-bundle creation, attestation, dashboard rendering and generated-artifact reading. See [docs/integrations/mcp.md](docs/integrations/mcp.md).

## Policy Surface

The default policy checks:

- synthetic fixture marker
- schema validation
- decision trace presence
- declared claims for final outputs
- evidence coverage for claims
- high-risk action containment
- fail-closed unknown action types
- secret-shaped values
- unscanned file detection
- optional private term list

Policies are JSON files so teams can tune risk categories, score thresholds, and private terms without changing the CLI.

Bundled policy packs:

- [default-policy.json](policies/default-policy.json)
- [open-source-policy.json](policies/open-source-policy.json)
- [strict-corporate-policy.json](policies/strict-corporate-policy.json)
- [high-stakes-policy.json](policies/high-stakes-policy.json)

See [docs/policy-packs.md](docs/policy-packs.md).

YAML policy DSL is also supported:

```bash
node bin/agent-proof.js compile-policy --input examples/policies/strict-corporate-policy.yaml
node bin/agent-proof.js verify --input examples/synthetic-agent-run.json --policy examples/policies/strict-corporate-policy.yaml
```

## Public Boundary

All checked-in examples and generated artifacts are synthetic and use reserved domains such as `example.com`. For downstream repositories, add project-specific names to `privateTerms`; the default scanner catches secret-shaped values, env/private-key paths and configured private terms; it does not detect unknown internal codenames automatically.

See [docs/public-boundary.md](docs/public-boundary.md) and [docs/threat-model.md](docs/threat-model.md).

## Attestations

Proof bundles can be hashed and optionally signed with an RSA key:

```bash
node bin/agent-proof.js sign-bundle --bundle docs/generated/proof-bundle.json --out proof-bundle.attestation.json
node bin/agent-proof.js verify-bundle-signature --bundle docs/generated/proof-bundle.json --signature proof-bundle.attestation.json
```

See [docs/signatures.md](docs/signatures.md).

## Local Dashboard

```bash
node bin/agent-proof.js dashboard \
  --bundle docs/generated/proof-bundle.json \
  --coverage docs/generated/gate-coverage.md \
  --attestation docs/generated/proof-bundle.attestation.json \
  --out proof-dashboard.html
```

See [docs/dashboard.md](docs/dashboard.md).

## Project Map

```text
action.yml                         reusable composite GitHub Action
bin/agent-proof.js                 CLI entry point
bin/agent-proof-mcp.js             local stdio MCP server
schemas/                           public JSON contracts
src/core/evaluate-agent-run.js     deterministic policy engine
src/core/diff-agent-runs.js        baseline/candidate regression diff
src/core/normalize-jsonl.js        synthetic JSONL trace adapter
src/core/trace-export.js           LangGraph, CrewAI, AutoGen and JSONL fixture export
src/core/policy-loader.js          JSON/YAML policy loader and DSL compiler
src/core/proof-signature.js        canonical proof-bundle digest and signature helpers
src/core/public-safety-scan.js     repository surface scanner
src/report/                        Markdown, SARIF, proof-bundle and dashboard renderers
examples/                          synthetic agent traces
policies/                          JSON policy gates
tests/                             unit, CLI, MCP, schema, adapter, diff, SARIF, signature, dashboard and pack tests
docs/generated/                    reproducible proof artifacts
docs/threat-model.md               public threat model and release rule
docs/signatures.md                 proof bundle digest and signature workflow
docs/dashboard.md                  local HTML dashboard workflow
```

## Roadmap

- [Draft ProofPatch RFC](docs/rfc-proofpatch.md): deterministic preimage-to-candidate
  mutation receipts. No implementation or compatibility claim yet.
- OpenTelemetry-shaped trace adapter.
- GitHub pull-request comment, status badge and required-check examples.
- Policy comparator and shared fixture registry.
- Progressive TypeScript migration, property tests and large-trace benchmarks.

## License

MIT
