import { compilePattern, defaultSecretPatterns } from "./patterns.js";

export function scanText(value, context, policy = {}) {
  const text = String(value ?? "");
  const findings = [];
  const patterns = policy.secretPatterns?.length ? policy.secretPatterns : defaultSecretPatterns;

  for (const pattern of patterns) {
    const regex = compilePattern(pattern);
    const matches = text.matchAll(regex);
    for (const match of matches) {
      findings.push({
        id: `secret.${pattern.id}`,
        severity: pattern.severity ?? "critical",
        title: `Secret-shaped value detected: ${pattern.id}`,
        location: locationWithPosition(context, text, match.index ?? 0),
        evidence: maskSecret(match[0]),
        recommendation: "Replace the value with a placeholder and rotate the credential if it was real."
      });
    }
  }

  for (const term of policy.privateTerms ?? []) {
    if (!term) continue;
    const index = text.toLowerCase().indexOf(String(term).toLowerCase());
    if (index !== -1) {
      findings.push({
        id: "privacy.private_term",
        severity: "high",
        title: "Private term detected",
        location: locationWithPosition(context, text, index),
        evidence: `${String(term).slice(0, 3)}...`,
        recommendation: "Move this example to a synthetic fixture or replace it with a neutral placeholder."
      });
    }
  }

  return findings;
}

export function maskSecret(secret) {
  if (secret.length <= 8) return "[redacted]";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function locationWithPosition(context, text, index) {
  if (String(context).startsWith("$")) return context;

  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = index - lastNewline;

  return `${context}:${line}:${column}`;
}

export function collectTextNodes(value, prefix = "$") {
  const nodes = [];
  if (typeof value === "string") {
    nodes.push({ path: prefix, value });
    return nodes;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      nodes.push(...collectTextNodes(item, `${prefix}[${index}]`));
    });
    return nodes;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      nodes.push(...collectTextNodes(nested, `${prefix}.${key}`));
    }
  }
  return nodes;
}
