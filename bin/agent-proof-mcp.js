#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { diffAgentRuns } from "../src/core/diff-agent-runs.js";
import { evaluateAgentRun } from "../src/core/evaluate-agent-run.js";
import { scanPublicSurface } from "../src/core/public-safety-scan.js";
import { exportTraceFixture, supportedTraceSources } from "../src/core/trace-export.js";
import { renderAgentProofReport, renderScanReport } from "../src/report/markdown-report.js";
import { createProofBundle } from "../src/report/proof-bundle.js";
import { renderSarif } from "../src/report/sarif-report.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = realpathSync(resolve(process.env.AGENT_PROOF_ROOT ?? process.cwd()));
const CHARACTER_LIMIT = 25000;

const ResponseFormat = {
  JSON: "json",
  MARKDOWN: "markdown",
  SARIF: "sarif"
};

const ArtifactName = {
  REPORT: "sample_report",
  PROOF_BUNDLE: "proof_bundle",
  SARIF: "sarif",
  NORMALIZED_RUN: "normalized_run",
  REGRESSION_DIFF: "regression_diff",
  GATE_COVERAGE: "gate_coverage"
};

const generatedArtifacts = {
  [ArtifactName.REPORT]: "docs/generated/sample-agent-proof-report.md",
  [ArtifactName.PROOF_BUNDLE]: "docs/generated/proof-bundle.json",
  [ArtifactName.SARIF]: "docs/generated/sample-agent-proof.sarif",
  [ArtifactName.NORMALIZED_RUN]: "docs/generated/normalized-agent-run.json",
  [ArtifactName.REGRESSION_DIFF]: "docs/generated/sample-agent-run-diff.json",
  [ArtifactName.GATE_COVERAGE]: "docs/generated/gate-coverage.md"
};

const server = new McpServer({
  name: "agent-proof-mcp-server",
  version: packageInfo().version
});

server.registerTool(
  "agent_proof_status",
  {
    title: "Agent Proof Status",
    description: `Summarize the Agent Proof Kit package and the configured workspace root.

Use this first when an assistant needs to understand what proof artifacts, sample inputs and workflow tools are available. It does not scan or modify files.`,
    inputSchema: z.object({
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN])
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: markdown for review, json for programmatic use.")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ response_format }) => toToolResult(() => {
    const info = {
      package: {
        name: packageInfo().name,
        version: packageInfo().version,
        root: packageRoot
      },
      workspaceRoot,
      bundledExamples: {
        safeRun: "examples/synthetic-agent-run.json",
        regressionRun: "examples/synthetic-agent-run-regression.json",
        policy: "policies/default-policy.json"
      },
      generatedArtifacts: Object.entries(generatedArtifacts).map(([name, path]) => ({
        name,
        path,
        exists: existsSync(resolve(packageRoot, path))
      })),
      nextTools: [
        "agent_proof_verify_run",
        "agent_proof_scan_surface",
        "agent_proof_export_trace",
        "agent_proof_diff_runs",
        "agent_proof_create_bundle",
        "agent_proof_read_artifact"
      ]
    };

    return response_format === ResponseFormat.JSON ? JSON.stringify(info, null, 2) : renderStatus(info);
  })
);

server.registerTool(
  "agent_proof_verify_run",
  {
    title: "Verify Agent Run",
    description: `Evaluate an agent-run JSON file against an Agent Proof Kit policy.

Use this to answer: "Does this run pass the release gate?", "Which findings block this run?", or "Show me the Markdown/SARIF proof for this run." If input or policy is omitted, the bundled synthetic safe fixture is used.`,
    inputSchema: z.object({
      input: z.string().min(1).max(500)
        .optional()
        .describe("Agent-run JSON path under the workspace root. Omit to use the bundled synthetic safe fixture."),
      policy: z.string().min(1).max(500)
        .optional()
        .describe("Policy JSON path under the workspace root. Omit to use the bundled default policy."),
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN, ResponseFormat.SARIF])
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format: markdown for review, json for data, sarif for code-scanning upload.")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ input, policy, response_format }) => toToolResult(() => {
    const inputRef = resolveInput(input, "examples/synthetic-agent-run.json", "input");
    const policyRef = resolveInput(policy, "policies/default-policy.json", "policy");
    const evaluation = evaluateAgentRun(readJson(inputRef.path), readJson(policyRef.path), {
      inputPath: inputRef.displayPath,
      policyPath: policyRef.displayPath
    });

    return formatEvaluation(evaluation, response_format);
  })
);

server.registerTool(
  "agent_proof_scan_surface",
  {
    title: "Scan Public Surface",
    description: `Scan a workspace directory for secret-shaped values, configured private terms, unsafe public filenames and oversized unscanned files.

Use this before publishing a repository or generated artifact. Paths are constrained to the configured workspace root. Add project-specific names through private_terms when scanning downstream work.`,
    inputSchema: z.object({
      scan_path: z.string().min(1).max(500)
        .default(".")
        .describe("Directory path under the workspace root to scan. Defaults to the workspace root."),
      policy: z.string().min(1).max(500)
        .optional()
        .describe("Policy JSON path under the workspace root. Omit to use the bundled default policy."),
      private_terms: z.array(z.string().min(1).max(200))
        .max(100)
        .default([])
        .describe("Additional project-specific private terms to detect for this scan only."),
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN, ResponseFormat.SARIF])
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format.")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ scan_path, policy, private_terms, response_format }) => toToolResult(() => {
    const scanPath = resolveWorkspacePath(scan_path, "scan_path");
    assertDirectory(scanPath.path, "scan_path");
    const policyRef = resolveInput(policy, "policies/default-policy.json", "policy");
    const parsedPolicy = readJson(policyRef.path);
    parsedPolicy.privateTerms = [...new Set([...(parsedPolicy.privateTerms ?? []), ...(private_terms ?? [])])];
    const scan = scanPublicSurface(scanPath.path, parsedPolicy, {
      rootDir: scanPath.path,
      displayRoot: scanPath.displayPath
    });

    return formatScan(scan, response_format);
  })
);

server.registerTool(
  "agent_proof_export_trace",
  {
    title: "Export Trace Fixture",
    description: `Normalize a supported trace file into the Agent Proof Kit agent-run fixture contract.

Use this when onboarding a repository that has JSONL events but not yet an Agent Proof Kit fixture. The tool can redact configured terms in string values before returning or writing the fixture.`,
    inputSchema: z.object({
      from: z.enum(supportedTraceSources)
        .default("agent-proof-jsonl")
        .describe("Trace source shape. Current supported values are agent-proof-jsonl and generic-jsonl."),
      input: z.string().min(1).max(500)
        .describe("Trace JSONL path under the workspace root."),
      redact_terms: z.array(z.string().min(1).max(200))
        .max(100)
        .default([])
        .describe("Sensitive terms to replace with [redacted-term-N] placeholders in string values."),
      write_path: z.string().min(1).max(500)
        .optional()
        .describe("Optional output JSON path under the workspace root. Parent directories are created."),
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN])
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format.")
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ from, input, redact_terms, write_path, response_format }) => toToolResult(() => {
    const inputRef = resolveWorkspacePath(input, "input");
    const exported = exportTraceFixture(readFileSync(inputRef.path, "utf8"), {
      source: from,
      redactTerms: redact_terms
    });
    let writtenTo = null;
    if (write_path) {
      const out = resolveWorkspaceWritePath(write_path, "write_path");
      mkdirSync(dirname(out.path), { recursive: true });
      writeFileSync(out.path, `${JSON.stringify(exported.run, null, 2)}\n`);
      writtenTo = out.displayPath;
    }

    if (response_format === ResponseFormat.JSON) {
      return JSON.stringify({ ...exported, writtenTo }, null, 2);
    }

    return `# Exported Agent Run Fixture

- Source: ${exported.source}
- Run: ${exported.run.runId}
- Actions: ${exported.run.actions.length}
- Outputs: ${exported.run.outputs.length}
- Evidence items: ${exported.run.evidence.length}
- Redactions applied: ${exported.redactedTerms}
${writtenTo ? `- Written to: \`${writtenTo}\`` : "- Written to: not requested"}
`;
  })
);

server.registerTool(
  "agent_proof_diff_runs",
  {
    title: "Diff Agent Runs",
    description: `Compare a baseline run and a candidate run under the same policy.

Use this to detect regression findings or score drops before accepting a changed agent workflow. Paths are constrained to the workspace root. If omitted, bundled safe and regression fixtures are used.`,
    inputSchema: z.object({
      base: z.string().min(1).max(500)
        .optional()
        .describe("Baseline agent-run JSON path under the workspace root. Omit to use the bundled safe fixture."),
      candidate: z.string().min(1).max(500)
        .optional()
        .describe("Candidate agent-run JSON path under the workspace root. Omit to use the bundled regression fixture."),
      policy: z.string().min(1).max(500)
        .optional()
        .describe("Policy JSON path under the workspace root. Omit to use the bundled default policy."),
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN, ResponseFormat.SARIF])
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format.")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ base, candidate, policy, response_format }) => toToolResult(() => {
    const baseRef = resolveInput(base, "examples/synthetic-agent-run.json", "base");
    const candidateRef = resolveInput(candidate, "examples/synthetic-agent-run-regression.json", "candidate");
    const policyRef = resolveInput(policy, "policies/default-policy.json", "policy");
    const diff = diffAgentRuns(readJson(baseRef.path), readJson(candidateRef.path), readJson(policyRef.path), {
      baselinePath: baseRef.displayPath,
      candidatePath: candidateRef.displayPath,
      policyPath: policyRef.displayPath
    });

    return formatDiff(diff, response_format);
  })
);

server.registerTool(
  "agent_proof_create_bundle",
  {
    title: "Create Proof Bundle",
    description: `Create a proof bundle by evaluating an agent run and scanning a workspace directory.

Use this when an assistant needs a single JSON object that combines run evaluation, public-surface scan and reproducible metadata. Optionally writes the bundle to a path under the workspace root.`,
    inputSchema: z.object({
      input: z.string().min(1).max(500)
        .optional()
        .describe("Agent-run JSON path under the workspace root. Omit to use the bundled safe fixture."),
      policy: z.string().min(1).max(500)
        .optional()
        .describe("Policy JSON path under the workspace root. Omit to use the bundled default policy."),
      scan_path: z.string().min(1).max(500)
        .default(".")
        .describe("Directory under the workspace root to scan."),
      write_path: z.string().min(1).max(500)
        .optional()
        .describe("Optional output JSON path under the workspace root. Parent directories are created."),
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN])
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format.")
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ input, policy, scan_path, write_path, response_format }) => toToolResult(() => {
    const inputRef = resolveInput(input, "examples/synthetic-agent-run.json", "input");
    const policyRef = resolveInput(policy, "policies/default-policy.json", "policy");
    const scanPath = resolveWorkspacePath(scan_path, "scan_path");
    const parsedPolicy = readJson(policyRef.path);
    const evaluation = evaluateAgentRun(readJson(inputRef.path), parsedPolicy, {
      inputPath: inputRef.displayPath,
      policyPath: policyRef.displayPath
    });
    const scan = scanPublicSurface(scanPath.path, parsedPolicy, {
      rootDir: scanPath.path,
      displayRoot: scanPath.displayPath
    });
    const bundle = createProofBundle({
      evaluation,
      scan,
      metadata: {
        version: packageInfo().version,
        generatedAt: new Date().toISOString(),
        command: "agent_proof_create_bundle",
        repository: packageInfo().repository?.url ?? null,
        commit: null
      }
    });
    let writtenTo = null;
    if (write_path) {
      const out = resolveWorkspaceWritePath(write_path, "write_path");
      mkdirSync(dirname(out.path), { recursive: true });
      writeFileSync(out.path, `${JSON.stringify(bundle, null, 2)}\n`);
      writtenTo = out.displayPath;
    }

    if (response_format === ResponseFormat.JSON) {
      return JSON.stringify({ writtenTo, bundle }, null, 2);
    }

    return `# Agent Proof Bundle

Status: **${bundle.status.toUpperCase()}**

- Tool: ${bundle.tool.name} ${bundle.tool.version}
- Run: ${bundle.evaluation.runId}
- Evaluation findings: ${bundle.evaluation.findings.length}
- Scan findings: ${bundle.scan.findings.length}
- Files scanned: ${bundle.scan.filesScanned}
${writtenTo ? `- Written to: \`${writtenTo}\`` : "- Written to: not requested"}
`;
  })
);

server.registerTool(
  "agent_proof_read_artifact",
  {
    title: "Read Generated Proof Artifact",
    description: `Read one checked-in generated proof artifact bundled with Agent Proof Kit.

Use this when an assistant needs to inspect the sample report, SARIF export, proof bundle, normalized run, regression diff, or gate coverage matrix without guessing file paths.`,
    inputSchema: z.object({
      artifact: z.enum(Object.values(ArtifactName))
        .describe("Generated artifact to read."),
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN])
        .default(ResponseFormat.MARKDOWN)
        .describe("JSON returns metadata plus content. Markdown returns the artifact content with a heading.")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ artifact, response_format }) => toToolResult(() => {
    const path = generatedArtifacts[artifact];
    const absolutePath = resolve(packageRoot, path);
    const content = readFileSync(absolutePath, "utf8");
    if (response_format === ResponseFormat.JSON) {
      return JSON.stringify({
        artifact,
        path,
        bytes: statSync(absolutePath).size,
        content
      }, null, 2);
    }

    return `# ${artifact}

Path: \`${path}\`

\`\`\`${path.endsWith(".json") || path.endsWith(".sarif") ? "json" : "markdown"}
${content.trimEnd()}
\`\`\`
`;
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`agent-proof-mcp-server ${packageInfo().version} running with workspace root ${workspaceRoot}`);
}

function packageInfo() {
  return readJson(resolve(packageRoot, "package.json"));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function toToolResult(fn) {
  try {
    return {
      content: [
        {
          type: "text",
          text: limitText(fn())
        }
      ]
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}

Check that paths are relative to the configured workspace root and that JSON files match the Agent Proof Kit schemas.`
        }
      ],
      isError: true
    };
  }
}

function limitText(text) {
  const value = String(text);
  if (value.length <= CHARACTER_LIMIT) return value;
  return `${value.slice(0, CHARACTER_LIMIT)}

[truncated: response exceeded ${CHARACTER_LIMIT} characters. Request JSON output or narrower inputs.]`;
}

function resolveInput(value, bundledFallback, label) {
  if (value) return resolveWorkspacePath(value, label);
  return {
    path: resolve(packageRoot, bundledFallback),
    displayPath: bundledFallback
  };
}

function resolveWorkspacePath(value, label) {
  const path = resolve(workspaceRoot, value);
  assertInsideWorkspace(path, label);
  return {
    path,
    displayPath: relative(workspaceRoot, path) || "."
  };
}

function resolveWorkspaceWritePath(value, label) {
  const path = resolve(workspaceRoot, value);
  assertInsideWorkspace(dirname(path), label);
  return {
    path,
    displayPath: relative(workspaceRoot, path) || "."
  };
}

function assertInsideWorkspace(path, label) {
  const realRoot = realpathSync(workspaceRoot);
  const existing = nearestExistingPath(path);
  const realPath = realpathSync(existing);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`${label} must stay under workspace root: ${realRoot}`);
  }
}

function nearestExistingPath(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertDirectory(path, label) {
  if (!statSync(path).isDirectory()) {
    throw new Error(`${label} must point to a directory.`);
  }
}

function formatEvaluation(evaluation, responseFormat) {
  if (responseFormat === ResponseFormat.JSON) return JSON.stringify(evaluation, null, 2);
  if (responseFormat === ResponseFormat.SARIF) {
    return renderSarif(evaluation, { defaultArtifact: evaluation.inputPath ?? "agent-run.json" });
  }
  return renderAgentProofReport(evaluation);
}

function formatScan(scan, responseFormat) {
  if (responseFormat === ResponseFormat.JSON) return JSON.stringify(scan, null, 2);
  if (responseFormat === ResponseFormat.SARIF) return renderSarif(scan, { defaultArtifact: scan.rootPath ?? "." });
  return renderScanReport(scan);
}

function formatDiff(diff, responseFormat) {
  if (responseFormat === ResponseFormat.JSON) return JSON.stringify(diff, null, 2);
  if (responseFormat === ResponseFormat.SARIF) {
    return renderSarif({ findings: diff.newFindings }, {
      defaultArtifact: diff.candidate?.inputPath ?? "candidate-agent-run.json"
    });
  }

  const rows = diff.newFindings.length
    ? diff.newFindings.map((finding) => `| ${finding.severity} | ${finding.id} | \`${finding.location}\` |`).join("\n")
    : "| none | none | none |";
  return `# Agent Run Diff

Status: **${diff.status.toUpperCase()}**

Score delta: **${diff.scoreDelta}**

${diff.summary}

| Severity | Finding | Location |
| --- | --- | --- |
${rows}
`;
}

function renderStatus(info) {
  const artifacts = info.generatedArtifacts
    .map((artifact) => `- ${artifact.name}: \`${artifact.path}\` (${artifact.exists ? "present" : "missing"})`)
    .join("\n");
  const tools = info.nextTools.map((tool) => `- \`${tool}\``).join("\n");

  return `# Agent Proof Kit MCP Status

- Package: ${info.package.name} ${info.package.version}
- Package root: \`${info.package.root}\`
- Workspace root: \`${info.workspaceRoot}\`

## Bundled Examples

- Safe run: \`${info.bundledExamples.safeRun}\`
- Regression run: \`${info.bundledExamples.regressionRun}\`
- Policy: \`${info.bundledExamples.policy}\`

## Generated Artifacts

${artifacts}

## Available Workflow Tools

${tools}
`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
