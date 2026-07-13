# ByteFence adversarial corpus

This versioned corpus exercises one narrow contract: an `exactReplace` candidate
must be derivable from the supplied preimage as raw bytes, and policy may still
deny the operation. It deliberately separates three artifacts:

- `preimage.bin`: bytes observed before the proposed operation;
- `candidate.bin`: bytes presented to ByteFence for evaluation;
- `expected-candidate.bin`: the only candidate produced by the declared unique
  replacement, when such a candidate exists.

The `.bin` suffix is intentional. These files must not pass through text-mode
I/O. Some contain mixed line endings, an initial UTF-8 BOM, decomposed Unicode or
astral UTF-8. [`corpus-v0.1.json`](./corpus-v0.1.json) records the exact byte
length and SHA-256 digest of every generated artifact.

## Cases

| Case | Expected decision | Contract exercised |
| --- | --- | --- |
| `exact-replace-allowed` | allow | Unique exact replacement control |
| `synthetic-truncation-377-to-58` | deny | Requested edit plus out-of-scope truncation |
| `ambiguous-occurrences-denied` | deny | Two anchors where v0.1 requires one |
| `vibe-mixed-eol-out-of-scope` | deny | Isolated LF rewritten as CRLF outside the anchor |
| `utf8-bom-removal-denied` | deny | Initial UTF-8 BOM removed outside the anchor |
| `unicode-nfc-nfd-out-of-scope` | deny | NFD normalized to NFC outside the anchor |
| `full-target-rewrite-denied` | deny | Exact but policy-denied full-target rewrite |

The 377-to-58 case is synthetic. It reproduces the shape of a historical report,
not a claim about a current editor. The full rewrite contains a self-declared
approval string to demonstrate that untrusted input cannot grant authority.

## Deterministic verification

Regenerate only when intentionally updating the corpus:

```sh
node scripts/bytefence/generate-corpus.js --write
```

CI and local checks use read-only verification:

```sh
node scripts/bytefence/generate-corpus.js --check
node --test tests/bytefence/corpus/corpus.test.js
```

The generator reconstructs every fixture independently and fails on missing,
modified or unexpected generated case files. Corpus tests then verify the
recorded digests, semantic invariants and ByteFence decisions.

## Optional Mistral Vibe reproduction

The static mixed-EOL fixture has no Vibe, Python, model, authentication or
network dependency. An optional local script exercises the installed Vibe code
path and compares its output with the pinned candidate:

```sh
node scripts/bytefence/reproduce-vibe-mixed-eol.js
```

The script imports these symbols from the installed package:

- `vibe.core.utils.io.read_safe`;
- `vibe.core.tools.builtins.edit.Edit._apply_edit`;
- `vibe.core.utils.io.atomic_replace`.

The v0.1.0 fixture pins these raw-byte results:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Preimage | 90 | `61757d5fd31b926962c42e53814e7a9b0cf6b6ec28c0203a08098fdcd75a8375` |
| ByteFence exact candidate | 89 | `d41547480d296f6e756e00bbbdb89a444cc9591054d818093e242b3b17f8663c` |
| Vibe-path candidate | 90 | `e9e38d550a95654d58ab205d800bf360de019a1aa04a52841eb921673fb15b2c` |

It operates on a temporary copy, prints the detected Vibe version and all
relevant SHA-256 digests, and never invokes a model. If Vibe is absent, it exits
successfully with an explicit `skipped` result so the deterministic CI contract
remains unchanged. The checked-in candidate was reproduced locally with Vibe
2.19.0; the RFC adapter target remains 2.19.1, so the script reports rather than
assumes compatibility with the version installed on another machine.
