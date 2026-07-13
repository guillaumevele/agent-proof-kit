import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BYTEFENCE_INTENT_SCHEMA,
  canonicalByteFenceJsonBytes,
  deriveByteFenceCandidate,
  parseByteFenceIntent,
  sha256Hex
} from "../../../src/core/bytefence-contract.js";
import { evaluateByteFence } from "../../../src/core/bytefence-evaluate.js";
import {
  createByteFenceTransactionReceipt,
  receiptDigest,
  verifyByteFenceReceipt
} from "../../../src/core/bytefence-receipt.js";

const policyBytes = readFileSync("policies/bytefence-default.json");
const intentBytes = Buffer.from(
  JSON.stringify({
    $schema: BYTEFENCE_INTENT_SCHEMA,
    operation: "exactReplace",
    targetPath: "src/example.txt",
    encoding: "utf-8",
    oldText: "enabled=false",
    newText: "enabled=true",
    expectedOccurrences: 1
  })
);
const preimage = Buffer.from("header with enough bytes\nconfig: enabled=false\nlong tail\n");
const candidate = deriveByteFenceCandidate(preimage, parseByteFenceIntent(intentBytes));
const workspaceId = "example/workspace";

function evaluation(observedAt = "2026-07-13T16:00:00Z") {
  return evaluateByteFence({
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId,
    observedAt
  });
}

function verification(receipt, overrides = {}) {
  return verifyByteFenceReceipt({
    receipt,
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId,
    ...overrides
  });
}

test("verifies a preflight receipt by recomputing all bound inputs", () => {
  const result = evaluation();
  const verified = verification(result.receiptBytes, {
    expectedReceiptDigest: receiptDigest(result.receiptBytes)
  });

  assert.equal(verified.status, "verified");
  assert.equal(verified.verified, true);
  assert.equal(verified.authorized, true);
  assert.equal(verified.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(verified.producerAuthenticated, false);
  assert.equal(verified.mediationEnvironmentTrusted, false);
  assert.equal(verified.operationId, result.operationId);
});

test("fails verification for altered candidate, workspace, checks and exact artifact bytes", () => {
  const result = evaluation();
  const alteredCandidate = Buffer.from(candidate);
  alteredCandidate[0] ^= 0x01;
  assert.equal(verification(result.receiptBytes, { candidate: alteredCandidate }).verified, false);
  assert.equal(verification(result.receiptBytes, { workspaceId: "replayed/workspace" }).verified, false);

  const alteredCheck = structuredClone(result.statement);
  alteredCheck.predicate.decision.checks[1].id = "scope.unknown";
  assert.equal(verification(alteredCheck).verified, false);

  const sameJsonDifferentBytes = Buffer.concat([result.receiptBytes, Buffer.from("\n")]);
  const digestFailure = verification(sameJsonDifferentBytes, {
    expectedReceiptDigest: sha256Hex(result.receiptBytes)
  });
  assert.equal(digestFailure.verified, false);
  assert.ok(digestFailure.findings.some((finding) => finding.id === "receipt.digestMismatch"));
});

test("rejects nested and escaped duplicate keys in raw receipt bytes", () => {
  const result = evaluation();
  const duplicateDecision = result.receiptBytes
    .toString("utf8")
    .replace('"status":"allow"', '"status":"allow","\\u0073tatus":"deny"');
  const verified = verification(Buffer.from(duplicateDecision));

  assert.equal(verified.verified, false);
  assert.ok(verified.findings.some((finding) => finding.id === "receipt.duplicateKey"));
});

test("checks an expected raw digest before parsing an adversarial receipt object", () => {
  const manyValues = `{"items":[${"0,".repeat(12_000)}0]}`;
  const digestFailure = verification(Buffer.from(manyValues), {
    expectedReceiptDigest: "0".repeat(64)
  });

  assert.equal(digestFailure.verified, false);
  assert.equal(digestFailure.findings[0].id, "receipt.digestMismatch");

  const budgetFailure = verification(Buffer.from(manyValues));
  assert.equal(budgetFailure.verified, false);
  assert.equal(budgetFailure.exitCode, 2);
  assert.equal(budgetFailure.findings[0].id, "receipt.nodeLimitExceeded");
});

test("rejects a non-object raw receipt before constructing its JSON tree", () => {
  const largeArray = Buffer.from(`[${"0,".repeat(12_000)}0]`);
  const verified = verification(largeArray);

  assert.equal(verified.verified, false);
  assert.equal(verified.exitCode, 2);
  assert.equal(verified.findings[0].id, "receipt.shapeInvalid");
});

test("ignores unknown in-toto top-level fields but rejects unknown predicate fields", () => {
  const result = evaluation();
  const topLevelExtension = structuredClone(result.statement);
  topLevelExtension.builderMetadata = { version: 1 };
  topLevelExtension.subject[0].unknownDescriptorField = "ignored";
  topLevelExtension.subject[0].digest.sha512 = "f".repeat(128);
  const extensionVerification = verification(topLevelExtension);
  assert.equal(extensionVerification.verified, true);
  assert.equal(extensionVerification.publicProfileConformant, false);
  assert.ok(
    extensionVerification.findings.some(
      (finding) => finding.id === "receipt.publicProfileExtensionsPresent"
    )
  );
  assert.equal(verification(result.statement).publicProfileConformant, true);

  const predicateExtension = structuredClone(result.statement);
  predicateExtension.predicate.unversionedExtension = true;
  assert.equal(verification(predicateExtension).verified, false);
});

test("creates a transaction receipt that binds the canonical preflight Statement", () => {
  const result = evaluation();
  const transaction = createByteFenceTransactionReceipt({
    preflightStatement: result.statement,
    postApply: {
      observedAt: "2026-07-13T16:00:01Z",
      observedTarget: candidate,
      cooperatingWriterLockActive: true,
      targetMatchedCandidate: true
    }
  });

  assert.equal(transaction._type, "ByteFenceTransactionReceipt/v0.1");
  assert.equal(
    transaction.postApply.predicate.preflightStatementDigest.sha256,
    sha256Hex(canonicalByteFenceJsonBytes(transaction.preflight))
  );
  assert.equal(
    transaction.postApply.predicate.decision.declaredGuaranteeLevel,
    "MEDIATED_PROVEN"
  );
  assert.equal(transaction.postApply.predicate.mediation.cooperatingWriterLockActive, true);
});

test("promotes mediated receipts only when both explicit trust decisions are true", () => {
  const result = evaluation();
  const transaction = createByteFenceTransactionReceipt({
    preflightStatement: result.statement,
    postApply: {
      observedAt: "2026-07-13T16:00:01Z",
      observedDigest: sha256Hex(candidate),
      cooperatingWriterLockActive: true,
      targetMatchedCandidate: true
    }
  });

  const bare = verification(transaction);
  assert.equal(bare.verified, true);
  assert.equal(bare.declaredGuaranteeLevel, "MEDIATED_PROVEN");
  assert.equal(bare.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(bare.producerAuthenticated, false);
  assert.equal(bare.mediationEnvironmentTrusted, false);

  const booleanDecision = verification(transaction, {
    authenticateProducer: () => true
  });
  assert.equal(booleanDecision.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(booleanDecision.producerAuthenticated, false);
  assert.equal(booleanDecision.mediationEnvironmentTrusted, false);

  const producerOnly = verification(transaction, {
    authenticateProducer: () => ({ producerAuthenticated: true })
  });
  assert.equal(producerOnly.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(producerOnly.producerAuthenticated, true);
  assert.equal(producerOnly.mediationEnvironmentTrusted, false);

  const environmentOnly = verification(transaction, {
    authenticateProducer: () => ({ mediationEnvironmentTrusted: true })
  });
  assert.equal(environmentOnly.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(environmentOnly.producerAuthenticated, false);
  assert.equal(environmentOnly.mediationEnvironmentTrusted, true);

  const inheritedDecisions = verification(transaction, {
    authenticateProducer: () => Object.create({
      producerAuthenticated: true,
      mediationEnvironmentTrusted: true
    })
  });
  assert.equal(inheritedDecisions.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(inheritedDecisions.producerAuthenticated, false);
  assert.equal(inheritedDecisions.mediationEnvironmentTrusted, false);

  let hookCalls = 0;
  const trusted = verification(transaction, {
    authenticateProducer(context) {
      hookCalls += 1;
      assert.equal(context.receipt._type, "ByteFenceTransactionReceipt/v0.1");
      return {
        producerAuthenticated: true,
        mediationEnvironmentTrusted: true
      };
    }
  });
  assert.equal(hookCalls, 1);
  assert.equal(trusted.effectiveGuaranteeLevel, "MEDIATED_PROVEN");
  assert.equal(trusted.producerAuthenticated, true);
  assert.equal(trusted.mediationEnvironmentTrusted, true);
});

test("rejects a post-apply Statement whose observed digest was altered", () => {
  const result = evaluation();
  const transaction = createByteFenceTransactionReceipt({
    preflightStatement: result.statement,
    postApply: {
      observedAt: "2026-07-13T16:00:01Z",
      observedTarget: candidate,
      cooperatingWriterLockActive: true,
      targetMatchedCandidate: true
    }
  });
  transaction.postApply.predicate.observed.digest.sha256 = "0".repeat(64);

  const verified = verification(transaction, {
    authenticateProducer: () => ({
      producerAuthenticated: true,
      mediationEnvironmentTrusted: true
    })
  });
  assert.equal(verified.verified, false);
  assert.equal(verified.effectiveGuaranteeLevel, "OUT_OF_SCOPE");
});

test("rejects an impossible post-apply calendar timestamp before receipt creation", () => {
  const result = evaluation();
  assert.throws(
    () =>
      createByteFenceTransactionReceipt({
        preflightStatement: result.statement,
        postApply: {
          observedAt: "2026-02-30T16:00:01Z",
          observedTarget: candidate,
          cooperatingWriterLockActive: true,
          targetMatchedCandidate: true
        }
      }),
    (error) => error?.code === "event.observedAtInvalid"
  );
});

test("rejects a post-apply observation that predates its bound preflight", () => {
  const result = evaluation();
  assert.throws(
    () =>
      createByteFenceTransactionReceipt({
        preflightStatement: result.statement,
        postApply: {
          observedAt: "2026-07-13T15:59:59Z",
          observedTarget: candidate,
          cooperatingWriterLockActive: true,
          targetMatchedCandidate: true
        }
      }),
    (error) => error?.code === "event.orderInvalid"
  );
});

test("rejects a post-apply observation inverted by one nanosecond", () => {
  const result = evaluation("2026-07-13T16:00:00.123456789Z");
  assert.throws(
    () =>
      createByteFenceTransactionReceipt({
        preflightStatement: result.statement,
        postApply: {
          observedAt: "2026-07-13T16:00:00.123456788Z",
          observedTarget: candidate,
          cooperatingWriterLockActive: true,
          targetMatchedCandidate: true
        }
      }),
    (error) => error?.code === "event.orderInvalid"
  );
});
