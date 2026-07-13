import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildMachineArtifacts } from "../../scripts/lib/machine-artifacts.js";

test("generated proof bundle uses the current package version", () => {
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const artifacts = buildMachineArtifacts();
  const bundle = JSON.parse(artifacts["docs/generated/proof-bundle.json"]);

  assert.equal(bundle.tool.version, packageVersion);
});
