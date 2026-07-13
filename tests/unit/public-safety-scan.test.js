import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanPublicSurface } from "../../src/core/public-safety-scan.js";

const policy = {
  minimumScore: 90,
  privateTerms: ["confidential-project-codename"]
};

test("passes a clean public directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-clean-"));
  writeFileSync(join(dir, "README.md"), "Public synthetic fixture only.\n");

  const result = scanPublicSurface(dir, policy);
  assert.equal(result.status, "pass");
  assert.equal(result.findings.length, 0);
});

test("ignores Python bytecode caches", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-python-cache-"));
  const cache = join(dir, "__pycache__");
  mkdirSync(cache);
  writeFileSync(join(dir, "README.md"), "Public synthetic fixture only.\n");
  writeFileSync(
    join(cache, "module.cpython-313.pyc"),
    `ignored cache probe: ${"sk-" + "B".repeat(24)}\n`
  );

  const result = scanPublicSurface(dir, policy);
  assert.equal(result.status, "pass");
  assert.equal(result.filesScanned, 1);
  assert.equal(result.findings.length, 0);
});

test("can scope deterministic fixture scans to tracked paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-tracked-scan-"));
  writeFileSync(join(dir, "tracked.md"), "Public synthetic fixture only.\n");
  writeFileSync(
    join(dir, "local.log"),
    `local-only probe: ${"sk-" + "B".repeat(24)}\n`
  );

  const scoped = scanPublicSurface(dir, policy, {
    includedPaths: ["tracked.md"]
  });
  assert.equal(scoped.status, "pass");
  assert.equal(scoped.filesScanned, 1);

  const complete = scanPublicSurface(dir, policy);
  assert.equal(complete.status, "fail");
  assert.equal(complete.filesScanned, 2);
  assert.ok(complete.findings.some((finding) => finding.id === "secret.openai_key"));
});

test("detects secret-shaped text and private terms", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-leaky-"));
  writeFileSync(
    join(dir, "trace.md"),
    `Synthetic leak probe: ${"sk-" + "B".repeat(24)} and confidential-project-codename.\n`
  );

  const result = scanPublicSurface(dir, policy);
  assert.equal(result.status, "fail");
  const secret = result.findings.find((finding) => finding.id === "secret.openai_key");
  const privateTerm = result.findings.find((finding) => finding.id === "privacy.private_term");
  assert.ok(secret);
  assert.ok(privateTerm);
  assert.match(secret.location, /^trace\.md:1:\d+$/);
  assert.match(privateTerm.location, /^trace\.md:1:\d+$/);
});

test("fails when a file is too large to scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-large-"));
  writeFileSync(join(dir, "large.txt"), "x".repeat(80));

  const result = scanPublicSurface(dir, { maxScannedFileBytes: 32 });
  assert.equal(result.status, "fail");
  assert.equal(result.skippedFiles.length, 1);
  assert.ok(result.findings.some((finding) => finding.id === "surface.file_not_scanned"));
});
