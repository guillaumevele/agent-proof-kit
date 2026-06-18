#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
