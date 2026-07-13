import {
  BYTEFENCE_LOCK_PROTOCOL,
  BYTEFENCE_MAX_RECEIPT_BYTES,
  BYTEFENCE_STATEMENT_SCHEMA,
  BYTEFENCE_TRANSACTION_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  ByteFenceContractError,
  canonicalByteFenceJsonBytes,
  copyByteFenceBytes,
  parseByteFenceJsonDocument,
  sha256Hex
} from "./bytefence-contract.js";
import { evaluateByteFence } from "./bytefence-evaluate.js";
import {
  compareByteFenceUtcTimestamps,
  parseByteFenceUtcTimestamp
} from "./bytefence-time.js";

const sha256Pattern = /^[0-9a-f]{64}$/;
const MAX_RECEIPT_OBJECT_NODES = 10_000;

export { sha256Hex };

export function receiptDigest(bytes) {
  return sha256Hex(bytes);
}

export function createByteFenceTransactionReceipt({ preflightStatement, postApply } = {}) {
  const postApplyStatement = createByteFencePostApplyStatement({ preflightStatement, postApply });
  return {
    _type: BYTEFENCE_TRANSACTION_TYPE,
    preflight: structuredClone(preflightStatement),
    postApply: postApplyStatement
  };
}

export function createByteFencePostApplyStatement({ preflightStatement, postApply } = {}) {
  validatePreflightForTransaction(preflightStatement);
  if (!postApply || typeof postApply !== "object" || Array.isArray(postApply)) {
    throw new ByteFenceContractError(
      "transaction.postApplyInvalid",
      "Post-apply evidence must be supplied as an object.",
      "$.postApply"
    );
  }
  const postApplyTimestamp = validateObservedAt(
    postApply.observedAt,
    "$.postApply.observedAt"
  );
  const preflightTimestamp = validateObservedAt(
    preflightStatement?.predicate?.observedAt,
    "$.preflight.predicate.observedAt"
  );
  if (
    compareByteFenceUtcTimestamps(postApplyTimestamp, preflightTimestamp) < 0
  ) {
    throw new ByteFenceContractError(
      "event.orderInvalid",
      "The post-apply observation cannot precede its preflight observation.",
      "$.postApply.observedAt"
    );
  }
  if (postApply.cooperatingWriterLockActive !== true || postApply.targetMatchedCandidate !== true) {
    throw new ByteFenceContractError(
      "transaction.mediationUnproven",
      "A mediated receipt requires an active cooperating-writer lock and an observed candidate match.",
      "$.postApply"
    );
  }

  const candidateDigest = preflightStatement.subject[0].digest.sha256;
  const observedDigest = resolveObservedDigest(postApply);
  if (observedDigest !== candidateDigest) {
    throw new ByteFenceContractError(
      "transaction.observedTargetMismatch",
      "The observed target digest does not match the authorized candidate.",
      "$.postApply.observedDigest"
    );
  }

  const preflightDigest = sha256Hex(canonicalByteFenceJsonBytes(preflightStatement));
  const predicate = structuredClone(preflightStatement.predicate);
  predicate.observedAt = postApply.observedAt;
  predicate.phase = "postApply";
  predicate.decision.declaredGuaranteeLevel = "MEDIATED_PROVEN";
  predicate.preflightStatementDigest = { sha256: preflightDigest };
  predicate.observed = {
    digest: { sha256: observedDigest },
    mediaType: "text/plain"
  };
  predicate.mediation = {
    protocol: BYTEFENCE_LOCK_PROTOCOL,
    cooperatingWriterLockActive: true,
    targetMatchedCandidate: true
  };

  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: structuredClone(preflightStatement.subject),
    predicateType: BYTEFENCE_STATEMENT_SCHEMA,
    predicate
  };
}

export function verifyByteFenceReceipt({
  receipt,
  preimage,
  candidate,
  intentBytes,
  policyBytes,
  workspaceId,
  expectedReceiptDigest,
  authenticateProducer
} = {}) {
  let parsed;
  let receiptBytes;

  if (expectedReceiptDigest !== undefined && !sha256Pattern.test(expectedReceiptDigest)) {
    return failedVerification(
      new ByteFenceContractError(
        "receipt.expectedDigestInvalid",
        "The expected receipt digest must be 64 lowercase hexadecimal characters.",
        "$.expectedReceiptDigest"
      )
    );
  }

  try {
    receiptBytes = prepareRawReceiptBytes(receipt);
  } catch (error) {
    return failedVerification(error);
  }

  if (expectedReceiptDigest !== undefined) {
    if (!receiptBytes) {
      return failedVerification(
        new ByteFenceContractError(
          "receipt.rawBytesRequired",
          "Exact artifact digest verification requires the original receipt bytes.",
          "$.receipt"
        )
      );
    }
    if (sha256Hex(receiptBytes) !== expectedReceiptDigest) {
      return failedVerification(
        new ByteFenceContractError(
          "receipt.digestMismatch",
          "The exact receipt bytes do not match the expected artifact digest.",
          "$.receipt"
        )
      );
    }
  }

  try {
    ({ parsed, bytes: receiptBytes } = parseReceipt(receipt, receiptBytes));
  } catch (error) {
    return failedVerification(error);
  }

  if (parsed?._type === BYTEFENCE_TRANSACTION_TYPE) {
    return verifyTransactionReceipt({
      receipt: parsed,
      preimage,
      candidate,
      intentBytes,
      policyBytes,
      workspaceId,
      authenticateProducer
    });
  }
  return verifyPreflightStatement({
    statement: parsed,
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId
  });
}

function verifyTransactionReceipt({
  receipt,
  preimage,
  candidate,
  intentBytes,
  policyBytes,
  workspaceId,
  authenticateProducer
}) {
  const keys = Object.keys(receipt).sort();
  if (keys.join(",") !== "_type,postApply,preflight") {
    return failedVerification(
      new ByteFenceContractError(
        "transaction.shapeInvalid",
        "The transaction receipt contains missing or unsupported fields.",
        "$"
      )
    );
  }

  const preflightVerification = verifyPreflightStatement({
    statement: receipt.preflight,
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId
  });
  if (!preflightVerification.verified || !preflightVerification.authorized) {
    return {
      ...preflightVerification,
      receiptType: BYTEFENCE_TRANSACTION_TYPE,
      effectiveGuaranteeLevel: "OUT_OF_SCOPE"
    };
  }

  let expectedPostApply;
  try {
    const predicate = receipt.postApply?.predicate;
    expectedPostApply = createByteFencePostApplyStatement({
      preflightStatement: receipt.preflight,
      postApply: {
        observedAt: predicate?.observedAt,
        observedDigest: predicate?.observed?.digest?.sha256,
        cooperatingWriterLockActive: predicate?.mediation?.cooperatingWriterLockActive,
        targetMatchedCandidate: predicate?.mediation?.targetMatchedCandidate
      }
    });
  } catch (error) {
    return failedVerification(error, BYTEFENCE_TRANSACTION_TYPE);
  }

  if (!canonicalObjectsEqual(receipt.postApply, expectedPostApply)) {
    return failedVerification(
      new ByteFenceContractError(
        "transaction.postApplyMismatch",
        "The post-apply Statement does not match the embedded preflight evidence.",
        "$.postApply"
      ),
      BYTEFENCE_TRANSACTION_TYPE
    );
  }

  const postApplyProfile = assessPublicProfile(receipt.postApply);
  const publicProfileConformant =
    preflightVerification.publicProfileConformant === false ||
    postApplyProfile.publicProfileConformant === false
      ? false
      : preflightVerification.publicProfileConformant;

  let producerAuthenticated = false;
  let mediationEnvironmentTrusted = false;
  if (authenticateProducer !== undefined) {
    if (typeof authenticateProducer !== "function") {
      return failedVerification(
        new ByteFenceContractError(
          "receipt.authenticatorInvalid",
          "Producer authentication must be supplied as an explicit verification function.",
          "$.authenticateProducer"
        ),
        BYTEFENCE_TRANSACTION_TYPE
      );
    }
    try {
      const authentication = authenticateProducer({
        receipt,
        preflightStatement: receipt.preflight,
        postApplyStatement: receipt.postApply
      });
      if (authentication && typeof authentication.then === "function") {
        throw new Error("Async authentication is not supported by this synchronous verifier.");
      }
      const decisions =
        authentication && typeof authentication === "object" && !Array.isArray(authentication)
          ? authentication
          : null;
      const authenticatedDecision =
        decisions !== null &&
        Object.hasOwn(decisions, "producerAuthenticated") &&
        decisions.producerAuthenticated === true;
      const environmentDecision =
        decisions !== null &&
        Object.hasOwn(decisions, "mediationEnvironmentTrusted") &&
        decisions.mediationEnvironmentTrusted === true;
      producerAuthenticated = authenticatedDecision;
      mediationEnvironmentTrusted = environmentDecision;
    } catch {
      producerAuthenticated = false;
      mediationEnvironmentTrusted = false;
    }
  }

  const mediatedGuaranteeAccepted =
    producerAuthenticated && mediationEnvironmentTrusted;

  return {
    status: "verified",
    verified: true,
    authorized: true,
    exitCode: 0,
    receiptType: BYTEFENCE_TRANSACTION_TYPE,
    declaredGuaranteeLevel: "MEDIATED_PROVEN",
    effectiveGuaranteeLevel: mediatedGuaranteeAccepted ? "MEDIATED_PROVEN" : "CORE_PROVEN",
    producerAuthenticated,
    mediationEnvironmentTrusted,
    operationId: receipt.preflight.predicate.operationId,
    publicProfileConformant,
    findings: [
      ...(preflightVerification.findings ?? []),
      ...postApplyProfile.findings,
      ...(mediatedGuaranteeAccepted
        ? []
        : [
          {
            id: "receipt.mediatedLevelUnauthenticated",
            severity: "low",
            title: "Mediated guarantee was downgraded",
            location: "$.postApply.predicate.decision.declaredGuaranteeLevel",
            recommendation:
              "Require explicit producer authentication and mediation-environment trust before accepting MEDIATED_PROVEN externally."
          }
        ])
    ]
  };
}

function verifyPreflightStatement({
  statement,
  preimage,
  candidate,
  intentBytes,
  policyBytes,
  workspaceId
}) {
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) {
    return failedVerification(
      new ByteFenceContractError("receipt.shapeInvalid", "The receipt must be a JSON object.", "$")
    );
  }
  if (statement._type !== IN_TOTO_STATEMENT_TYPE || statement.predicateType !== BYTEFENCE_STATEMENT_SCHEMA) {
    return failedVerification(
      new ByteFenceContractError(
        "receipt.contractUnsupported",
        "The in-toto Statement or ByteFence predicate type is unsupported.",
        "$"
      )
    );
  }
  if (statement.predicate?.phase !== "preflight") {
    return failedVerification(
      new ByteFenceContractError(
        "receipt.phaseUnsupported",
        "A standalone receipt must be a preflight Statement.",
        "$.predicate.phase"
      )
    );
  }

  const receiptProfile = statement.predicate?.receiptProfile;
  const correlation = receiptProfile === "local" ? statement.predicate?.correlation : undefined;
  const evaluation = evaluateByteFence({
    preimage,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId,
    observedAt: statement.predicate?.observedAt,
    receiptProfile,
    correlation
  });
  if (!evaluation.statement) {
    return {
      status: "failed",
      verified: false,
      authorized: false,
      exitCode: evaluation.exitCode === 2 ? 2 : 1,
      receiptType: "preflight",
      declaredGuaranteeLevel: statement.predicate?.decision?.declaredGuaranteeLevel ?? "OUT_OF_SCOPE",
      effectiveGuaranteeLevel: "OUT_OF_SCOPE",
      producerAuthenticated: false,
      mediationEnvironmentTrusted: false,
      findings: evaluation.findings
    };
  }

  const relevantStatement = {
    _type: statement._type,
    subject: Array.isArray(statement.subject)
      ? statement.subject.map((subject) => ({
          name: subject?.name,
          digest: { sha256: subject?.digest?.sha256 },
          mediaType: subject?.mediaType
        }))
      : statement.subject,
    predicateType: statement.predicateType,
    predicate: statement.predicate
  };
  if (!canonicalObjectsEqual(relevantStatement, evaluation.statement)) {
    return failedVerification(
      new ByteFenceContractError(
        "receipt.contentMismatch",
        "The receipt does not match the recomputed ByteFence decision.",
        "$"
      )
    );
  }

  const profile = assessPublicProfile(statement);

  return {
    status: "verified",
    verified: true,
    authorized: evaluation.allowed,
    exitCode: evaluation.allowed ? 0 : 1,
    receiptType: "preflight",
    declaredGuaranteeLevel: statement.predicate.decision.declaredGuaranteeLevel,
    effectiveGuaranteeLevel: evaluation.allowed ? "CORE_PROVEN" : "OUT_OF_SCOPE",
    producerAuthenticated: false,
    mediationEnvironmentTrusted: false,
    publicProfileConformant: profile.publicProfileConformant,
    operationId: evaluation.operationId,
    findings: [...evaluation.findings, ...profile.findings]
  };
}

function assessPublicProfile(statement) {
  if (statement?.predicate?.receiptProfile !== "public") {
    return { publicProfileConformant: null, findings: [] };
  }

  const topLevelKeys = new Set(["_type", "subject", "predicateType", "predicate"]);
  const subjectKeys = new Set(["name", "digest", "mediaType"]);
  const digestKeys = new Set(["sha256"]);
  const hasExtension =
    Object.keys(statement).some((key) => !topLevelKeys.has(key)) ||
    !Array.isArray(statement.subject) ||
    statement.subject.some((subject) => (
      !subject ||
      typeof subject !== "object" ||
      Object.keys(subject).some((key) => !subjectKeys.has(key)) ||
      !subject.digest ||
      typeof subject.digest !== "object" ||
      Object.keys(subject.digest).some((key) => !digestKeys.has(key))
    ));

  if (!hasExtension) {
    return { publicProfileConformant: true, findings: [] };
  }
  return {
    publicProfileConformant: false,
    findings: [
      {
        id: "receipt.publicProfileExtensionsPresent",
        severity: "medium",
        title: "Public receipt contains unreviewed in-toto extensions",
        location: "$",
        recommendation:
          "Do not publish this artifact as a ByteFence public-profile receipt; extensions may carry cleartext."
      }
    ]
  };
}

function prepareRawReceiptBytes(receipt) {
  if (typeof receipt === "string") {
    if (Buffer.byteLength(receipt, "utf8") > BYTEFENCE_MAX_RECEIPT_BYTES) {
      throw receiptTooLargeError();
    }
    const bytes = Buffer.from(receipt, "utf8");
    assertReceiptObjectPrefix(bytes);
    return bytes;
  }
  if (Buffer.isBuffer(receipt) || receipt instanceof Uint8Array) {
    if (receipt.byteLength > BYTEFENCE_MAX_RECEIPT_BYTES) {
      throw receiptTooLargeError();
    }
    const bytes = copyByteFenceBytes(receipt, "receipt");
    assertReceiptObjectPrefix(bytes);
    return bytes;
  }
  return null;
}

function parseReceipt(receipt, preparedBytes) {
  if (preparedBytes) {
    return { parsed: parseReceiptBytes(preparedBytes), bytes: preparedBytes };
  }
  if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
    assertReceiptObjectBudget(receipt);
    const canonical = canonicalByteFenceJsonBytes(receipt);
    if (canonical.length > BYTEFENCE_MAX_RECEIPT_BYTES) throw receiptTooLargeError();
    return { parsed: structuredClone(receipt), bytes: null };
  }
  throw new ByteFenceContractError("receipt.shapeInvalid", "The receipt must be bytes or a JSON object.", "$");
}

function assertReceiptObjectBudget(receipt) {
  const pending = [receipt];
  const seen = new Set();
  let nodes = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    nodes += 1;
    if (nodes > MAX_RECEIPT_OBJECT_NODES) throw receiptNodeLimitError();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const entries = Array.isArray(value) ? value : Object.values(value);
    nodes += Array.isArray(value) ? 0 : Object.keys(value).length;
    if (
      nodes > MAX_RECEIPT_OBJECT_NODES ||
      entries.length > MAX_RECEIPT_OBJECT_NODES - nodes
    ) {
      throw receiptNodeLimitError();
    }
    for (const entry of entries) pending.push(entry);
  }
}

function receiptNodeLimitError() {
  return new ByteFenceContractError(
    "receipt.nodeLimitExceeded",
    "The receipt document exceeds the maximum JSON value budget.",
    "$"
  );
}

function assertReceiptObjectPrefix(bytes) {
  let index = 0;
  while (
    index < bytes.length &&
    (bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d || bytes[index] === 0x20)
  ) {
    index += 1;
  }
  if (bytes[index] !== 0x7b) {
    throw new ByteFenceContractError(
      "receipt.shapeInvalid",
      "A raw ByteFence receipt must encode a JSON object.",
      "$"
    );
  }
}

function receiptTooLargeError() {
  return new ByteFenceContractError(
    "receipt.documentTooLarge",
    "The receipt document exceeds the ByteFence v0.1 byte limit.",
    "$"
  );
}

function parseReceiptBytes(bytes) {
  const parsed = parseByteFenceJsonDocument(bytes, "receipt");
  canonicalByteFenceJsonBytes(parsed);
  return parsed;
}

function validatePreflightForTransaction(statement) {
  if (
    !statement ||
    typeof statement !== "object" ||
    statement._type !== IN_TOTO_STATEMENT_TYPE ||
    statement.predicateType !== BYTEFENCE_STATEMENT_SCHEMA ||
    statement.predicate?.phase !== "preflight" ||
    statement.predicate?.decision?.status !== "allow" ||
    statement.predicate?.decision?.declaredGuaranteeLevel !== "CORE_PROVEN" ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    !sha256Pattern.test(statement.subject[0]?.digest?.sha256 ?? "")
  ) {
    throw new ByteFenceContractError(
      "transaction.preflightInvalid",
      "A transaction requires an allowed CORE_PROVEN preflight Statement.",
      "$.preflight"
    );
  }
  if (
    !Array.isArray(statement.predicate.decision.checks) ||
    statement.predicate.decision.checks.length !== 3 ||
    statement.predicate.decision.checks.some((check) => check?.status !== "pass")
  ) {
    throw new ByteFenceContractError(
      "transaction.preflightDenied",
      "A transaction cannot promote a failed preflight check.",
      "$.preflight.predicate.decision.checks"
    );
  }
  canonicalByteFenceJsonBytes(statement);
}

function resolveObservedDigest(postApply) {
  if (postApply.observedTarget !== undefined) {
    return sha256Hex(copyByteFenceBytes(postApply.observedTarget, "observed target"));
  }
  if (typeof postApply.observedDigest === "string" && sha256Pattern.test(postApply.observedDigest)) {
    return postApply.observedDigest;
  }
  throw new ByteFenceContractError(
    "transaction.observedDigestInvalid",
    "Post-apply evidence requires observed target bytes or a SHA-256 digest.",
    "$.postApply.observedDigest"
  );
}

function validateObservedAt(value, location) {
  const timestamp = parseByteFenceUtcTimestamp(value);
  if (!timestamp) {
    throw new ByteFenceContractError(
      "event.observedAtInvalid",
      "The post-apply timestamp must be an explicit UTC RFC 3339 value.",
      location
    );
  }
  return timestamp;
}

function canonicalObjectsEqual(left, right) {
  try {
    return canonicalByteFenceJsonBytes(left).equals(canonicalByteFenceJsonBytes(right));
  } catch {
    return false;
  }
}

function failedVerification(error, receiptType = "preflight") {
  const safeError =
    error instanceof ByteFenceContractError
      ? error
      : new ByteFenceContractError(
          "receipt.verificationFailed",
          "The receipt could not be verified against the supplied evidence.",
          "$"
        );
  return {
    status: "failed",
    verified: false,
    authorized: false,
    exitCode: isInvalidReceiptInputCode(safeError.code) ? 2 : 1,
    receiptType,
    declaredGuaranteeLevel: "OUT_OF_SCOPE",
    effectiveGuaranteeLevel: "OUT_OF_SCOPE",
    producerAuthenticated: false,
    mediationEnvironmentTrusted: false,
    findings: [
      {
        id: safeError.code,
        severity: "high",
        title: "ByteFence receipt verification failed",
        location: safeError.location,
        recommendation: safeError.message
      }
    ]
  };
}

function isInvalidReceiptInputCode(code) {
  return [
    "jsonInvalid",
    "documentTooLarge",
    "documentBom",
    "documentUtf8",
    "duplicateKey",
    "depthExceeded",
    "nodeLimitExceeded",
    "shapeInvalid",
    "expectedDigestInvalid",
    "rawBytesRequired",
    "contractUnsupported",
    "authenticatorInvalid"
  ].some((suffix) => code.endsWith(suffix));
}
