import { createHash, createSign, createVerify } from "node:crypto";

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function proofBundleDigest(bundle) {
  return createHash("sha256").update(canonicalJson(bundle)).digest("hex");
}

export function createProofAttestation(bundle, options = {}) {
  const digest = proofBundleDigest(bundle);
  const attestation = {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    subject: {
      tool: bundle.tool ?? null,
      status: bundle.status ?? null,
      runId: bundle.evaluation?.runId ?? null
    },
    digest: {
      algorithm: "sha256",
      value: digest
    },
    signature: null
  };

  if (options.privateKeyPem) {
    const signer = createSign("RSA-SHA256");
    signer.update(digest);
    signer.end();
    attestation.signature = {
      algorithm: "RSA-SHA256",
      value: signer.sign(options.privateKeyPem, "base64")
    };
  }

  return attestation;
}

export function verifyProofAttestation(bundle, attestation, options = {}) {
  const expectedDigest = proofBundleDigest(bundle);
  const actualDigest = attestation?.digest?.value;
  const digestMatches = actualDigest === expectedDigest;
  const result = {
    status: "pass",
    digestMatches,
    signatureVerified: null,
    findings: []
  };

  if (!digestMatches) {
    result.status = "fail";
    result.findings.push({
      id: "attestation.digest_mismatch",
      severity: "critical",
      title: "Proof bundle digest does not match attestation",
      recommendation: "Regenerate the attestation from the exact proof bundle being reviewed."
    });
  }

  if (attestation?.signature) {
    if (!options.publicKeyPem) {
      result.status = "fail";
      result.signatureVerified = false;
      result.findings.push({
        id: "attestation.public_key_missing",
        severity: "high",
        title: "Public key is required to verify signature",
        recommendation: "Pass the public key that matches the signing private key."
      });
      return result;
    }

    const verifier = createVerify("RSA-SHA256");
    verifier.update(actualDigest ?? "");
    verifier.end();
    result.signatureVerified = verifier.verify(options.publicKeyPem, attestation.signature.value, "base64");
    if (!result.signatureVerified) {
      result.status = "fail";
      result.findings.push({
        id: "attestation.signature_invalid",
        severity: "critical",
        title: "Proof bundle signature is invalid",
        recommendation: "Check that the bundle, attestation and public key belong together."
      });
    }
  }

  return result;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}
