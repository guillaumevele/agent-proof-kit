import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyByteFenceTransaction } from "../../../src/core/bytefence-apply.js";
import { BYTEFENCE_INTENT_SCHEMA } from "../../../src/core/bytefence-contract.js";

const POLICY_BYTES = readFileSync(
  new URL("../../../policies/bytefence-default.json", import.meta.url)
);
const OBSERVED_AT = "2026-07-13T10:00:00Z";
const TARGET_BEFORE = "prefix-preserved\nvalue=old\nsuffix-preserved\n";
const TARGET_AFTER = "prefix-preserved\nvalue=new\nsuffix-preserved\n";

test("commits one raw-byte exact replacement and persists a linked transaction receipt", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "receipts"));
  const targetPath = join(root, "target.txt");
  const before = Buffer.from(
    "alpha-preserved\r\nanchor=old\r\nisolated\nomega-preserved\r\n",
    "utf8"
  );
  const expected = Buffer.from(
    "alpha-preserved\r\nanchor=new\r\nisolated\nomega-preserved\r\n",
    "utf8"
  );
  writeFileSync(targetPath, before, { mode: 0o640 });

  const result = apply(root, {
    oldText: "anchor=old",
    newText: "anchor=new",
    receiptPath: "receipts/target.bytefence.json"
  });

  assert.equal(result.status, "allow");
  assert.equal(result.exitCode, 0);
  assert.equal(result.declaredGuaranteeLevel, "MEDIATED_PROVEN");
  assert.equal(result.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(result.mediationEnvironmentTrusted, false);
  assert.equal(result.receiptPersisted, true);
  assert.deepEqual(readFileSync(targetPath), expected);
  assert.equal(result.observedDigest, result.candidateDigest);

  const transaction = JSON.parse(
    readFileSync(join(root, "receipts", "target.bytefence.json"), "utf8")
  );
  assert.equal(transaction._type, "ByteFenceTransactionReceipt/v0.1");
  assert.equal(transaction.preflight.predicate.phase, "preflight");
  assert.equal(transaction.postApply.predicate.phase, "postApply");
  assert.equal(transaction.postApply.subject[0].digest.sha256, result.candidateDigest);
  assertTransactionFilesRemoved(root);

  if (process.platform !== "win32") {
    assert.equal(statSync(targetPath).mode & 0o777, 0o640);
  }
});

test("denies an ambiguous anchor before acquiring a lock or writing", () => {
  const root = fixtureRoot();
  const targetPath = join(root, "target.txt");
  const before = Buffer.from("old and old\n", "utf8");
  writeFileSync(targetPath, before);

  const result = apply(root, { oldText: "old", newText: "new" });

  assert.equal(result.status, "deny");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(readFileSync(targetPath), before);
  assert.equal(existsSync(join(root, ".target.txt.bytefence.lock")), false);
});

test("denies an oversized target from metadata before reading its bytes", () => {
  const root = fixtureRoot();
  const targetPath = join(root, "target.txt");
  writeFileSync(targetPath, TARGET_BEFORE);
  truncateSync(targetPath, 10 * 1024 * 1024 + 1);

  const result = apply(root, { oldText: "value=old", newText: "value=new" });

  assert.equal(result.status, "deny");
  assert.equal(result.exitCode, 1);
  assert.equal(result.findings.at(-1).id, "change.targetTooLarge");
  assert.equal(statSync(targetPath).size, 10 * 1024 * 1024 + 1);
  assert.equal(existsSync(join(root, ".target.txt.bytefence.lock")), false);
});

test("denies a stale base changed after lock acquisition and preserves the external state", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "receipts"));
  const targetPath = join(root, "target.txt");
  writeFileSync(targetPath, TARGET_BEFORE);

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    receiptPath: "receipts/stale.json",
    onStage(stage) {
      if (stage === "after-lock") writeFileSync(targetPath, "external\n");
    }
  });

  assert.equal(result.status, "deny");
  assert.equal(result.exitCode, 1);
  assert.equal(result.findings.at(-1).id, "apply.staleBase");
  assert.equal(readFileSync(targetPath, "utf8"), "external\n");
  assert.equal(existsSync(join(root, "receipts", "stale.json")), false);
  assertTransactionFilesRemoved(root);
});

test("denies an existing cooperative lock without deleting it", () => {
  const root = fixtureRoot();
  const targetPath = join(root, "target.txt");
  const lockPath = join(root, ".target.txt.bytefence.lock");
  writeFileSync(targetPath, TARGET_BEFORE);
  writeFileSync(lockPath, "owned-by-another-operation\n", { mode: 0o600 });

  const result = apply(root, { oldText: "value=old", newText: "value=new" });

  assert.equal(result.status, "deny");
  assert.equal(result.findings.at(-1).id, "lock.busy");
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_BEFORE);
  assert.equal(readFileSync(lockPath, "utf8"), "owned-by-another-operation\n");
});

test("rejects a future preflight timestamp before acquiring the transaction lock", () => {
  const root = fixtureRoot();
  const targetPath = join(root, "target.txt");
  writeFileSync(targetPath, TARGET_BEFORE);

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    clock: () => "2026-07-13T09:59:59Z"
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.exitCode, 2);
  assert.equal(result.findings.at(-1).id, "event.observedAtFuture");
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_BEFORE);
  assert.equal(existsSync(join(root, ".target.txt.bytefence.lock")), false);
});

test("rejects a preflight timestamp ahead of the transaction clock by one nanosecond", () => {
  const root = fixtureRoot();
  const targetPath = join(root, "target.txt");
  writeFileSync(targetPath, TARGET_BEFORE);

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    observedAt: "2026-07-13T10:00:00.123456789Z",
    clock: () => "2026-07-13T10:00:00.123456788Z"
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.exitCode, 2);
  assert.equal(result.findings.at(-1).id, "event.observedAtFuture");
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_BEFORE);
  assert.equal(existsSync(join(root, ".target.txt.bytefence.lock")), false);
});

test("reports committed-unreceipted and never retries when receipt persistence fails", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "receipts"));
  const targetPath = join(root, "target.txt");
  writeFileSync(targetPath, TARGET_BEFORE);

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    receiptPath: "receipts/failure.json",
    receiptWriter() {
      throw new Error("injected persistence failure");
    }
  });

  assert.equal(result.status, "committed-unreceipted");
  assert.equal(result.exitCode, 3);
  assert.equal(result.allowed, false);
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_AFTER);
  assert.equal(existsSync(join(root, "receipts", "failure.json")), false);
  assertTransactionFilesRemoved(root);
});

test("does not trust an injected receipt writer until exact persisted bytes are confirmed", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "receipts"));
  const targetPath = join(root, "target.txt");
  const receiptPath = join(root, "receipts", "no-op.json");
  writeFileSync(targetPath, TARGET_BEFORE);

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    receiptPath: "receipts/no-op.json",
    receiptWriter() {
      // Deliberately returns without persisting the requested artifact.
    }
  });

  assert.equal(result.status, "committed-unreceipted");
  assert.equal(result.exitCode, 3);
  assert.equal(result.allowed, false);
  assert.equal(result.receiptPersisted, undefined);
  assert.equal(result.findings.at(-1).id, "receipt.persistVerificationFailed");
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_AFTER);
  assert.equal(existsSync(receiptPath), false);
  assertTransactionFilesRemoved(root);
});

test("does not overwrite a colliding temporary path", () => {
  const root = fixtureRoot();
  const targetPath = join(root, "target.txt");
  const token = "11".repeat(16);
  const temporaryPath = join(root, `.target.txt.bytefence.${token}.tmp`);
  writeFileSync(targetPath, TARGET_BEFORE);
  writeFileSync(temporaryPath, "sentinel\n");

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    randomBytesFn() {
      return Buffer.alloc(16, 0x11);
    }
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.findings.at(-1).id, "temp.collisionLimit");
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_BEFORE);
  assert.equal(readFileSync(temporaryPath, "utf8"), "sentinel\n");
  assert.equal(existsSync(join(root, ".target.txt.bytefence.lock")), false);
});

test("detects a non-cooperating writer after rename and emits no success receipt", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "receipts"));
  const targetPath = join(root, "target.txt");
  writeFileSync(targetPath, TARGET_BEFORE);

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    receiptPath: "receipts/posthoc.json",
    onStage(stage) {
      if (stage === "after-rename") writeFileSync(targetPath, "hostile\n");
    }
  });

  assert.equal(result.status, "committed-unreceipted");
  assert.equal(result.exitCode, 3);
  assert.equal(result.effectiveGuaranteeLevel, "POSTHOC_DETECTED");
  assert.equal(result.findings.at(-1).id, "apply.postCommitDigestMismatch");
  assert.equal(readFileSync(targetPath, "utf8"), "hostile\n");
  assert.equal(existsSync(join(root, "receipts", "posthoc.json")), false);
  assertTransactionFilesRemoved(root);
});

test("rejects an existing immutable receipt path before mutation", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "receipts"));
  const targetPath = join(root, "target.txt");
  const receiptPath = join(root, "receipts", "existing.json");
  writeFileSync(targetPath, TARGET_BEFORE);
  writeFileSync(receiptPath, "existing\n");

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    receiptPath: "receipts/existing.json"
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.findings.at(-1).id, "receipt.exists");
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_BEFORE);
  assert.equal(readFileSync(receiptPath, "utf8"), "existing\n");
});

test("rejects a dangling receipt symlink before mutation", (t) => {
  const root = fixtureRoot();
  mkdirSync(join(root, "receipts"));
  const targetPath = join(root, "target.txt");
  const receiptPath = join(root, "receipts", "dangling.json");
  writeFileSync(targetPath, TARGET_BEFORE);
  try {
    symlinkSync(
      join(root, "missing.json"),
      receiptPath,
      process.platform === "win32" ? "file" : undefined
    );
  } catch (error) {
    t.skip(`file symlink creation unavailable: ${error.code ?? "unknown"}`);
    return;
  }

  const result = apply(root, {
    oldText: "value=old",
    newText: "value=new",
    receiptPath: "receipts/dangling.json"
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.findings.at(-1).id, "receipt.exists");
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_BEFORE);
  assert.equal(lstatIsSymlink(receiptPath), true);
});

test("preserves basic POSIX mode bits", {
  skip: process.platform === "win32"
}, () => {
  const root = fixtureRoot();
  const targetPath = join(root, "target.txt");
  writeFileSync(targetPath, TARGET_BEFORE);
  chmodSync(targetPath, 0o751);

  const result = apply(root, { oldText: "value=old", newText: "value=new" });

  assert.equal(result.status, "allow");
  assert.equal(statSync(targetPath).mode & 0o777, 0o751);
});

test("serializes two cooperating writers so exactly one commits", async () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "receipts"));
  const targetPath = join(root, "target.txt");
  const releasePath = join(root, "release");
  const readyOne = join(root, "ready-one");
  const readyTwo = join(root, "ready-two");
  writeFileSync(targetPath, TARGET_BEFORE);

  const worker = fileURLToPath(new URL("./fixtures/apply-worker.js", import.meta.url));
  const first = runWorker(worker, [
    root,
    readyOne,
    releasePath,
    "receipts/one.json"
  ]);
  const second = runWorker(worker, [
    root,
    readyTwo,
    releasePath,
    "receipts/two.json"
  ]);

  await waitFor(() => existsSync(readyOne) && existsSync(readyTwo));
  writeFileSync(releasePath, "go\n");
  const results = await Promise.all([first, second]);

  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ["allow", "deny"]
  );
  const allowed = results.find((result) => result.status === "allow");
  const denied = results.find((result) => result.status === "deny");
  assert.equal(allowed?.exitCode, 0);
  assert.equal(denied?.exitCode, 1);
  assert.ok(
    denied.findingIds.some((id) => id === "lock.busy" || id === "apply.staleBase"),
    `unexpected concurrent denial: ${JSON.stringify(denied)}`
  );
  assert.equal(readFileSync(targetPath, "utf8"), TARGET_AFTER);
  assert.equal(
    ["one.json", "two.json"].filter((name) => existsSync(join(root, "receipts", name))).length,
    1
  );
  assertTransactionFilesRemoved(root);
});

test("leaves explicit recoverable states when the process crashes", {
  skip: process.platform === "win32"
}, async () => {
  const worker = fileURLToPath(new URL("./fixtures/crash-worker.js", import.meta.url));
  const cases = [
    {
      stage: "after-lock",
      expectedTarget: TARGET_BEFORE,
      expectedTemporaryCount: 0
    },
    {
      stage: "after-temp-flush",
      expectedTarget: TARGET_BEFORE,
      expectedTemporaryCount: 1
    },
    {
      stage: "after-rename",
      expectedTarget: TARGET_AFTER,
      expectedTemporaryCount: 0
    }
  ];

  for (const crashCase of cases) {
    const root = fixtureRoot();
    mkdirSync(join(root, "receipts"));
    const readyPath = join(root, "crash-ready");
    writeFileSync(join(root, "target.txt"), TARGET_BEFORE);
    const processHandle = spawnCrashWorker(worker, [root, crashCase.stage, readyPath]);

    await waitFor(() => existsSync(readyPath));
    processHandle.child.kill("SIGKILL");
    const termination = await processHandle.done;

    assert.equal(termination.signal, "SIGKILL", crashCase.stage);
    assert.equal(
      readFileSync(join(root, "target.txt"), "utf8"),
      crashCase.expectedTarget,
      crashCase.stage
    );
    const transactionFiles = readdirSync(root).filter((name) => name.includes(".bytefence."));
    const lockFiles = transactionFiles.filter((name) => name.endsWith(".lock"));
    const temporaryFiles = transactionFiles.filter((name) => name.endsWith(".tmp"));
    assert.equal(
      lockFiles.length,
      1,
      crashCase.stage
    );
    assert.match(
      readFileSync(join(root, lockFiles[0]), "utf8"),
      /^[a-f0-9]{64}\n$/u,
      crashCase.stage
    );
    assert.equal(
      temporaryFiles.length,
      crashCase.expectedTemporaryCount,
      crashCase.stage
    );
    if (temporaryFiles.length === 1) {
      assert.equal(
        readFileSync(join(root, temporaryFiles[0]), "utf8"),
        TARGET_AFTER,
        crashCase.stage
      );
    }
    assert.equal(existsSync(join(root, "receipts", "crash.json")), false);
  }
});

function apply(root, {
  oldText,
  newText,
  observedAt = OBSERVED_AT,
  receiptPath,
  onStage,
  receiptWriter,
  randomBytesFn,
  clock = () => "2026-07-13T10:00:01Z"
}) {
  return applyByteFenceTransaction({
    root,
    intentBytes: intentBytes({ oldText, newText }),
    policyBytes: POLICY_BYTES,
    workspaceId: "example/project",
    observedAt,
    receiptProfile: "public",
    receiptPath,
    onStage,
    receiptWriter,
    randomBytesFn,
    clock
  });
}

function intentBytes({ oldText, newText }) {
  return Buffer.from(JSON.stringify({
    $schema: BYTEFENCE_INTENT_SCHEMA,
    operation: "exactReplace",
    targetPath: "target.txt",
    encoding: "utf-8",
    oldText,
    newText,
    expectedOccurrences: 1
  }), "utf8");
}

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), "bytefence-apply-"));
}

function lstatIsSymlink(path) {
  return lstatSync(path).isSymbolicLink();
}

function runWorker(worker, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [worker, ...args], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`ByteFence worker exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        rejectPromise(new Error(`Invalid ByteFence worker output: ${error.message}`));
      }
    });
  });
}

function spawnCrashWorker(worker, args) {
  const child = spawn(process.execPath, [worker, ...args], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (signal === null && code !== 0) {
        rejectPromise(new Error(`ByteFence crash worker exited ${code}: ${stderr}`));
        return;
      }
      resolvePromise({ code, signal });
    });
  });
  return { child, done };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("ByteFence concurrency setup timed out.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function assertTransactionFilesRemoved(root) {
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes(".bytefence.")),
    []
  );
}
