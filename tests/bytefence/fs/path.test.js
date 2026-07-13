import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  constants,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ByteFencePathError,
  inspectByteFenceTarget,
  readByteFenceTarget,
  sameByteFenceFileIdentity
} from "../../../src/core/bytefence-path.js";

test("inspects one existing regular target under the configured root", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.js"), "export const safe = true;\n");

  const target = inspectByteFenceTarget({
    root,
    targetPath: "src/index.js"
  });

  assert.equal(target.targetPath, "src/index.js");
  assert.equal(target.stat.nlink, 1);
  assert.equal(target.stat.size, 26);
  assert.equal(
    readByteFenceTarget(target).bytes.toString("utf8"),
    "export const safe = true;\n"
  );
  assert.equal(sameByteFenceFileIdentity(target.stat, target.stat), true);
});

test("denies absolute, parent, Windows and non-portable path forms", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, "target.txt"), "safe\n");

  for (const targetPath of [
    "/tmp/target.txt",
    "../target.txt",
    "src/../target.txt",
    "C:\\target.txt",
    "server\\share\\target.txt",
    "target.txt:stream",
    "target?.txt",
    "target|pipe.txt",
    "CON",
    "COM¹.txt",
    "target.txt."
  ]) {
    assert.throws(
      () => inspectByteFenceTarget({ root, targetPath }),
      ByteFencePathError,
      targetPath
    );
  }
});

test("denies a symbolic link in the final component", (t) => {
  const root = fixtureRoot();
  const outside = fixtureRoot();
  writeFileSync(join(outside, "outside.txt"), "outside\n");
  try {
    symlinkSync(
      join(outside, "outside.txt"),
      join(root, "target.txt"),
      process.platform === "win32" ? "file" : undefined
    );
  } catch (error) {
    t.skip(`file symlink creation unavailable: ${error.code ?? "unknown"}`);
    return;
  }

  assertPathError(
    () => inspectByteFenceTarget({ root, targetPath: "target.txt" }),
    "path.symlink_denied"
  );
});

test("denies a symbolic link or junction in the parent chain", () => {
  const root = fixtureRoot();
  const outside = fixtureRoot();
  writeFileSync(join(outside, "outside.txt"), "outside\n");
  symlinkSync(
    outside,
    join(root, "linked-parent"),
    process.platform === "win32" ? "junction" : "dir"
  );

  assertPathError(
    () => inspectByteFenceTarget({
      root,
      targetPath: "linked-parent/outside.txt"
    }),
    "path.symlink_denied"
  );
});

test("denies hardlinks, directories and privileged POSIX modes", () => {
  const root = fixtureRoot();
  const source = join(root, "source.txt");
  writeFileSync(source, "source\n");
  linkSync(source, join(root, "hardlink.txt"));
  mkdirSync(join(root, "directory"));

  assertPathError(
    () => inspectByteFenceTarget({ root, targetPath: "source.txt" }),
    "path.hardlink_denied"
  );
  assertPathError(
    () => inspectByteFenceTarget({ root, targetPath: "directory" }),
    "path.target_not_regular"
  );

  if (process.platform !== "win32") {
    const privileged = join(root, "privileged.txt");
    writeFileSync(privileged, "privileged\n");
    chmodSync(privileged, 0o4755);
    assertPathError(
      () => inspectByteFenceTarget({ root, targetPath: "privileged.txt" }),
      "path.privileged_mode_denied"
    );
  }
});

test("compares file identities rather than path strings", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, "one.txt"), "one\n");
  writeFileSync(join(root, "two.txt"), "two\n");
  const one = inspectByteFenceTarget({ root, targetPath: "one.txt" });
  const two = inspectByteFenceTarget({ root, targetPath: "two.txt" });

  assert.equal(sameByteFenceFileIdentity(one.stat, two.stat), false);
  assert.equal(sameByteFenceFileIdentity(null, two.stat), false);
});

test("refuses a target before reading beyond the configured byte limit", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, "target.txt"), "0123456789");
  const target = inspectByteFenceTarget({ root, targetPath: "target.txt" });

  assertPathError(
    () => readByteFenceTarget(target, { maxBytes: 9 }),
    "path.target_too_large"
  );
  assert.equal(
    readByteFenceTarget(target, { maxBytes: 10 }).bytes.toString("utf8"),
    "0123456789"
  );
  assertPathError(
    () => readByteFenceTarget(target, { maxBytes: -1 }),
    "path.read_limit_invalid"
  );
});

test("refuses a target whose inode changes after inspection", () => {
  const root = fixtureRoot();
  const path = join(root, "target.txt");
  const replacement = join(root, "replacement.txt");
  writeFileSync(path, "before\n");
  writeFileSync(replacement, "after\n");
  const inspected = inspectByteFenceTarget({ root, targetPath: "target.txt" });
  const replacementInspected = inspectByteFenceTarget({
    root,
    targetPath: "replacement.txt"
  });

  assert.equal(
    sameByteFenceFileIdentity(inspected.stat, replacementInspected.stat),
    false
  );

  unlinkSync(path);
  renameSync(replacement, path);

  assertPathError(
    () => readByteFenceTarget(inspected),
    "path.identity_changed"
  );
});

test("detects a final-component symlink swap with or without no-follow support", (t) => {
  const root = fixtureRoot();
  const outside = fixtureRoot();
  const path = join(root, "target.txt");
  const outsidePath = join(outside, "outside.txt");
  writeFileSync(path, "before\n");
  writeFileSync(outsidePath, "outside\n");
  const inspected = inspectByteFenceTarget({ root, targetPath: "target.txt" });

  unlinkSync(path);
  try {
    symlinkSync(outsidePath, path, process.platform === "win32" ? "file" : undefined);
  } catch (error) {
    t.skip(`file symlink creation unavailable: ${error.code ?? "unknown"}`);
    return;
  }

  assertPathError(
    () => readByteFenceTarget(inspected),
    typeof constants.O_NOFOLLOW === "number"
      ? "path.open_failed"
      : "path.identity_changed"
  );
});

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), "bytefence-path-"));
}

function assertPathError(operation, code) {
  assert.throws(operation, (error) => (
    error instanceof ByteFencePathError && error.code === code
  ));
}
