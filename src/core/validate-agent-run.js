import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "./json-schema-validator.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(moduleDir, "../..");
const agentRunSchema = readSchema("agent-run.schema.json");
const policySchema = readSchema("policy.schema.json");

export function validateAgentRun(run) {
  return toValidationResult(validateJsonSchema(run, agentRunSchema));
}

export function validatePolicy(policy) {
  return toValidationResult(validateJsonSchema(policy, policySchema));
}

function toValidationResult(issues) {
  const findings = issues.map((issue) => makeFinding(issue.location, issue.message));
  return {
    status: findings.length === 0 ? "pass" : "fail",
    findings
  };
}

function makeFinding(location, message) {
  return {
    id: "schema.invalid_shape",
    severity: "high",
    title: "Schema validation failed",
    location,
    evidence: message,
    recommendation: "Update the fixture to match schemas/agent-run.schema.json or schemas/policy.schema.json."
  };
}

function readSchema(fileName) {
  return JSON.parse(readFileSync(resolve(rootDir, "schemas", fileName), "utf8"));
}
