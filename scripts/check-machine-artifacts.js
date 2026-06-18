import { readFileSync } from "node:fs";
import { buildMachineArtifacts } from "./lib/machine-artifacts.js";

const expectedArtifacts = buildMachineArtifacts();

for (const [path, expected] of Object.entries(expectedArtifacts)) {
  const actual = readFileSync(path, "utf8");
  assertValidGeneratedArtifact(path, actual);
  assertNoLocalPaths(path, actual);

  if (actual !== expected) {
    process.stderr.write(`Generated artifact is stale: ${path}. Run npm run artifacts:generate.\n`);
    process.exit(1);
  }
}

process.stdout.write("generated machine artifacts are current\n");

function assertValidGeneratedArtifact(path, text) {
  if (path.endsWith(".json") || path.endsWith(".sarif")) {
    JSON.parse(text);
    return;
  }

  if (path.endsWith(".html")) {
    if (!text.startsWith("<!doctype html>") || !text.includes("<title>Agent Proof Dashboard</title>")) {
      process.stderr.write(`Generated HTML artifact is invalid: ${path}\n`);
      process.exit(1);
    }
    return;
  }

  process.stderr.write(`Generated artifact has no validator: ${path}\n`);
  process.exit(1);
}

function assertNoLocalPaths(path, text) {
  const localPathPattern = /(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\)/;
  if (localPathPattern.test(text)) {
    process.stderr.write(`Generated artifact contains a local or temporary path: ${path}\n`);
    process.exit(1);
  }
}
