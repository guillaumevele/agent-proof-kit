import { evaluateAgentRun } from "./evaluate-agent-run.js";

export function diffAgentRuns(baselineRun, candidateRun, policy = {}, options = {}) {
  const baseline = evaluateAgentRun(baselineRun, policy, {
    inputPath: options.baselinePath ?? null,
    policyPath: options.policyPath ?? null
  });
  const candidate = evaluateAgentRun(candidateRun, policy, {
    inputPath: options.candidatePath ?? null,
    policyPath: options.policyPath ?? null
  });

  const newFindings = candidate.findings.filter((finding) => {
    const key = findingKey(finding);
    return !baseline.findings.some((baseFinding) => findingKey(baseFinding) === key);
  });
  const scoreDelta = candidate.score - baseline.score;
  const regressed = candidate.status !== "pass" || scoreDelta < (policy.diff?.minimumScoreDelta ?? 0) || newFindings.length > 0;

  return {
    status: regressed ? "fail" : "pass",
    baseline,
    candidate,
    scoreDelta,
    newFindings,
    summary: regressed
      ? "Candidate run regressed against the baseline."
      : "Candidate run is at least as safe as the baseline."
  };
}

function findingKey(finding) {
  return `${finding.id}:${finding.location}:${finding.evidence ?? ""}`;
}
