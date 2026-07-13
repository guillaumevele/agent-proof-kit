import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BYTEFENCE_INTENT_SCHEMA,
  BYTEFENCE_MAX_TARGET_BYTES,
  UTF8_BOM,
  deriveByteFenceCandidate,
  parseByteFenceIntent
} from "../../../src/core/bytefence-contract.js";
import { evaluateByteFence } from "../../../src/core/bytefence-evaluate.js";

const policyBytes = readFileSync("policies/bytefence-default.json");
const observedAt = "2026-07-13T16:00:00Z";

function intentDocument(overrides = {}) {
  return Buffer.from(
    JSON.stringify({
      $schema: BYTEFENCE_INTENT_SCHEMA,
      operation: "exactReplace",
      targetPath: "src/private-example.txt",
      encoding: "utf-8",
      oldText: "enabled=false",
      newText: "enabled=true",
      expectedOccurrences: 1,
      ...overrides
    })
  );
}

function allowedFixture(overrides = {}) {
  const intentBytes = overrides.intentBytes ?? intentDocument();
  const preimage =
    overrides.preimage ?? Buffer.from("header with enough bytes\r\nconfig: enabled=false\ntail=𐐀\n", "utf8");
  const intent = parseByteFenceIntent(intentBytes);
  const candidate = overrides.candidate ?? deriveByteFenceCandidate(preimage, intent);
  return {
    preimage,
    candidate,
    intentBytes,
    policyBytes: overrides.policyBytes ?? policyBytes,
    workspaceId: overrides.workspaceId ?? "example/private-workspace",
    observedAt: overrides.observedAt ?? observedAt,
    receiptProfile: overrides.receiptProfile,
    correlation: overrides.correlation
  };
}

function evaluateWithForbiddenTargetCopies(input, guardedInputs) {
  const originalBufferFrom = Buffer.from;
  let copyAttemptCount = 0;
  Buffer.from = function guardedBufferFrom(value, ...args) {
    if (guardedInputs.includes(value)) {
      copyAttemptCount += 1;
      throw new Error("test detected a forbidden target copy");
    }
    return Reflect.apply(originalBufferFrom, Buffer, [value, ...args]);
  };

  try {
    return { result: evaluateByteFence(input), copyAttemptCount };
  } finally {
    Buffer.from = originalBufferFrom;
  }
}

test("allows a unique exact replacement and emits a deterministic public Statement", () => {
  const input = allowedFixture({
    correlation: {
      repository: "https://example.invalid/private-repository",
      toolName: "private-tool-name"
    }
  });
  const result = evaluateByteFence(input);

  assert.equal(result.status, "allow");
  assert.equal(result.allowed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(result.operationId, `bf-${result.operationBindingDigest.slice(0, 32)}`);
  assert.ok(result.expectedCandidate.equals(input.candidate));
  assert.equal(result.statement.predicate.decision.declaredGuaranteeLevel, "CORE_PROVEN");
  assert.equal(result.statement.predicate.receiptProfile, "public");
  assert.equal(result.statement.predicate.targetPath, undefined);
  assert.equal(result.statement.predicate.correlation, undefined);

  const publicReceipt = result.receiptBytes.toString("utf8");
  for (const fragment of [
    "src/private-example.txt",
    "enabled=false",
    "enabled=true",
    "private-repository",
    "private-tool-name",
    "example/private-workspace"
  ]) {
    assert.equal(publicReceipt.includes(fragment), false, `public receipt leaked ${fragment}`);
  }
});

test("preserves BOM, mixed EOL, decomposed Unicode and astral bytes outside the range", () => {
  const intentBytes = intentDocument({ oldText: "cafe\u0301", newText: "café" });
  const preimage = Buffer.concat([
    UTF8_BOM,
    Buffer.from("top\r\nkeep\nvalue=cafe\u0301\r\nastral=𐐀\nlong-tail-for-ratio\n", "utf8")
  ]);
  const candidate = deriveByteFenceCandidate(preimage, parseByteFenceIntent(intentBytes));
  const result = evaluateByteFence(allowedFixture({ intentBytes, preimage, candidate }));

  assert.equal(result.status, "allow");
  assert.ok(candidate.subarray(0, 3).equals(UTF8_BOM));
  assert.ok(candidate.includes(Buffer.from("top\r\nkeep\n", "utf8")));
  assert.ok(candidate.includes(Buffer.from("astral=𐐀", "utf8")));
});

test("denies a synthetic 377-to-58-line truncation without trusting valid-looking text", () => {
  const lines = Array.from({ length: 377 }, (_, index) =>
    index === 180 ? "config: enabled=false" : `line ${String(index).padStart(3, "0")} remains`
  );
  const preimage = Buffer.from(`${lines.join("\n")}\n`);
  const candidate = Buffer.from(`${lines.slice(0, 58).join("\n")}\n`);
  const result = evaluateByteFence(allowedFixture({ preimage, candidate }));

  assert.equal(result.status, "deny");
  assert.equal(result.allowed, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.findings.some((finding) => finding.id === "candidate.derivationMismatch"));
  assert.equal(result.checks.find((check) => check.id === "scope.exact").status, "fail");
});

test("denies ambiguous anchors and full-target replacements", () => {
  const ambiguousIntent = intentDocument({ oldText: "same", newText: "changed" });
  const ambiguous = evaluateByteFence({
    ...allowedFixture({
      intentBytes: ambiguousIntent,
      preimage: Buffer.from("long prefix same and another same with tail"),
      candidate: Buffer.from("long prefix changed and another same with tail")
    })
  });
  assert.equal(ambiguous.status, "deny");
  assert.ok(ambiguous.findings.some((finding) => finding.id === "occurrence.mismatch"));

  const fullIntent = intentDocument({ oldText: "complete-target", newText: "replacement" });
  const fullPreimage = Buffer.from("complete-target");
  const fullCandidate = deriveByteFenceCandidate(fullPreimage, parseByteFenceIntent(fullIntent));
  const full = evaluateByteFence(
    allowedFixture({ intentBytes: fullIntent, preimage: fullPreimage, candidate: fullCandidate })
  );
  assert.equal(full.status, "deny");
  assert.ok(full.findings.some((finding) => finding.id === "change.fullTargetDenied"));
});

test("binds operation identity to workspace, policy and manifest but not event time", () => {
  const fixture = allowedFixture();
  const first = evaluateByteFence(fixture);
  const later = evaluateByteFence({ ...fixture, observedAt: "2026-07-13T17:00:00Z" });
  const replay = evaluateByteFence({ ...fixture, workspaceId: "another/workspace" });

  assert.equal(first.operationId, later.operationId);
  assert.equal(first.operationBindingDigest, later.operationBindingDigest);
  assert.notEqual(first.operationId, replay.operationId);
  assert.notEqual(first.workspaceIdDigest, replay.workspaceIdDigest);
});

test("uses local profile only when cleartext diagnostics are explicitly requested", () => {
  const fixture = allowedFixture({
    receiptProfile: "local",
    correlation: { traceId: "a".repeat(32), spanId: "b".repeat(16), toolName: "bytefence_apply" }
  });
  const result = evaluateByteFence(fixture);

  assert.equal(result.status, "allow");
  assert.equal(result.statement.predicate.targetPath, "src/private-example.txt");
  assert.deepEqual(result.statement.predicate.correlation, fixture.correlation);
  assert.equal(result.manifest.targetPath, "src/private-example.txt");
});

test("classifies malformed documents as invalid input without echoing source fragments", () => {
  const invalidIntent = Buffer.from(
    intentDocument().toString().replace('"expectedOccurrences":1', '"expectedOccurrences":2')
  );
  const result = evaluateByteFence({
    preimage: Buffer.from("private-source-fragment"),
    candidate: Buffer.from("another-private-fragment"),
    intentBytes: invalidIntent,
    policyBytes,
    workspaceId: "workspace",
    observedAt
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.stringify(result.findings).includes("private-source-fragment"), false);
  assert.equal(JSON.stringify(result.findings).includes("another-private-fragment"), false);
});

test("rejects absolute target overages before copying or hashing either target", () => {
  const fixture = allowedFixture();
  const oversizedPreimage = Buffer.allocUnsafe(BYTEFENCE_MAX_TARGET_BYTES + 1);
  Object.defineProperty(oversizedPreimage, "byteLength", { value: 1 });
  const preimageAttempt = evaluateWithForbiddenTargetCopies(
    { ...fixture, preimage: oversizedPreimage },
    [oversizedPreimage, fixture.candidate]
  );

  assert.equal(preimageAttempt.result.status, "invalid");
  assert.equal(preimageAttempt.result.exitCode, 2);
  assert.equal(preimageAttempt.result.findings[0].id, "preimage.byteLimitExceeded");
  assert.equal(preimageAttempt.copyAttemptCount, 0);

  const oversizedCandidate = new Uint8Array(BYTEFENCE_MAX_TARGET_BYTES + 1);
  Object.defineProperty(oversizedCandidate, "byteLength", { value: 1 });
  const candidateAttempt = evaluateWithForbiddenTargetCopies(
    { ...fixture, candidate: oversizedCandidate },
    [fixture.preimage, oversizedCandidate]
  );

  assert.equal(candidateAttempt.result.status, "invalid");
  assert.equal(candidateAttempt.result.exitCode, 2);
  assert.equal(candidateAttempt.result.findings[0].id, "candidate.byteLimitExceeded");
  assert.equal(candidateAttempt.copyAttemptCount, 0);
});

test("validates both target input types before copying either target", () => {
  const fixture = allowedFixture();
  const attempt = evaluateWithForbiddenTargetCopies(
    { ...fixture, candidate: "not raw bytes" },
    [fixture.preimage]
  );

  assert.equal(attempt.result.status, "invalid");
  assert.equal(attempt.result.exitCode, 2);
  assert.equal(attempt.result.findings[0].id, "input.bytesRequired");
  assert.equal(attempt.result.findings[0].location, "$.candidate");
  assert.equal(attempt.copyAttemptCount, 0);
});

test("keeps policy target overages below the absolute cap as a denial", () => {
  const fixture = allowedFixture();
  const policy = JSON.parse(policyBytes.toString("utf8"));
  policy.id = "bytefence-core-narrow-target";
  policy.maxTargetBytes = 16;

  const result = evaluateByteFence({
    ...fixture,
    policyBytes: Buffer.from(JSON.stringify(policy))
  });

  assert.equal(result.status, "deny");
  assert.equal(result.exitCode, 1);
  assert.ok(result.findings.some((finding) => finding.id === "change.targetTooLarge"));
  assert.ok(result.findings.some((finding) => finding.id === "change.candidateTooLarge"));
  assert.equal(result.findings.some((finding) => finding.id.endsWith(".byteLimitExceeded")), false);
});

test("rejects normalized-looking but impossible calendar timestamps", () => {
  const result = evaluateByteFence(
    allowedFixture({ observedAt: "2026-02-30T16:00:00Z" })
  );
  assert.equal(result.status, "invalid");
  assert.ok(result.findings.some((finding) => finding.id === "event.observedAtInvalid"));
});

test("uses the shared proleptic Gregorian timestamp semantics", () => {
  const result = evaluateByteFence(
    allowedFixture({ observedAt: "0000-02-29T16:00:00.000000001Z" })
  );
  assert.equal(result.status, "allow");
});
