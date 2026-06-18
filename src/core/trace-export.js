import { normalizeJsonlTrace } from "./normalize-jsonl.js";

export const supportedTraceSources = [
  "agent-proof-jsonl",
  "generic-jsonl",
  "langgraph-stream",
  "crewai-events",
  "autogen-run-stream"
];

export function exportTraceFixture(text, options = {}) {
  const source = options.source ?? "agent-proof-jsonl";
  if (!supportedTraceSources.includes(source)) {
    throw new Error(`Unsupported trace source: ${source}. Supported sources: ${supportedTraceSources.join(", ")}`);
  }

  const run = adaptTrace(text, source);
  const redaction = redactValue(run, normalizeTerms(options.redactTerms ?? []));

  return {
    source,
    redactedTerms: redaction.redactedTerms,
    run: redaction.value
  };
}

function adaptTrace(text, source) {
  if (source === "agent-proof-jsonl" || source === "generic-jsonl") {
    return normalizeJsonlTrace(text);
  }
  if (source === "langgraph-stream") {
    return adaptLangGraphStream(text);
  }
  if (source === "crewai-events") {
    return adaptCrewAiEvents(text);
  }
  if (source === "autogen-run-stream") {
    return adaptAutoGenRunStream(text);
  }
  throw new Error(`Unsupported trace source: ${source}`);
}

function adaptLangGraphStream(text) {
  const { metadata, records } = parseTraceRecords(text, ["chunks", "stream"]);
  const run = createRun({
    source: "langgraph",
    runId: metadata.runId ?? "langgraph-stream-run",
    subject: metadata.subject ?? "LangGraph stream fixture",
    generatedAt: metadata.generatedAt ?? null,
    agent: metadata.agent ?? { name: "LangGraph app", provider: "langgraph" }
  });

  addInputFromValue(run, metadata.input, "langgraph-input");

  let step = 0;
  for (const chunk of records) {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) continue;
    for (const [nodeName, value] of Object.entries(chunk)) {
      step += 1;
      const actionId = `langgraph-${step}-${slug(nodeName)}`;
      const evidenceId = `${actionId}-evidence`;
      run.actions.push({
        id: actionId,
        type: "read",
        target: `langgraph.node:${nodeName}`,
        approval: "not_required",
        outcome: "completed",
        note: `Observed LangGraph stream update for node '${nodeName}'.`
      });
      run.evidence.push({
        id: evidenceId,
        kind: "langgraph_stream_chunk",
        result: "pass",
        excerpt: excerpt(value)
      });

      const outputText = extractOutputText(value);
      if (outputText) {
        run.outputs.push({
          id: `${actionId}-output`,
          channel: "langgraph",
          content: outputText,
          claims: [
            {
              text: `Node '${nodeName}' produced a synthetic stream update.`,
              evidence: evidenceId
            }
          ]
        });
      }
    }
  }

  ensureOutput(run, "langgraph-final-output", "LangGraph synthetic stream was normalized into auditable node steps.");
  return run;
}

function adaptCrewAiEvents(text) {
  const { metadata, records } = parseTraceRecords(text, ["events"]);
  const run = createRun({
    source: "crewai",
    runId: metadata.runId ?? "crewai-events-run",
    subject: metadata.subject ?? "CrewAI events fixture",
    generatedAt: metadata.generatedAt ?? null,
    agent: metadata.agent ?? { name: metadata.crew_name ?? "CrewAI crew", provider: "crewai" }
  });

  let step = 0;
  for (const event of records) {
    if (!event || typeof event !== "object") continue;
    const eventName = String(event.event ?? event.type ?? event.name ?? "");
    const eventKey = eventName.toLowerCase();

    if (eventKey.includes("kickoffstarted")) {
      run.objectives.push(event.task ?? event.input ?? `Run CrewAI crew '${event.crew_name ?? "unknown"}'.`);
      continue;
    }

    if (event.task?.description) {
      run.objectives.push(event.task.description);
    }

    if (eventKey.includes("kickoffcompleted")) {
      const evidenceId = "crewai-completed-evidence";
      run.evidence.push({
        id: evidenceId,
        kind: "crewai_event",
        result: "pass",
        excerpt: excerpt(event.output ?? event)
      });
      run.outputs.push({
        id: "crewai-final-output",
        channel: "crewai",
        content: extractOutputText(event.output) ?? "CrewAI crew completed.",
        claims: [
          {
            text: "CrewAI crew completed with a synthetic output.",
            evidence: evidenceId
          }
        ]
      });
      continue;
    }

    if (eventKey.includes("agentexecutioncompleted") || event.agent || event.task || event.output) {
      step += 1;
      const role = event.agent?.role ?? event.agent_role ?? event.role ?? `agent-${step}`;
      const actionId = `crewai-${step}-${slug(role)}`;
      const evidenceId = `${actionId}-evidence`;
      run.actions.push({
        id: actionId,
        type: "read",
        target: `crewai.agent:${role}`,
        approval: "not_required",
        outcome: "completed",
        note: event.task?.description ?? `Observed CrewAI event '${eventName || "unknown"}'.`
      });
      run.evidence.push({
        id: evidenceId,
        kind: "crewai_event",
        result: "pass",
        excerpt: excerpt(event.output ?? event.task?.output ?? event)
      });

      const outputText = extractOutputText(event.output ?? event.task?.output ?? event.raw);
      if (outputText) {
        run.outputs.push({
          id: `${actionId}-output`,
          channel: "crewai",
          content: outputText,
          claims: [
            {
              text: `CrewAI agent '${role}' produced a synthetic task output.`,
              evidence: evidenceId
            }
          ]
        });
      }
      continue;
    }

  }

  ensureOutput(run, "crewai-final-output", "CrewAI synthetic events were normalized into auditable agent steps.");
  return run;
}

function adaptAutoGenRunStream(text) {
  const { metadata, records } = parseTraceRecords(text, ["messages", "events"]);
  const run = createRun({
    source: "autogen",
    runId: metadata.runId ?? "autogen-run-stream",
    subject: metadata.subject ?? "AutoGen run_stream fixture",
    generatedAt: metadata.generatedAt ?? null,
    agent: metadata.agent ?? { name: metadata.team ?? "AutoGen team", provider: "autogen" }
  });

  let step = 0;
  for (const message of records) {
    if (!message || typeof message !== "object") continue;
    const messageType = String(message.type ?? message.event ?? message.kind ?? "");
    const source = String(message.source ?? message.sender ?? message.role ?? "autogen");
    const content = extractOutputText(message.content ?? message.message ?? message);

    if (source.toLowerCase() === "user") {
      run.inputs.push({
        id: `autogen-input-${run.inputs.length + 1}`,
        source: "autogen.run_stream",
        classification: "public-synthetic",
        content: content ?? excerpt(message)
      });
      continue;
    }

    if (messageType.toLowerCase().includes("taskresult") || message.stop_reason) {
      run.evidence.push({
        id: "autogen-task-result",
        kind: "autogen_task_result",
        result: "pass",
        excerpt: `stop_reason=${message.stop_reason ?? "unknown"}`
      });
      continue;
    }

    step += 1;
    const actionId = `autogen-${step}-${slug(source)}`;
    const evidenceId = `${actionId}-evidence`;
    run.actions.push({
      id: actionId,
      type: "read",
      target: `autogen.source:${source}`,
      approval: "not_required",
      outcome: "completed",
      note: messageType ? `Observed AutoGen stream message '${messageType}'.` : "Observed AutoGen stream message."
    });
    run.evidence.push({
      id: evidenceId,
      kind: "autogen_run_stream_message",
      result: "pass",
      excerpt: excerpt(message)
    });
    if (content) {
      run.outputs.push({
        id: `${actionId}-output`,
        channel: "autogen",
        content,
        claims: [
          {
            text: `AutoGen source '${source}' produced a synthetic stream message.`,
            evidence: evidenceId
          }
        ]
      });
    }
  }

  ensureOutput(run, "autogen-final-output", "AutoGen synthetic run_stream messages were normalized into auditable agent steps.");
  return run;
}

function createRun({ source, runId, subject, generatedAt, agent }) {
  return {
    schemaVersion: 1,
    runId,
    subject,
    synthetic: true,
    generatedAt: generatedAt ?? "2026-06-18T00:00:00.000Z",
    agent,
    objectives: [`Normalize ${source} trace into Agent Proof Kit fixture.`],
    inputs: [],
    actions: [],
    outputs: [],
    evidence: []
  };
}

function parseTraceRecords(text, collectionKeys) {
  const trimmed = text.trim();
  if (!trimmed) return { metadata: {}, records: [] };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { metadata: {}, records: parsed };
      for (const key of collectionKeys) {
        if (Array.isArray(parsed[key])) {
          return { metadata: parsed, records: parsed[key] };
        }
      }
      return { metadata: parsed, records: [parsed] };
    } catch (error) {
      if (!trimmed.includes("\n")) throw error;
    }
  }

  return {
    metadata: {},
    records: text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid JSONL on line ${index + 1}: ${error.message}`);
        }
      })
  };
}

function addInputFromValue(run, value, id) {
  if (!value) return;
  const messages = Array.isArray(value?.messages) ? value.messages : null;
  if (messages) {
    messages.forEach((message, index) => {
      run.inputs.push({
        id: `${id}-${index + 1}`,
        source: "langgraph.input.messages",
        classification: "public-synthetic",
        content: extractOutputText(message) ?? excerpt(message)
      });
    });
    return;
  }
  run.inputs.push({
    id,
    source: "langgraph.input",
    classification: "public-synthetic",
    content: excerpt(value)
  });
}

function ensureOutput(run, id, content) {
  if (run.outputs.length) return;
  const evidenceId = `${id}-evidence`;
  run.evidence.push({
    id: evidenceId,
    kind: "adapter_summary",
    result: "pass",
    excerpt: content
  });
  run.outputs.push({
    id,
    channel: "final",
    content,
    claims: [
      {
        text: content,
        evidence: evidenceId
      }
    ]
  });
}

function extractOutputText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(extractOutputText).filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  if (typeof value !== "object") return String(value);

  if (typeof value.content === "string") return value.content;
  if (typeof value.raw === "string") return value.raw;
  if (typeof value.output === "string") return value.output;
  if (typeof value.generation === "string") return value.generation;
  if (typeof value.final === "string") return value.final;
  if (Array.isArray(value.messages) && value.messages.length) {
    return extractOutputText(value.messages[value.messages.length - 1]);
  }
  if (Array.isArray(value.content)) {
    return extractOutputText(value.content);
  }

  return null;
}

function excerpt(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function slug(value) {
  const normalized = String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "unknown";
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
