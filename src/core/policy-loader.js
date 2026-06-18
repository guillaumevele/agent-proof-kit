import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const bundledPolicyPacks = {
  default: "../../policies/default-policy.json",
  "open-source": "../../policies/open-source-policy.json",
  "strict-corporate": "../../policies/strict-corporate-policy.json",
  "high-stakes": "../../policies/high-stakes-policy.json"
};

export function loadPolicyFile(path) {
  return compilePolicyDefinition(readPolicyDefinition(path));
}

export function readPolicyDefinition(path) {
  const text = readFileSync(path, "utf8");
  const extension = extname(path).toLowerCase();
  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(text);
  }
  return JSON.parse(text);
}

export function compilePolicyDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("Policy definition must be an object.");
  }

  const base = definition.extends ? loadBundledPolicyPack(definition.extends) : {};
  const gates = {
    ...(base.gates ?? {}),
    ...(definition.gates ? compileGates(definition.gates) : {})
  };
  const actionRisk = {
    ...(base.actionRisk ?? {}),
    ...(definition.actionRisk ?? {}),
    ...(definition.actions ?? {})
  };

  return {
    id: definition.id ?? base.id ?? "custom-agent-policy",
    schemaVersion: definition.schemaVersion ?? base.schemaVersion ?? 1,
    minimumScore: definition.minimumScore ?? definition.score?.minimum ?? base.minimumScore ?? 90,
    maxScannedFileBytes: definition.maxScannedFileBytes ?? definition.scan?.maxFileBytes ?? base.maxScannedFileBytes ?? 512000,
    severityWeights: {
      ...(base.severityWeights ?? {}),
      ...(definition.severityWeights ?? {})
    },
    gates,
    actionRisk,
    privateTerms: definition.privateTerms ?? base.privateTerms ?? []
  };
}

function compileGates(gates) {
  const compiled = { ...gates };
  mapGate(compiled, gates, "synthetic", "requireSyntheticFixture");
  mapGate(compiled, gates, "decisionTrace", "requireDecisionTrace");
  mapGate(compiled, gates, "evidenceForClaims", "requireEvidenceForClaims");
  mapGate(compiled, gates, "claimsForFinalOutputs", "requireClaimsForFinalOutputs");
  return compiled;
}

function mapGate(compiled, source, from, to) {
  if (source[from] === undefined) return;
  compiled[to] = source[from] === true || source[from] === "required";
  delete compiled[from];
}

function loadBundledPolicyPack(name) {
  const key = String(name);
  const path = bundledPolicyPacks[key];
  if (!path) {
    throw new Error(`Unknown policy pack '${key}'. Supported packs: ${Object.keys(bundledPolicyPacks).join(", ")}`);
  }
  return JSON.parse(readFileSync(resolve(fileURLToPath(new URL(path, import.meta.url))), "utf8"));
}
