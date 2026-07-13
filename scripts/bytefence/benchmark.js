#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import {
  BYTEFENCE_INTENT_SCHEMA,
  deriveByteFenceCandidate,
  parseByteFenceIntent
} from "../../src/core/bytefence-contract.js";
import { evaluateByteFence } from "../../src/core/bytefence-evaluate.js";

const policyBytes = readFileSync(
  new URL("../../policies/bytefence-default.json", import.meta.url)
);
const benchmarkCases = [
  { bytes: 64 * 1024, iterations: 100 },
  { bytes: 1024 * 1024, iterations: 20 },
  { bytes: 8 * 1024 * 1024, iterations: 5 }
];
const results = benchmarkCases.map(runCase);
const report = {
  _type: "ByteFenceBenchmark/v0.1",
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch
  },
  contract: "evaluate exactReplace from raw preimage and candidate bytes",
  thresholdPolicy: "informational-no-release-threshold",
  results
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write("ByteFence raw-byte evaluation benchmark\n");
  for (const result of results) {
    process.stdout.write(
      `${result.inputMiB.toFixed(3)} MiB: median=${result.medianMs.toFixed(3)} ms ` +
        `p95=${result.p95Ms.toFixed(3)} ms throughput=${result.medianMiBPerSecond.toFixed(1)} MiB/s\n`
    );
  }
  process.stdout.write("Informational only; no environment-dependent release threshold is applied.\n");
}

function runCase({ bytes, iterations }) {
  const anchor = Buffer.from("bytefence-anchor=before", "utf8");
  const prefixLength = Math.floor((bytes - anchor.length - 1) / 2);
  const suffixLength = bytes - anchor.length - prefixLength;
  const preimage = Buffer.concat([
    Buffer.alloc(prefixLength, 0x61),
    anchor,
    Buffer.alloc(suffixLength, 0x62)
  ]);
  const intentBytes = Buffer.from(JSON.stringify({
    $schema: BYTEFENCE_INTENT_SCHEMA,
    operation: "exactReplace",
    targetPath: `bench/input-${bytes}.txt`,
    encoding: "utf-8",
    oldText: "bytefence-anchor=before",
    newText: "bytefence-anchor=after",
    expectedOccurrences: 1
  }));
  const intent = parseByteFenceIntent(intentBytes);
  const candidate = deriveByteFenceCandidate(preimage, intent);
  const durations = [];

  for (let warmup = 0; warmup < 3; warmup += 1) evaluate();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    evaluate();
    durations.push(performance.now() - startedAt);
  }

  durations.sort((left, right) => left - right);
  const medianMs = percentile(durations, 0.5);
  const p95Ms = percentile(durations, 0.95);
  const inputMiB = bytes / (1024 * 1024);
  return {
    inputBytes: bytes,
    inputMiB,
    iterations,
    medianMs,
    p95Ms,
    medianMiBPerSecond: inputMiB / (medianMs / 1000)
  };

  function evaluate() {
    const result = evaluateByteFence({
      preimage,
      candidate,
      intentBytes,
      policyBytes,
      workspaceId: "bytefence/benchmark",
      observedAt: "2026-07-13T10:00:00Z"
    });
    if (!result.allowed) {
      throw new Error(`Benchmark contract denied: ${JSON.stringify(result.findings)}`);
    }
  }
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}
