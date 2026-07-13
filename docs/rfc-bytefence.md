# RFC: ByteFence mediated writes

Status: **Implemented for Agent Proof Kit v0.5.0**

Date: 2026-07-13

## Summary

ByteFence is the working name for a deterministic write firewall for coding
agents. It decides whether candidate bytes are exactly derived from specific
preimage bytes, inside a declared mutation scope and under a versioned policy.
For writes mediated by its own transactional tool, it can deny the operation
before mutation and emit a machine-verifiable before/proposed/after receipt.

Version 0.5.0 implements the read-only evaluator, mediated writer, CLI, MCP
tools, Vibe adapter, corpus and verification paths described here. Remote matrix
status remains visible in GitHub Actions. ByteFence does not claim that the
resulting code is semantically correct.

The public product name remains unresolved. “ByteFence” is a development
codename because it overlaps a discontinued anti-malware brand; no package or
standalone repository is published under that name by this RFC.

## Motivation

An agent tool can report success while the filesystem effect contradicts the
intent. Relevant failure classes include:

- a file truncated during a full rewrite;
- a global replacement where one occurrence was intended;
- a stale preimage changed between read and write;
- a mutation outside the declared path or hunks;
- a successful tool result that does not match the bytes on disk.

[Mistral Vibe issue #667](https://github.com/mistralai/mistral-vibe/issues/667)
is an unconfirmed historical report: a 377-line file became 58 lines while the
agent reported success. The report cites older Vibe versions and a Gitea MCP
whole-file writer. Current Vibe makes its built-in `write_file` create-only, so
this RFC does not present that report as a current native Vibe vulnerability.

A current byte-level example exists in Vibe 2.19.1: its
[`edit` tool](https://github.com/mistralai/mistral-vibe/blob/v2.19.1/vibe/core/tools/builtins/edit.py)
reads through a helper that
[normalizes mixed line endings](https://github.com/mistralai/mistral-vibe/blob/v2.19.1/vibe/core/utils/io.py)
and later rewrites with one detected style. A local exact replacement can
therefore change bytes outside the requested anchor in a mixed-EOL file. This
behavior is the primary public interoperability fixture, not an accusation of
semantic corruption.

ByteFence answers one narrow question:

> Is this candidate exactly derived from this preimage, within the declared
> scope and policy? For a mediated write, did the committed state observed by
> ByteFence match the authorized candidate?

## Goals

- Bind preimage, candidate, intent, policy and workspace context by digest.
- Recompute the mutation rather than trusting a tool's success response.
- Fail closed on unknown operations, paths, schemas and policy checks.
- Detect truncation, ambiguous replacement, stale reads and scope drift.
- Deny before mutation when the write is executed by the ByteFence broker.
- Emit stable JSON, SARIF findings and an optional Agent Proof Kit evidence item.
- Avoid raw source, prompts and tool arguments in receipts by default.
- Reuse in-toto and OpenTelemetry concepts instead of inventing competing
  envelope or telemetry formats.

## Non-goals for v0.1

- Infer intent from a conversation or an LLM response.
- Evaluate semantic code quality, type correctness or runtime behavior.
- Replace Git, tests, review or human approval.
- Execute arbitrary validation commands.
- Support directories, binaries, creation, deletion or multi-file transactions.
- Claim producer identity from an unsigned digest.
- Protect Bash, IDEs, third-party MCP servers or any writer that bypasses the
  ByteFence broker.
- Authorize full-file rewrites or model human approvals in v0.1.
- Claim a universal filesystem compare-and-swap, power-loss durability, or
  preservation of ownership, ACLs, xattrs, resource forks and alternate streams.

## Adjacent work and narrow wedge

[PatchGate](https://github.com/shivae372/patchgate) already provides path
blocklists, whole-file patch sets, snapshots, rollback, audit logs and OpenAI/
Claude adapters. ByteFence must not duplicate that product. Its narrower
contract is preimage-bound raw-byte derivation: a declared local replacement
cannot alter an undeclared byte, normalize representation silently or commit
from a stale cooperating base.

[ActionLineage](https://github.com/VectorTrace-Labs/ActionLineage) records broad
agent-action evidence but explicitly separates detection from synchronous
enforcement. ByteFence is an enforcement primitive that may export compatible
evidence; it is not a competing observability plane.

Built-in editors such as Vibe, Pi and OpenCode already implement useful
exact-replace and representation-preservation behavior. ByteFence's value is not
“the first safe edit tool.” Its testable wedge is the portable combination of
raw-byte out-of-scope invariants, preimage binding, a mediated transaction,
explicit guarantee levels and a public adversarial corpus.

## Threat model

### Guarantee levels

Every result declares one of four levels. Integrations must not silently promote
a weaker level:

| Level | Meaning |
| --- | --- |
| `CORE_PROVEN` | Digests, occurrence count, exact byte derivation, mutation ranges, policy and receipt can be independently recomputed. |
| `MEDIATED_PROVEN` | On a supported local filesystem, all cooperating writers used the ByteFence lock protocol; the target was rechecked immediately before an atomic replacement and matched the authorized candidate immediately afterwards. Accepting this level requires explicit trust in the producer and mediation environment. |
| `POSTHOC_DETECTED` | A later observation found that the target did or did not match an authorized candidate; this is detection, not prevention. |
| `OUT_OF_SCOPE` | The operation used an unmediated writer or an unsupported environment, so ByteFence makes no write-integrity claim. |

`MEDIATED_PROVEN` is not a universal compare-and-swap. Node.js cannot make
`re-read + rename` indivisible against a non-cooperating process. A hostile
writer can still race between the last digest check and the rename. ByteFence
prevents stale-base commits between cooperating brokers and provides atomic
visibility; it does not prove the absence of every lost update.

A Statement carries `declaredGuaranteeLevel`. Verification returns a separate
`effectiveGuaranteeLevel`. A post-apply Statement may declare
`MEDIATED_PROVEN`, but both the live apply result and bare-receipt verification
remain effectively `CORE_PROVEN` by default. The apply result exposes
`mediationEnvironmentTrusted: false`; the CLI and MCP paths do not infer
filesystem capability. Accepting the mediated level requires an explicit
authenticator that establishes both a policy-trusted producer and the mediation
environment. Persistence or JSON shape alone authenticates neither.
The programmatic verifier therefore requires its trust callback to return both
own decisions, `producerAuthenticated: true` and
`mediationEnvironmentTrusted: true`; booleans, inherited properties and partial
decisions cannot promote the effective level.

### Covered

1. A truncated but syntactically valid candidate.
2. An ambiguous or unintended global replacement.
3. A target changed after its preimage was captured.
4. Absolute paths, `..` traversal or an escaping symlink.
5. A candidate or receipt altered after the decision.
6. A receipt replayed under another workspace ID.
7. A tool result that disagrees with the observed file bytes.
8. Sensitive source or prompts copied into public telemetry.
9. Mixed EOL, BOM or Unicode normalization changing bytes outside the declared
   replacement.
10. A cooperating writer attempting to commit from a stale preimage.

### Residual limits

- An actor controlling the file, verifier and signing key can still lie.
- An attestation proves what an identified producer asserted, not that the
  assertion is true.
- A non-cooperating process can write through Bash, an IDE, another MCP server
  or a filesystem race outside the broker.
- Network filesystems, FUSE, hostile same-user processes, power loss, ownership,
  ACLs, xattrs and platform-specific alternate data are outside v0.1 guarantees.
- A same-directory rename is used to avoid a partially visible target on each
  tested local filesystem. The supported platform/filesystem matrix is evidence,
  not an assumption; rename alone does not prove power-loss durability.
- Missing receipts are never implicit authorization.

## Receipt model

### Intent document v0.1

`bytefence-check` receives a private, schema-validated intent document. The receipt
contains only its digest. The initial operation is `exactReplace`:

```json
{
  "$schema": "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json",
  "operation": "exactReplace",
  "targetPath": "src/pages/index.astro",
  "encoding": "utf-8",
  "oldText": "const enabled = false;",
  "newText": "const enabled = true;",
  "expectedOccurrences": 1
}
```

The target must be valid UTF-8. A target UTF-8 BOM is allowed and must remain
byte-identical. `oldText` and `newText` are converted directly from decoded
JSON strings to UTF-8 bytes, with no Unicode or line-ending normalization.
`oldText` must be non-empty, `newText` must differ and v0.1 requires exactly
one non-overlapping occurrence. An intent whose range intersects the initial
three-byte UTF-8 BOM is denied, even when it names that byte sequence. An
occurrence mismatch, an overlapping match, a NUL byte, invalid UTF-8 or an
isolated JSON surrogate is an invalid input or denial according to the published
finding ID.

The intent file can contain source fragments and remains private by default.
Only its digest and non-sensitive scope metadata enter the receipt.

### Policy document v0.1

ByteFence uses a dedicated policy contract rather than extending the agent-run
scoring policy. The bundled policy starts with these conservative limits:

```json
{
  "$schema": "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-policy-v0.1.schema.json",
  "id": "bytefence-default",
  "maxTargetBytes": 10485760,
  "maxOldBytes": 65536,
  "maxNewBytes": 65536,
  "maxDeletionRatio": 0.25,
  "denyFullTargetReplacement": true,
  "allowSymlinks": false,
  "allowHardlinks": false,
  "requireUtf8": true,
  "allowNul": false,
  "preserveUtf8Bom": true,
  "preservePosixMode": true
}
```

Deletion ratio is `deletedBytes / beforeBytes`; it is zero for an empty
preimage, which is unsupported for `exactReplace`. Policy documents reject
unknown keys. The runtime parser must enforce every schema keyword used by the
contract; a JSON schema file is not evidence of validation by itself.

Policy values can only tighten the runtime envelope. v0.1 applies non-configurable
upper bounds of 1 MiB for an intent document, 64 KiB for a policy document,
4 MiB for a receipt document, 16 MiB for a target and 64 KiB each for
`oldText` and `newText`. The bundled policy tightens the target limit to
10 MiB. Exceeding a policy limit is a denial; exceeding an absolute document or
runtime limit is invalid input. Bounded reads enforce these limits before a
document is parsed or an entire target is buffered.

### Workspace and event binding

The caller supplies a non-sensitive `workspaceId`. Receipts store only its
SHA-256 digest. Repository URL and commit are optional diagnostic correlation
fields and are not authorization inputs in v0.1. The deterministic
`operationId` binds the mutation-manifest, intent, policy and workspace-ID
digests. `observedAt` is an injected event timestamp and is not part of that
deterministic binding.

The receipt is an
[in-toto Statement v1](https://github.com/in-toto/attestation/blob/v1.2.0/spec/v1/statement.md).
Its subject is the immutable candidate. The predicate binds the preimage,
declared intent, policy and decision.

Predicate type for the v0.5.0 implementation release:

```text
https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-statement-v0.1.schema.json
```

The contract uses immutable tag-backed URLs and binds the exact Statement schema
bytes by SHA-256 in the predicate.

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "bytefence-target",
      "digest": { "sha256": "<candidate-sha256>" },
      "mediaType": "text/plain"
    }
  ],
  "predicateType": "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-statement-v0.1.schema.json",
  "predicate": {
    "operationId": "bf-...",
    "observedAt": "2026-07-13T10:00:00Z",
    "phase": "preflight",
    "receiptProfile": "public",
    "operation": "exactReplace",
    "contractDigest": { "sha256": "<statement-contract-sha256>" },
    "targetPathDigest": { "sha256": "<target-path-sha256>" },
    "before": {
      "digest": { "sha256": "<preimage-sha256>" },
      "mediaType": "text/plain"
    },
    "workspace": {
      "idDigest": { "sha256": "<workspace-id-sha256>" }
    },
    "intent": {
      "digest": { "sha256": "<intent-document-sha256>" },
      "expectedPathDigest": { "sha256": "<target-path-sha256>" },
      "expectedOccurrences": 1
    },
    "change": {
      "patchManifestDigest": { "sha256": "<bytefence-manifest-sha256>" },
      "beforeBytes": 18420,
      "afterBytes": 18428,
      "beforeLines": 377,
      "afterLines": 377,
      "addedLines": 1,
      "deletedLines": 1,
      "hunks": 1
    },
    "policy": {
      "id": "bytefence-default",
      "digest": { "sha256": "<policy-sha256>" }
    },
    "decision": {
      "status": "allow",
      "declaredGuaranteeLevel": "CORE_PROVEN",
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

`bytefence-check` emits one preflight Statement. `bytefence-apply --out`
emits one `ByteFenceTransactionReceipt/v0.1` document containing both the
preflight and post-apply Statements. The post-apply predicate contains the
SHA-256 of the exact canonical preflight Statement bytes embedded in the same
document. Verification recomputes that digest before evaluating either phase.
If the target commit succeeds but the transaction receipt cannot be persisted,
the command returns an explicit `committed-unreceipted` failure state; it never
reports a fully receipted success.

The default `public` receipt profile contains digests and metrics, not the raw
target path, repository, commit, trace identifiers, preimage, candidate, prompt
or tool arguments. An explicit `local` diagnostic profile may add the relative
target path and correlation identifiers; it remains private by default and is
written with restrictive permissions where supported. Public artifacts in this
repository must use the `public` profile. Digests can still link or reveal
low-entropy paths, workspace IDs and small file contents through guessing; this
profile removes cleartext but does not promise confidentiality or anonymity.
`contextSignals` is ByteFence-specific and must not be emitted as an
OpenTelemetry semantic-convention attribute.

The verifier reports `publicProfileConformant` for public receipts. Unknown
in-toto top-level, subject or digest extensions do not change recomputed
`CORE_PROVEN` integrity, but they set that flag to `false` and add a finding
because an unreviewed extension may contain cleartext. Unknown predicate fields
remain invalid. A local-profile receipt reports no public-profile conclusion.

An additive Agent Proof Kit evidence record can reference the receipt:

```json
{
  "id": "e-bytefence-1",
  "kind": "bytefence_receipt",
  "result": "pass",
  "artifact": {
    "path": "receipts/bf-1.json",
    "sha256": "<receipt-sha256>"
  }
}
```

### Digest and metric rules

- `intent.digest` and `policy.digest` hash the exact UTF-8 input-file bytes
  before parsing. A BOM is invalid; no whitespace, key-order or newline
  normalization occurs.
- `patchManifestDigest` hashes a versioned
  `ByteFenceMutationManifest/v0.1` serialized with
  `ByteFenceCanonicalJson/v0.1`: recursive lexicographic key ordering, original
  array order, UTF-8 JSON bytes and a strict value set of null, booleans,
  strings and safe integers. Floats, non-finite numbers, lone surrogates,
  `undefined` and unsupported object types are invalid. This is deliberately
  not presented as RFC 8785 compatibility.
- The manifest contains the operation, target path, preimage and candidate
  digests, occurrence count, byte metrics and one ordered changed range with
  both `before: {start, end}` and `after: {start, end}` byte coordinates. A
  human-readable unified diff is presentation only and is not hashed.
- `operationId` is `bf-` plus the first 32 hexadecimal characters of a
  transaction-binding SHA-256 over the mutation-manifest, intent, policy and
  workspace-ID digests. It therefore cannot collide merely because the same
  source edit is evaluated under another policy or workspace.
- An evidence record's `receipt-sha256` hashes the exact UTF-8 output artifact
  bytes written to disk: either one preflight Statement or one complete
  `ByteFenceTransactionReceipt/v0.1`. A verifier must not parse and
  reserialize before checking that artifact digest.
- Byte counts use the raw file bytes. Line counts are `0` for an empty file;
  otherwise they are the count of LF bytes plus one, minus one when the final
  byte is LF. CR bytes remain content and CRLF is never normalized.

Unknown in-toto Statement fields are ignored as required for forward
compatibility. Unknown ByteFence operations or check IDs, and missing required
predicate fields, make a receipt insufficient for authorization and therefore deny.

## Required invariants

The verifier fails closed when any of these conditions is not satisfied:

1. The schema, predicate type and operation are recognized.
2. `targetPath` is relative, inside the root, names a regular file and does
   not traverse a symlink. Symlinks and hardlinks are denied by the v0.1 policy.
3. The observed preimage matches its declared digest and metrics.
4. The candidate matches the Statement subject digest.
5. A recomputed patch manifest matches `patchManifestDigest`.
6. The evaluated path equals the intent `targetPath`; in the public receipt,
   its digest matches `targetPathDigest`.
7. `exactReplace` observes exactly one unambiguous occurrence.
8. Applying the declared operation to the preimage produces the candidate
   byte-for-byte; every byte outside the declared before/after range is
   identical.
9. An initial UTF-8 BOM remains identical and cannot overlap the mutation range.
10. Byte, line, hunk and deletion-ratio limits satisfy the policy.
11. A full-file or policy-defined large rewrite is denied in v0.1; a future
    version requires a separately verifiable approval artifact.
12. The workspace-ID digest matches.
13. A `postApply` receipt declares `MEDIATED_PROVEN` only when the observed
    target matches the candidate digest, the embedded preflight Statement is
    referenced by digest and the cooperating-writer lock protocol was active.
    Apply and external verification keep the effective level at `CORE_PROVEN`
    unless an explicit authenticator establishes the trusted producer and
    mediation environment.

A context-pressure or compaction signal can inform review, but cannot prove
corruption and must never block on its own.

### Phase guarantees

- A `preflight` receipt proves only that the candidate was eligible against the
  observed preimage, intent and policy at check time. It does not prove that any
  write occurred or that the final file matches the candidate. Its maximum
  guarantee level is `CORE_PROVEN`.
- `bytefence-verify` receives an explicit preserved preimage at
  `--before`, plus candidate, intent and policy, and recomputes the preflight
  decision.
- `bytefence-apply` emits a `postApply` receipt that binds the embedded preflight
  Statement digest, rehashes the final target and records the declared guarantee
  level. The JSON shape can be constructed independently, so it remains
  effectively `CORE_PROVEN` without explicit producer and environment trust.
- A post-apply receipt can become stale immediately after it is emitted. It
  proves the state observed at that instant, not permanent future state.

## CLI

The existing CLI uses flat commands, so hyphenated commands avoid a parser
rewrite in the first phase.

```bash
agent-proof bytefence-check \
  --target src/pages/index.astro \
  --candidate /tmp/index.astro.candidate \
  --intent bytefence-intent.json \
  --policy policies/bytefence-default.json \
  --workspace-id example/project \
  --receipt-profile public \
  --root . \
  --out receipts/index.bytefence.json

agent-proof bytefence-verify \
  --receipt receipts/index.bytefence.json \
  --before snapshots/index.astro.before \
  --intent bytefence-intent.json \
  --policy policies/bytefence-default.json \
  --candidate /tmp/index.astro.candidate \
  --workspace-id example/project \
  --root .

agent-proof bytefence-apply \
  --intent bytefence-intent.json \
  --policy policies/bytefence-default.json \
  --workspace-id example/project \
  --receipt-profile public \
  --root . \
  --out receipts/index.bytefence.post-apply.json
```

Exit codes:

- `0`: allowed and verified;
- `1`: policy denial or integrity mismatch;
- `2`: invalid input, schema or environment;
- `3`: target committed but post-apply receipt persistence failed. Machine
  output uses `status: "committed-unreceipted"`; callers must inspect the
  target and must not retry the edit automatically.

`bytefence-check` and `bytefence-verify` are read-only except for an explicitly
requested receipt output. `bytefence-apply` is the only command that mutates
the target.
`bytefence-apply` acquires the cooperative lock, re-reads and verifies the
preimage, writes an exclusively created temporary file in the same directory,
flushes it, rechecks the target, atomically replaces the target, rehashes the
observed state and emits a post-apply receipt. Parent-directory flushing is used
where the platform exposes a supported operation. These steps do not remove the
documented race with non-cooperating writers.

A successful apply result declares `MEDIATED_PROVEN` in the transaction evidence
but exposes `effectiveGuaranteeLevel: "CORE_PROVEN"` and
`mediationEnvironmentTrusted: false`. No CLI or MCP flag silently promotes it.

### Cooperative lock and commit protocol

For v0.1 the protocol is reproducible and intentionally conservative:

1. Validate every existing path component with `lstat`; deny symlinks,
   non-regular targets, hardlinks (`nlink > 1`) and POSIX setuid/setgid bits.
2. Acquire `.<target-name>.bytefence.lock` in the target directory using
   exclusive creation (`wx`) and restrictive permissions. Write and flush the
   transaction-binding digest. An existing lock is a denial; v0.1 never breaks
   or ages out a lock automatically.
3. Re-read the target as raw bytes, metadata and digest under that cooperative
   lock. Re-evaluate the complete contract.
4. Create `.<target-name>.bytefence.<128-bit-random>.tmp` in the same directory
   using `wx`. Write candidate bytes, preserve and test basic POSIX mode bits,
   flush and close it.
5. Re-run path checks and re-read the target digest immediately before rename.
   Any change denies the commit and removes the temp.
6. Rename the temp over the target, re-read the committed bytes and emit the
   post-apply Statement. Flush the parent directory only on platforms where the
   operation is supported and tested.
7. Remove the cooperative lock in a `finally` path. A crash may leave the lock;
   recovery requires explicit inspection and removal, not automatic guessing.

Before rename, failure must leave the target equal to the preimage. After rename,
the target may be committed even if receipt persistence fails; that state is
`committed-unreceipted`. The protocol serializes cooperating ByteFence writers
but does not lock out Bash, IDEs or hostile same-user processes.

## Integration boundary

### Mistral Vibe

Vibe 2.19.1 is the first version-pinned adapter target. Hooks are a control
plane, not the transaction:

- a strict `before_tool` hook can deny a call before its tool body;
- an `after_tool` hook runs after side effects and can only support audit or
  post-hoc detection;
- Bash and third-party mutation-capable MCP tools remain bypasses unless the
  protected profile denies those surfaces entirely;
- an empty successful hook output is not an affirmative ByteFence decision.

The enforced adapter therefore supplies an explicitly named project tool from
`.vibe/tools/` that delegates the complete edit to `bytefence-apply`. It does
not replace Vibe's built-in `edit` variant. This uses an experimental internal
extension surface and falls back to explicit-tool-only or unsupported mode when
compatibility fails. Hooks may deny side doors, but they never rewrite shell
commands or perform the filesystem mutation themselves.

`check_compatibility.py --project-root <path>` inspects the deployed copy at
probe time: the Vibe version and APIs, importable tool and validated config,
exact broker security fields, allowlist, empty local and remote extension
sources, default-agent settings, enabled hooks with exact strictness, and
SHA-256 digests for the adapter runtime, tool and guard. Vibe selects the
trusted project's config instead of merging the user config, but separately
discovers user/additional-directory hooks and user/project agent profiles. The
checker therefore composes hooks through Vibe's own loader, rejects every
external hook or agent TOML, attests the pinned builtin `default` profile and
applies its overrides.

It also runs the pinned `ToolManager` selection over builtins, project tools and
the current user-tool directory. Each of the nine configured names must have
one variant, the selected class origin and digest must match the manifest, and
the default agent must expose exactly the reviewed eight-name model-facing set.
A dedicated `VIBE_HOME` may contain an ordinary, size-bounded `.env` with no
assignments or exactly one non-empty `MISTRAL_API_KEY`. Other dotenv keys,
non-empty process `VIBE_*` overrides apart from `VIBE_HOME`, documented
Python/Node/shell or loader injection variables, and any observed `--add-dir`
are unsupported.
The manifest itself is not authenticated, and the probe cannot predict later
CLI overrides or prove the files remain unchanged.

The adapter success state is `committed-and-receipted`. It confirms that a fresh
regular receipt remained stable while a bounded 4 MiB read was hashed; it does
not semantically reverify the receipt. The private mode-0600 intent is removed
on handled exit and cancellation, but `SIGKILL` or a process crash can leave it
for operating-system or operator cleanup. The underlying apply result still
declares mediation evidence while remaining effectively `CORE_PROVEN` with an
untrusted mediation environment by default.

The hook command resolves `python3` and the broker command resolves
`agent-proof` through `PATH`. The compatibility checker verifies the reviewed
command strings but not the executables selected at launch. `PATH`, the Python
interpreter and the broker remain roots of trust, so adapter compatibility alone
cannot promote the effective guarantee above `CORE_PROVEN`.

### MCP

The vendor-neutral integration is a ByteFence MCP tool that owns the transaction
locally. MCP annotations are usability hints, not a security boundary. A
third-party MCP server cannot be promoted to `MEDIATED_PROVEN` merely because
it declares itself read-only or returns a success result.

## OpenTelemetry boundary

The current, Development-status
[OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/63f8200eee093730ce845d26ce2aafb621b0807e/docs/gen-ai/gen-ai-spans.md#execute-tool-span)
define `execute_tool` spans and identifiers such as the tool name and tool-call
ID. ByteFence may import trace ID, span ID, tool-call ID and tool name for
correlation. Arguments and results are opt-in, potentially sensitive values and
must not be copied into a receipt.

Telemetry supplies correlation. The receipt supplies mutation integrity.

## Signing and in-toto compatibility

The existing Agent Proof Kit signature signs a digest of canonically serialized
JSON. It is not an in-toto envelope and must not be presented as one.

Likewise, a bare Statement is structurally an in-toto Statement but is
unauthenticated. It is not an authenticated attestation until an appropriate
envelope and signer verification are applied.

If signing is added, ByteFence will use
[DSSE](https://github.com/in-toto/attestation/blob/v1.2.0/spec/v1/envelope.md)
over the complete Statement payload, with
`payloadType=application/vnd.in-toto+json`. The signature covers DSSE
pre-authentication encoding of `payloadType` and the payload bytes. The current
proof-bundle signature remains supported independently for backward compatibility.

The predicate should be proposed upstream to in-toto only after two independent
adopters and after checking whether an existing predicate is sufficient, following
their [new predicate guidelines](https://github.com/in-toto/attestation/blob/v1.2.0/docs/new_predicate_guidelines.md).

## Mandatory test corpus

1. A mixed-EOL Vibe fixture demonstrates bytes changing outside a local anchor
   with the native edit path, while ByteFence preserves every out-of-range byte.
2. A synthetic historical 377-to-58-line candidate is denied before writing.
3. A unique exact replacement is allowed and committed byte-for-byte.
4. Two matching anchors with `expectedOccurrences: 1` are denied.
5. A full-file or policy-defined large rewrite is denied in v0.1, including when
   the input self-declares approval.
6. A target changed before the final apply recheck is denied without writing.
7. Two cooperating applies from one preimage produce exactly one commit.
8. A modified candidate invalidates the receipt.
9. An altered receipt fails digest or signature verification.
10. Absolute, parent-traversal, symlink, hardlink and non-regular targets are
    denied.
11. BOM, CRLF, mixed EOL, NFC/NFD and astral UTF-8 fixtures retain all
    out-of-range bytes.
12. Unknown operations and schema keys fail closed.
13. A receipt replayed under another workspace ID is denied.
14. Sensitive tool arguments and source fragments are absent from generated
    receipts and findings.
15. DSSE tests, when signing ships, cover valid, altered and wrong-signer
    envelopes.
16. Seeded property tests perform at least 100,000 out-of-range byte mutations
    with zero false allows.
17. Crash failpoints leave the target equal to either the complete preimage or
    complete candidate, never a partial state.
18. SARIF findings retain stable rule IDs and precise file locations.

## Delivery phases

1. **Read-only core:** schema, fixtures, `evaluateByteFence`,
   `bytefence-check` and `bytefence-verify`.
2. **Mediated application:** cooperative inter-process lock, preimage recheck,
   exclusive same-directory temporary file, flush, atomic replacement,
   post-apply hash and crash recovery classification.
3. **First public vertical slice:** CLI demo, mixed-EOL and historical
   truncation corpus, stable findings, raw benchmark data and supported-platform
   CI.
4. **Adapters:** version-pinned Mistral Vibe tool plus vendor-neutral MCP tool,
   with explicit surface-coverage reporting.
5. **Reporting and attestation:** SARIF, Agent Proof Kit evidence, OTel
   correlation and, only if justified, DSSE signer verification.
6. **Independent validation:** second mutation toolchain and adopter feedback
   before proposing an in-toto predicate upstream.

No README or release may claim prevention before phases 1 through 3 are
implemented and tested. The Vibe adapter may not claim session-wide enforcement
until phase 4 reports all enabled mutation surfaces.

## Kill criteria

Reduce or stop the proposal when any of the following holds:

- no second mutation toolchain with a reproducible integrity failure is found;
- the corpus cannot detect truncation while keeping false blocks below 5% on
  declared legitimate refactors;
- integrations cannot route the complete write through the ByteFence broker;
- the product requires a hostile-writer compare-and-swap while remaining
  portable `node:fs` code;
- no two independent adopters appear after the read-only MVP;
- in-toto maintainers identify an existing predicate that already fits;
- raw source or prompts must be captured by default for the verifier to work.

If only post-hoc verification is defensible, the project must remove every
prevention claim and remain a verifier.

## Decisions for implementation

1. v0.1 supports one unique `exactReplace` only. Anchor-bounded and multi-match
   operations require new versioned contracts.
2. `workspaceId` is required and hashed. Repository and commit remain optional
   diagnostic fields and are never authorization inputs in v0.1.
3. The bundled limits above are provisional until measured against at least 200
   declared legitimate synthetic or public edits; a false-block rate above 5%
   blocks release.
4. The first two integrations are a version-pinned Mistral Vibe project tool and
   a vendor-neutral MCP tool.
5. CLI check/verify/apply ship before the mutation-capable MCP tool. The MCP
   apply tool is exposed only after path, symlink and crash tests pass.
6. No approval artifact exists in v0.1. Full-file and policy-defined large
   rewrites are denied rather than “approved.”
7. The first ByteFence implementation release bumps `engines.node` to `>=22`;
   the previously published v0.4.1 remains installable under its contract because
   it contains no ByteFence runtime. Node.js 22 and 24 are release lines. Node
   26 Current may run as an informative CI job but is not a release guarantee.
