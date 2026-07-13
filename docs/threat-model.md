# Threat Model

Agent Proof Kit is a public demonstration repository. The main risk is not model failure; it is publishing
claims, examples, or artifacts that are broader than the deterministic gates can support.

## Assets

- Synthetic agent-run fixtures and policies.
- Generated proof artifacts committed under `docs/generated/`.
- The reusable CLI and composite GitHub Action.
- CI logs and artifacts produced by repository workflows.
- Downstream trust from readers who may reuse the project as a release gate.

## Threats And Controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| Real prompts, product traces, customer data, or internal names are published as examples. | Synthetic fixture marker, public boundary rules, repository scan, generated-artifact freshness checks. | Contextual leakage and unknown internal names still require configured `privateTerms` and human review before release. |
| A new action type bypasses risk classification. | Unknown action types fail closed until the policy classifies them. | Downstream policies can still choose weak classifications. |
| Schema drift makes examples look valid when the runtime rejects them, or the reverse. | JSON schemas are executed by runtime validation and schema tests. | Consumers must pin versions when relying on a stable contract. |
| Generated reports become stale and overstate current behavior. | Report, machine artifact and gate-coverage freshness checks run in `npm run verify`. | A downstream fork can disable those checks. |
| Secret-shaped values appear in text files or generated artifacts. | Public surface scan checks configured private terms, common token shapes and generated outputs with file, line and column locations when available. | Binary files and unusual secret formats still need manual review. |
| Oversized files evade scanning. | Oversized unscanned files are blocking findings instead of silent skips. | Teams must tune file-size limits to their repository shape. |
| SARIF output implies GitHub code-scanning coverage that was not uploaded. | Docs describe SARIF as an export format, not as proof of downstream upload. | Consumers must wire upload permissions and branch protections themselves. |
| The composite GitHub Action is misconfigured downstream or receives shell-sensitive paths. | A clean-checkout smoke job lets the action install its lockfile-pinned production graph, passes inputs through quoted environment variables, then covers literal metacharacter paths plus safe and unsafe result propagation. | Registry availability, downstream checkout, permissions and artifact retention remain outside this repository. |

## Release Rule

A public claim belongs in the README only when it is covered by code, tests or CI, and a generated artifact
or documentation page that a reviewer can inspect without private context.
