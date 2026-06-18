import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("detects secret-shaped text and private terms", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-proof-leaky-"));
  writeFileSync(
    join(dir, "trace.md"),
    `Synthetic leak probe: ${"sk-" + "B".repeat(24)} and confidential-project-codename.\n`
  );

  const result = scanPublicSurface(dir, policy);
  assert.equal(result.status, "fail");
  assert.ok(result.findings.some((finding) => finding.id === "secret.openai_key"));
  assert.ok(result.findings.some((finding) => finding.id === "privacy.private_term"));
});
