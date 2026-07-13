#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BYTEFENCE_MAX_INTENT_BYTES,
  BYTEFENCE_MAX_POLICY_BYTES,
  BYTEFENCE_MAX_RECEIPT_BYTES,
  BYTEFENCE_MAX_TARGET_BYTES,
  ByteFenceContractError,
  parseByteFenceIntent,
  parseByteFencePolicy,
  sha256Hex
} from "../src/core/bytefence-contract.js";
import {
  ByteFenceApplyError,
  applyByteFenceTransaction,
  persistByteFenceReceipt
} from "../src/core/bytefence-apply.js";
import { evaluateByteFence } from "../src/core/bytefence-evaluate.js";
import {
  ByteFencePathError,
  inspectByteFenceTarget,
  readByteFenceTarget
} from "../src/core/bytefence-path.js";
import { receiptDigest, verifyByteFenceReceipt } from "../src/core/bytefence-receipt.js";
import { diffAgentRuns } from "../src/core/diff-agent-runs.js";
import { evaluateAgentRun } from "../src/core/evaluate-agent-run.js";
import { normalizeJsonlTrace } from "../src/core/normalize-jsonl.js";
import { compilePolicyDefinition, loadPolicyFile, readPolicyDefinition } from "../src/core/policy-loader.js";
import { createProofAttestation, verifyProofAttestation } from "../src/core/proof-signature.js";
import { exportTraceFixture, supportedTraceSources } from "../src/core/trace-export.js";
import { scanPublicSurface } from "../src/core/public-safety-scan.js";
import { validateAgentRun, validatePolicy } from "../src/core/validate-agent-run.js";
import { renderAgentProofReport, renderScanReport } from "../src/report/markdown-report.js";
import { createProofBundle } from "../src/report/proof-bundle.js";
import { renderProofDashboard } from "../src/report/dashboard.js";
import { renderSarif } from "../src/report/sarif-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const BYTEFENCE_READ_CHUNK_BYTES = 64 * 1024;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function packageVersion() {
  return readJson(resolve(rootDir, "package.json")).version;
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      flags.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { command: positionals[0] ?? "help", flags };
}

function usage() {
  return `agent-proof

Deterministic release gates for synthetic AI-agent runs.

Commands:
  verify    --input <file> --policy <file> [--format text|json|markdown|sarif] [--out <file>]
  scan      --path <dir>   --policy <file> [--format text|json|markdown|sarif] [--out <file>]
  validate  --input <file> [--policy <file>] [--format text|json]
  compile-policy --input <yaml|json> [--out <file>]
  normalize --input <jsonl> [--out <file>]
  adapt     --input <jsonl> [--out <file>]
  export    --from <source> --input <jsonl> [--redact-terms <term,term>] [--out <file>]
  diff      --base <file> --candidate <file> --policy <file> [--format text|json|markdown|sarif] [--out <file>]
  bundle    --input <file> --policy <file> --scan-path <dir> --out <file>
  sign-bundle --bundle <file> [--private-key <pem>] [--out <file>]
  verify-bundle-signature --bundle <file> --signature <file> [--public-key <pem>] [--format text|json]
  dashboard --bundle <file> [--coverage <md>] [--attestation <json>] [--out <html>]
  serve --bundle <file> [--coverage <md>] [--attestation <json>] [--port <port>]
  report --input <file> --policy <file> --out <file>
  bytefence-check --target <relative-file> --candidate <file> --intent <file> --policy <file> --workspace-id <id> --root <dir> [--receipt-profile public|local] [--observed-at <UTC>] [--out <file>]
  bytefence-verify --receipt <file> --before <file> --candidate <file> --intent <file> --policy <file> --workspace-id <id> --root <dir>
  bytefence-apply --intent <file> --policy <file> --workspace-id <id> --root <dir> --out <fresh-file> [--receipt-profile public|local] [--observed-at <UTC>]

Examples:
  agent-proof verify --input examples/synthetic-agent-run.json --policy policies/default-policy.json
  agent-proof scan --path . --policy policies/default-policy.json
  agent-proof compile-policy --input examples/policies/strict-corporate-policy.yaml --out compiled-policy.json
  agent-proof export --from langgraph-stream --input examples/adapters/langgraph-stream.json --out exported-agent-run.json
  agent-proof sign-bundle --bundle docs/generated/proof-bundle.json --out proof-bundle.attestation.json
  agent-proof dashboard --bundle docs/generated/proof-bundle.json --coverage docs/generated/gate-coverage.md --attestation docs/generated/proof-bundle.attestation.json --out proof-dashboard.html
  agent-proof report --input examples/synthetic-agent-run.json --policy policies/default-policy.json --out docs/generated/sample-agent-proof-report.md
`;
}

function requireFlag(flags, name) {
  if (!flags[name]) {
    throw new Error(`Missing required flag: --${name}`);
  }
  return String(flags[name]);
}

function writeOutput(payload, flags, stdout) {
  if (flags.out) {
    const outPath = resolve(String(flags.out));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, payload);
    stdout.write(`wrote ${outPath}\n`);
    return;
  }

  stdout.write(payload);
  if (!payload.endsWith("\n")) stdout.write("\n");
}

function formatEvaluation(result, flags) {
  const format = flags.format ?? "text";
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    return renderAgentProofReport(result);
  }
  if (format === "sarif") {
    return `${renderSarif(result, { defaultArtifact: result.inputPath ?? "agent-run.json" })}\n`;
  }
  if (format !== "text") {
    throw new Error(`Unsupported format: ${format}`);
  }

  return `${result.status.toUpperCase()} score=${result.score} findings=${result.findings.length} run=${result.runId}\n`;
}

function formatScan(result, flags) {
  const format = flags.format ?? "text";
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    return renderScanReport(result);
  }
  if (format === "sarif") {
    return `${renderSarif(result, { defaultArtifact: result.rootPath ?? "." })}\n`;
  }
  if (format !== "text") {
    throw new Error(`Unsupported format: ${format}`);
  }

  return `${result.status.toUpperCase()} files=${result.filesScanned} findings=${result.findings.length}\n`;
}

function formatValidation(result, flags) {
  const format = flags.format ?? "text";
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format !== "text") {
    throw new Error(`Unsupported format: ${format}`);
  }
  return `${result.status.toUpperCase()} findings=${result.findings.length}\n`;
}

function formatDiff(result, flags) {
  const format = flags.format ?? "text";
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    const rows = result.newFindings.length
      ? result.newFindings.map((finding) => `| ${finding.severity} | ${finding.id} | \`${finding.location}\` |`).join("\n")
      : "| none | none | none |";
    return `# Agent Run Diff

Status: **${result.status.toUpperCase()}**

Score delta: **${result.scoreDelta}**

${result.summary}

| Severity | Finding | Location |
| --- | --- | --- |
${rows}
`;
  }
  if (format === "sarif") {
    return `${renderSarif({ findings: result.newFindings }, {
      defaultArtifact: result.candidate?.inputPath ?? "candidate-agent-run.json"
    })}\n`;
  }
  if (format !== "text") {
    throw new Error(`Unsupported format: ${format}`);
  }
  return `${result.status.toUpperCase()} scoreDelta=${result.scoreDelta} newFindings=${result.newFindings.length}\n`;
}

export async function main(argv = process.argv.slice(2), io = process) {
  const { command, flags } = parseArgs(argv);

  if (flags.help || command === "help") {
    io.stdout.write(usage());
    return 0;
  }

  if (command === "bytefence-check") {
    return runByteFenceCommand(() => byteFenceCheck(flags), io.stdout);
  }

  if (command === "bytefence-verify") {
    return runByteFenceCommand(() => byteFenceVerify(flags), io.stdout);
  }

  if (command === "bytefence-apply") {
    return runByteFenceCommand(() => byteFenceApply(flags), io.stdout);
  }

  if (command === "verify") {
    const inputPath = resolve(requireFlag(flags, "input"));
    const policyPath = resolve(requireFlag(flags, "policy"));
    const result = evaluateAgentRun(readJson(inputPath), loadPolicyFile(policyPath), {
      inputPath,
      policyPath
    });
    writeOutput(formatEvaluation(result, flags), flags, io.stdout);
    return result.status === "pass" ? 0 : 1;
  }

  if (command === "validate") {
    const inputPath = resolve(requireFlag(flags, "input"));
    const runValidation = validateAgentRun(readJson(inputPath));
    const policyValidation = flags.policy ? validatePolicy(loadPolicyFile(resolve(String(flags.policy)))) : { status: "pass", findings: [] };
    const result = {
      status: runValidation.status === "pass" && policyValidation.status === "pass" ? "pass" : "fail",
      findings: [...runValidation.findings, ...policyValidation.findings]
    };
    writeOutput(formatValidation(result, flags), flags, io.stdout);
    return result.status === "pass" ? 0 : 2;
  }

  if (command === "compile-policy") {
    const inputPath = resolve(requireFlag(flags, "input"));
    const policy = compilePolicyDefinition(readPolicyDefinition(inputPath));
    writeOutput(`${JSON.stringify(policy, null, 2)}\n`, flags, io.stdout);
    return 0;
  }

  if (command === "normalize" || command === "adapt") {
    const inputPath = resolve(requireFlag(flags, "input"));
    const run = normalizeJsonlTrace(readText(inputPath));
    writeOutput(`${JSON.stringify(run, null, 2)}\n`, flags, io.stdout);
    return 0;
  }

  if (command === "export") {
    const inputPath = resolve(requireFlag(flags, "input"));
    const source = String(flags.from ?? "agent-proof-jsonl");
    if (!supportedTraceSources.includes(source)) {
      throw new Error(`Unsupported --from value: ${source}. Supported values: ${supportedTraceSources.join(", ")}`);
    }
    const result = exportTraceFixture(readText(inputPath), {
      source,
      redactTerms: splitList(flags["redact-terms"])
    });
    writeOutput(`${JSON.stringify(result.run, null, 2)}\n`, flags, io.stdout);
    return 0;
  }

  if (command === "scan") {
    const scanPath = resolve(requireFlag(flags, "path"));
    const policyPath = resolve(requireFlag(flags, "policy"));
    const result = scanPublicSurface(scanPath, loadPolicyFile(policyPath), {
      rootDir: scanPath
    });
    writeOutput(formatScan(result, flags), flags, io.stdout);
    return result.status === "pass" ? 0 : 1;
  }

  if (command === "diff") {
    const baselineArg = requireFlag(flags, "base");
    const candidateArg = requireFlag(flags, "candidate");
    const policyArg = requireFlag(flags, "policy");
    const baselinePath = resolve(baselineArg);
    const candidatePath = resolve(candidateArg);
    const policyPath = resolve(policyArg);
    const result = diffAgentRuns(readJson(baselinePath), readJson(candidatePath), loadPolicyFile(policyPath), {
      baselinePath: baselineArg,
      candidatePath: candidateArg,
      policyPath: policyArg
    });
    writeOutput(formatDiff(result, flags), flags, io.stdout);
    return result.status === "pass" ? 0 : 1;
  }

  if (command === "bundle") {
    const inputPath = resolve(requireFlag(flags, "input"));
    const policyPath = resolve(requireFlag(flags, "policy"));
    const scanPath = resolve(requireFlag(flags, "scan-path"));
    const outPath = resolve(requireFlag(flags, "out"));
    const policy = loadPolicyFile(policyPath);
    const evaluation = evaluateAgentRun(readJson(inputPath), policy, {
      inputPath,
      policyPath
    });
    const scan = scanPublicSurface(scanPath, policy, {
      rootDir: scanPath
    });
    const bundle = createProofBundle({
      evaluation,
      scan,
      metadata: {
        version: packageVersion(),
        generatedAt: new Date().toISOString(),
        command: `agent-proof bundle --input ${flags.input} --policy ${flags.policy} --scan-path ${flags["scan-path"]}`
      }
    });
    writeOutput(`${JSON.stringify(bundle, null, 2)}\n`, { out: outPath }, io.stdout);
    return bundle.status === "pass" ? 0 : 1;
  }

  if (command === "sign-bundle") {
    const bundlePath = resolve(requireFlag(flags, "bundle"));
    const privateKeyPath = flags["private-key"] ? resolve(String(flags["private-key"])) : null;
    const attestation = createProofAttestation(readJson(bundlePath), {
      privateKeyPem: privateKeyPath ? readText(privateKeyPath) : null
    });
    writeOutput(`${JSON.stringify(attestation, null, 2)}\n`, flags, io.stdout);
    return 0;
  }

  if (command === "verify-bundle-signature") {
    const bundlePath = resolve(requireFlag(flags, "bundle"));
    const signaturePath = resolve(requireFlag(flags, "signature"));
    const publicKeyPath = flags["public-key"] ? resolve(String(flags["public-key"])) : null;
    const result = verifyProofAttestation(readJson(bundlePath), readJson(signaturePath), {
      publicKeyPem: publicKeyPath ? readText(publicKeyPath) : null
    });
    if (flags.format === "json") {
      writeOutput(`${JSON.stringify(result, null, 2)}\n`, flags, io.stdout);
    } else {
      writeOutput(`${result.status.toUpperCase()} digest=${result.digestMatches ? "match" : "mismatch"} signature=${result.signatureVerified === null ? "not_present" : result.signatureVerified ? "valid" : "invalid"}\n`, flags, io.stdout);
    }
    return result.status === "pass" ? 0 : 1;
  }

  if (command === "dashboard") {
    const html = buildDashboardHtml(flags);
    writeOutput(html, flags, io.stdout);
    return 0;
  }

  if (command === "serve") {
    const html = buildDashboardHtml(flags);
    const port = Number(flags.port ?? 8787);
    const server = createServer((request, response) => {
      if (request.url !== "/" && request.url !== "/index.html") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    });
    await new Promise((resolveListen) => {
      server.listen(port, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    io.stdout.write(`serving http://127.0.0.1:${address.port}\n`);
    return new Promise(() => {});
  }

  if (command === "report") {
    const inputPath = resolve(requireFlag(flags, "input"));
    const policyPath = resolve(requireFlag(flags, "policy"));
    const outPath = resolve(requireFlag(flags, "out"));
    const result = evaluateAgentRun(readJson(inputPath), loadPolicyFile(policyPath), {
      inputPath,
      policyPath
    });
    writeOutput(renderAgentProofReport(result), { out: outPath }, io.stdout);
    return result.status === "pass" ? 0 : 1;
  }

  throw new Error(`Unknown command: ${command}`);
}

export { rootDir };

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildDashboardHtml(flags) {
  const bundlePath = resolve(requireFlag(flags, "bundle"));
  const coveragePath = flags.coverage ? resolve(String(flags.coverage)) : null;
  const attestationPath = flags.attestation ? resolve(String(flags.attestation)) : null;
  return renderProofDashboard({
    bundle: readJson(bundlePath),
    gateCoverageMarkdown: coveragePath ? readText(coveragePath) : null,
    attestation: attestationPath ? readJson(attestationPath) : null
  });
}

class ByteFenceCliError extends Error {
  constructor(code, message, location = "cli") {
    super(message);
    this.name = "ByteFenceCliError";
    this.code = code;
    this.location = location;
  }
}

function byteFenceCheck(flags) {
  assertByteFenceFlags(flags, new Set([
    "target",
    "candidate",
    "intent",
    "policy",
    "workspace-id",
    "root",
    "receipt-profile",
    "observed-at",
    "out"
  ]));

  const targetPath = requireByteFenceFlag(flags, "target");
  const candidatePath = requireByteFenceFlag(flags, "candidate");
  const intentBytes = readByteFenceInput(
    requireByteFenceFlag(flags, "intent"),
    "intent",
    BYTEFENCE_MAX_INTENT_BYTES
  );
  const intent = parseByteFenceIntent(intentBytes);
  if (targetPath !== intent.targetPath) {
    throw new ByteFenceCliError(
      "cli.targetIntentMismatch",
      "The --target value must exactly match the validated intent targetPath.",
      "--target"
    );
  }

  const root = readByteFenceRoot(requireByteFenceFlag(flags, "root"));
  const policyBytes = readByteFenceInput(
    requireByteFenceFlag(flags, "policy"),
    "policy",
    BYTEFENCE_MAX_POLICY_BYTES
  );
  const policy = parseByteFencePolicy(policyBytes);
  const targetLimit = Math.min(policy.maxTargetBytes, BYTEFENCE_MAX_TARGET_BYTES);
  const workspaceId = requireByteFenceFlag(flags, "workspace-id");
  const receiptProfile = readByteFenceReceiptProfile(flags);
  const observedAt = optionalByteFenceFlag(flags, "observed-at") ?? new Date().toISOString();
  const target = inspectByteFenceTarget({ root, targetPath });
  if (target.stat.size > targetLimit) {
    return byteFencePolicySizeDenial({
      id: "change.targetTooLarge",
      title: "The target exceeds maxTargetBytes.",
      receiptProfile
    });
  }
  const before = readByteFenceTarget(target, { maxBytes: targetLimit }).bytes;
  const candidateInput = inspectByteFenceInput(candidatePath, "candidate");
  if (candidateInput.stat.size > targetLimit) {
    return byteFencePolicySizeDenial({
      id: "change.candidateTooLarge",
      title: "The candidate exceeds maxTargetBytes.",
      receiptProfile
    });
  }
  const candidate = readByteFenceInput(
    candidatePath,
    "candidate",
    BYTEFENCE_MAX_TARGET_BYTES
  );
  const result = evaluateByteFence({
    preimage: before,
    candidate,
    intentBytes,
    policyBytes,
    workspaceId,
    observedAt,
    receiptProfile
  });

  let artifact;
  if (flags.out !== undefined && result.receiptBytes) {
    const outPath = resolveByteFenceReceiptOutput(
      root,
      requireByteFenceFlag(flags, "out")
    );
    try {
      persistByteFenceReceipt({
        path: outPath,
        bytes: result.receiptBytes,
        mode: receiptProfile === "local" ? 0o600 : 0o644
      });
    } catch {
      throw new ByteFenceCliError(
        "cli.receiptPersistFailed",
        "The preflight receipt could not be persisted immutably.",
        "--out"
      );
    }
    artifact = { sha256: receiptDigest(result.receiptBytes) };
  }

  return {
    code: result.exitCode,
    payload: byteFenceMachineResult(result, {
      receiptProfile,
      ...(artifact ? { artifact } : {}),
      ...(!flags.out && result.statement ? { receipt: result.statement } : {})
    })
  };
}

function byteFenceVerify(flags) {
  assertByteFenceFlags(flags, new Set([
    "receipt",
    "before",
    "candidate",
    "intent",
    "policy",
    "workspace-id",
    "root"
  ]));

  readByteFenceRoot(requireByteFenceFlag(flags, "root"));
  const policyBytes = readByteFenceInput(
    requireByteFenceFlag(flags, "policy"),
    "policy",
    BYTEFENCE_MAX_POLICY_BYTES
  );
  const policy = parseByteFencePolicy(policyBytes);
  const targetLimit = Math.min(policy.maxTargetBytes, BYTEFENCE_MAX_TARGET_BYTES);
  const intentBytes = readByteFenceInput(
    requireByteFenceFlag(flags, "intent"),
    "intent",
    BYTEFENCE_MAX_INTENT_BYTES
  );
  parseByteFenceIntent(intentBytes);
  const beforePath = requireByteFenceFlag(flags, "before");
  const candidatePath = requireByteFenceFlag(flags, "candidate");
  const beforeInput = inspectByteFenceInput(beforePath, "before");
  if (beforeInput.stat.size > targetLimit) {
    return byteFencePolicySizeDenial({
      id: "change.targetTooLarge",
      title: "The preserved preimage exceeds maxTargetBytes.",
      verification: true
    });
  }
  const candidateInput = inspectByteFenceInput(candidatePath, "candidate");
  if (candidateInput.stat.size > targetLimit) {
    return byteFencePolicySizeDenial({
      id: "change.candidateTooLarge",
      title: "The candidate exceeds maxTargetBytes.",
      verification: true
    });
  }
  const result = verifyByteFenceReceipt({
    receipt: readByteFenceInput(
      requireByteFenceFlag(flags, "receipt"),
      "receipt",
      BYTEFENCE_MAX_RECEIPT_BYTES
    ),
    preimage: readByteFenceInput(
      beforePath,
      "before",
      BYTEFENCE_MAX_TARGET_BYTES
    ),
    candidate: readByteFenceInput(
      candidatePath,
      "candidate",
      BYTEFENCE_MAX_TARGET_BYTES
    ),
    intentBytes,
    policyBytes,
    workspaceId: requireByteFenceFlag(flags, "workspace-id")
  });

  return {
    code: result.exitCode,
    payload: byteFenceMachineResult(result)
  };
}

function byteFenceApply(flags) {
  assertByteFenceFlags(flags, new Set([
    "intent",
    "policy",
    "workspace-id",
    "root",
    "out",
    "receipt-profile",
    "observed-at"
  ]));

  const root = readByteFenceRoot(requireByteFenceFlag(flags, "root"));
  const outPath = resolveByteFenceReceiptOutput(
    root,
    requireByteFenceFlag(flags, "out")
  );
  const receiptProfile = readByteFenceReceiptProfile(flags);
  const intentBytes = readByteFenceInput(
    requireByteFenceFlag(flags, "intent"),
    "intent",
    BYTEFENCE_MAX_INTENT_BYTES
  );
  parseByteFenceIntent(intentBytes);
  const policyBytes = readByteFenceInput(
    requireByteFenceFlag(flags, "policy"),
    "policy",
    BYTEFENCE_MAX_POLICY_BYTES
  );
  parseByteFencePolicy(policyBytes);
  const result = applyByteFenceTransaction({
    root,
    intentBytes,
    policyBytes,
    workspaceId: requireByteFenceFlag(flags, "workspace-id"),
    observedAt: optionalByteFenceFlag(flags, "observed-at") ?? new Date().toISOString(),
    receiptProfile,
    receiptPath: outPath
  });
  const checkedResult = verifyFreshByteFenceApplyReceipt(result, outPath);

  return {
    code: checkedResult.exitCode,
    payload: byteFenceMachineResult(checkedResult, { receiptProfile })
  };
}

function runByteFenceCommand(operation, stdout) {
  let response;
  try {
    response = operation();
  } catch (error) {
    response = {
      code: 2,
      payload: invalidByteFenceCliResult(error)
    };
  }
  stdout.write(`${JSON.stringify(response.payload, null, 2)}\n`);
  return response.code;
}

function byteFenceMachineResult(result, additions = {}) {
  const payload = {
    status: result.status,
    exitCode: result.exitCode,
    ...additions
  };
  for (const key of [
    "allowed",
    "verified",
    "authorized",
    "operationId",
    "phase",
    "receiptType",
    "declaredGuaranteeLevel",
    "effectiveGuaranteeLevel",
    "mediationEnvironmentTrusted",
    "publicProfileConformant",
    "producerAuthenticated",
    "receiptPersisted",
    "receiptDigest"
  ]) {
    if (result[key] !== undefined) payload[key] = result[key];
  }
  if (Array.isArray(result.checks)) payload.checks = result.checks;
  payload.findings = Array.isArray(result.findings)
    ? result.findings.map(sanitizeByteFenceFinding)
    : [];
  return payload;
}

function byteFencePolicySizeDenial({
  id,
  title,
  receiptProfile,
  verification = false
}) {
  const result = {
    status: "deny",
    exitCode: 1,
    allowed: false,
    ...(verification ? { verified: false, authorized: false } : {}),
    effectiveGuaranteeLevel: "OUT_OF_SCOPE",
    findings: [
      {
        id,
        severity: "high",
        title,
        location: "bytes",
        recommendation: "Reduce the input size or select an explicitly versioned policy."
      }
    ]
  };
  return {
    code: 1,
    payload: byteFenceMachineResult(
      result,
      receiptProfile ? { receiptProfile } : {}
    )
  };
}

function sanitizeByteFenceFinding(finding) {
  const output = {};
  for (const key of [
    "id",
    "severity",
    "title",
    "location",
    "recommendation",
    "remediation"
  ]) {
    if (typeof finding?.[key] === "string") output[key] = finding[key];
  }
  return output;
}

function invalidByteFenceCliResult(error) {
  const safe = safeByteFenceError(error);
  return {
    status: "invalid",
    exitCode: 2,
    effectiveGuaranteeLevel: "OUT_OF_SCOPE",
    findings: [
      {
        id: safe.code,
        severity: "high",
        title: "ByteFence input is invalid",
        location: safe.location,
        recommendation: safe.message
      }
    ]
  };
}

function safeByteFenceError(error) {
  if (
    error instanceof ByteFenceCliError ||
    error instanceof ByteFenceContractError ||
    error instanceof ByteFencePathError ||
    error instanceof ByteFenceApplyError
  ) {
    return {
      code: error.code ?? "cli.invalid",
      message: error.message,
      location: error.location ?? "cli"
    };
  }
  return {
    code: "cli.inputUnreadable",
    message: "A required ByteFence input could not be read safely.",
    location: "cli"
  };
}

function assertByteFenceFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw new ByteFenceCliError(
        "cli.flagUnsupported",
        "An unsupported ByteFence flag was provided.",
        "cli"
      );
    }
  }
}

function requireByteFenceFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ByteFenceCliError(
      "cli.flagMissing",
      `Missing required flag: --${name}.`,
      `--${name}`
    );
  }
  if (value.includes("\0")) {
    throw new ByteFenceCliError(
      "cli.flagInvalid",
      `The --${name} value is invalid.`,
      `--${name}`
    );
  }
  return value;
}

function optionalByteFenceFlag(flags, name) {
  if (flags[name] === undefined) return undefined;
  return requireByteFenceFlag(flags, name);
}

function readByteFenceReceiptProfile(flags) {
  const profile = optionalByteFenceFlag(flags, "receipt-profile") ?? "public";
  if (profile !== "public" && profile !== "local") {
    throw new ByteFenceCliError(
      "cli.receiptProfileInvalid",
      "The ByteFence receipt profile must be public or local.",
      "--receipt-profile"
    );
  }
  return profile;
}

function inspectByteFenceInput(path, label) {
  try {
    const inputPath = resolve(path);
    const rawStat = lstatSync(inputPath, { bigint: true });
    if (!rawStat.isFile()) {
      throw new ByteFenceCliError(
        `cli.${label}NotRegular`,
        `The ByteFence ${label} input must be a regular file.`,
        `--${label}`
      );
    }
    return { inputPath, stat: snapshotByteFenceInput(rawStat) };
  } catch (error) {
    if (error instanceof ByteFenceCliError) throw error;
    throw new ByteFenceCliError(
      `cli.${label}Unreadable`,
      `The ByteFence ${label} input could not be inspected safely.`,
      `--${label}`
    );
  }
}

function readByteFenceInput(path, label, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ByteFenceCliError(
      "cli.readLimitInvalid",
      "The ByteFence input read limit is invalid.",
      `--${label}`
    );
  }

  let descriptor;
  try {
    const { inputPath, stat: pathStat } = inspectByteFenceInput(path, label);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
    descriptor = openSync(inputPath, constants.O_RDONLY | noFollow | nonBlocking);
    const rawStat = fstatSync(descriptor, { bigint: true });
    if (!rawStat.isFile()) {
      throw new ByteFenceCliError(
        `cli.${label}NotRegular`,
        `The ByteFence ${label} input must be a regular file.`,
        `--${label}`
      );
    }
    const stat = snapshotByteFenceInput(rawStat);
    if (!sameByteFenceInputIdentity(pathStat, stat)) {
      throw new ByteFenceCliError(
        `cli.${label}ChangedBeforeRead`,
        `The ByteFence ${label} input changed before it could be read.`,
        `--${label}`
      );
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw byteFenceInputTooLarge(label);
    }

    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(BYTEFENCE_READ_CHUNK_BYTES, remaining));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (total > maxBytes) throw byteFenceInputTooLarge(label);
    const after = snapshotByteFenceInput(fstatSync(descriptor, { bigint: true }));
    if (
      total !== stat.size ||
      after.size !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new ByteFenceCliError(
        `cli.${label}ChangedDuringRead`,
        `The ByteFence ${label} input changed while it was being read.`,
        `--${label}`
      );
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ByteFenceCliError) throw error;
    throw new ByteFenceCliError(
      `cli.${label}Unreadable`,
      `The ByteFence ${label} input could not be read safely.`,
      `--${label}`
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The bounded read result or original failure remains authoritative.
      }
    }
  }
}

function byteFenceInputTooLarge(label) {
  return new ByteFenceCliError(
    `cli.${label}TooLarge`,
    `The ByteFence ${label} input exceeds its configured byte limit.`,
    `--${label}`
  );
}

function sameByteFenceInputIdentity(left, right) {
  if (left.dev === "0" && left.ino === "0" && right.dev === "0" && right.ino === "0") {
    return false;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function snapshotByteFenceInput(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs)
  };
}

function readByteFenceRoot(path) {
  try {
    const root = realpathSync(resolve(path));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return root;
  } catch {
    throw new ByteFenceCliError(
      "cli.rootInvalid",
      "The ByteFence workspace root must be an existing directory.",
      "--root"
    );
  }
}

function resolveByteFenceReceiptOutput(root, value) {
  let absolutePath;
  if (isAbsolute(value)) {
    try {
      absolutePath = resolve(realpathSync(dirname(value)), basename(value));
    } catch {
      throw new ByteFenceCliError(
        "cli.receiptParentMissing",
        "The ByteFence receipt parent directory must already exist.",
        "--out"
      );
    }
  } else {
    absolutePath = resolve(root, value);
  }
  const child = relative(root, absolutePath);
  if (
    child.length === 0 ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new ByteFenceCliError(
      "cli.receiptOutsideRoot",
      "The ByteFence receipt output must remain inside the workspace root.",
      "--out"
    );
  }

  const parent = dirname(absolutePath);
  const parentChild = relative(root, parent);
  let current = root;
  for (const component of parentChild.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new ByteFenceCliError(
        "cli.receiptParentMissing",
        "The ByteFence receipt parent directory must already exist.",
        "--out"
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ByteFenceCliError(
        "cli.receiptParentUnsafe",
        "The ByteFence receipt parent chain must contain only real directories.",
        "--out"
      );
    }
  }
  return absolutePath;
}

function verifyFreshByteFenceApplyReceipt(result, outPath) {
  if (result.exitCode !== 0) return result;
  try {
    const bytes = readByteFenceInput(
      outPath,
      "receipt",
      BYTEFENCE_MAX_RECEIPT_BYTES
    );
    if (
      result.receiptPersisted !== true ||
      !/^[a-f0-9]{64}$/.test(result.receiptDigest ?? "") ||
      sha256Hex(bytes) !== result.receiptDigest
    ) {
      throw new Error("receipt mismatch");
    }
    return result;
  } catch {
    return {
      ...result,
      status: "committed-unreceipted",
      allowed: false,
      exitCode: 3,
      effectiveGuaranteeLevel: "POSTHOC_DETECTED",
      receiptPersisted: false,
      findings: [
        ...(result.findings ?? []),
        {
          id: "receipt.postPersistVerificationFailed",
          severity: "high",
          title: "The committed receipt could not be confirmed",
          location: "transaction:receipt",
          remediation: "Inspect the target and receipt. Do not retry the edit automatically."
        }
      ]
    };
  }
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n\n${usage()}`);
      process.exitCode = 2;
    });
}
