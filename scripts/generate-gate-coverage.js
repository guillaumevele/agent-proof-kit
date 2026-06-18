import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildGateCoverageMatrix } from "./lib/gate-coverage.js";

const outPath = resolve("docs/generated/gate-coverage.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, buildGateCoverageMatrix());

process.stdout.write("wrote docs/generated/gate-coverage.md\n");
