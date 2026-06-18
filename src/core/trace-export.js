import { normalizeJsonlTrace } from "./normalize-jsonl.js";

export const supportedTraceSources = ["agent-proof-jsonl", "generic-jsonl"];

export function exportTraceFixture(text, options = {}) {
  const source = options.source ?? "agent-proof-jsonl";
  if (!supportedTraceSources.includes(source)) {
    throw new Error(`Unsupported trace source: ${source}. Supported sources: ${supportedTraceSources.join(", ")}`);
  }

  const run = normalizeJsonlTrace(text);
  const redaction = redactValue(run, normalizeTerms(options.redactTerms ?? []));

  return {
    source,
    redactedTerms: redaction.redactedTerms,
    run: redaction.value
  };
}

function normalizeTerms(terms) {
  return terms
    .map((term) => String(term ?? "").trim())
    .filter(Boolean);
}

function redactValue(value, terms) {
  if (!terms.length) return { value, redactedTerms: 0 };

  let redactedTerms = 0;

  function visit(input) {
    if (typeof input === "string") {
      let output = input;
      terms.forEach((term, index) => {
        const escaped = escapeRegExp(term);
        const pattern = new RegExp(escaped, "gi");
        output = output.replace(pattern, () => {
          redactedTerms += 1;
          return `[redacted-term-${index + 1}]`;
        });
      });
      return output;
    }

    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, nested]) => [key, visit(nested)]));
    }
    return input;
  }

  return {
    value: visit(value),
    redactedTerms
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
