import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { evaluateAgentRun } from "../src/core/evaluate-agent-run.js";
import { renderAgentProofReport } from "../src/report/markdown-report.js";

const inputPath = resolve("examples/synthetic-agent-run.json");
const policyPath = resolve("policies/default-policy.json");
const outPath = resolve("docs/generated/sample-agent-proof-report.md");

const run = JSON.parse(readFileSync(inputPath, "utf8"));
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const report = renderAgentProofReport(
  evaluateAgentRun(run, policy, {
    inputPath,
    policyPath
  })
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report);
process.stdout.write(`wrote ${outPath}\n`);
