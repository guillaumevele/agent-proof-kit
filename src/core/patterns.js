export const defaultSecretPatterns = [
  {
    id: "openai_key",
    severity: "critical",
    pattern: "\\bsk-[A-Za-z0-9_-]{20,}\\b",
    description: "OpenAI-style API key"
  },
  {
    id: "anthropic_key",
    severity: "critical",
    pattern: "\\bsk-ant-[A-Za-z0-9_-]{20,}\\b",
    description: "Anthropic-style API key"
  },
  {
    id: "github_token",
    severity: "critical",
    pattern: "\\bgh[pousr]_[A-Za-z0-9_]{30,}\\b",
    description: "GitHub token"
  },
  {
    id: "google_api_key",
    severity: "critical",
    pattern: "\\bAIza[0-9A-Za-z\\-_]{20,}\\b",
    description: "Google API key"
  },
  {
    id: "bearer_token",
    severity: "high",
    pattern: "\\bBearer\\s+[A-Za-z0-9._\\-]{20,}\\b",
    description: "Bearer token"
  },
  {
    id: "private_key_block",
    severity: "critical",
    pattern: "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    description: "Private key block"
  }
];

export const severityWeights = {
  critical: 35,
  high: 20,
  medium: 10,
  low: 3
};

export function compilePattern(entry) {
  return new RegExp(entry.pattern, "g");
}

export function severityRank(severity) {
  return {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4
  }[severity] ?? 0;
}
