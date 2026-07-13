# RFC: ProofPatch receipts

Status: **Draft for validation; not implemented**  
Date: 2026-07-13

## Summary

ProofPatch is a proposed deterministic contract for deciding whether a candidate
file is derived from a specific preimage, inside a declared mutation scope and
under a versioned policy. It produces a machine-verifiable receipt without
claiming that the resulting code is correct.

The first release, if validated, would be read-only: `patch-check` and
`patch-verify`. Atomic application and DSSE signing are deliberately later
phases.

## Motivation

An agent tool can report success while the filesystem effect contradicts the
intent. Relevant failure classes include:

- a file truncated during a full rewrite;
- a global replacement where one occurrence was intended;
- a stale preimage changed between read and write;
- a mutation outside the declared path or hunks;
- a successful tool result that does not match the bytes on disk.

[Mistral Vibe issue #667](https://github.com/mistralai/mistral-vibe/issues/667)
is an unconfirmed user report of one historical example: a 377-line file became
58 lines while the agent reported success. Vibe changed its built-in `write_file` to create-only in
[v2.14.0](https://github.com/mistralai/mistral-vibe/blob/main/CHANGELOG.md#2140---2026-06-04),
so this RFC is not a claim about the current Vibe built-in. It targets mutation
integrity across agent tools, MCP servers and coding workflows.

ProofPatch answers one narrow question:

> Is this candidate exactly derived from this preimage, within the declared
> scope and policy? In a later atomic-apply phase, does the observed final state
> still match the authorized candidate?

## Goals

- Bind preimage, candidate, intent, policy and workspace context by digest.
- Recompute the mutation rather than trusting a tool's success response.
- Fail closed on unknown operations, paths, schemas and policy checks.
- Detect truncation, ambiguous replacement, stale reads and scope drift.
- Emit stable JSON, SARIF findings and an optional Agent Proof Kit evidence item.
- Avoid raw source, prompts and tool arguments in receipts by default.
- Reuse in-toto and OpenTelemetry concepts instead of inventing competing
  envelope or telemetry formats.

## Non-goals for v0.1

- Infer intent from a conversation or an LLM response.
- Evaluate semantic code quality, type correctness or runtime behavior.
- Replace Git, tests, review or human approval.
- Execute arbitrary validation commands.
- Support directories, binaries, deletions or atomic multi-file transactions.
- Claim producer identity from an unsigned digest.
- Prevent a write before an integration actually calls the preflight verifier.
- Authorize full-file rewrites or model human approvals in v0.1.

## Threat model

### Covered

1. A truncated but syntactically valid candidate.
2. An ambiguous or unintended global replacement.
3. A target changed after its preimage was captured.
4. Absolute paths, `..` traversal or an escaping symlink.
5. A candidate or receipt altered after the decision.
6. A receipt replayed in another repository or commit.
7. A tool result that disagrees with the observed file bytes.
8. Sensitive source or prompts copied into public telemetry.

### Residual limits

- An actor controlling the file, verifier and signing key can still lie.
- An attestation proves what an identified producer asserted, not that the
  assertion is true.
- A time-of-check/time-of-use window remains until atomic `patch-apply` exists.
- Missing receipts are never implicit authorization.

## Receipt model

### Intent document v0.1

`patch-check` receives a private, schema-validated intent document. The receipt
contains only its digest. The initial operation is `exactReplace`:

```json
{
  "$schema": "https://github.com/guillaumevele/agent-proof-kit/schemas/proofpatch-intent-v0.1.json",
  "operation": "exactReplace",
  "targetPath": "src/pages/index.astro",
  "encoding": "utf-8",
  "oldText": "const enabled = false;",
  "newText": "const enabled = true;",
  "expectedOccurrences": 1
}
```

The target must be valid UTF-8. `oldText` and `newText` are converted directly
from decoded JSON strings to UTF-8 bytes, with no Unicode or line-ending
normalization. The operation replaces exactly the declared number of byte
sequences. Any invalid encoding or occurrence mismatch is a denial.

The intent file can contain source fragments and remains private by default.
Only its digest and non-sensitive scope metadata enter the receipt.

The receipt is an
[in-toto Statement v1](https://github.com/in-toto/attestation/blob/v1.2.0/spec/v1/statement.md).
Its subject is the immutable candidate. The predicate binds the preimage,
declared intent, policy and decision.

Provisional predicate type:

```text
https://github.com/guillaumevele/agent-proof-kit/attestations/proofpatch/v0.1
```

This URI must resolve to a versioned schema before a public v0.1 release.

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "src/pages/index.astro",
      "digest": { "sha256": "<candidate-sha256>" },
      "mediaType": "text/plain"
    }
  ],
  "predicateType": "https://github.com/guillaumevele/agent-proof-kit/attestations/proofpatch/v0.1",
  "predicate": {
    "operationId": "pp-...",
    "observedAt": "2026-07-13T10:00:00Z",
    "phase": "preflight",
    "operation": "exactReplace",
    "targetPath": "src/pages/index.astro",
    "before": {
      "digest": { "sha256": "<preimage-sha256>" },
      "mediaType": "text/plain"
    },
    "workspace": {
      "repository": "https://github.com/example/project",
      "baseCommit": "<git-commit>"
    },
    "intent": {
      "digest": { "sha256": "<intent-document-sha256>" },
      "expectedPaths": ["src/pages/index.astro"],
      "expectedOccurrences": 1
    },
    "change": {
      "patchManifestDigest": { "sha256": "<proofpatch-manifest-sha256>" },
      "beforeBytes": 18420,
      "afterBytes": 18428,
      "beforeLines": 377,
      "afterLines": 377,
      "addedLines": 1,
      "deletedLines": 1,
      "hunks": 1
    },
    "telemetry": {
      "traceId": "<32-hex>",
      "spanId": "<16-hex>",
      "toolCallId": "<provider-call-id>",
      "toolName": "replace_file_content"
    },
    "contextSignals": {
      "conversationCompacted": true
    },
    "policy": {
      "id": "proofpatch-default",
      "digest": { "sha256": "<policy-sha256>" }
    },
    "decision": {
      "status": "allow",
      "checks": [
        { "id": "preimage.digestMatches", "status": "pass" },
        { "id": "scope.exact", "status": "pass" },
        { "id": "change.withinLimits", "status": "pass" }
      ],
      "approval": { "status": "notApplicableInV0.1" }
    }
  }
}
```

Receipts contain digests and metrics, not preimage, candidate, prompt or tool
arguments. `contextSignals` is ProofPatch-specific and must not be emitted as an
OpenTelemetry semantic-convention attribute.

An additive Agent Proof Kit evidence record can reference the receipt:

```json
{
  "id": "e-proofpatch-1",
  "kind": "proofpatch_receipt",
  "result": "pass",
  "artifact": {
    "path": "receipts/pp-1.json",
    "sha256": "<receipt-sha256>"
  }
}
```

### Digest and metric rules

- `intent.digest` and `policy.digest` hash the exact UTF-8 input-file bytes
  before parsing. A BOM is invalid; no whitespace, key-order or newline
  normalization occurs.
- `patchManifestDigest` hashes a versioned `ProofPatchPatchManifest/v0.1` serialized with
  [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785).
  The manifest contains the operation, target path, preimage and candidate
  digests, occurrence count, byte metrics and ordered changed byte ranges. A
  human-readable unified diff is presentation only and is not hashed.
- An evidence record's `receipt-sha256` hashes the exact UTF-8 Statement bytes
  written to disk. A verifier must not parse and reserialize before checking it.
- Byte counts use the raw file bytes. Line counts are `0` for an empty file;
  otherwise they are the count of LF bytes plus one, minus one when the final
  byte is LF. CR bytes remain content and CRLF is never normalized.

Unknown in-toto Statement fields are ignored as required for forward
compatibility. Unknown ProofPatch operations or check IDs, and missing required
predicate fields, make a receipt insufficient for authorization and therefore deny.

## Required invariants

The verifier fails closed when any of these conditions is not satisfied:

1. The schema, predicate type and operation are recognized.
2. `targetPath` is relative, inside the root and does not resolve through a
   disallowed symlink.
3. The observed preimage matches its declared digest and metrics.
4. The candidate matches the Statement subject digest.
5. A recomputed patch manifest matches `patchManifestDigest`.
6. Every changed path belongs to `expectedPaths`.
7. `exactReplace` observes exactly `expectedOccurrences` matches.
8. Applying the declared operation to the preimage produces the candidate
   byte-for-byte.
9. Byte, line, hunk and deletion-ratio limits satisfy the policy.
10. A full-file or policy-defined large rewrite is denied in v0.1; a future
    version requires a separately verifiable approval artifact.
11. Repository and base commit match the bound workspace context.
12. In a future `postApply` receipt, the observed target matches the candidate
    digest and references the preflight receipt by digest.

A context-pressure or compaction signal can inform review, but cannot prove
corruption and must never block on its own.

### Phase guarantees

- A `preflight` receipt proves only that the candidate was eligible against the
  observed preimage, intent and policy at check time. It does not prove that any
  write occurred or that the final file matches the candidate.
- `patch-verify` in the read-only MVP receives the still-available preimage at
  `--target`, plus candidate, intent and policy, and recomputes the preflight
  decision.
- A `postApply` receipt is out of scope for v0.1. It must be newly emitted by the
  future atomic `patch-apply`, bind the preflight receipt digest and rehash the
  final target. An external writer cannot obtain the same guarantee unless it
  supplies a preserved `--before` snapshot and accepts that atomicity was not
  proven.

## Proposed CLI

The existing CLI uses flat commands, so hyphenated commands avoid a parser
rewrite in the first phase.

```bash
agent-proof patch-check \
  --target src/pages/index.astro \
  --candidate /tmp/index.astro.candidate \
  --intent proofpatch-intent.json \
  --policy policies/proofpatch-default.json \
  --root . \
  --out receipts/index.proofpatch.json

agent-proof patch-verify \
  --receipt receipts/index.proofpatch.json \
  --target src/pages/index.astro \
  --intent proofpatch-intent.json \
  --policy policies/proofpatch-default.json \
  --candidate /tmp/index.astro.candidate \
  --root .
```

Exit codes:

- `0`: allowed and verified;
- `1`: policy denial or integrity mismatch;
- `2`: invalid input, schema or environment.

Both commands are read-only except for the explicitly requested receipt output.
A future `patch-apply` would re-read the preimage under a lock, verify its digest,
write a temporary file in the same directory, atomically replace the target and
rehash the final state.

## OpenTelemetry boundary

The current, Development-status
[OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/63f8200eee093730ce845d26ce2aafb621b0807e/docs/gen-ai/gen-ai-spans.md#execute-tool-span)
define `execute_tool` spans and identifiers such as the tool name and tool-call
ID. ProofPatch may import trace ID, span ID, tool-call ID and tool name for
correlation. Arguments and results are opt-in, potentially sensitive values and
must not be copied into a receipt.

Telemetry supplies correlation. The receipt supplies mutation integrity.

## Signing and in-toto compatibility

The existing Agent Proof Kit signature signs a digest of canonically serialized
JSON. It is not an in-toto envelope and must not be presented as one.

Likewise, a bare Statement is structurally an in-toto Statement but is
unauthenticated. It is not an authenticated attestation until an appropriate
envelope and signer verification are applied.

If signing is added, ProofPatch will use
[DSSE](https://github.com/in-toto/attestation/blob/v1.2.0/spec/v1/envelope.md)
over the complete Statement payload, with
`payloadType=application/vnd.in-toto+json`. The signature covers DSSE
pre-authentication encoding of `payloadType` and the payload bytes. The current
proof-bundle signature remains supported independently for backward compatibility.

The predicate should be proposed upstream to in-toto only after two independent
adopters and after checking whether an existing predicate is sufficient, following
their [new predicate guidelines](https://github.com/in-toto/attestation/blob/v1.2.0/docs/new_predicate_guidelines.md).

## Mandatory test corpus

1. A synthetic 377-to-58-line truncation is denied before writing.
2. A unique exact replacement is allowed.
3. Two matching anchors with `expectedOccurrences: 1` are denied.
4. A full-file or policy-defined large rewrite is denied in v0.1, including when
   the input self-declares approval.
5. A target changed after `patch-check` is denied without writing.
6. A modified candidate invalidates the receipt.
7. An altered receipt fails digest or signature verification.
8. Absolute, parent-traversal and escaping-symlink paths are denied.
9. Unknown operations fail closed.
10. A receipt replayed on another commit is denied.
11. Sensitive tool arguments are absent from generated receipts.
12. DSSE tests cover valid, altered and wrong-signer envelopes.
13. Property tests reject any byte changed outside declared hunks.
14. SARIF findings retain stable rule IDs and precise file locations.

## Delivery phases

1. **Read-only core:** schema, fixtures, `evaluateProofPatch`, `patch-check` and
   `patch-verify`.
2. **Reporting:** SARIF, agent-run evidence, proof bundles, OTel correlation and
   read-only MCP tools.
3. **Atomic application:** locks, preimage recheck, same-directory temporary
   file, atomic replacement and post-apply hash.
4. **Attestation:** final predicate, DSSE and signer verification.
5. **Adapters:** Mistral Vibe/MCP plus at least two other mutation toolchains and
   a public synthetic corruption corpus.

No phase may claim prevention before phase 3 is implemented and tested.

## Kill criteria

Reduce or stop the proposal when any of the following holds:

- no second mutation toolchain with a reproducible integrity failure is found;
- the corpus cannot detect truncation while keeping false blocks below 5% on
  declared legitimate refactors;
- integrations cannot call a preflight verifier before writing;
- atomic application cannot reasonably close the supported-platform TOCTOU;
- no two independent adopters appear after the read-only MVP;
- in-toto maintainers identify an existing predicate that already fits;
- raw source or prompts must be captured by default for the verifier to work.

If only post-hoc verification is defensible, the project must remove every
prevention claim and remain a verifier.

## Open questions before implementation

1. Is `exactReplace` the only operation required for the first public fixture
   corpus, or must anchor-bounded replacement ship with it?
2. Should repository and commit binding be mandatory outside a Git worktree?
3. Which deletion-ratio defaults avoid both silent truncation and false blocks on
   legitimate rewrites?
4. Which two external toolchains can participate in the initial validation?
5. Should the first integration live only in the CLI, or also expose read-only
   MCP tools?
6. What independently verifiable approval artifact, if any, should a later
   version require for large rewrites?
