import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import {
  BYTEFENCE_MAX_RECEIPT_BYTES,
  ByteFenceContractError,
  canonicalByteFenceJsonBytes,
  deriveByteFenceCandidate,
  parseByteFenceIntent,
  parseByteFencePolicy,
  sha256Hex
} from "./bytefence-contract.js";
import { evaluateByteFence } from "./bytefence-evaluate.js";
import {
  createByteFenceTransactionReceipt,
  receiptDigest
} from "./bytefence-receipt.js";
import {
  ByteFencePathError,
  inspectByteFenceTarget,
  readByteFenceTarget,
  sameByteFenceFileIdentity
} from "./bytefence-path.js";
import {
  compareByteFenceUtcTimestamps,
  parseByteFenceUtcTimestamp
} from "./bytefence-time.js";

const LOCK_MODE = 0o600;
const RECEIPT_PUBLIC_MODE = 0o644;
const RECEIPT_LOCAL_MODE = 0o600;
const BASIC_POSIX_MODE = 0o777;
const TEMP_CREATE_ATTEMPTS = 4;

export class ByteFenceApplyError extends Error {
  constructor(code, message, classification = "invalid") {
    super(message);
    this.name = "ByteFenceApplyError";
    this.code = code;
    this.classification = classification;
  }
}

/**
 * Apply one exactReplace operation through the ByteFence cooperative protocol.
 * `onStage` is a synchronous test/telemetry seam. It is not an authorization
 * callback and cannot turn a denial into an allow.
 */
export function applyByteFenceTransaction({
  root,
  intentBytes,
  policyBytes,
  workspaceId,
  observedAt,
  receiptProfile = "public",
  correlation,
  receiptPath,
  onStage,
  receiptWriter = persistByteFenceReceipt,
  randomBytesFn = randomBytes,
  clock = () => new Date().toISOString()
} = {}) {
  let intent;
  let policy;
  let target;
  let initialRead;
  let candidate;
  let initialEvaluation;
  let receiptOutput;

  try {
    assertOptionalFunction(onStage, "apply.stageHookInvalid");
    assertOptionalFunction(receiptWriter, "apply.receiptWriterInvalid");
    if (typeof clock !== "function") {
      throw new ByteFenceApplyError(
        "apply.clockInvalid",
        "ByteFence requires a synchronous event clock."
      );
    }
    if (typeof randomBytesFn !== "function") {
      throw new ByteFenceApplyError(
        "apply.randomSourceInvalid",
        "ByteFence requires a callable cryptographic random source."
      );
    }

    intent = parseByteFenceIntent(intentBytes);
    policy = parseByteFencePolicy(policyBytes);
    target = inspectByteFenceTarget({ root, targetPath: intent.targetPath });
    if (target.stat.size > policy.maxTargetBytes) {
      throw new ByteFenceApplyError(
        "change.targetTooLarge",
        "The target exceeds maxTargetBytes before the transaction can read it.",
        "deny"
      );
    }
    initialRead = readByteFenceTarget(target, { maxBytes: policy.maxTargetBytes });
    candidate = deriveCandidateForEvaluation(initialRead.bytes, intent);
    initialEvaluation = evaluateByteFence({
      preimage: initialRead.bytes,
      candidate,
      intentBytes,
      policyBytes,
      workspaceId,
      observedAt,
      receiptProfile,
      correlation
    });

    if (!initialEvaluation.allowed) return initialEvaluation;
    const transactionStartedAt = readByteFenceClock(clock);
    const preflightTimestamp = parseByteFenceUtcTimestamp(observedAt);
    if (
      !preflightTimestamp ||
      compareByteFenceUtcTimestamps(transactionStartedAt.timestamp, preflightTimestamp) < 0
    ) {
      throw new ByteFenceApplyError(
        "event.observedAtFuture",
        "The preflight timestamp cannot be later than the transaction clock."
      );
    }

    receiptOutput = receiptPath === undefined
      ? undefined
      : prepareByteFenceReceiptOutput({
          rootPath: target.rootPath,
          receiptPath,
          targetPath: target.absolutePath,
          lockPath: lockPathFor(target.absolutePath)
        });
    notifyStage(onStage, "after-preflight", {
      operationId: initialEvaluation.operationId
    });
  } catch (error) {
    if (error instanceof ByteFenceApplyError && error.classification === "deny") {
      return deniedApplyResult(error);
    }
    return invalidApplyResult(error);
  }

  let lock;
  let temporary;
  let committed = false;
  let lockedEvaluation;

  try {
    lock = acquireByteFenceLock({
      targetPath: target.absolutePath,
      operationBindingDigest: initialEvaluation.operationBindingDigest
    });
    notifyStage(onStage, "after-lock", {
      operationId: initialEvaluation.operationId
    });

    const lockedTarget = inspectByteFenceTarget({
      root: target.rootPath,
      targetPath: intent.targetPath
    });
    const lockedRead = readByteFenceTarget(lockedTarget, {
      maxBytes: policy.maxTargetBytes
    });
    if (!sameTargetSnapshot(target, initialRead, lockedTarget, lockedRead)) {
      return staleBaseResult(initialEvaluation, "lock-recheck");
    }

    lockedEvaluation = evaluateByteFence({
      preimage: lockedRead.bytes,
      candidate,
      intentBytes,
      policyBytes,
      workspaceId,
      observedAt,
      receiptProfile,
      correlation
    });
    if (!lockedEvaluation.allowed) return lockedEvaluation;
    if (
      lockedEvaluation.operationBindingDigest !==
      initialEvaluation.operationBindingDigest
    ) {
      return staleBaseResult(initialEvaluation, "operation-binding");
    }
    notifyStage(onStage, "after-lock-recheck", {
      operationId: lockedEvaluation.operationId
    });

    temporary = createByteFenceTemporary({
      targetPath: lockedTarget.absolutePath,
      candidate,
      targetMode: lockedRead.stat.mode,
      randomBytesFn
    });
    notifyStage(onStage, "after-temp-flush", {
      operationId: lockedEvaluation.operationId
    });
    notifyStage(onStage, "before-final-recheck", {
      operationId: lockedEvaluation.operationId
    });

    const finalTarget = inspectByteFenceTarget({
      root: target.rootPath,
      targetPath: intent.targetPath
    });
    const finalRead = readByteFenceTarget(finalTarget, {
      maxBytes: policy.maxTargetBytes
    });
    if (!sameTargetSnapshot(lockedTarget, lockedRead, finalTarget, finalRead)) {
      return staleBaseResult(lockedEvaluation, "final-recheck");
    }
    if (sha256Hex(finalRead.bytes) !== lockedEvaluation.preimageDigest) {
      return staleBaseResult(lockedEvaluation, "final-digest");
    }

    notifyStage(onStage, "before-rename", {
      operationId: lockedEvaluation.operationId
    });
    closeOwnedDescriptor(temporary);
    renameSync(temporary.path, finalTarget.absolutePath);
    temporary.renamed = true;
    committed = true;
    flushDirectory(finalTarget.parentPath);
    notifyStage(onStage, "after-rename", {
      operationId: lockedEvaluation.operationId
    });

    const committedTarget = inspectByteFenceTarget({
      root: target.rootPath,
      targetPath: intent.targetPath
    });
    const committedRead = readByteFenceTarget(committedTarget, {
      maxBytes: policy.maxTargetBytes
    });
    const observedDigest = sha256Hex(committedRead.bytes);
    if (observedDigest !== lockedEvaluation.candidateDigest) {
      throw new ByteFenceApplyError(
        "apply.postCommitDigestMismatch",
        "The committed target did not match the authorized candidate.",
        "committed"
      );
    }

    const postApplyObservedAt = readByteFenceClock(clock).value;
    const transaction = createByteFenceTransactionReceipt({
      preflightStatement: lockedEvaluation.statement,
      postApply: {
        observedAt: postApplyObservedAt,
        observedTarget: committedRead.bytes,
        observedDigest,
        cooperatingWriterLockActive: true,
        targetMatchedCandidate: true
      }
    });
    const transactionBytes = canonicalByteFenceJsonBytes(transaction);
    const artifactDigest = receiptDigest(transactionBytes);
    let receiptPersisted = false;

    if (receiptOutput) {
      notifyStage(onStage, "before-receipt-persist", {
        operationId: lockedEvaluation.operationId
      });
      revalidateByteFenceReceiptOutput(receiptOutput);
      receiptWriter({
        path: receiptOutput.absolutePath,
        bytes: transactionBytes,
        mode: receiptProfile === "local"
          ? RECEIPT_LOCAL_MODE
          : RECEIPT_PUBLIC_MODE
      });
      confirmPersistedByteFenceReceipt({
        path: receiptOutput.absolutePath,
        expectedBytes: transactionBytes,
        expectedDigest: artifactDigest
      });
      receiptPersisted = true;
      notifyStage(onStage, "after-receipt-persist", {
        operationId: lockedEvaluation.operationId
      });
    }

    return {
      ...lockedEvaluation,
      status: "allow",
      allowed: true,
      exitCode: 0,
      phase: "postApply",
      transaction,
      receiptBytes: transactionBytes,
      receiptDigest: artifactDigest,
      receiptPersisted,
      observedDigest,
      postApplyObservedAt,
      declaredGuaranteeLevel: "MEDIATED_PROVEN",
      effectiveGuaranteeLevel: "CORE_PROVEN",
      mediationEnvironmentTrusted: false
    };
  } catch (error) {
    if (committed || error?.classification === "committed") {
      return committedUnreceiptedResult(error, lockedEvaluation ?? initialEvaluation);
    }
    if (error instanceof ByteFenceApplyError && error.classification === "deny") {
      return deniedApplyResult(error, lockedEvaluation ?? initialEvaluation);
    }
    return invalidApplyResult(error, lockedEvaluation ?? initialEvaluation);
  } finally {
    cleanupOwnedTemporary(temporary);
    releaseOwnedLock(lock);
  }
}

function readByteFenceClock(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw new ByteFenceApplyError(
      "apply.clockFailed",
      "The ByteFence event clock failed."
    );
  }
  const timestamp = parseByteFenceUtcTimestamp(value);
  if (!timestamp) {
    throw new ByteFenceApplyError(
      "apply.clockInvalid",
      "The ByteFence event clock must return an explicit UTC RFC 3339 timestamp."
    );
  }
  return { value, timestamp };
}

export function persistByteFenceReceipt({ path, bytes, mode }) {
  if (typeof path !== "string" || path.length === 0) {
    throw new ByteFenceApplyError(
      "receipt.pathInvalid",
      "The receipt output path is invalid."
    );
  }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new ByteFenceApplyError(
      "receipt.bytesInvalid",
      "The receipt output must be raw bytes."
    );
  }

  let descriptor;
  let created = false;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    created = true;
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    flushDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original persistence error remains authoritative.
      }
    }
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // A partial receipt is invalid and will fail verification if retained.
      }
    }
    throw new ByteFenceApplyError(
      "receipt.persistFailed",
      "The committed ByteFence receipt could not be persisted.",
      "committed"
    );
  }
}

function confirmPersistedByteFenceReceipt({ path, expectedBytes, expectedDigest }) {
  let descriptor;
  try {
    const pathStat = lstatSync(path, { bigint: true });
    const pathSize = Number(pathStat.size);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.nlink !== 1n ||
      !Number.isSafeInteger(pathSize) ||
      pathSize < 0 ||
      pathSize > BYTEFENCE_MAX_RECEIPT_BYTES ||
      pathSize !== expectedBytes.length
    ) {
      throw new Error("unsafe receipt artifact");
    }

    const noFollow = typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameByteFenceFileIdentity(pathStat, before) ||
      Number(before.size) !== expectedBytes.length
    ) {
      throw new Error("receipt identity mismatch");
    }

    const chunks = [];
    let total = 0;
    while (total <= BYTEFENCE_MAX_RECEIPT_BYTES) {
      const remaining = BYTEFENCE_MAX_RECEIPT_BYTES + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (total > BYTEFENCE_MAX_RECEIPT_BYTES) {
      throw new Error("receipt exceeds absolute limit");
    }

    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameByteFenceFileIdentity(before, after) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("receipt changed during verification");
    }

    const observedBytes = Buffer.concat(chunks, total);
    if (
      !observedBytes.equals(expectedBytes) ||
      sha256Hex(observedBytes) !== expectedDigest
    ) {
      throw new Error("receipt content mismatch");
    }
  } catch {
    throw new ByteFenceApplyError(
      "receipt.persistVerificationFailed",
      "The committed ByteFence receipt could not be confirmed byte-for-byte.",
      "committed"
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The verification result remains authoritative.
      }
    }
  }
}

function deriveCandidateForEvaluation(preimage, intent) {
  try {
    return deriveByteFenceCandidate(preimage, intent);
  } catch (error) {
    if (error instanceof ByteFenceContractError) return Buffer.from(preimage);
    throw error;
  }
}

function acquireByteFenceLock({ targetPath, operationBindingDigest }) {
  if (!/^[a-f0-9]{64}$/.test(operationBindingDigest ?? "")) {
    throw new ByteFenceApplyError(
      "lock.bindingInvalid",
      "The transaction binding digest is unavailable."
    );
  }

  const path = lockPathFor(targetPath);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      LOCK_MODE
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ByteFenceApplyError(
        "lock.busy",
        "A ByteFence cooperative lock already exists for the target.",
        "deny"
      );
    }
    throw new ByteFenceApplyError(
      "lock.acquireFailed",
      "The ByteFence cooperative lock could not be acquired."
    );
  }

  try {
    writeFileSync(descriptor, Buffer.from(`${operationBindingDigest}\n`, "ascii"));
    fsyncSync(descriptor);
    return {
      path,
      descriptor,
      stat: snapshotIdentity(fstatSync(descriptor, { bigint: true })),
      released: false
    };
  } catch {
    try {
      closeSync(descriptor);
    } catch {
      // Cleanup below is best effort and never turns this into an allow.
    }
    try {
      unlinkSync(path);
    } catch {
      // A failed lock initialization remains a closed failure.
    }
    throw new ByteFenceApplyError(
      "lock.initializeFailed",
      "The ByteFence cooperative lock could not be initialized."
    );
  }
}

function createByteFenceTemporary({
  targetPath,
  candidate,
  targetMode,
  randomBytesFn
}) {
  const parent = dirname(targetPath);
  const name = basename(targetPath);

  for (let attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt += 1) {
    const random = randomBytesFn(16);
    if (!Buffer.isBuffer(random) && !(random instanceof Uint8Array)) {
      throw new ByteFenceApplyError(
        "temp.randomInvalid",
        "The random source did not return bytes."
      );
    }
    const token = Buffer.from(random).toString("hex");
    if (!/^[a-f0-9]{32}$/.test(token)) {
      throw new ByteFenceApplyError(
        "temp.randomInvalid",
        "The random source did not return exactly 128 bits."
      );
    }
    const path = resolve(parent, `.${name}.bytefence.${token}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        LOCK_MODE
      );
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw new ByteFenceApplyError(
        "temp.createFailed",
        "The ByteFence temporary file could not be created."
      );
    }

    try {
      writeFileSync(descriptor, candidate);
      if (process.platform !== "win32") {
        fchmodSync(descriptor, targetMode & BASIC_POSIX_MODE);
      }
      fsyncSync(descriptor);
      return {
        path,
        descriptor,
        stat: snapshotIdentity(fstatSync(descriptor, { bigint: true })),
        renamed: false
      };
    } catch {
      try {
        closeSync(descriptor);
      } catch {
        // The write error remains authoritative.
      }
      try {
        unlinkSync(path);
      } catch {
        // The invalid temp remains outside the target and is never committed.
      }
      throw new ByteFenceApplyError(
        "temp.writeFailed",
        "The authorized candidate could not be flushed to a temporary file."
      );
    }
  }

  throw new ByteFenceApplyError(
    "temp.collisionLimit",
    "ByteFence could not allocate a unique temporary file."
  );
}

function prepareByteFenceReceiptOutput({
  rootPath,
  receiptPath,
  targetPath,
  lockPath
}) {
  if (typeof receiptPath !== "string" || receiptPath.length === 0 || receiptPath.includes("\0")) {
    throw new ByteFenceApplyError(
      "receipt.pathInvalid",
      "The receipt path must be a non-empty path inside the workspace."
    );
  }

  const absolutePath = isAbsolute(receiptPath)
    ? resolve(receiptPath)
    : resolve(rootPath, receiptPath);
  assertPathInsideRoot(rootPath, absolutePath, "receipt.pathOutsideRoot");
  if (samePath(absolutePath, targetPath) || samePath(absolutePath, lockPath)) {
    throw new ByteFenceApplyError(
      "receipt.pathConflict",
      "The receipt path conflicts with a ByteFence transaction path."
    );
  }
  assertReceiptPathAbsent(absolutePath, "invalid");

  const parentPath = dirname(absolutePath);
  assertSafeExistingDirectoryChain(rootPath, parentPath);
  return {
    rootPath,
    absolutePath,
    parentPath,
    parentRealPath: realpathSync(parentPath)
  };
}

function revalidateByteFenceReceiptOutput(output) {
  assertSafeExistingDirectoryChain(output.rootPath, output.parentPath);
  if (realpathSync(output.parentPath) !== output.parentRealPath) {
    throw new ByteFenceApplyError(
      "receipt.parentChanged",
      "The receipt parent directory changed after preflight.",
      "committed"
    );
  }
  assertReceiptPathAbsent(output.absolutePath, "committed");
}

function assertReceiptPathAbsent(path, classification) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new ByteFenceApplyError(
      "receipt.inspectFailed",
      "The receipt output path could not be inspected safely.",
      classification
    );
  }
  throw new ByteFenceApplyError(
    "receipt.exists",
    classification === "committed"
      ? "The immutable receipt output path appeared after preflight."
      : "ByteFence receipts are immutable and the output path already exists.",
    classification
  );
}

function assertSafeExistingDirectoryChain(rootPath, directoryPath) {
  assertPathInsideRoot(rootPath, directoryPath, "receipt.pathOutsideRoot", true);
  const child = relative(rootPath, directoryPath);
  let current = rootPath;
  for (const component of child.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new ByteFenceApplyError(
        "receipt.parentMissing",
        "The receipt parent directory must already exist."
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ByteFenceApplyError(
        "receipt.parentUnsafe",
        "The receipt parent chain must contain only real directories."
      );
    }
  }
}

function assertPathInsideRoot(rootPath, candidatePath, code, allowRoot = false) {
  const child = relative(rootPath, candidatePath);
  if (
    (!allowRoot && child.length === 0) ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new ByteFenceApplyError(
      code,
      "The path must remain inside the configured workspace root."
    );
  }
}

function sameTargetSnapshot(leftTarget, leftRead, rightTarget, rightRead) {
  return (
    leftTarget.parentRealPath === rightTarget.parentRealPath &&
    sameByteFenceFileIdentity(leftRead.stat, rightRead.stat) &&
    leftRead.stat.mode === rightRead.stat.mode &&
    leftRead.stat.nlink === rightRead.stat.nlink &&
    leftRead.stat.size === rightRead.stat.size &&
    sha256Hex(leftRead.bytes) === sha256Hex(rightRead.bytes)
  );
}

function staleBaseResult(evaluation, stage) {
  return {
    ...evaluation,
    status: "deny",
    allowed: false,
    exitCode: 1,
    effectiveGuaranteeLevel: "OUT_OF_SCOPE",
    findings: [
      ...(evaluation?.findings ?? []),
      applyFinding(
        "apply.staleBase",
        "The target changed before the ByteFence commit.",
        stage
      )
    ]
  };
}

function deniedApplyResult(error, evaluation) {
  return {
    ...(evaluation ?? {}),
    status: "deny",
    allowed: false,
    exitCode: 1,
    effectiveGuaranteeLevel: "OUT_OF_SCOPE",
    findings: [
      ...(evaluation?.findings ?? []),
      applyFinding(error.code ?? "apply.denied", error.message)
    ]
  };
}

function invalidApplyResult(error, evaluation) {
  const code =
    error instanceof ByteFenceContractError || error instanceof ByteFencePathError
      ? error.code
      : error?.code ?? "apply.invalid";
  return {
    ...(evaluation ?? {}),
    status: "invalid",
    allowed: false,
    exitCode: 2,
    effectiveGuaranteeLevel: "OUT_OF_SCOPE",
    findings: [
      ...(evaluation?.findings ?? []),
      applyFinding(code, safeErrorMessage(error))
    ]
  };
}

function committedUnreceiptedResult(error, evaluation) {
  return {
    ...(evaluation ?? {}),
    status: "committed-unreceipted",
    allowed: false,
    exitCode: 3,
    effectiveGuaranteeLevel: "POSTHOC_DETECTED",
    phase: "postApply",
    findings: [
      ...(evaluation?.findings ?? []),
      applyFinding(
        error?.code ?? "apply.committedUnreceipted",
        safeErrorMessage(error)
      )
    ]
  };
}

function applyFinding(id, message, stage) {
  return {
    id,
    severity: id === "apply.postCommitDigestMismatch" ? "critical" : "high",
    title: message,
    location: stage ? `transaction:${stage}` : "transaction",
    remediation:
      "Inspect the target and transaction state. Do not retry the edit automatically."
  };
}

function safeErrorMessage(error) {
  if (
    error instanceof ByteFenceApplyError ||
    error instanceof ByteFenceContractError ||
    error instanceof ByteFencePathError
  ) {
    return error.message;
  }
  return "The ByteFence transaction failed closed before it could be verified.";
}

function lockPathFor(targetPath) {
  return resolve(dirname(targetPath), `.${basename(targetPath)}.bytefence.lock`);
}

function flushDirectory(path) {
  if (process.platform === "win32") return false;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function closeOwnedDescriptor(resource) {
  if (!resource || resource.descriptor === undefined) return;
  closeSync(resource.descriptor);
  resource.descriptor = undefined;
}

function cleanupOwnedTemporary(temporary) {
  if (!temporary) return;
  try {
    closeOwnedDescriptor(temporary);
  } catch {
    // Cleanup cannot upgrade a failed transaction into success.
  }
  if (temporary.renamed) return;
  unlinkIfOwned(temporary.path, temporary.stat);
}

function releaseOwnedLock(lock) {
  if (!lock || lock.released) return;
  try {
    closeOwnedDescriptor(lock);
  } catch {
    // Identity-checked cleanup below is still attempted.
  }
  unlinkIfOwned(lock.path, lock.stat);
  lock.released = true;
}

function unlinkIfOwned(path, identity) {
  try {
    const current = snapshotIdentity(lstatSync(path, { bigint: true }));
    if (sameIdentity(identity, current)) unlinkSync(path);
  } catch {
    // Missing or replaced transaction files are never blindly unlinked.
  }
}

function snapshotIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mode: Number(stat.mode)
  };
}

function sameIdentity(left, right) {
  if (!left || !right) return false;
  if (left.dev === "0" && left.ino === "0" && right.dev === "0" && right.ino === "0") {
    return false;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left, right) {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function notifyStage(onStage, stage, details) {
  if (onStage) onStage(stage, Object.freeze({ ...details }));
}

function assertOptionalFunction(value, code) {
  if (value !== undefined && typeof value !== "function") {
    throw new ByteFenceApplyError(code, "An optional ByteFence callback is not callable.");
  }
}
