# Agent Proof Kit

[![Verify](https://github.com/guillaumevele/agent-proof-kit/actions/workflows/verify.yml/badge.svg)](https://github.com/guillaumevele/agent-proof-kit/actions/workflows/verify.yml)
[![npm](https://img.shields.io/npm/v/agent-proof-kit.svg)](https://www.npmjs.com/package/agent-proof-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Deterministic release gates and raw-byte write receipts for AI agents. The kit
validates a public agent-run contract, evaluates safety and provenance
invariants, scans the repository surface, exports SARIF, produces proof bundles,
and mediates narrowly declared file edits through ByteFence.

The evaluation path is intentionally narrow: no provider account, API key or
model call, and no network access after installation. Installation itself may
fetch lockfile-pinned dependencies. ByteFence reads local project bytes, but
its public receipt omits source fragments and prompts.

Maturity: ByteFence ships in v0.5.0 and is backed by deterministic local and CI
tests. The workflow badge is the live source for matrix status. The project is
tested against synthetic fixtures and is not presented as production-proven.

## Install

```bash
npm install -g agent-proof-kit          # provides `agent-proof` and `agent-proof-mcp`
# or run without installing:
npx --yes --package agent-proof-kit agent-proof verify --input examples/synthetic-agent-run.json --policy policies/default-policy.json
```

ByteFence requires Node.js 22 or later. The release matrix covers the Node.js 22
and 24 release lines.

## 30-Second Review

```bash
npm run verify
node bin/agent-proof.js verify --input examples/synthetic-agent-run.json --policy policies/default-policy.json
node bin/agent-proof.js diff --base examples/synthetic-agent-run.json --candidate examples/synthetic-agent-run-regression.json --policy policies/default-policy.json
node bin/agent-proof.js verify --input examples/synthetic-agent-run-regression.json --policy policies/default-policy.json --format sarif
node bin/agent-proof.js export --from langgraph-stream --input examples/adapters/langgraph-stream.json --redact-terms internal-codename --out agent-run.synthetic.json
npm run test:bytefence
npm run corpus:verify
```

Expected output:

```text
PASS score=100 findings=0 run=demo-agent-run-001
FAIL scoreDelta=-40 newFindings=2
```

## ByteFence in 30 seconds

ByteFence is a transactional boundary for one unique `exactReplace`. It derives
the only authorized candidate from the raw preimage, denies undeclared byte
changes, rechecks the preimage under a cooperative lock, commits through an
exclusive same-directory temporary file, and emits a linked preflight/postApply
receipt.

```bash
npm run test:bytefence
npm run bytefence:reproduce-vibe
```

The checked-in evidence includes seven adversarial cases, a raw-byte matcher
rejecting 100,000 seeded out-of-range mutations with zero false allows, 1,000
seeded legitimate edits through the complete evaluator with zero false blocks,
two-process stale-base serialization, and crash failpoints before and after
rename. The complete evaluator is additionally sampled every 512 iterations in
the 100,000-case test. The optional reproduction exercises a mixed-EOL behavior
through installed Mistral Vibe code without invoking a model.

Start with the executable [check/apply/verify quickstart](docs/integrations/bytefence.md),
then review the [Mistral Vibe 2.19.1 adapter](adapters/vibe/README.md) and
[approved threat model](docs/rfc-bytefence.md).

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
- A ByteFence preflight receipt can be independently recomputed from preserved
  raw inputs, intent and policy (`CORE_PROVEN`).
- A successful ByteFence apply reports that one cooperating broker rechecked
  and committed the exact candidate, then emits a transaction receipt whose
  declared level is `MEDIATED_PROVEN`.
- Apply and bare-receipt verification remain effectively `CORE_PROVEN` by
  default, with `mediationEnvironmentTrusted: false`. Accepting the mediated
  level requires separate trust in both the producer and deployment boundary.
- Receipt verification reports `publicProfileConformant` separately from core
  integrity, so unreviewed in-toto extensions cannot be mistaken for a safe
  public artifact.

## What It Does Not Claim

- It does not certify a model, vendor, user workflow, or production system.
- It does not replace threat modeling, red-team work, or manual review.
- It does not benchmark model quality.
- It does not require or inspect private repositories.
- ByteFence does not exclude non-cooperating writers such as Bash, an IDE,
  another MCP server or a hostile same-user process.
- ByteFence is not a universal filesystem compare-and-swap and does not claim
  network-filesystem or power-loss guarantees.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run test:unit` | Unit tests for policy evaluation and public-surface scanning. |
| `npm run test:schema` | Contract validation tests for agent runs and policies. |
| `npm run test:bytefence` | Raw-byte contract, receipt, property, corpus, path, transaction, concurrency and crash tests. |
| `npm run test:vibe-adapter` | Python tests for the version-pinned Mistral Vibe project-tool profile. |
| `npm run test:adapter` | JSONL trace normalization tests. |
| `npm run test:diff` | Baseline versus candidate regression tests. |
| `npm run test:sarif` | SARIF 2.1.0 export tests. |
| `npm run test:cli` | End-to-end CLI behavior on safe and unsafe fixtures. |
| `npm run test:mcp` | MCP stdio workflow tests. |
| `npm run test:signature` | Proof-bundle digest and RSA signature tests. |
| `npm run test:dashboard` | Local HTML dashboard rendering tests. |
| `npm run test:pack` | `npm pack` smoke test for the complete published package surface. |
| `npm run scan:leaks` | Repository scan for secret-shaped values and configured private terms. |
| `npm run report:generate` | Regenerates `docs/generated/sample-agent-proof-report.md`. |
| `npm run report:verify` | Fails when the generated report is stale. |
| `npm run artifacts:generate` | Regenerates JSON, SARIF and proof-bundle artifacts. |
| `npm run artifacts:verify` | Validates generated machine artifacts, freshness and local path hygiene without rewriting them. |
| `npm run coverage:generate` | Regenerates the gate coverage matrix. |
| `npm run coverage:verify` | Fails when the gate coverage matrix is stale or references missing files. |
| `npm run corpus:verify` | Rebuilds the ByteFence corpus in memory and checks every recorded byte length and digest. |
| `npm run bytefence:benchmark` | Runs an informational local raw-byte evaluator benchmark and prints timing summaries. |
| `npm run bytefence:reproduce-vibe` | Optionally reproduces the mixed-EOL candidate through installed Vibe code on a temporary copy. |
| `npm run refresh` | Regenerates all checked-in generated artifacts. |
| `npm run verify` | Runs the complete Node release gate; the pinned Vibe contract runs separately in CI. |

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
- uses: guillaumevele/agent-proof-kit@v0.5.0
  with:
    input: examples/synthetic-agent-run.json
    policy: policies/default-policy.json
    report: agent-proof-report.md
    sarif: agent-proof-results.sarif
```

The composite action installs its locked production dependencies inside the
action checkout with lifecycle scripts disabled. Consumers need Node.js 22 or
newer, but do not need to run `npm install` for Agent Proof Kit first.

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

Available MCP tools cover ByteFence read-only checks and mediated applies,
status, policy compilation, trace export, run verification, public-surface scan,
run diff, proof-bundle creation, attestation, dashboard rendering and
generated-artifact reading. The mutation-capable `bytefence_apply` tool is
destructive, non-idempotent and never retries an uncertain state. See
[docs/integrations/mcp.md](docs/integrations/mcp.md).

The `npx` configuration above resolves the latest published package. Replace
`agent-proof-kit` with `agent-proof-kit@0.5.0` when an immutable MCP dependency
version is required.

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
CHANGELOG.md                       tagged history and 0.5.0 release notes
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
src/core/bytefence-evaluate.js     raw-byte preflight evaluator
src/core/bytefence-apply.js        mediated lock/recheck/rename transaction
src/core/bytefence-receipt.js      preflight and postApply receipt verification
src/report/                        Markdown, SARIF, proof-bundle and dashboard renderers
examples/bytefence/                deterministic adversarial raw-byte corpus
adapters/vibe/                     version-pinned Mistral Vibe 2.19.1 profile
examples/adapters/                 synthetic framework trace shapes
policies/                          JSON policy gates
tests/                             unit, CLI, MCP, schema, adapter, diff, SARIF, signature, dashboard and pack tests
docs/generated/                    reproducible proof artifacts
docs/threat-model.md               public threat model and release rule
docs/signatures.md                 proof bundle digest and signature workflow
docs/dashboard.md                  local HTML dashboard workflow
docs/integrations/bytefence.md     ByteFence quickstart, guarantees and evidence
```

## ByteFence 0.5.0

- ByteFence read-only check, mediated apply and independent receipt verification.
- Versioned intent, policy and in-toto-shaped Statement contracts.
- Public adversarial corpus and optional Mistral Vibe mixed-EOL reproduction.
- Explicit Mistral Vibe 2.19.1 and vendor-neutral MCP integrations.
- Node.js 22/24 contract and a configured Ubuntu/macOS/Windows ByteFence matrix.

See the [changelog](CHANGELOG.md) for the complete 0.5.0 inventory and
historical tags. The workflow badge above remains the source of truth for the
current remote matrix.

## Roadmap

- OpenTelemetry-shaped trace adapter.
- GitHub pull-request comment, status badge and required-check examples.
- Policy comparator and shared fixture registry.
- A second independently reproduced mutation toolchain and external adopter
  feedback before proposing a ByteFence predicate upstream.
- Progressive TypeScript migration and large-trace benchmarks.

## License

MIT
