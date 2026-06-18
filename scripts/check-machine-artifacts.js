import { readFileSync } from "node:fs";
import { buildMachineArtifacts } from "./lib/machine-artifacts.js";

const expectedArtifacts = buildMachineArtifacts();

for (const [path, expected] of Object.entries(expectedArtifacts)) {
  const actual = readFileSync(path, "utf8");
  JSON.parse(actual);
  assertNoLocalPaths(path, actual);

  if (actual !== expected) {
    process.stderr.write(`Generated artifact is stale: ${path}. Run npm run artifacts:generate.\n`);
    process.exit(1);
  }
}

process.stdout.write("generated machine artifacts are current\n");

function assertNoLocalPaths(path, text) {
  const localPathPattern = /(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\)/;
  if (localPathPattern.test(text)) {
    process.stderr.write(`Generated artifact contains a local or temporary path: ${path}\n`);
    process.exit(1);
  }
}
