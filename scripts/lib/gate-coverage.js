export const gateCoverageEntries = [
  {
    gate: "Public JSON contracts",
    evidence: [
      "schemas/agent-run.schema.json",
      "schemas/policy.schema.json",
      "src/core/json-schema-validator.js"
    ],
    verification: [
      "tests/schema/schema.test.js",
      ".github/workflows/verify.yml"
    ],
    artifacts: [
      "docs/spec.md",
      "docs/generated/proof-bundle.json"
    ]
  },
  {
    gate: "Runtime schema validation",
    evidence: [
      "src/core/validate-agent-run.js",
      "src/core/evaluate-agent-run.js"
    ],
    verification: [
      "tests/schema/schema.test.js",
      "tests/unit/evaluate-agent-run.test.js"
    ],
    artifacts: [
      "docs/generated/sample-agent-proof-report.md"
    ]
  },
  {
    gate: "Synthetic-only public examples",
    evidence: [
      "examples/synthetic-agent-run.json",
      "examples/synthetic-agent-run-regression.json",
      "docs/public-boundary.md"
    ],
    verification: [
      "tests/cli/cli.test.js",
      "scripts/check-machine-artifacts.js"
    ],
    artifacts: [
      "docs/generated/proof-bundle.json"
    ]
  },
  {
    gate: "High-risk action containment",
    evidence: [
      "src/core/evaluate-agent-run.js",
      "policies/default-policy.json"
    ],
    verification: [
      "tests/unit/evaluate-agent-run.test.js",
      "tests/cli/cli.test.js"
    ],
    artifacts: [
      "docs/generated/sample-agent-proof-report.md",
      "docs/generated/sample-agent-proof.sarif"
    ]
  },
  {
    gate: "Fail-closed unknown action types",
    evidence: [
      "src/core/evaluate-agent-run.js",
      "policies/default-policy.json"
    ],
    verification: [
      "tests/unit/evaluate-agent-run.test.js",
      "tests/diff/diff.test.js"
    ],
    artifacts: [
      "docs/generated/sample-agent-run-diff.json",
      "docs/generated/sample-agent-proof.sarif"
    ]
  },
  {
    gate: "Declared claims need evidence",
    evidence: [
      "src/core/evaluate-agent-run.js",
      "src/report/markdown-report.js"
    ],
    verification: [
      "tests/unit/evaluate-agent-run.test.js",
      "tests/cli/cli.test.js"
    ],
    artifacts: [
      "docs/generated/sample-agent-proof-report.md",
      "docs/generated/proof-bundle.json"
    ]
  },
  {
    gate: "Public surface scan",
    evidence: [
      "src/core/public-safety-scan.js",
      "src/core/patterns.js"
    ],
    verification: [
      "tests/unit/public-safety-scan.test.js",
      "package.json"
    ],
    artifacts: [
      "docs/generated/proof-bundle.json"
    ]
  },
  {
    gate: "Oversized unscanned files block release",
    evidence: [
      "src/core/public-safety-scan.js"
    ],
    verification: [
      "tests/unit/public-safety-scan.test.js"
    ],
    artifacts: [
      "docs/generated/proof-bundle.json"
    ]
  },
  {
    gate: "JSONL trace adapter",
    evidence: [
      "src/core/normalize-jsonl.js",
      "examples/synthetic-agent-events.jsonl"
    ],
    verification: [
      "tests/adapter/jsonl.test.js"
    ],
    artifacts: [
      "docs/generated/normalized-agent-run.json",
      "docs/integrations/trace-adapters.md"
    ]
  },
  {
    gate: "Baseline versus candidate diff",
    evidence: [
      "src/core/diff-agent-runs.js",
      "examples/synthetic-agent-run-regression.json"
    ],
    verification: [
      "tests/diff/diff.test.js"
    ],
    artifacts: [
      "docs/generated/sample-agent-run-diff.json"
    ]
  },
  {
    gate: "SARIF export",
    evidence: [
      "src/report/sarif-report.js"
    ],
    verification: [
      "tests/sarif/sarif.test.js",
      ".github/workflows/verify.yml"
    ],
    artifacts: [
      "docs/generated/sample-agent-proof.sarif"
    ]
  },
  {
    gate: "Proof bundle export",
    evidence: [
      "src/report/proof-bundle.js",
      "scripts/lib/machine-artifacts.js"
    ],
    verification: [
      "scripts/check-machine-artifacts.js",
      "package.json"
    ],
    artifacts: [
      "docs/generated/proof-bundle.json"
    ]
  },
  {
    gate: "Composite GitHub Action",
    evidence: [
      "action.yml",
      "docs/integrations/github-action.md"
    ],
    verification: [
      ".github/workflows/verify.yml"
    ],
    artifacts: [
      "docs/generated/sample-agent-proof-report.md",
      "docs/generated/sample-agent-proof.sarif"
    ]
  },
  {
    gate: "Packaged CLI smoke test",
    evidence: [
      "bin/agent-proof.js",
      "package.json"
    ],
    verification: [
      "tests/pack/pack.test.js"
    ],
    artifacts: [
      "docs/generated/sample-agent-proof-report.md"
    ]
  },
  {
    gate: "Generated artifact freshness",
    evidence: [
      "scripts/generate-report.js",
      "scripts/generate-machine-artifacts.js",
      "scripts/lib/gate-coverage.js"
    ],
    verification: [
      "scripts/check-generated-report.js",
      "scripts/check-machine-artifacts.js",
      "scripts/check-gate-coverage.js"
    ],
    artifacts: [
      "docs/generated/sample-agent-proof-report.md",
      "docs/generated/proof-bundle.json",
      "docs/generated/gate-coverage.md"
    ]
  }
];

export function buildGateCoverageMatrix() {
  return `${[
    "# Gate Coverage Matrix",
    "",
    "This generated file maps the public release gates claimed by Agent Proof Kit to implementation files, verification paths and checked-in proof artifacts.",
    "",
    "Scope note: this matrix proves repository coverage for public claims. It does not certify a model, vendor, production workflow, or downstream repository configuration.",
    "",
    "| Gate | Implementation evidence | Verification | Generated proof |",
    "| --- | --- | --- | --- |",
    ...gateCoverageEntries.map((entry) => `| ${[
      entry.gate,
      formatPathList(entry.evidence),
      formatPathList(entry.verification),
      formatPathList(entry.artifacts)
    ].join(" | ")} |`)
  ].join("\n")}\n`;
}

function formatPathList(paths) {
  return paths.map((path) => `[${path}](../../${path})`).join("<br>");
}
