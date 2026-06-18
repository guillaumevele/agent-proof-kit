# Local Dashboard

Agent Proof Kit can render a local HTML dashboard from a proof bundle, gate coverage matrix and optional
attestation.

## Generate HTML

```bash
node bin/agent-proof.js dashboard \
  --bundle docs/generated/proof-bundle.json \
  --coverage docs/generated/gate-coverage.md \
  --attestation docs/generated/proof-bundle.attestation.json \
  --out proof-dashboard.html
```

## Serve Locally

```bash
node bin/agent-proof.js serve \
  --bundle docs/generated/proof-bundle.json \
  --coverage docs/generated/gate-coverage.md \
  --attestation docs/generated/proof-bundle.attestation.json \
  --port 8787
```

Then open `http://127.0.0.1:8787`.

The dashboard is static HTML. It does not call model providers, analytics services, or external APIs.
