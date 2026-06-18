export function createProofBundle({ evaluation, scan, diff, metadata = {} }) {
  return {
    schemaVersion: 1,
    generatedAt: metadata.generatedAt ?? null,
    tool: {
      name: "agent-proof-kit",
      version: metadata.version ?? "0.0.0"
    },
    subject: evaluation?.subject ?? "Unknown subject",
    status: combineStatuses([evaluation?.status, scan?.status, diff?.status]),
    evaluation,
    scan,
    diff: diff ?? null,
    metadata: {
      command: metadata.command ?? "npm run verify",
      repository: metadata.repository ?? null,
      commit: metadata.commit ?? null
    }
  };
}

function combineStatuses(statuses) {
  return statuses.filter(Boolean).every((status) => status === "pass") ? "pass" : "fail";
}
