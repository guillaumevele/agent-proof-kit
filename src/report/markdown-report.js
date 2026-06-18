export function renderAgentProofReport(result) {
  const findings = result.findings.length
    ? result.findings.map(renderFindingRow).join("\n")
    : "| none | none | none | none |";

  const checks = result.checks
    .map((check) => `| ${check.id} | ${check.status} | ${escapePipes(check.summary)} |`)
    .join("\n");

  return `# Agent Proof Report

Status: **${result.status.toUpperCase()}**

Score: **${result.score}/100**

Run: \`${result.runId}\`

Policy: \`${result.policyId}\`

## Scope

This report evaluates a synthetic AI-agent trace against deterministic release gates. It does not certify a model, provider, or production system.

## Checks

| Check | Status | Summary |
| --- | --- | --- |
${checks}

## Findings

| Severity | Finding | Location | Recommendation |
| --- | --- | --- | --- |
${findings}
`;
}

export function renderScanReport(result) {
  const findings = result.findings.length
    ? result.findings.map(renderFindingRow).join("\n")
    : "| none | none | none | none |";

  return `# Public Surface Scan

Status: **${result.status.toUpperCase()}**

Files scanned: **${result.filesScanned}**

| Severity | Finding | Location | Recommendation |
| --- | --- | --- | --- |
${findings}
`;
}

function renderFindingRow(finding) {
  return `| ${finding.severity} | ${escapePipes(finding.title)} | \`${escapePipes(finding.location ?? "unknown")}\` | ${escapePipes(finding.recommendation ?? "Review manually.")} |`;
}

function escapePipes(value) {
  return String(value ?? "").replaceAll("|", "\\|");
}
