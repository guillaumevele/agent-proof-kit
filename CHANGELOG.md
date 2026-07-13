# Changelog

Notable changes are recorded here from the repository's commit history and
version tags. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and published releases follow semantic versioning.

## [Unreleased]

No unreleased changes.

## [0.5.0] - 2026-07-13

### Added

- Added ByteFence `exactReplace`: a raw-byte preflight evaluator, mediated
  write transaction and independent receipt verifier.
- Added the `bytefence-check`, `bytefence-apply` and `bytefence-verify` CLI
  commands with JSON-only machine output and explicit exit states.
- Added linked preflight/postApply transaction receipts with separate declared
  and effective guarantee levels: `CORE_PROVEN`, `MEDIATED_PROVEN`,
  `POSTHOC_DETECTED` and `OUT_OF_SCOPE`.
- Apply receipts declare mediation evidence but remain effectively
  `CORE_PROVEN`, with `mediationEnvironmentTrusted: false`, until producer and
  environment trust are established separately.
- Receipt verification promotes that level only when a trust callback returns
  explicit own decisions for both producer authentication and mediation-
  environment trust; legacy booleans and partial decisions remain
  `CORE_PROVEN`.
- Added `publicProfileConformant` so receipt integrity can remain independently
  verifiable while unreviewed in-toto extensions are marked unsuitable for
  public-profile publication.
- Added `bytefence_check` and non-idempotent `bytefence_apply` to the local MCP
  server.
- Added an explicit Mistral Vibe 2.19.1 project-tool profile, enumerated
  side-door guard and deployed-profile compatibility check. The checker validates
  the exact allowlist, local and remote discovery settings, hooks, fixed broker
  configuration, adapter-code digests and the selected origin/SHA of all nine
  configured tool classes at a named project root. It also attests the selected
  project config, builtin default-agent override and exact model-facing tool set;
  composes user/additional-directory hooks; rejects external agent profiles;
  bounds and allowlists `VIBE_HOME/.env`; and rejects relevant Vibe, Python,
  Node, shell and dynamic-loader environment injection. The profile uses
  experimental Vibe extension surfaces and fails closed on runtime drift.
- Added the Vibe `committed-and-receipted` outcome. It confirms a fresh, stable,
  size-bounded receipt digest without claiming semantic reverification; handled
  exits attempt to remove the private intent, while a crash may leave it for
  explicit cleanup.
- Added a seven-case adversarial corpus covering truncation, ambiguous anchors,
  mixed line endings, BOM loss, Unicode normalization and full-target rewrites,
  plus an optional model-free Vibe reproduction.
- Added seeded property evidence: 100,000 out-of-range mutations against the
  raw-byte matcher and 1,000 legitimate edits through the complete evaluator.
- Added transaction tests for stale bases, two-process serialization, immutable
  receipts, temporary-file collisions, post-commit mismatches and crash stages.
- Configured ByteFence tests on GitHub-hosted Ubuntu, macOS and Windows with
  Node.js 24, plus the general verification workflow on Node.js 22 and 24.

### Changed

- Raised the package runtime contract to Node.js 22 or later for the 0.5.0
  release.
- Expanded package contents and smoke tests to include ByteFence contracts,
  corpus, adapters, policies and reproduction scripts.
- Extended the release gate to replay the pinned Vibe contract and to fail if
  the tagged package is not actually available from npm.

### Security boundaries

- Target paths are confined to a declared root; absolute and parent-traversal
  forms, symlinks, hardlinks, non-regular files and privileged POSIX mode bits
  are denied by the v0.1 contract.
- The apply path uses an exclusive cooperative lock, stale-preimage recheck,
  exclusively created same-directory temporary file, flush, final recheck,
  rename and post-commit digest observation.
- Receipt outputs must be fresh. Exit code `3` reports
  `committed-unreceipted` and must never trigger an automatic retry.
- Bare receipts cannot authenticate their producer. External verification caps
  them at `CORE_PROVEN` unless a policy-trusted producer and the mediation
  environment are independently established.
- The Vibe hooks and broker resolve `python3` and `agent-proof` through `PATH`.
  The checker verifies command strings, not those executables; `PATH`, the
  interpreter and broker remain trust roots and adapter success remains
  effectively `CORE_PROVEN` by default.
- Non-cooperating writers, hostile same-user races, network filesystems, FUSE,
  power-loss durability, ownership, ACLs and xattrs remain outside the v0.1
  guarantee.

## [0.4.1] - 2026-06-22

### Changed

- Added npm install guidance and Marketplace branding.
- Added a provenance-capable npm publication step with least-privilege
  permissions; the publish step is skipped when no repository token is
  configured.
- Made the README's fixture-based maturity and scanner boundary explicit.

## [0.4.0] - 2026-06-18

### Added

- Added LangGraph, CrewAI and AutoGen trace adapters.
- Added YAML policy compilation, proof-bundle digests and optional RSA
  signatures.
- Added the local proof dashboard and its generated sample artifact.

## [0.3.0] - 2026-06-18

### Added

- Added the local stdio MCP server and assistant-oriented proof workflow.
- Added policy packs and additional trace onboarding adapters.

## [0.2.1] - 2026-06-18

### Added

- Added the gate-coverage artifact linking public claims to implementation and
  verification paths.
- Hardened generated artifacts, SARIF findings and public-surface scanning.

## [0.2.0] - 2026-06-18

### Added

- Added the versioned agent-run and policy contracts, deterministic policy
  engine, CLI verification and repository scan.
- Added regression diffing, SARIF output, proof bundles, trace normalization,
  package smoke tests and the reusable GitHub Action.

## [0.1.0] - 2026-06-18

### Added

- Established the initial public Agent Proof Kit repository and CI baseline.

[Unreleased]: https://github.com/guillaumevele/agent-proof-kit/compare/v0.5.0...main
[0.5.0]: https://github.com/guillaumevele/agent-proof-kit/releases/tag/v0.5.0
[0.4.1]: https://github.com/guillaumevele/agent-proof-kit/releases/tag/v0.4.1
[0.4.0]: https://github.com/guillaumevele/agent-proof-kit/releases/tag/v0.4.0
[0.3.0]: https://github.com/guillaumevele/agent-proof-kit/releases/tag/v0.3.0
[0.2.1]: https://github.com/guillaumevele/agent-proof-kit/releases/tag/v0.2.1
[0.2.0]: https://github.com/guillaumevele/agent-proof-kit/releases/tag/v0.2.0
[0.1.0]: https://github.com/guillaumevele/agent-proof-kit/releases/tag/v0.1.0
