# ByteFence Mediated Writes

ByteFence is the raw-byte write boundary introduced in Agent Proof Kit 0.5.0.
It accepts one narrow operation: replace one unique UTF-8 byte sequence in one
existing regular file. The same transaction binds the observed preimage,
intent, policy, exact candidate and post-commit observation into a verifiable
receipt.

It is designed for agent tools that can delegate the complete filesystem write
to a local broker. It is not a monitor wrapped around an editor that has already
written the file.

> Release contract: this page describes ByteFence v0.5.0. The npm registry and
> repository workflow badge remain the sources of truth for package and matrix
> availability.

## What is different

A text editor can report that it replaced the requested string while also
normalizing line endings, Unicode or a BOM elsewhere in the file. ByteFence
derives the only authorized candidate directly from the raw preimage and denies
every other candidate. Its mediated path then rechecks the preimage under a
cooperative lock immediately before a same-directory replacement.

```text
private intent + raw target + policy
                 |
                 v
       derive exact candidate       bytefence-check: no target write
                 |
                 v
       acquire cooperative lock
                 |
                 v
       re-read and re-evaluate       stale preimages stop here
                 |
                 v
  exclusive same-directory temp
       + flush + final recheck
                 |
                 v
       atomic rename + rehash        bytefence-apply: one mediated write
                 |
                 v
   linked preflight/postApply receipt
```

The transaction does not capture prompts or source fragments in its public
receipt. It records digests, mutation ranges, byte counts, policy identity and
decision metadata. The private intent is still required to reproduce a
decision.

## Quickstart from a source checkout

ByteFence requires Node.js 22 or later; the release matrix covers Node.js 22 and
24. This POSIX-shell example uses the checked-in allowed corpus case, preserving
the original bytes for independent verification:

```bash
npm ci

ROOT="$(mktemp -d)"
mkdir -p "$ROOT/workspace" "$ROOT/receipts" "$ROOT/snapshots"
cp examples/bytefence/cases/exact-replace-allowed/preimage.bin "$ROOT/workspace/config.js"
cp examples/bytefence/cases/exact-replace-allowed/preimage.bin "$ROOT/snapshots/config.before"
cp examples/bytefence/cases/exact-replace-allowed/candidate.bin "$ROOT/candidate.bin"
cp examples/bytefence/cases/exact-replace-allowed/intent.json "$ROOT/intent.json"
cp policies/bytefence-default.json "$ROOT/policy.json"

node bin/agent-proof.js bytefence-check \
  --target workspace/config.js \
  --candidate "$ROOT/candidate.bin" \
  --intent "$ROOT/intent.json" \
  --policy "$ROOT/policy.json" \
  --workspace-id example/bytefence-quickstart \
  --root "$ROOT" \
  --out "$ROOT/receipts/preflight.json"

node bin/agent-proof.js bytefence-apply \
  --intent "$ROOT/intent.json" \
  --policy "$ROOT/policy.json" \
  --workspace-id example/bytefence-quickstart \
  --root "$ROOT" \
  --out "$ROOT/receipts/transaction.json"

node bin/agent-proof.js bytefence-verify \
  --receipt "$ROOT/receipts/transaction.json" \
  --before "$ROOT/snapshots/config.before" \
  --candidate "$ROOT/candidate.bin" \
  --intent "$ROOT/intent.json" \
  --policy "$ROOT/policy.json" \
  --workspace-id example/bytefence-quickstart \
  --root "$ROOT"

cmp "$ROOT/workspace/config.js" "$ROOT/candidate.bin"
```

The commands write JSON only to stdout. The important states in this sequence
are:

| Command | Expected status | Effective guarantee |
| --- | --- | --- |
| `bytefence-check` | `allow` | `CORE_PROVEN` |
| `bytefence-apply` | `allow` | `CORE_PROVEN`; the receipt declares `MEDIATED_PROVEN`, but the environment is not trusted automatically |
| `bytefence-verify` | `verified` | `CORE_PROVEN` for an unauthenticated receipt |

`bytefence-apply` requires a fresh `--out` path inside `--root`. It exits with
success only after reading that receipt back and confirming its digest. Receipt
files are created immutably rather than overwritten. Its machine result includes
`declaredGuaranteeLevel: "MEDIATED_PROVEN"`,
`effectiveGuaranteeLevel: "CORE_PROVEN"` and
`mediationEnvironmentTrusted: false`. Verification of the generated public
receipt also returns `publicProfileConformant: true`.

## Intent and policy

The v0.1 contract supports only `exactReplace`, with one required occurrence:

```json
{
  "$schema": "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json",
  "operation": "exactReplace",
  "targetPath": "src/config.js",
  "encoding": "utf-8",
  "oldText": "const enabled = false;",
  "newText": "const enabled = true;",
  "expectedOccurrences": 1
}
```

The runtime rejects unknown contract keys. `oldText` and `newText` become UTF-8
bytes without EOL or Unicode normalization. The target must be valid UTF-8; an
initial UTF-8 BOM is permitted but protected from mutation. The bundled policy
also denies full-target replacement, symlinks, hardlinks, NUL bytes and deletion
above its configured ratio.

See the versioned [intent schema](../../schemas/bytefence-intent-v0.1.schema.json),
[policy schema](../../schemas/bytefence-policy-v0.1.schema.json),
[receipt schema](../../schemas/bytefence-statement-v0.1.schema.json) and
[default policy](../../policies/bytefence-default.json).

JSON Schema validation establishes document shape, not authorization. Consumers
must run the ByteFence verifier against the preserved preimage, candidate,
intent, policy and workspace ID. In particular, an object that merely labels
itself `postApply` or `MEDIATED_PROVEN` cannot establish either claim without
the transaction wrapper, linked preflight evidence and runtime invariants.

Verification keeps integrity and publication hygiene separate. A standard
public receipt returns `publicProfileConformant: true`. Unknown in-toto
top-level, subject or digest extensions can remain verifiable at `CORE_PROVEN`,
but return `publicProfileConformant: false` with a finding because those fields
may contain cleartext. Unknown predicate extensions remain invalid. The field is
not applicable to a local-profile receipt.

## Guarantee levels

Guarantee levels are deliberately not interchangeable:

| Level | What a verifier may conclude |
| --- | --- |
| `CORE_PROVEN` | The preimage, unique occurrence, exact byte derivation, policy decision and receipt content can be recomputed from supplied inputs. |
| `MEDIATED_PROVEN` | A supported local run used the cooperative lock, rechecked the preimage, committed the exact candidate and observed it after rename. Acceptance requires explicit trust in the producer and mediation environment. |
| `POSTHOC_DETECTED` | A later observation found a match or mismatch. This is detection, not prevention. |
| `OUT_OF_SCOPE` | The write bypassed the broker or the environment is unsupported, so no ByteFence write-integrity claim applies. |

The postApply Statement declares the evidence required for a mediated claim,
but the live apply engine does not promote its own effective result: it returns
`CORE_PROVEN` and `mediationEnvironmentTrusted: false`. Anyone can serialize a
JSON object with a `postApply` shape, so the shape itself is not evidence of
mediation. The external verifier recomputes the linked content but keeps a bare
receipt at `CORE_PROVEN`. A trust policy that promotes it must authenticate the
producer and establish the deployment environment. Version 0.5.0 does not
present its existing digest/RSA attestation format as DSSE.

The programmatic verifier makes that promotion contract explicit. Its
`authenticateProducer` callback must return an object with both own properties
`producerAuthenticated: true` and `mediationEnvironmentTrusted: true`. A bare
boolean, the former `{ trusted: true }` shape, an inherited property or either
decision alone leaves the effective level at `CORE_PROVEN`.

The producing process cannot discover every competing writer or infer that an
arbitrary filesystem has the semantics of the tested local filesystems. The
0.5.0 CLI and MCP paths therefore provide no automatic effective
`MEDIATED_PROVEN` result. A higher-level verifier may accept that level only
after an explicit, reviewable trust decision covering those conditions.

## Exit codes and retry rule

| Code | Meaning | Retry behavior |
| ---: | --- | --- |
| `0` | Allowed and verified. | No retry is needed. |
| `1` | Policy denial or integrity mismatch, including a target above the policy's `maxTargetBytes`. | Change the intent, policy or inputs; do not treat it as success. |
| `2` | Invalid schema, absolute runtime cap, path or environment. | Correct the input or environment first. |
| `3` | The target committed, but receipt persistence or post-commit confirmation failed. Status is `committed-unreceipted`. | Never retry automatically; inspect the target and receipt path. |

An existing cooperative lock is denied and never auto-broken. A crash can leave
the lock and, before rename, an exclusive temporary file. Recovery is an
explicit operator action after inspecting the target and transaction files.

## Evidence in the repository

Version 0.5.0 includes evidence rather than relying on an editor success
message:

| Evidence | Current checked-in claim |
| --- | --- |
| Adversarial corpus | Seven deterministic raw-byte cases: allowed exact replacement, ambiguous anchor, synthetic 377-to-58 truncation, mixed EOL, BOM removal, Unicode normalization and full-target rewrite. |
| Out-of-scope property test | The raw-byte matcher rejects 100,000 seeded byte mutations outside the declared range with zero false allows; the complete receipt-producing evaluator is sampled every 512 iterations with zero false allows. |
| Legitimate-edit property test | 1,000 seeded unique replacements across mixed EOL, BOM, decomposed Unicode and astral UTF-8, with zero false blocks. |
| Concurrency test | Two cooperating processes start from the same preimage; exactly one commits. |
| Crash tests | `SIGKILL` after lock, after temp flush and after rename leaves the complete preimage or complete candidate, never a partial target, on the tested POSIX host. |
| Platform workflow | ByteFence contract, corpus and filesystem tests are configured for GitHub-hosted Ubuntu, macOS and Windows on Node.js 24. The general verification job is configured for Node.js 22 and 24 on Ubuntu. |
| Vibe adapter | A separate workflow installs exactly Mistral Vibe 2.19.1 on Python 3.12 and runs the adapter compatibility contract without invoking a model. |

Run the deterministic evidence locally:

```bash
npm run test:bytefence
npm run corpus:verify
npm run test:vibe-adapter
npm run bytefence:benchmark
```

The workflow matrix being present is not, by itself, a green-run claim. Consult
the commit's GitHub Actions result before treating all platform cells as passed.
POSIX mode preservation and `SIGKILL` crash tests are skipped where Windows has
no equivalent contract.

## Mistral Vibe 2.19.1

The version-pinned Vibe integration exposes an explicit project tool named
`bytefence_apply`. It delegates the entire operation to
`agent-proof bytefence-apply`; it does not wrap or replace Vibe's native `edit`
tool. The protected example profile excludes native `edit`, `write_file`,
`bash` and `task`, fixes `tool_paths`, MCP servers and connectors to empty, and
disables connector discovery and the configuration orchestrator. It enables
only the pinned builtin `default` agent, rejects every external agent profile,
and applies that builtin's `exit_plan_mode` disable so exactly eight tools reach
the model. A strict `before_tool` hook is a second guard for the declared side
doors.

```bash
python3 adapters/vibe/check_compatibility.py --project-root /absolute/path/to/project
npm run test:vibe-adapter
npm run bytefence:reproduce-vibe
```

The static mixed-EOL fixture is deterministic and requires neither a model nor
authentication. The optional reproduction script exercises installed Vibe I/O
code on a temporary copy. It exits with an explicit skip when Vibe is absent.
The checked-in candidate was reproduced with Vibe 2.19.0; 2.19.1 is the pinned
adapter target and CI dependency.

On exit `0`, the compatibility script has inspected the named project root at
that instant: it imports and validates the deployed tool, checks the exact
allowlist, broker configuration, project-tool inventory, remote-source settings
and hook strictness. It confirms that trusted-project selection chose the
project config without merging the user config, while separately composing the
actual project, additional-directory and user hook files. Any external hook or
agent TOML is unsupported. Through Vibe 2.19.1's builtin default-agent model and
`ToolManager`, it also requires one variant for each of the nine configured
names, attests the selected classes' origins and SHA-256 values, and requires the
exact eight-name model-facing set, including tools visible from the current
`VIBE_HOME`.

Protected launches use a dedicated `VIBE_HOME`. Its optional `.env` must be an
ordinary regular file of at most 1 MiB with no assignments or exactly one
non-empty `MISTRAL_API_KEY`; other keys, including `VIBE_HOME`, `PYTHONPATH` and
`NODE_OPTIONS`, are rejected. Non-empty process `VIBE_*` variables other than
`VIBE_HOME`, and the documented Python, Node, shell and dynamic-loader injection
variables, are likewise unsupported. Every observed `--add-dir` is unsupported.
The script does not authenticate the manifest, predict future CLI overrides or
prove files remain unchanged after the probe.

Vibe's project-tool and hook APIs are internal or experimental. A non-broker
class collision or other contract drift falls back to the explicitly named
tool, while a `bytefence_apply` collision is unsupported because that name no
longer resolves to reviewed code. Neither outcome may silently claim
session-wide enforcement. `after_tool` is audit-only because it runs after side
effects. The allowlist, not the hook's finite deny patterns, is what excludes
unreviewed tools.

A successful adapter outcome is `committed-and-receipted`: the adapter confirms
that a fresh regular receipt remained stable while it was hashed, with a 4 MiB
read bound. It does not independently recompute the receipt's ByteFence
semantics. The private intent is mode `0600` on POSIX and is removed on handled
exit or cancellation. `SIGKILL` or a process crash can leave it in the operating
system temporary directory for OS or operator cleanup. See the
[adapter documentation](../../adapters/vibe/README.md) for the surface
inventory, installation profile and unknown-state behavior.

The hooks invoke `python3` and the broker invokes `agent-proof` by name. The
checker verifies those command strings, not the executables selected by
`PATH`. `PATH`, the Python interpreter and the broker remain explicit trust
roots, so even a green adapter check does not raise the effective result above
`CORE_PROVEN` without separate producer and mediation-environment trust.

## MCP

The local stdio server exposes `bytefence_check` and `bytefence_apply`.
`bytefence_apply` owns one transaction and never retries it. MCP annotations
mark it destructive and non-idempotent, but annotations are client hints rather
than an authorization boundary. See the [MCP integration](mcp.md) for schemas,
workspace confinement and an example client configuration.

## Explicit limits

- Writers that bypass the cooperative broker remain outside the guarantee.
  Bash, an IDE, another MCP server or a hostile same-user process can still race
  the final check and rename.
- The protocol is not a universal filesystem compare-and-swap. It serializes
  cooperating ByteFence writers on tested local filesystems.
- Network filesystems, FUSE, power-loss durability, ACLs, ownership, xattrs and
  platform-specific alternate data are outside v0.1.
- The operation cannot create, delete, rename or replace an entire file. v0.1
  intentionally supports one unique `exactReplace` only.
- A post-apply receipt describes the file state observed at that instant. It
  does not guarantee the file remains unchanged later.
- A public receipt avoids raw source, prompt, repository and path values, but
  digests can still link or reveal low-entropy paths, workspace IDs and small
  file contents through guessing. It is neither a confidentiality nor an
  anonymity claim.

The full rationale and threat model are in the
[approved ByteFence RFC](../rfc-bytefence.md).
