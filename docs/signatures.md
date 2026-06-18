# Proof Bundle Attestations

Agent Proof Kit can create a detached attestation for a proof bundle.

The default attestation contains a canonical SHA-256 digest. Teams that need stronger provenance can pass
an RSA private key to add a detached `RSA-SHA256` signature.

## Digest-Only Attestation

```bash
node bin/agent-proof.js sign-bundle \
  --bundle docs/generated/proof-bundle.json \
  --out proof-bundle.attestation.json
```

Verify:

```bash
node bin/agent-proof.js verify-bundle-signature \
  --bundle docs/generated/proof-bundle.json \
  --signature proof-bundle.attestation.json
```

Expected output:

```text
PASS digest=match signature=not_present
```

## RSA Signature

```bash
node bin/agent-proof.js sign-bundle \
  --bundle docs/generated/proof-bundle.json \
  --private-key team-private-key.pem \
  --out proof-bundle.attestation.json
```

Verify with the matching public key:

```bash
node bin/agent-proof.js verify-bundle-signature \
  --bundle docs/generated/proof-bundle.json \
  --signature proof-bundle.attestation.json \
  --public-key team-public-key.pem
```

The signature covers the canonical JSON digest of the proof bundle. It does not certify model quality,
downstream workflow correctness, or the identity of a signer unless the team protects and distributes its
keys correctly.
