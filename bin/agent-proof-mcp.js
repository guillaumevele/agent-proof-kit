#!/usr/bin/env node

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyByteFenceTransaction } from "../src/core/bytefence-apply.js";
import {
  BYTEFENCE_MAX_INTENT_BYTES,
  BYTEFENCE_MAX_POLICY_BYTES,
  parseByteFenceIntent,
  parseByteFencePolicy
} from "../src/core/bytefence-contract.js";
import { evaluateByteFence } from "../src/core/bytefence-evaluate.js";
import { inspectByteFenceTarget, readByteFenceTarget } from "../src/core/bytefence-path.js";
import { receiptDigest as digestByteFenceReceipt } from "../src/core/bytefence-receipt.js";
import { diffAgentRuns } from "../src/core/diff-agent-runs.js";
import { evaluateAgentRun } from "../src/core/evaluate-agent-run.js";
import { compilePolicyDefinition, loadPolicyFile, readPolicyDefinition } from "../src/core/policy-loader.js";
import { createProofAttestation, verifyProofAttestation } from "../src/core/proof-signature.js";
import { scanPublicSurface } from "../src/core/public-safety-scan.js";
import { exportTraceFixture, supportedTraceSources } from "../src/core/trace-export.js";
import { renderAgentProofReport, renderScanReport } from "../src/report/markdown-report.js";
import { createProofBundle } from "../src/report/proof-bundle.js";
import { renderProofDashboard } from "../src/report/dashboard.js";
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
  GATE_COVERAGE: "gate_coverage",
  PROOF_ATTESTATION: "proof_attestation",
  PROOF_DASHBOARD: "proof_dashboard"
};

const generatedArtifacts = {
  [ArtifactName.REPORT]: "docs/generated/sample-agent-proof-report.md",
  [ArtifactName.PROOF_BUNDLE]: "docs/generated/proof-bundle.json",
  [ArtifactName.SARIF]: "docs/generated/sample-agent-proof.sarif",
  [ArtifactName.NORMALIZED_RUN]: "docs/generated/normalized-agent-run.json",
  [ArtifactName.REGRESSION_DIFF]: "docs/generated/sample-agent-run-diff.json",
  [ArtifactName.GATE_COVERAGE]: "docs/generated/gate-coverage.md",
  [ArtifactName.PROOF_ATTESTATION]: "docs/generated/proof-bundle.attestation.json",
  [ArtifactName.PROOF_DASHBOARD]: "docs/generated/proof-dashboard.html"
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
        "bytefence_check",
        "bytefence_apply",
        "agent_proof_verify_run",
        "agent_proof_scan_surface",
        "agent_proof_compile_policy",
        "agent_proof_export_trace",
        "agent_proof_diff_runs",
        "agent_proof_create_bundle",
        "agent_proof_sign_bundle",
        "agent_proof_verify_bundle_signature",
        "agent_proof_render_dashboard",
        "agent_proof_read_artifact"
      ]
    };

    return response_format === ResponseFormat.JSON ? JSON.stringify(info, null, 2) : renderStatus(info);
  })
);

server.registerTool(
  "bytefence_check",
  {
    title: "Check a ByteFence Exact Replacement",
    description: `Check proposed raw candidate bytes against a ByteFence exactReplace intent without modifying the workspace.

Intent, policy, target and candidate are read as bytes under the configured workspace root. The response contains only decision metadata and digests; it never returns source bytes, prompts or tool arguments.`,
    inputSchema: z.object({
      intent_path: z.string().min(1).max(500)
        .describe("ByteFence intent JSON path under the workspace root."),
      policy_path: z.string().min(1).max(500)
        .describe("ByteFence policy JSON path under the workspace root."),
      candidate_path: z.string().min(1).max(500)
        .describe("Raw candidate file path under the workspace root."),
      workspace_id: z.string().min(1).max(1024)
        .describe("Stable caller-defined workspace identifier. Only its digest enters a public receipt.")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ intent_path, policy_path, candidate_path, workspace_id }) => toToolResult(() => {
    const intentBytes = readByteFenceWorkspaceFile(
      intent_path,
      BYTEFENCE_MAX_INTENT_BYTES
    ).bytes;
    const policyBytes = readByteFenceWorkspaceFile(
      policy_path,
      BYTEFENCE_MAX_POLICY_BYTES
    ).bytes;
    const policy = parseByteFencePolicy(policyBytes);
    const candidate = readByteFenceWorkspaceFile(
      candidate_path,
      policy.maxTargetBytes
    ).bytes;
    const intent = parseByteFenceIntent(intentBytes);
    const target = inspectByteFenceTarget({
      root: workspaceRoot,
      targetPath: intent.targetPath
    });
    const preimage = readByteFenceTarget(target, {
      maxBytes: policy.maxTargetBytes
    }).bytes;
    const evaluation = evaluateByteFence({
      preimage,
      candidate,
      intentBytes,
      policyBytes,
      workspaceId: workspace_id,
      observedAt: new Date().toISOString(),
      receiptProfile: "public"
    });

    return JSON.stringify(summarizeByteFenceResult(evaluation, {
      receipt: evaluation.statement ?? null,
      receiptDigest: evaluation.receiptBytes
        ? digestByteFenceReceipt(evaluation.receiptBytes)
        : null
    }), null, 2);
  })
);

server.registerTool(
  "bytefence_apply",
  {
    title: "Apply a ByteFence Exact Replacement",
    description: `Apply one ByteFence exactReplace transaction and create one immutable public receipt.

This tool owns the mediated write. It calls the transaction engine exactly once and never retries, including after an unknown or committed-unreceipted state. Intent, policy, target and receipt paths remain confined to the configured workspace root. The response contains no source bytes, prompts or tool arguments.`,
    inputSchema: z.object({
      intent_path: z.string().min(1).max(500)
        .describe("ByteFence intent JSON path under the workspace root."),
      policy_path: z.string().min(1).max(500)
        .describe("ByteFence policy JSON path under the workspace root."),
      workspace_id: z.string().min(1).max(1024)
        .describe("Stable caller-defined workspace identifier. Only its digest enters the public receipt."),
      receipt_path: z.string().min(1).max(500)
        .describe("Fresh receipt path under the workspace root. Its parent directory must already exist.")
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ intent_path, policy_path, workspace_id, receipt_path }) => toToolResult(() => {
    const intentBytes = readByteFenceWorkspaceFile(
      intent_path,
      BYTEFENCE_MAX_INTENT_BYTES
    ).bytes;
    const policyBytes = readByteFenceWorkspaceFile(
      policy_path,
      BYTEFENCE_MAX_POLICY_BYTES
    ).bytes;
    const result = applyByteFenceTransaction({
      root: workspaceRoot,
      intentBytes,
      policyBytes,
      workspaceId: workspace_id,
      observedAt: new Date().toISOString(),
      receiptProfile: "public",
      receiptPath: receipt_path
    });

    return JSON.stringify(summarizeByteFenceResult(result, {
      receiptDigest: result.receiptDigest ?? null,
      receiptPersisted: result.receiptPersisted === true,
      retryAutomatically: false
    }), null, 2);
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
    const evaluation = evaluateAgentRun(readJson(inputRef.path), loadPolicyFile(policyRef.path), {
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
    const parsedPolicy = loadPolicyFile(policyRef.path);
    parsedPolicy.privateTerms = [...new Set([...(parsedPolicy.privateTerms ?? []), ...(private_terms ?? [])])];
    const scan = scanPublicSurface(scanPath.path, parsedPolicy, {
      rootDir: scanPath.path,
      displayRoot: scanPath.displayPath
    });

    return formatScan(scan, response_format);
  })
);

server.registerTool(
  "agent_proof_compile_policy",
  {
    title: "Compile Policy Definition",
    description: `Compile a YAML or JSON policy definition into the public Agent Proof Kit policy contract.

Use this when a team has a YAML policy DSL file or wants an assistant to inspect the exact compiled gates, action risks, score threshold and scan limits before verification.`,
    inputSchema: z.object({
      input: z.string().min(1).max(500)
        .optional()
        .describe("Policy YAML or JSON path under the workspace root. Omit to use the bundled YAML policy example."),
      write_path: z.string().min(1).max(500)
        .optional()
        .describe("Optional fresh compiled policy JSON path under the workspace root. Parent directories are created; existing paths are refused."),
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
  async ({ input, write_path, response_format }) => toToolResult(() => {
    const inputRef = resolveInput(input, "examples/policies/strict-corporate-policy.yaml", "input");
    const policy = compilePolicyDefinition(readPolicyDefinition(inputRef.path));
    let writtenTo = null;
    if (write_path) {
      const out = resolveWorkspaceWritePath(write_path, "write_path");
      writeFreshWorkspaceArtifact(out, `${JSON.stringify(policy, null, 2)}\n`);
      writtenTo = out.displayPath;
    }

    if (response_format === ResponseFormat.JSON) {
      return JSON.stringify({ input: inputRef.displayPath, writtenTo, policy }, null, 2);
    }

    return `# Compiled Agent Proof Policy

- Input: \`${inputRef.displayPath}\`
- Policy ID: ${policy.id}
- Minimum score: ${policy.minimumScore}
- Max scanned file bytes: ${policy.maxScannedFileBytes}
- Gates: ${Object.keys(policy.gates ?? {}).length}
- Action risk rules: ${Object.keys(policy.actionRisk ?? {}).length}
${writtenTo ? `- Written to: \`${writtenTo}\`` : "- Written to: not requested"}
`;
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
        .describe(`Trace source shape. Supported values: ${supportedTraceSources.join(", ")}.`),
      input: z.string().min(1).max(500)
        .describe("Trace JSONL path under the workspace root."),
      redact_terms: z.array(z.string().min(1).max(200))
        .max(100)
        .default([])
        .describe("Sensitive terms to replace with [redacted-term-N] placeholders in string values."),
      write_path: z.string().min(1).max(500)
        .optional()
        .describe("Optional fresh output JSON path under the workspace root. Parent directories are created; existing paths are refused."),
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
      writeFreshWorkspaceArtifact(out, `${JSON.stringify(exported.run, null, 2)}\n`);
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
    const diff = diffAgentRuns(readJson(baseRef.path), readJson(candidateRef.path), loadPolicyFile(policyRef.path), {
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
        .describe("Optional fresh output JSON path under the workspace root. Parent directories are created; existing paths are refused."),
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
    const parsedPolicy = loadPolicyFile(policyRef.path);
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
      writeFreshWorkspaceArtifact(out, `${JSON.stringify(bundle, null, 2)}\n`);
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
  "agent_proof_sign_bundle",
  {
    title: "Sign Proof Bundle",
    description: `Create a detached proof-bundle attestation with a canonical SHA-256 digest and, optionally, an RSA-SHA256 signature.

Use this after creating or receiving a proof bundle. Provide private_key only when the user explicitly wants local cryptographic signing; otherwise the tool creates a digest-only attestation.`,
    inputSchema: z.object({
      bundle: z.string().min(1).max(500)
        .optional()
        .describe("Proof bundle JSON path under the workspace root. Omit to use the bundled sample proof bundle."),
      private_key: z.string().min(1).max(500)
        .optional()
        .describe("Optional RSA private key PEM path under the workspace root for cryptographic signing."),
      write_path: z.string().min(1).max(500)
        .optional()
        .describe("Optional fresh attestation JSON path under the workspace root. Parent directories are created; existing paths are refused."),
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
  async ({ bundle, private_key, write_path, response_format }) => toToolResult(() => {
    const bundleRef = resolveInput(bundle, "docs/generated/proof-bundle.json", "bundle");
    const privateKeyRef = private_key ? resolveWorkspacePath(private_key, "private_key") : null;
    const attestation = createProofAttestation(readJson(bundleRef.path), {
      privateKeyPem: privateKeyRef ? readFileSync(privateKeyRef.path, "utf8") : null
    });
    let writtenTo = null;
    if (write_path) {
      const out = resolveWorkspaceWritePath(write_path, "write_path");
      writeFreshWorkspaceArtifact(out, `${JSON.stringify(attestation, null, 2)}\n`);
      writtenTo = out.displayPath;
    }

    if (response_format === ResponseFormat.JSON) {
      return JSON.stringify({ bundle: bundleRef.displayPath, writtenTo, attestation }, null, 2);
    }

    return `# Proof Bundle Attestation

- Bundle: \`${bundleRef.displayPath}\`
- Digest: \`${attestation.digest.value}\`
- Signature: ${attestation.signature ? attestation.signature.algorithm : "not present"}
${writtenTo ? `- Written to: \`${writtenTo}\`` : "- Written to: not requested"}
`;
  })
);

server.registerTool(
  "agent_proof_verify_bundle_signature",
  {
    title: "Verify Proof Bundle Attestation",
    description: `Verify that a detached attestation matches a proof bundle digest and, when a public key is provided, validate the RSA-SHA256 signature.

Use this before trusting a checked-in proof bundle or CI artifact.`,
    inputSchema: z.object({
      bundle: z.string().min(1).max(500)
        .optional()
        .describe("Proof bundle JSON path under the workspace root. Omit to use the bundled sample proof bundle."),
      attestation: z.string().min(1).max(500)
        .optional()
        .describe("Attestation JSON path under the workspace root. Omit to use the bundled sample attestation."),
      public_key: z.string().min(1).max(500)
        .optional()
        .describe("Optional RSA public key PEM path under the workspace root for signature verification."),
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN])
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
  async ({ bundle, attestation, public_key, response_format }) => toToolResult(() => {
    const bundleRef = resolveInput(bundle, "docs/generated/proof-bundle.json", "bundle");
    const attestationRef = resolveInput(attestation, "docs/generated/proof-bundle.attestation.json", "attestation");
    const publicKeyRef = public_key ? resolveWorkspacePath(public_key, "public_key") : null;
    const result = verifyProofAttestation(readJson(bundleRef.path), readJson(attestationRef.path), {
      publicKeyPem: publicKeyRef ? readFileSync(publicKeyRef.path, "utf8") : null
    });

    if (response_format === ResponseFormat.JSON) {
      return JSON.stringify({
        bundle: bundleRef.displayPath,
        attestation: attestationRef.displayPath,
        result
      }, null, 2);
    }

    return `# Proof Bundle Attestation Verification

Status: **${result.status.toUpperCase()}**

- Bundle: \`${bundleRef.displayPath}\`
- Attestation: \`${attestationRef.displayPath}\`
- Digest: ${result.digestMatches ? "match" : "mismatch"}
- Signature: ${result.signatureVerified === null ? "not present" : result.signatureVerified ? "valid" : "invalid"}
- Findings: ${result.findings.length}
`;
  })
);

server.registerTool(
  "agent_proof_render_dashboard",
  {
    title: "Render Proof Dashboard",
    description: `Render a local HTML dashboard from a proof bundle, gate coverage matrix and optional attestation.

Use this when a team wants a reviewable proof artifact for pull requests, release notes or local inspection. The tool writes HTML only when write_path is provided.`,
    inputSchema: z.object({
      bundle: z.string().min(1).max(500)
        .optional()
        .describe("Proof bundle JSON path under the workspace root. Omit to use the bundled sample proof bundle."),
      coverage: z.string().min(1).max(500)
        .optional()
        .describe("Gate coverage Markdown path under the workspace root. Omit to use the bundled sample coverage matrix."),
      attestation: z.string().min(1).max(500)
        .optional()
        .describe("Optional attestation JSON path under the workspace root. Omit to use the bundled sample attestation."),
      write_path: z.string().min(1).max(500)
        .optional()
        .describe("Optional fresh dashboard HTML path under the workspace root. Parent directories are created; existing paths are refused."),
      response_format: z.enum([ResponseFormat.JSON, ResponseFormat.MARKDOWN, "html"])
        .default(ResponseFormat.MARKDOWN)
        .describe("Output format. Use html only when the caller explicitly needs raw HTML in the response.")
    }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ bundle, coverage, attestation, write_path, response_format }) => toToolResult(() => {
    const bundleRef = resolveInput(bundle, "docs/generated/proof-bundle.json", "bundle");
    const coverageRef = resolveInput(coverage, "docs/generated/gate-coverage.md", "coverage");
    const attestationRef = resolveInput(attestation, "docs/generated/proof-bundle.attestation.json", "attestation");
    const html = renderProofDashboard({
      bundle: readJson(bundleRef.path),
      gateCoverageMarkdown: readFileSync(coverageRef.path, "utf8"),
      attestation: readJson(attestationRef.path)
    });
    let writtenTo = null;
    if (write_path) {
      const out = resolveWorkspaceWritePath(write_path, "write_path");
      writeFreshWorkspaceArtifact(out, html);
      writtenTo = out.displayPath;
    }

    if (response_format === "html") return html;
    if (response_format === ResponseFormat.JSON) {
      return JSON.stringify({
        bundle: bundleRef.displayPath,
        coverage: coverageRef.displayPath,
        attestation: attestationRef.displayPath,
        writtenTo,
        bytes: Buffer.byteLength(html)
      }, null, 2);
    }

    return `# Agent Proof Dashboard

- Bundle: \`${bundleRef.displayPath}\`
- Coverage: \`${coverageRef.displayPath}\`
- Attestation: \`${attestationRef.displayPath}\`
- HTML bytes: ${Buffer.byteLength(html)}
${writtenTo ? `- Written to: \`${writtenTo}\`` : "- Written to: not requested"}
`;
  })
);

server.registerTool(
  "agent_proof_read_artifact",
  {
    title: "Read Generated Proof Artifact",
    description: `Read one checked-in generated proof artifact bundled with Agent Proof Kit.

Use this when an assistant needs to inspect the sample report, SARIF export, proof bundle, attestation, dashboard, normalized run, regression diff, or gate coverage matrix without guessing file paths.`,
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

\`\`\`${artifactLanguage(path)}
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

function readByteFenceWorkspaceFile(relativePath, maxBytes) {
  const target = inspectByteFenceTarget({
    root: workspaceRoot,
    targetPath: relativePath
  });
  return readByteFenceTarget(target, { maxBytes });
}

function summarizeByteFenceResult(result, extra = {}) {
  return {
    status: result?.status ?? "invalid",
    allowed: result?.allowed === true,
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 2,
    declaredGuaranteeLevel: result?.declaredGuaranteeLevel ?? null,
    effectiveGuaranteeLevel: result?.effectiveGuaranteeLevel ?? "OUT_OF_SCOPE",
    mediationEnvironmentTrusted: result?.mediationEnvironmentTrusted === true,
    publicProfileConformant: result?.publicProfileConformant ?? null,
    phase: result?.phase ?? "preflight",
    operationId: result?.operationId ?? null,
    preimageDigest: result?.preimageDigest ?? null,
    candidateDigest: result?.candidateDigest ?? null,
    manifestDigest: result?.manifestDigest ?? null,
    checks: result?.checks ?? null,
    findings: (result?.findings ?? []).map((finding) => ({
      code: finding.id,
      severity: finding.severity,
      location: finding.location
    })),
    ...extra
  };
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
    displayPath: relative(workspaceRoot, path) || ".",
    label
  };
}

function writeFreshWorkspaceArtifact(output, bytes) {
  const parent = dirname(output.path);
  mkdirSync(parent, { recursive: true });
  assertInsideWorkspace(parent, output.label);

  let descriptor;
  let createdStat;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0;
    descriptor = openSync(
      output.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    );
    createdStat = fstatSync(descriptor, { bigint: true });
    if (!createdStat.isFile() || createdStat.nlink !== 1n) {
      throw new Error("The output is not a uniquely linked regular file.");
    }

    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    createdStat = fstatSync(descriptor, { bigint: true });
    if (!createdStat.isFile() || createdStat.nlink !== 1n) {
      throw new Error("The output identity changed while it was being written.");
    }
    closeSync(descriptor);
    descriptor = undefined;

    const pathStat = lstatSync(output.path, { bigint: true });
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.nlink !== 1n ||
      !sameFileIdentity(createdStat, pathStat)
    ) {
      throw new Error("The output identity changed while it was being written.");
    }
    assertInsideWorkspace(output.path, output.label);
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original closed failure remains authoritative.
      }
    }
    removeOwnedWorkspaceArtifact(output.path, createdStat);
    throw new Error(
      `${output.label} must name a fresh regular file under the workspace root.`
    );
  }
}

function removeOwnedWorkspaceArtifact(path, createdStat) {
  if (!createdStat) return;
  try {
    const current = lstatSync(path, { bigint: true });
    if (!current.isSymbolicLink() && sameFileIdentity(createdStat, current)) {
      unlinkSync(path);
    }
  } catch {
    // Cleanup is identity-checked and best effort; the operation still fails.
  }
}

function sameFileIdentity(left, right) {
  const leftDev = String(left.dev);
  const leftIno = String(left.ino);
  const rightDev = String(right.dev);
  const rightIno = String(right.ino);
  if (leftDev === "0" && leftIno === "0" && rightDev === "0" && rightIno === "0") {
    return false;
  }
  return leftDev === rightDev && leftIno === rightIno;
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

function artifactLanguage(path) {
  if (path.endsWith(".json") || path.endsWith(".sarif")) return "json";
  if (path.endsWith(".html")) return "html";
  return "markdown";
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
