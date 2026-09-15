# ByteFence edit protocol (Codex)

Copy this section into the repository's `AGENTS.md`. It assumes the
`agent_proof_kit` MCP server from `examples/codex/config.toml` is enabled with
`AGENT_PROOF_ROOT` set to the repository root.

## Protected files

These paths must never be edited with `apply_patch`, shell redirection, `sed -i`
or any other direct write:

- `src/config.js`
- `.github/workflows/**`

Adapt the list to the repository. Everything else follows the normal workflow.

## How to change a protected file

1. Read the file and choose the smallest `oldText` that occurs exactly once.
   `oldText` must stay under 25% of the file size (default ByteFence policy).
2. Write a fresh intent file under `.bytefence/intents/<short-name>.json`:

   ```json
   {
     "$schema": "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json",
     "operation": "exactReplace",
     "targetPath": "src/config.js",
     "encoding": "utf-8",
     "oldText": "featureFlag: false",
     "newText": "featureFlag: true",
     "expectedOccurrences": 1
   }
   ```

   The `$schema` value is part of the contract and must be copied exactly.
   Text is compared as raw UTF-8 bytes: keep the original indentation and line
   endings.
3. Call the `bytefence_apply` MCP tool with:
   - `intent_path`: the intent file from step 2
   - `policy_path`: `.bytefence/policy.json`
   - `workspace_id`: the repository slug, for example `owner/repo`
   - `receipt_path`: a new file under `.bytefence/receipts/` that does not exist yet
4. Read the result. Report `status`, `exitCode` and `effectiveGuaranteeLevel`.
   - `status: "allow"` with `exitCode: 0`: the edit is committed and receipted.
   - Any other status: the file was not changed by ByteFence. Do not fall back to
     a direct edit. Explain the finding codes and stop.
   - `exitCode: 3` (`committed-unreceipted`): the target may already contain the
     change. Never retry automatically; ask for a human decision.
5. Do not delete intents or receipts. Reviewers need them to run
   `agent-proof bytefence-verify`.

This protocol is cooperative: it relies on Codex following these instructions.
Run `agent-proof export --from codex-exec-jsonl` with
`policies/codex-bytefence-strict-policy.json` in CI to fail runs that patched
files directly. See `docs/integrations/codex.md` for the limits of that check.
