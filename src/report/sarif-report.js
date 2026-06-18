export function renderSarif(result, options = {}) {
  const findings = result.findings ?? result.newFindings ?? [];
  const rules = new Map();

  for (const finding of findings) {
    if (!rules.has(finding.id)) {
      rules.set(finding.id, {
        id: finding.id,
        name: finding.title,
        shortDescription: {
          text: finding.title
        },
        help: {
          text: finding.recommendation ?? "Review this finding."
        }
      });
    }
  }

  return JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [
        {
          tool: {
            driver: {
              name: "agent-proof-kit",
              informationUri: "https://github.com/guillaumevele/agent-proof-kit",
              rules: [...rules.values()]
            }
          },
          results: findings.map((finding) => ({
            ruleId: finding.id,
            level: sarifLevel(finding.severity),
            message: {
              text: `${finding.title}. ${finding.recommendation ?? "Review manually."}`
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: artifactUri(finding, options)
                  },
                  region: {
                    startLine: 1
                  }
                },
                logicalLocations: [
                  {
                    name: finding.location ?? "unknown"
                  }
                ]
              }
            ]
          }))
        }
      ]
    },
    null,
    2
  );
}

function sarifLevel(severity) {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function artifactUri(finding, options) {
  const location = String(finding.location ?? "");
  if (location && !location.startsWith("$")) return location;
  return options.defaultArtifact ?? "agent-run.json";
}
