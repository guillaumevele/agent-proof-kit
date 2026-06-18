import { existsSync, readFileSync } from "node:fs";
import { buildGateCoverageMatrix, gateCoverageEntries } from "./lib/gate-coverage.js";

const outPath = "docs/generated/gate-coverage.md";
const expected = buildGateCoverageMatrix();
const actual = readFileSync(outPath, "utf8");

assertNoLocalPaths(outPath, actual);
assertReferencedPathsExist();

if (actual !== expected) {
  process.stderr.write("Generated gate coverage matrix is stale. Run npm run coverage:generate.\n");
  process.exit(1);
}

process.stdout.write("gate coverage matrix is current\n");

function assertReferencedPathsExist() {
  const paths = new Set();

  for (const entry of gateCoverageEntries) {
    for (const path of [...entry.evidence, ...entry.verification, ...entry.artifacts]) {
      paths.add(path);
    }
  }

  for (const path of paths) {
    if (!existsSync(path)) {
      process.stderr.write(`Gate coverage matrix references a missing path: ${path}\n`);
      process.exit(1);
    }
  }
}

function assertNoLocalPaths(path, text) {
  const localPathPattern = /(?:\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\)/;
  if (localPathPattern.test(text)) {
    process.stderr.write(`Generated artifact contains a local or temporary path: ${path}\n`);
    process.exit(1);
  }
}
