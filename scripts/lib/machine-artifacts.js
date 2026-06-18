import { readFileSync } from "node:fs";
import { diffAgentRuns } from "../../src/core/diff-agent-runs.js";
import { evaluateAgentRun } from "../../src/core/evaluate-agent-run.js";
import { normalizeJsonlTrace } from "../../src/core/normalize-jsonl.js";
import { createProofAttestation } from "../../src/core/proof-signature.js";
import { scanPublicSurface } from "../../src/core/public-safety-scan.js";
import { createProofBundle } from "../../src/report/proof-bundle.js";
import { renderProofDashboard } from "../../src/report/dashboard.js";
import { renderSarif } from "../../src/report/sarif-report.js";
import { buildGateCoverageMatrix } from "./gate-coverage.js";

export function buildMachineArtifacts() {
  const policy = readJson("policies/default-policy.json");
  const baselineRun = readJson("examples/synthetic-agent-run.json");
  const regressionRun = readJson("examples/synthetic-agent-run-regression.json");

  const normalized = normalizeJsonlTrace(readFileSync("examples/synthetic-agent-events.jsonl", "utf8"));
  const regressionEvaluation = evaluateAgentRun(regressionRun, policy, {
    inputPath: "examples/synthetic-agent-run-regression.json",
    policyPath: "policies/default-policy.json"
  });
  const diff = diffAgentRuns(baselineRun, regressionRun, policy, {
    baselinePath: "examples/synthetic-agent-run.json",
    candidatePath: "examples/synthetic-agent-run-regression.json",
    policyPath: "policies/default-policy.json"
  });
  const evaluation = evaluateAgentRun(baselineRun, policy, {
    inputPath: "examples/synthetic-agent-run.json",
    policyPath: "policies/default-policy.json"
  });
  const scan = scanPublicSurface(".", policy, {
    rootDir: ".",
    displayRoot: "."
  });
  const bundle = createProofBundle({
    evaluation,
    scan,
    metadata: {
      version: "0.4.0",
      generatedAt: "2026-06-18T00:00:00.000Z",
      command: "npm run verify",
      repository: "guillaumevele/agent-proof-kit",
      commit: "generated-fixture"
    }
  });

  const attestation = createProofAttestation(bundle, {
    generatedAt: "2026-06-18T00:00:00.000Z"
  });
  const gateCoverageMarkdown = buildGateCoverageMatrix();

  return {
    "docs/generated/normalized-agent-run.json": `${JSON.stringify(normalized, null, 2)}\n`,
    "docs/generated/sample-agent-proof.sarif": `${renderSarif(regressionEvaluation, {
      defaultArtifact: "examples/synthetic-agent-run-regression.json"
    })}\n`,
    "docs/generated/sample-agent-run-diff.json": `${JSON.stringify(diff, null, 2)}\n`,
    "docs/generated/proof-bundle.json": `${JSON.stringify(bundle, null, 2)}\n`,
    "docs/generated/proof-bundle.attestation.json": `${JSON.stringify(attestation, null, 2)}\n`,
    "docs/generated/proof-dashboard.html": renderProofDashboard({
      bundle,
      attestation,
      gateCoverageMarkdown
    })
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
