#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAgentRun } from "../src/core/evaluate-agent-run.js";
import { scanPublicSurface } from "../src/core/public-safety-scan.js";
import { renderAgentProofReport, renderScanReport } from "../src/report/markdown-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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
  verify --input <file> --policy <file> [--format text|json|markdown] [--out <file>]
  scan   --path <dir>   --policy <file> [--format text|json|markdown] [--out <file>]
  report --input <file> --policy <file> --out <file>

Examples:
  agent-proof verify --input examples/synthetic-agent-run.json --policy policies/default-policy.json
  agent-proof scan --path . --policy policies/default-policy.json
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
  if (format !== "text") {
    throw new Error(`Unsupported format: ${format}`);
  }

  return `${result.status.toUpperCase()} files=${result.filesScanned} findings=${result.findings.length}\n`;
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
    const result = evaluateAgentRun(readJson(inputPath), readJson(policyPath), {
      inputPath,
      policyPath
    });
    writeOutput(formatEvaluation(result, flags), flags, io.stdout);
    return result.status === "pass" ? 0 : 1;
  }

  if (command === "scan") {
    const scanPath = resolve(requireFlag(flags, "path"));
    const policyPath = resolve(requireFlag(flags, "policy"));
    const result = scanPublicSurface(scanPath, readJson(policyPath), {
      rootDir: scanPath
    });
    writeOutput(formatScan(result, flags), flags, io.stdout);
    return result.status === "pass" ? 0 : 1;
  }

  if (command === "report") {
    const inputPath = resolve(requireFlag(flags, "input"));
    const policyPath = resolve(requireFlag(flags, "policy"));
    const outPath = resolve(requireFlag(flags, "out"));
    const result = evaluateAgentRun(readJson(inputPath), readJson(policyPath), {
      inputPath,
      policyPath
    });
    writeOutput(renderAgentProofReport(result), { out: outPath }, io.stdout);
    return result.status === "pass" ? 0 : 1;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
