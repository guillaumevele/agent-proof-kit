import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createProofAttestation, proofBundleDigest, verifyProofAttestation } from "../../src/core/proof-signature.js";

const bundle = JSON.parse(readFileSync("docs/generated/proof-bundle.json", "utf8"));

test("proof bundle digest is deterministic", () => {
  assert.equal(proofBundleDigest(bundle), proofBundleDigest(structuredClone(bundle)));
  assert.match(proofBundleDigest(bundle), /^[a-f0-9]{64}$/);
});

test("digest-only attestation verifies the proof bundle", () => {
  const attestation = createProofAttestation(bundle, {
    generatedAt: "2026-06-18T00:00:00.000Z"
  });
  const result = verifyProofAttestation(bundle, attestation);
  assert.equal(result.status, "pass");
  assert.equal(result.digestMatches, true);
  assert.equal(result.signatureVerified, null);
});

test("RSA-signed attestation verifies with matching public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const attestation = createProofAttestation(bundle, {
    generatedAt: "2026-06-18T00:00:00.000Z",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
  });
  const result = verifyProofAttestation(bundle, attestation, {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" })
  });
  assert.equal(result.status, "pass");
  assert.equal(result.digestMatches, true);
  assert.equal(result.signatureVerified, true);
});

test("attestation fails when bundle content changes", () => {
  const attestation = createProofAttestation(bundle, {
    generatedAt: "2026-06-18T00:00:00.000Z"
  });
  const changed = structuredClone(bundle);
  changed.status = "fail";
  const result = verifyProofAttestation(changed, attestation);
  assert.equal(result.status, "fail");
  assert.equal(result.digestMatches, false);
  assert.ok(result.findings.some((finding) => finding.id === "attestation.digest_mismatch"));
});
