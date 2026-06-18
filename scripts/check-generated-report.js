import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateAgentRun } from "../src/core/evaluate-agent-run.js";
import { renderAgentProofReport } from "../src/report/markdown-report.js";

const inputPath = resolve("examples/synthetic-agent-run.json");
const policyPath = resolve("policies/default-policy.json");
const outPath = resolve("docs/generated/sample-agent-proof-report.md");

const run = JSON.parse(readFileSync(inputPath, "utf8"));
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const expected = renderAgentProofReport(
  evaluateAgentRun(run, policy, {
    inputPath,
    policyPath
  })
);
const actual = readFileSync(outPath, "utf8");

if (actual !== expected) {
  process.stderr.write("Generated report is stale. Run npm run report:generate.\n");
  process.exitCode = 1;
} else {
  process.stdout.write("generated report is current\n");
}
