import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildMachineArtifacts } from "./lib/machine-artifacts.js";

const artifacts = buildMachineArtifacts();

for (const [path, text] of Object.entries(artifacts)) {
  const outPath = resolve(path);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
}

process.stdout.write("wrote docs/generated\n");
