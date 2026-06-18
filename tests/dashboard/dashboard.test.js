import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderProofDashboard } from "../../src/report/dashboard.js";

const bundle = JSON.parse(readFileSync("docs/generated/proof-bundle.json", "utf8"));
const attestation = JSON.parse(readFileSync("docs/generated/proof-bundle.attestation.json", "utf8"));

test("renders a proof dashboard HTML document", () => {
  const html = renderProofDashboard({
    bundle,
    attestation,
    gateCoverageMarkdown: "# Gate Coverage Matrix\n\nSynthetic coverage."
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Agent Proof Dashboard/);
  assert.match(html, /demo-agent-run-001/);
  assert.match(html, /Gate Coverage Matrix/);
  assert.match(html, new RegExp(attestation.digest.value.slice(0, 12)));
});
