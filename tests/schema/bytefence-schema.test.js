import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deriveByteFenceCandidate,
  parseByteFenceIntent,
  sha256Hex
} from "../../src/core/bytefence-contract.js";
import { evaluateByteFence } from "../../src/core/bytefence-evaluate.js";
import { validateJsonSchema } from "../../src/core/json-schema-validator.js";
import { createByteFenceTransactionReceipt } from "../../src/core/bytefence-receipt.js";

const intentSchema = readJson("schemas/bytefence-intent-v0.1.schema.json");
const policySchema = readJson("schemas/bytefence-policy-v0.1.schema.json");
const statementSchema = readJson("schemas/bytefence-statement-v0.1.schema.json");
const intentBytes = readFileSync(
  "examples/bytefence/cases/exact-replace-allowed/intent.json"
);
const policyBytes = readFileSync("policies/bytefence-default.json");
const preimage = readFileSync(
  "examples/bytefence/cases/exact-replace-allowed/preimage.bin"
);
const intent = parseByteFenceIntent(intentBytes);
const candidate = deriveByteFenceCandidate(preimage, intent);

test("executes all checked-in ByteFence schemas against real artifacts", () => {
  assert.deepEqual(validateJsonSchema(JSON.parse(intentBytes), intentSchema), []);
  assert.deepEqual(validateJsonSchema(JSON.parse(policyBytes), policySchema), []);

  const evaluation = evaluateByteFence({
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId: "bytefence/schema-test",
    observedAt: "2026-07-13T10:00:00Z"
  });
  assert.equal(evaluation.status, "allow");
  assert.deepEqual(validateJsonSchema(evaluation.statement, statementSchema), []);

  const transaction = createByteFenceTransactionReceipt({
    preflightStatement: evaluation.statement,
    postApply: {
      observedAt: "2026-07-13T10:00:01Z",
      observedTarget: candidate,
      cooperatingWriterLockActive: true,
      targetMatchedCandidate: true
    }
  });
  assert.deepEqual(validateJsonSchema(transaction.preflight, statementSchema), []);
  assert.deepEqual(validateJsonSchema(transaction.postApply, statementSchema), []);
});

test("detects ByteFence const, pattern, cardinality and unknown-field violations", () => {
  const invalidIntent = JSON.parse(intentBytes);
  invalidIntent.operation = "rewrite";
  assertIssue(validateJsonSchema(invalidIntent, intentSchema), "$.operation");

  const invalidPolicy = JSON.parse(policyBytes);
  invalidPolicy.allowSymlinks = true;
  assertIssue(validateJsonSchema(invalidPolicy, policySchema), "$.allowSymlinks");

  const evaluation = evaluateByteFence({
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId: "bytefence/schema-test",
    observedAt: "2026-07-13T10:00:00Z"
  });
  const invalidStatement = structuredClone(evaluation.statement);
  invalidStatement.subject = [];
  invalidStatement.predicate.unknown = true;
  invalidStatement.predicate.before.digest.sha256 = sha256Hex(preimage).toUpperCase();
  const issues = validateJsonSchema(invalidStatement, statementSchema);

  assertIssue(issues, "$.subject");
  assertIssue(issues, "$.predicate.unknown");
  assertIssue(issues, "$.predicate.before.digest.sha256");
});

test("enforces ByteFence phase, mediation, privacy and ordered-check invariants", () => {
  const evaluation = evaluateByteFence({
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId: "bytefence/schema-invariants",
    observedAt: "2026-07-13T10:00:00Z"
  });
  const transaction = createByteFenceTransactionReceipt({
    preflightStatement: evaluation.statement,
    postApply: {
      observedAt: "2026-07-13T10:00:01Z",
      observedTarget: candidate,
      cooperatingWriterLockActive: true,
      targetMatchedCandidate: true
    }
  });

  const forgedPostApply = structuredClone(evaluation.statement);
  forgedPostApply.predicate.phase = "postApply";
  forgedPostApply.predicate.decision.declaredGuaranteeLevel = "MEDIATED_PROVEN";
  const forgedIssues = validateJsonSchema(forgedPostApply, statementSchema);
  assertIssue(forgedIssues, "$.predicate.preflightStatementDigest");
  assertIssue(forgedIssues, "$.predicate.observed");
  assertIssue(forgedIssues, "$.predicate.mediation");

  const publicDisclosure = structuredClone(evaluation.statement);
  publicDisclosure.predicate.targetPath = "private/source.txt";
  publicDisclosure.predicate.correlation = { repository: "private/repository" };
  assertIssue(validateJsonSchema(publicDisclosure, statementSchema), "$.predicate");

  const promotedPreflight = structuredClone(evaluation.statement);
  promotedPreflight.predicate.decision.declaredGuaranteeLevel = "MEDIATED_PROVEN";
  assertIssue(
    validateJsonSchema(promotedPreflight, statementSchema),
    "$.predicate.decision.declaredGuaranteeLevel"
  );

  const deniedPostApply = structuredClone(transaction.postApply);
  deniedPostApply.predicate.decision.status = "deny";
  deniedPostApply.predicate.decision.checks[1].status = "fail";
  const deniedPostIssues = validateJsonSchema(deniedPostApply, statementSchema);
  assertIssue(deniedPostIssues, "$.predicate.decision.status");
  assertIssue(deniedPostIssues, "$.predicate.decision.checks[1].status");

  const duplicateChecks = structuredClone(evaluation.statement);
  duplicateChecks.predicate.decision.checks[1].id =
    duplicateChecks.predicate.decision.checks[0].id;
  assertIssue(
    validateJsonSchema(duplicateChecks, statementSchema),
    "$.predicate.decision.checks[1].id"
  );

  const localEvaluation = evaluateByteFence({
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId: "bytefence/schema-local",
    observedAt: "2026-07-13T10:00:00Z",
    receiptProfile: "local"
  });
  const localWithoutPath = structuredClone(localEvaluation.statement);
  delete localWithoutPath.predicate.targetPath;
  assertIssue(validateJsonSchema(localWithoutPath, statementSchema), "$.predicate.targetPath");

  const preflightWithPostFields = structuredClone(evaluation.statement);
  preflightWithPostFields.predicate.preflightStatementDigest = { sha256: "0".repeat(64) };
  preflightWithPostFields.predicate.observed = {
    digest: { sha256: "0".repeat(64) },
    mediaType: "text/plain"
  };
  preflightWithPostFields.predicate.mediation = structuredClone(
    transaction.postApply.predicate.mediation
  );
  assertIssue(
    validateJsonSchema(preflightWithPostFields, statementSchema),
    "$.predicate"
  );
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertIssue(issues, location) {
  assert.ok(
    issues.some((issue) => issue.location === location),
    `Expected schema issue at ${location}: ${JSON.stringify(issues)}`
  );
}
