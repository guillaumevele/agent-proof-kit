import { readFileSync } from "node:fs";
import {
  BYTEFENCE_MANIFEST_TYPE,
  BYTEFENCE_MAX_TARGET_BYTES,
  BYTEFENCE_STATEMENT_SCHEMA,
  IN_TOTO_STATEMENT_TYPE,
  ByteFenceContractError,
  assertNoLoneSurrogates,
  byteFenceCandidateMatches,
  canonicalByteFenceJsonBytes,
  copyByteFenceBytes,
  countByteFenceLines,
  deriveByteFenceMutation,
  hasUtf8Bom,
  isValidUtf8,
  parseByteFenceIntent,
  parseByteFencePolicy,
  sha256Hex
} from "./bytefence-contract.js";
import { parseByteFenceUtcTimestamp } from "./bytefence-time.js";

const statementContractBytes = readFileSync(
  new URL("../../schemas/bytefence-statement-v0.1.schema.json", import.meta.url)
);
const statementContractDigest = sha256Hex(statementContractBytes);
const allowedReceiptProfiles = new Set(["public", "local"]);
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength"
).get;
const allowedCorrelationKeys = new Set([
  "repository",
  "commit",
  "traceId",
  "spanId",
  "toolCallId",
  "toolName"
]);

export function evaluateByteFence({
  preimage,
  candidate,
  intentBytes,
  policyBytes,
  workspaceId,
  observedAt,
  receiptProfile = "public",
  correlation
} = {}) {
  let before;
  let proposed;
  let rawIntent;
  let rawPolicy;
  let intent;
  let policy;

  try {
    validateTargetInputs(preimage, candidate);
    before = copyByteFenceBytes(preimage, "preimage");
    proposed = copyByteFenceBytes(candidate, "candidate");
    rawIntent = copyByteFenceBytes(intentBytes, "intent document");
    rawPolicy = copyByteFenceBytes(policyBytes, "policy document");
    intent = parseByteFenceIntent(rawIntent);
    policy = parseByteFencePolicy(rawPolicy);
    validateWorkspaceId(workspaceId);
    validateObservedAt(observedAt);
    validateReceiptProfile(receiptProfile);
    validateCorrelation(correlation);
  } catch (error) {
    return invalidResult(error);
  }

  const findings = [];
  const scopeFailures = [];
  const limitFailures = [];
  const beforeDigest = sha256Hex(before);
  const candidateDigest = sha256Hex(proposed);
  const intentDigest = sha256Hex(rawIntent);
  const policyDigest = sha256Hex(rawPolicy);
  const workspaceDigest = sha256Hex(workspaceId);
  const targetPathDigest = sha256Hex(intent.targetPath);

  if (before.length === 0) {
    scopeFailures.push(
      finding(
        "preimage.emptyUnsupported",
        "high",
        "Empty preimage is unsupported",
        "$",
        "exactReplace v0.1 only evaluates existing non-empty targets."
      )
    );
  }
  if (policy.requireUtf8 && !isValidUtf8(before)) {
    scopeFailures.push(
      finding(
        "preimage.utf8Invalid",
        "high",
        "Preimage is not valid UTF-8",
        "$",
        "Supply the exact bytes of a valid UTF-8 text target."
      )
    );
  }
  if (!policy.allowNul && before.includes(0x00)) {
    scopeFailures.push(
      finding(
        "preimage.nulDenied",
        "high",
        "Preimage contains a denied NUL byte",
        "$",
        "Use a policy and operation designed for the target representation."
      )
    );
  }
  if (before.length > policy.maxTargetBytes) {
    limitFailures.push(limitFinding("change.targetTooLarge", "The preimage exceeds maxTargetBytes."));
  }
  if (proposed.length > policy.maxTargetBytes) {
    limitFailures.push(limitFinding("change.candidateTooLarge", "The candidate exceeds maxTargetBytes."));
  }

  const oldBytes = Buffer.from(intent.oldText, "utf8");
  const newBytes = Buffer.from(intent.newText, "utf8");
  if (oldBytes.length > policy.maxOldBytes) {
    limitFailures.push(limitFinding("change.oldTextTooLarge", "The replacement anchor exceeds maxOldBytes."));
  }
  if (newBytes.length > policy.maxNewBytes) {
    limitFailures.push(limitFinding("change.newTextTooLarge", "The replacement value exceeds maxNewBytes."));
  }

  let mutation;
  if (scopeFailures.length === 0) {
    try {
      mutation = deriveByteFenceMutation(before, intent);
    } catch (error) {
      if (error instanceof ByteFenceContractError) {
        scopeFailures.push(contractFinding(error));
      } else {
        return invalidResult(error);
      }
    }
  }

  if (!mutation) {
    findings.push(...scopeFailures, ...limitFailures);
    return {
      status: "deny",
      allowed: false,
      exitCode: 1,
      effectiveGuaranteeLevel: "OUT_OF_SCOPE",
      checks: makeChecks(false, limitFailures.length === 0),
      findings
    };
  }

  if (policy.requireUtf8 && !isValidUtf8(proposed)) {
    scopeFailures.push(
      finding(
        "candidate.utf8Invalid",
        "high",
        "Candidate is not valid UTF-8",
        "$",
        "Supply candidate bytes in the representation required by policy."
      )
    );
  }
  if (!policy.allowNul && proposed.includes(0x00)) {
    scopeFailures.push(
      finding(
        "candidate.nulDenied",
        "high",
        "Candidate contains a denied NUL byte",
        "$",
        "Remove the NUL byte or use a separately versioned binary operation."
      )
    );
  }
  if (!byteFenceCandidateMatches(proposed, mutation.candidate)) {
    scopeFailures.push(
      finding(
        "candidate.derivationMismatch",
        "critical",
        "Candidate does not match the declared exact replacement",
        "$",
        "Regenerate the candidate exclusively from the supplied preimage and intent."
      )
    );
  }
  if (policy.preserveUtf8Bom && hasUtf8Bom(before) !== hasUtf8Bom(proposed)) {
    scopeFailures.push(
      finding(
        "candidate.bomChanged",
        "high",
        "Candidate changes the initial UTF-8 BOM state",
        "$",
        "Preserve the initial BOM byte-for-byte."
      )
    );
  }

  const payloadStart = hasUtf8Bom(before) ? 3 : 0;
  const replacesFullTarget =
    mutation.range.before.start === payloadStart && mutation.range.before.end === before.length;
  if (policy.denyFullTargetReplacement && replacesFullTarget) {
    limitFailures.push(
      limitFinding("change.fullTargetDenied", "Full-target replacement is denied in ByteFence v0.1.")
    );
  }

  const deletionRatio = before.length === 0 ? 0 : mutation.oldBytes.length / before.length;
  if (deletionRatio > policy.maxDeletionRatio) {
    limitFailures.push(
      limitFinding("change.deletionRatioExceeded", "The declared deletion ratio exceeds policy.", {
        deletedBytes: mutation.oldBytes.length,
        beforeBytes: before.length
      })
    );
  }

  findings.push(...scopeFailures, ...limitFailures);
  const allowed = findings.length === 0;
  const checks = makeChecks(scopeFailures.length === 0, limitFailures.length === 0);
  const metrics = {
    beforeBytes: before.length,
    afterBytes: proposed.length,
    beforeLines: countByteFenceLines(before),
    afterLines: countByteFenceLines(proposed),
    addedBytes: mutation.newBytes.length,
    deletedBytes: mutation.oldBytes.length,
    addedLines: countByteFenceLines(mutation.newBytes),
    deletedLines: countByteFenceLines(mutation.oldBytes),
    hunks: 1
  };
  const manifest = {
    _type: BYTEFENCE_MANIFEST_TYPE,
    operation: intent.operation,
    targetPath: intent.targetPath,
    beforeDigest: { sha256: beforeDigest },
    candidateDigest: { sha256: candidateDigest },
    occurrenceCount: mutation.occurrenceCount,
    metrics,
    changedRanges: [mutation.range]
  };
  const manifestDigest = sha256Hex(canonicalByteFenceJsonBytes(manifest));
  const operationBinding = {
    _type: "ByteFenceOperationBinding/v0.1",
    intentDigest: { sha256: intentDigest },
    manifestDigest: { sha256: manifestDigest },
    policyDigest: { sha256: policyDigest },
    workspaceIdDigest: { sha256: workspaceDigest }
  };
  const operationBindingDigest = sha256Hex(canonicalByteFenceJsonBytes(operationBinding));
  const operationId = `bf-${operationBindingDigest.slice(0, 32)}`;
  const statement = createPreflightStatement({
    operationId,
    observedAt,
    receiptProfile,
    correlation,
    intent,
    policy,
    checks,
    allowed,
    beforeDigest,
    candidateDigest,
    intentDigest,
    policyDigest,
    workspaceDigest,
    targetPathDigest,
    manifestDigest,
    metrics
  });
  const receiptBytes = canonicalByteFenceJsonBytes(statement);

  return {
    status: allowed ? "allow" : "deny",
    allowed,
    exitCode: allowed ? 0 : 1,
    effectiveGuaranteeLevel: allowed ? "CORE_PROVEN" : "OUT_OF_SCOPE",
    operationId,
    operationBindingDigest,
    expectedCandidate: Buffer.from(mutation.candidate),
    candidateDigest,
    preimageDigest: beforeDigest,
    intentDigest,
    policyDigest,
    workspaceIdDigest: workspaceDigest,
    targetPathDigest,
    manifestDigest,
    metrics,
    checks,
    findings,
    statement,
    receiptBytes,
    publicProfileConformant: receiptProfile === "public" ? true : null,
    ...(receiptProfile === "local" ? { manifest } : {})
  };
}

export function getByteFenceStatementContractDigest() {
  return statementContractDigest;
}

function validateTargetInputs(preimage, candidate) {
  const preimageByteLength = rawTargetByteLength(preimage, "preimage");
  const candidateByteLength = rawTargetByteLength(candidate, "candidate");
  assertAbsoluteTargetLimit(preimageByteLength, "preimage");
  assertAbsoluteTargetLimit(candidateByteLength, "candidate");
}

function rawTargetByteLength(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new ByteFenceContractError(
      "input.bytesRequired",
      `The ${label} must be supplied as raw bytes.`,
      `$.${label}`
    );
  }
  try {
    return Reflect.apply(typedArrayByteLengthGetter, value, []);
  } catch {
    throw new ByteFenceContractError(
      "input.bytesRequired",
      `The ${label} must be supplied as raw bytes.`,
      `$.${label}`
    );
  }
}

function assertAbsoluteTargetLimit(byteLength, label) {
  if (byteLength > BYTEFENCE_MAX_TARGET_BYTES) {
    throw new ByteFenceContractError(
      `${label}.byteLimitExceeded`,
      `The ${label} exceeds the ByteFence v0.1 absolute target byte limit.`,
      `$.${label}`
    );
  }
}

function createPreflightStatement({
  operationId,
  observedAt,
  receiptProfile,
  correlation,
  intent,
  policy,
  checks,
  allowed,
  beforeDigest,
  candidateDigest,
  intentDigest,
  policyDigest,
  workspaceDigest,
  targetPathDigest,
  manifestDigest,
  metrics
}) {
  const predicate = {
    operationId,
    observedAt,
    phase: "preflight",
    receiptProfile,
    operation: intent.operation,
    contractDigest: { sha256: statementContractDigest },
    targetPathDigest: { sha256: targetPathDigest },
    before: {
      digest: { sha256: beforeDigest },
      mediaType: "text/plain"
    },
    workspace: {
      idDigest: { sha256: workspaceDigest }
    },
    intent: {
      digest: { sha256: intentDigest },
      expectedPathDigest: { sha256: targetPathDigest },
      expectedOccurrences: intent.expectedOccurrences
    },
    change: {
      patchManifestDigest: { sha256: manifestDigest },
      beforeBytes: metrics.beforeBytes,
      afterBytes: metrics.afterBytes,
      beforeLines: metrics.beforeLines,
      afterLines: metrics.afterLines,
      addedLines: metrics.addedLines,
      deletedLines: metrics.deletedLines,
      hunks: metrics.hunks
    },
    policy: {
      id: policy.id,
      digest: { sha256: policyDigest }
    },
    decision: {
      status: allowed ? "allow" : "deny",
      declaredGuaranteeLevel: "CORE_PROVEN",
      checks,
      approval: { status: "notApplicableInV0.1" }
    }
  };

  if (receiptProfile === "local") {
    predicate.targetPath = intent.targetPath;
    if (correlation && Object.keys(correlation).length > 0) {
      predicate.correlation = structuredClone(correlation);
    }
  }

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      {
        name: "bytefence-target",
        digest: { sha256: candidateDigest },
        mediaType: "text/plain"
      }
    ],
    predicateType: BYTEFENCE_STATEMENT_SCHEMA,
    predicate
  };
}

function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length < 1 || workspaceId.length > 1024) {
    throw new ByteFenceContractError(
      "workspace.idInvalid",
      "workspaceId must be a non-empty string of at most 1024 characters.",
      "$.workspaceId"
    );
  }
  assertNoLoneSurrogates(workspaceId, "workspace.idInvalid", "$.workspaceId");
}

function validateObservedAt(observedAt) {
  if (!parseByteFenceUtcTimestamp(observedAt)) {
    throw new ByteFenceContractError(
      "event.observedAtInvalid",
      "observedAt must be a valid explicit UTC RFC 3339 timestamp.",
      "$.observedAt"
    );
  }
}

function validateReceiptProfile(receiptProfile) {
  if (!allowedReceiptProfiles.has(receiptProfile)) {
    throw new ByteFenceContractError(
      "receipt.profileUnsupported",
      "The receipt profile is not supported by ByteFence v0.1.",
      "$.receiptProfile"
    );
  }
}

function validateCorrelation(correlation) {
  if (correlation === undefined) return;
  if (!correlation || typeof correlation !== "object" || Array.isArray(correlation)) {
    throw new ByteFenceContractError(
      "correlation.shapeInvalid",
      "Correlation metadata must be an object.",
      "$.correlation"
    );
  }
  for (const [key, value] of Object.entries(correlation)) {
    if (!allowedCorrelationKeys.has(key)) {
      throw new ByteFenceContractError(
        "correlation.unknownKey",
        "Correlation metadata contains an unsupported key.",
        "$.correlation.<unknown>"
      );
    }
    const maximumLength = key === "repository" ? 2048 : 256;
    if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
      throw new ByteFenceContractError(
        "correlation.shapeInvalid",
        "A correlation value does not satisfy the v0.1 contract.",
        `$.correlation.${key}`
      );
    }
    assertNoLoneSurrogates(value, "correlation.shapeInvalid", `$.correlation.${key}`);
  }
  if (correlation.traceId !== undefined && !/^[0-9a-f]{32}$/.test(correlation.traceId)) {
    throw new ByteFenceContractError(
      "correlation.traceIdInvalid",
      "traceId must contain 32 lowercase hexadecimal characters.",
      "$.correlation.traceId"
    );
  }
  if (correlation.spanId !== undefined && !/^[0-9a-f]{16}$/.test(correlation.spanId)) {
    throw new ByteFenceContractError(
      "correlation.spanIdInvalid",
      "spanId must contain 16 lowercase hexadecimal characters.",
      "$.correlation.spanId"
    );
  }
}

function makeChecks(scopePasses, limitsPass) {
  return [
    { id: "preimage.digestMatches", status: "pass" },
    { id: "scope.exact", status: scopePasses ? "pass" : "fail" },
    { id: "change.withinLimits", status: limitsPass ? "pass" : "fail" }
  ];
}

function invalidResult(error) {
  const safeError =
    error instanceof ByteFenceContractError
      ? error
      : new ByteFenceContractError(
          "internal.evaluationFailed",
          "ByteFence could not evaluate the supplied contract.",
          "$"
        );
  return {
    status: "invalid",
    allowed: false,
    exitCode: 2,
    effectiveGuaranteeLevel: "OUT_OF_SCOPE",
    checks: makeChecks(false, false),
    findings: [contractFinding(safeError)]
  };
}

function contractFinding(error) {
  return finding(
    error.code,
    error.code.startsWith("canonical.") ? "critical" : "high",
    "ByteFence contract check failed",
    error.location,
    error.message
  );
}

function limitFinding(id, recommendation, metrics) {
  return finding(id, "high", "Mutation exceeds ByteFence policy", "$", recommendation, metrics);
}

function finding(id, severity, title, location, recommendation, metrics) {
  return {
    id,
    severity,
    title,
    location,
    recommendation,
    ...(metrics ? { metrics } : {})
  };
}
