# Policy Packs

Agent Proof Kit policies are JSON files. The bundled packs are starting points, not certifications.
Teams should copy a pack, add project-specific `privateTerms`, and review risk categories before enforcing it.

| Pack | Intended use | Minimum score | Notes |
| --- | --- | --- | --- |
| [default-policy.json](../policies/default-policy.json) | Balanced public demo and CI baseline. | 90 | Used by examples and generated artifacts. |
| [open-source-policy.json](../policies/open-source-policy.json) | Public repositories where contributor ergonomics matter. | 85 | Same high/critical zero tolerance, lighter medium/low penalties. |
| [strict-corporate-policy.json](../policies/strict-corporate-policy.json) | Internal product teams with stricter release gates. | 95 | Treats writes as high risk and scans smaller files by default. |
| [high-stakes-policy.json](../policies/high-stakes-policy.json) | Regulated or sensitive domains that need conservative defaults. | 98 | Treats network and professional-advice actions as critical. |

## Usage

```bash
node bin/agent-proof.js verify \
  --input examples/synthetic-agent-run.json \
  --policy policies/strict-corporate-policy.json
```

## YAML Policy DSL

Teams that prefer a more compact authoring format can write YAML and compile it to the same public JSON
contract:

```yaml
extends: strict-corporate
id: example-strict-corporate-yaml-policy
score:
  minimum: 96
scan:
  maxFileBytes: 256000
gates:
  synthetic: required
  decisionTrace: required
  evidenceForClaims: required
  claimsForFinalOutputs: required
actions:
  write: high
  network: high
privateTerms:
  - internal-codename
```

```bash
node bin/agent-proof.js compile-policy \
  --input examples/policies/strict-corporate-policy.yaml \
  --out compiled-policy.json
```

The CLI accepts YAML policies anywhere it accepts `--policy`, so teams can run `verify`, `scan`, `diff`,
`bundle` and `report` directly against YAML files.

## Private Terms

The bundled policies intentionally ship with empty `privateTerms`; a public package should not contain
your internal product names, customer names or staging domains. Downstream repositories should add those
terms before relying on the public-surface scan.

## Choosing A Pack

- Use `open-source-policy.json` when the repository is public and the main risk is accidental leakage.
- Use `strict-corporate-policy.json` when agent runs can write files, call internal systems, or affect releases.
- Use `high-stakes-policy.json` when traces touch medical, legal, financial, safety, identity, or regulated workflows.
