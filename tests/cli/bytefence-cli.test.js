import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("bin/agent-proof.js");
const policyPath = resolve("policies/bytefence-default.json");
const observedAt = "2026-07-13T12:34:56Z";
const workspaceId = "synthetic/bytefence-cli-test";
const intentSchema =
  "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json";

test("ByteFence commands are included in CLI help", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bytefence-check/);
  assert.match(result.stdout, /bytefence-verify/);
  assert.match(result.stdout, /bytefence-apply/);
});

test("bytefence-check allows exact raw bytes and persists an immutable preflight receipt", () => {
  const fixture = makeFixture();
  const receiptPath = join(fixture.root, "receipts", "preflight.json");
  const result = runCheck(fixture, ["--out", receiptPath]);

  assert.equal(result.status, 0, result.stderr);
  const payload = parseMachineOutput(result);
  assert.equal(payload.status, "allow");
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.allowed, true);
  assert.match(payload.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.receiptProfile, "public");
  assert.equal(result.stdout.includes(fixture.oldText), false);
  assert.equal(result.stdout.includes(fixture.newText), false);
  assert.deepEqual(readFileSync(fixture.targetPath), fixture.before);

  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.predicate.observedAt, observedAt);
  assert.equal(receipt.predicate.decision.status, "allow");

  const second = runCheck(fixture, ["--out", receiptPath]);
  assert.equal(second.status, 2, second.stderr);
  assert.equal(parseMachineOutput(second).status, "invalid");
});

test("bytefence-check rejects a target that does not exactly match the intent", () => {
  const fixture = makeFixture();
  const args = checkArgs(fixture);
  const targetIndex = args.indexOf("--target") + 1;
  args[targetIndex] = "src/another.txt";
  const result = runCli(["bytefence-check", ...args]);

  assert.equal(result.status, 2, result.stderr);
  const payload = parseMachineOutput(result);
  assert.equal(payload.status, "invalid");
  assert.equal(payload.findings[0].id, "cli.targetIntentMismatch");
  assert.deepEqual(readFileSync(fixture.targetPath), fixture.before);
});

test("bytefence-check denies a candidate with undeclared byte changes", () => {
  const fixture = makeFixture();
  const mismatched = Buffer.concat([fixture.candidate, Buffer.from("extra\n")]);
  writeFileSync(fixture.candidatePath, mismatched);
  const result = runCheck(fixture);

  assert.equal(result.status, 1, result.stderr);
  const payload = parseMachineOutput(result);
  assert.equal(payload.status, "deny");
  assert.equal(payload.allowed, false);
  assert.ok(payload.findings.some((finding) => finding.id === "candidate.derivationMismatch"));
  assert.deepEqual(readFileSync(fixture.targetPath), fixture.before);
});

test("bytefence-verify recomputes a preflight receipt from preserved raw inputs", () => {
  const fixture = makeFixture();
  const receiptPath = join(fixture.root, "receipts", "verified-preflight.json");
  const check = runCheck(fixture, ["--out", receiptPath]);
  assert.equal(check.status, 0, check.stderr);

  const result = runVerify(fixture, receiptPath);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseMachineOutput(result);
  assert.equal(payload.status, "verified");
  assert.equal(payload.verified, true);
  assert.equal(payload.authorized, true);
  assert.equal(payload.effectiveGuaranteeLevel, "CORE_PROVEN");
});

test("bytefence-verify returns integrity mismatch for a tampered receipt", () => {
  const fixture = makeFixture();
  const receiptPath = join(fixture.root, "receipts", "tampered-preflight.json");
  const check = runCheck(fixture, ["--out", receiptPath]);
  assert.equal(check.status, 0, check.stderr);

  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.predicate.operationId = `${receipt.predicate.operationId}-tampered`;
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const result = runVerify(fixture, receiptPath);

  assert.equal(result.status, 1, result.stderr);
  const payload = parseMachineOutput(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.verified, false);
  assert.ok(payload.findings.some((finding) => finding.id === "receipt.contentMismatch"));
});

test("bytefence-apply commits the exact candidate and a fresh transaction receipt", () => {
  const fixture = makeFixture();
  const receiptPath = join(fixture.root, "receipts", "transaction.json");
  const result = runApply(fixture, receiptPath);

  assert.equal(result.status, 0, result.stderr);
  const payload = parseMachineOutput(result);
  assert.equal(payload.status, "allow");
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.allowed, true);
  assert.equal(payload.phase, "postApply");
  assert.equal(payload.receiptPersisted, true);
  assert.equal(payload.declaredGuaranteeLevel, "MEDIATED_PROVEN");
  assert.equal(payload.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(payload.mediationEnvironmentTrusted, false);
  assert.match(payload.receiptDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(fixture.targetPath), fixture.candidate);

  const transaction = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(transaction._type, "ByteFenceTransactionReceipt/v0.1");
  assert.equal(transaction.preflight.predicate.observedAt, observedAt);
  assert.ok(
    Date.parse(transaction.postApply.predicate.observedAt) >= Date.parse(observedAt)
  );

  const verify = runVerify(fixture, receiptPath);
  assert.equal(verify.status, 0, verify.stderr);
  const verified = parseMachineOutput(verify);
  assert.equal(verified.receiptType, "ByteFenceTransactionReceipt/v0.1");
  assert.equal(verified.effectiveGuaranteeLevel, "CORE_PROVEN");
  assert.equal(verified.producerAuthenticated, false);
  assert.equal(verified.mediationEnvironmentTrusted, false);
});

test("bytefence-apply refuses an existing receipt before changing the target", () => {
  const fixture = makeFixture();
  const receiptPath = join(fixture.root, "receipts", "existing.json");
  writeFileSync(receiptPath, "existing receipt\n");
  const result = runApply(fixture, receiptPath);

  assert.equal(result.status, 2, result.stderr);
  const payload = parseMachineOutput(result);
  assert.equal(payload.status, "invalid");
  assert.ok(payload.findings.some((finding) => finding.id === "receipt.exists"));
  assert.deepEqual(readFileSync(fixture.targetPath), fixture.before);
  assert.equal(readFileSync(receiptPath, "utf8"), "existing receipt\n");
});

test("ByteFence invalid-input failures remain JSON-only and do not disclose input paths", () => {
  const fixture = makeFixture();
  const secretPath = join(fixture.root, "private-candidate-name.txt");
  const result = runCli([
    "bytefence-check",
    "--target",
    fixture.targetRelative,
    "--candidate",
    secretPath,
    "--intent",
    fixture.intentPath,
    "--policy",
    policyPath,
    "--workspace-id",
    workspaceId,
    "--root",
    fixture.root
  ]);

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(secretPath), false);
  assert.equal(parseMachineOutput(result).status, "invalid");
});

test("ByteFence rejects unsupported flags and receipt outputs outside the root", () => {
  const fixture = makeFixture();
  const unsupported = runCheck(fixture, ["--format", "text"]);
  assert.equal(unsupported.status, 2, unsupported.stderr);
  assert.equal(parseMachineOutput(unsupported).findings[0].id, "cli.flagUnsupported");

  const outside = runCheck(fixture, [
    "--out",
    join(tmpdir(), `bytefence-outside-${process.pid}.json`)
  ]);
  assert.equal(outside.status, 2, outside.stderr);
  assert.equal(parseMachineOutput(outside).findings[0].id, "cli.receiptOutsideRoot");
  assert.deepEqual(readFileSync(fixture.targetPath), fixture.before);
});

test("ByteFence bounds policy and candidate reads before evaluation", () => {
  const fixture = makeFixture();
  const oversizedPolicyPath = join(fixture.root, "oversized-policy.json");
  const missingCandidatePath = join(fixture.root, "must-not-be-read.txt");
  writeFileSync(oversizedPolicyPath, Buffer.alloc(64 * 1024 + 1, 0x20));
  const policyFirstArgs = checkArgs(fixture);
  policyFirstArgs[policyFirstArgs.indexOf("--policy") + 1] = oversizedPolicyPath;
  policyFirstArgs[policyFirstArgs.indexOf("--candidate") + 1] = missingCandidatePath;
  const policyFirst = runCli(["bytefence-check", ...policyFirstArgs]);
  assert.equal(policyFirst.status, 2, policyFirst.stderr);
  assert.equal(parseMachineOutput(policyFirst).findings[0].id, "cli.policyTooLarge");

  const narrowPolicy = JSON.parse(readFileSync(policyPath, "utf8"));
  narrowPolicy.id = "bytefence-cli-narrow";
  narrowPolicy.maxTargetBytes = fixture.before.length;
  const narrowPolicyPath = join(fixture.root, "narrow-policy.json");
  writeFileSync(narrowPolicyPath, `${JSON.stringify(narrowPolicy)}\n`);
  writeFileSync(fixture.candidatePath, Buffer.alloc(fixture.before.length + 1, 0x61));
  const candidateArgs = checkArgs(fixture);
  candidateArgs[candidateArgs.indexOf("--policy") + 1] = narrowPolicyPath;
  const candidate = runCli(["bytefence-check", ...candidateArgs]);
  assert.equal(candidate.status, 1, candidate.stderr);
  assert.equal(parseMachineOutput(candidate).findings[0].id, "change.candidateTooLarge");
  assert.deepEqual(readFileSync(fixture.targetPath), fixture.before);

  const targetPolicy = {
    ...narrowPolicy,
    id: "bytefence-cli-target-narrow",
    maxTargetBytes: fixture.before.length - 1
  };
  const targetPolicyPath = join(fixture.root, "target-narrow-policy.json");
  writeFileSync(targetPolicyPath, `${JSON.stringify(targetPolicy)}\n`);
  const targetArgs = checkArgs(fixture);
  targetArgs[targetArgs.indexOf("--policy") + 1] = targetPolicyPath;
  const target = runCli(["bytefence-check", ...targetArgs]);
  assert.equal(target.status, 1, target.stderr);
  assert.equal(parseMachineOutput(target).findings[0].id, "change.targetTooLarge");

  const placeholderReceipt = join(fixture.root, "receipts", "placeholder.json");
  writeFileSync(placeholderReceipt, "{}\n");
  const verifyCandidate = runVerify(
    fixture,
    placeholderReceipt,
    narrowPolicyPath
  );
  assert.equal(verifyCandidate.status, 1, verifyCandidate.stderr);
  const verifyPayload = parseMachineOutput(verifyCandidate);
  assert.equal(verifyPayload.findings[0].id, "change.candidateTooLarge");
  assert.equal(verifyPayload.verified, false);
});

test("bytefence-verify refuses an oversized receipt without parsing it", () => {
  const fixture = makeFixture();
  const receiptPath = join(fixture.root, "receipts", "oversized.json");
  writeFileSync(receiptPath, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
  const result = runVerify(fixture, receiptPath);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(parseMachineOutput(result).findings[0].id, "cli.receiptTooLarge");
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "bytefence-cli-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "receipts"));
  mkdirSync(join(root, "snapshots"));
  const targetRelative = "src/target.txt";
  const targetPath = join(root, targetRelative);
  const beforePath = join(root, "snapshots", "before.txt");
  const candidatePath = join(root, "candidate.txt");
  const intentPath = join(root, "intent.json");
  const oldText = "const enabled = false;";
  const newText = "const enabled = true;";
  const before = Buffer.from(
    `${"scope-padding-".repeat(14)}\r\n${oldText}\nunchanged-tail\r\n`,
    "utf8"
  );
  const oldBytes = Buffer.from(oldText, "utf8");
  const start = before.indexOf(oldBytes);
  assert.notEqual(start, -1);
  const candidate = Buffer.concat([
    before.subarray(0, start),
    Buffer.from(newText, "utf8"),
    before.subarray(start + oldBytes.length)
  ]);
  const intent = {
    $schema: intentSchema,
    operation: "exactReplace",
    targetPath: targetRelative,
    encoding: "utf-8",
    oldText,
    newText,
    expectedOccurrences: 1
  };

  writeFileSync(targetPath, before);
  writeFileSync(beforePath, before);
  writeFileSync(candidatePath, candidate);
  writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
  return {
    root,
    targetRelative,
    targetPath,
    beforePath,
    candidatePath,
    intentPath,
    oldText,
    newText,
    before,
    candidate
  };
}

function checkArgs(fixture) {
  return [
    "--target",
    fixture.targetRelative,
    "--candidate",
    fixture.candidatePath,
    "--intent",
    fixture.intentPath,
    "--policy",
    policyPath,
    "--workspace-id",
    workspaceId,
    "--receipt-profile",
    "public",
    "--observed-at",
    observedAt,
    "--root",
    fixture.root
  ];
}

function runCheck(fixture, extra = []) {
  return runCli(["bytefence-check", ...checkArgs(fixture), ...extra]);
}

function runApply(fixture, receiptPath) {
  return runCli([
    "bytefence-apply",
    "--intent",
    fixture.intentPath,
    "--policy",
    policyPath,
    "--workspace-id",
    workspaceId,
    "--receipt-profile",
    "public",
    "--observed-at",
    observedAt,
    "--root",
    fixture.root,
    "--out",
    receiptPath
  ]);
}

function runVerify(fixture, receiptPath, selectedPolicyPath = policyPath) {
  return runCli([
    "bytefence-verify",
    "--receipt",
    receiptPath,
    "--before",
    fixture.beforePath,
    "--candidate",
    fixture.candidatePath,
    "--intent",
    fixture.intentPath,
    "--policy",
    selectedPolicyPath,
    "--workspace-id",
    workspaceId,
    "--root",
    fixture.root
  ]);
}

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}

function parseMachineOutput(result) {
  assert.doesNotThrow(() => JSON.parse(result.stdout), result.stdout);
  return JSON.parse(result.stdout);
}
