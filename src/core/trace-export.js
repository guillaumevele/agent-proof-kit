import { normalizeJsonlTrace } from "./normalize-jsonl.js";

export const supportedTraceSources = [
  "agent-proof-jsonl",
  "generic-jsonl",
  "langgraph-stream",
  "crewai-events",
  "autogen-run-stream",
  "codex-exec-jsonl"
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
  if (source === "codex-exec-jsonl") {
    return adaptCodexExecJsonl(text);
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

const codexItemOutcomes = {
  completed: "completed",
  failed: "failed",
  declined: "refused"
};

// Normalizes the JSONL stream written by `codex exec --json` (thread.*, turn.*,
// item.* and error events). Only item.completed records become actions; items
// that start but never complete are recorded as `incomplete`. Reasoning text,
// command output and MCP tool arguments are intentionally not copied into the
// fixture. Shell commands are not risk-classified: they are exported as
// `command` actions and the policy decides how to treat them.
function adaptCodexExecJsonl(text) {
  const { records } = parseTraceRecords(text, ["events"]);
  const threadEvent = records.find((event) => event?.type === "thread.started");
  const threadId = typeof threadEvent?.thread_id === "string" ? threadEvent.thread_id : null;
  const run = createRun({
    source: "codex exec --json",
    runId: threadId ? `codex-exec-${slug(threadId)}` : "codex-exec-run",
    subject: "Codex CLI exec run",
    generatedAt: null,
    agent: { name: "Codex CLI", provider: "openai-codex" }
  });
  run.synthetic = false;
  run.objectives = ["Normalize a codex exec --json event stream into an Agent Proof Kit run."];

  const pending = new Map();
  const counters = { turn: 0, command: 0, patch: 0, mcp: 0, search: 0, collab: 0, message: 0, error: 0 };

  for (const event of records) {
    if (!event || typeof event !== "object") continue;
    const type = String(event.type ?? "");

    if (type === "turn.started") {
      counters.turn += 1;
      continue;
    }

    if (type === "turn.completed") {
      const usage = event.usage ?? {};
      run.evidence.push({
        id: `codex-turn-${Math.max(counters.turn, 1)}-completed`,
        kind: "codex_turn_completed",
        result: "pass",
        excerpt: `input_tokens=${usage.input_tokens ?? "?"} output_tokens=${usage.output_tokens ?? "?"} reasoning_output_tokens=${usage.reasoning_output_tokens ?? "?"}`
      });
      continue;
    }

    if (type === "turn.failed" || type === "error") {
      counters.error += 1;
      const message = type === "error" ? event.message : event.error?.message;
      run.evidence.push({
        id: `codex-${type === "error" ? "stream-error" : "turn-failed"}-${counters.error}`,
        kind: type === "error" ? "codex_stream_error" : "codex_turn_failed",
        result: "fail",
        excerpt: excerpt(String(message ?? "unknown error"))
      });
      continue;
    }

    if (type === "item.started" || type === "item.updated") {
      const item = event.item;
      if (item?.id) pending.set(item.id, item);
      continue;
    }

    if (type !== "item.completed") continue;
    const item = event.item;
    if (!item || typeof item !== "object") continue;
    if (item.id) pending.delete(item.id);
    addCodexItem(run, item, counters, "completed");
  }

  for (const item of pending.values()) {
    addCodexItem(run, item, counters, "incomplete");
  }

  ensureOutput(run, "codex-exec-final-output", "Codex exec event stream was normalized into auditable agent steps.");
  return run;
}

function addCodexItem(run, item, counters, phase) {
  const itemType = String(item.type ?? "");
  const statusOutcome = (status) => (phase === "incomplete" ? "incomplete" : codexItemOutcomes[status] ?? "unknown");

  if (itemType === "command_execution") {
    counters.command += 1;
    const actionId = `codex-command-${counters.command}`;
    const evidenceId = `${actionId}-evidence`;
    run.actions.push({
      id: actionId,
      type: "command",
      target: excerpt(String(item.command ?? "unknown command")),
      approval: "not_recorded",
      outcome: statusOutcome(item.status),
      note: "Shell command executed by Codex. Risk is not inferred from the command text."
    });
    run.evidence.push({
      id: evidenceId,
      kind: "codex_command_execution",
      result: item.status === "completed" && item.exit_code === 0 ? "pass" : "fail",
      excerpt: `status=${item.status ?? "unknown"} exit_code=${item.exit_code ?? "none"}`
    });
    return;
  }

  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    for (const change of changes) {
      counters.patch += 1;
      const actionId = `codex-file-change-${counters.patch}`;
      const intentWrite = change?.kind !== "delete" && isByteFenceIntentPath(change?.path);
      run.actions.push({
        id: actionId,
        type: change?.kind === "delete" ? "destructive" : intentWrite ? "bytefence_intent" : "unmediated_write",
        target: String(change?.path ?? "unknown path"),
        approval: "not_recorded",
        outcome: statusOutcome(item.status),
        note: intentWrite
          ? `Codex patch (${change?.kind ?? "unknown"}) writing a ByteFence intent, an input of the mediated path.`
          : `Codex patch (${change?.kind ?? "unknown"}) applied outside ByteFence mediation.`
      });
      run.evidence.push({
        id: `${actionId}-evidence`,
        kind: "codex_file_change",
        result: item.status === "completed" ? "pass" : "fail",
        excerpt: `kind=${change?.kind ?? "unknown"} status=${item.status ?? "unknown"}`
      });
    }
    return;
  }

  if (itemType === "mcp_tool_call") {
    counters.mcp += 1;
    const tool = String(item.tool ?? "unknown");
    const server = String(item.server ?? "unknown");
    const actionId = `codex-mcp-${counters.mcp}-${slug(tool)}`;
    const evidenceId = `${actionId}-evidence`;
    const summary = parseByteFenceToolResult(item);

    if (tool === "bytefence_apply") {
      const committed = summary?.status === "allow" && summary?.exitCode === 0 && summary?.receiptPersisted === true;
      const denied = summary && summary.exitCode !== 3 && summary.status !== "allow";
      run.actions.push({
        id: actionId,
        type: "write",
        target: `bytefence:${String(item.arguments?.intent_path ?? "unknown intent")}`,
        approval: "not_recorded",
        outcome: phase === "incomplete" ? "incomplete" : committed ? "completed" : denied ? "blocked" : "unknown",
        note: `ByteFence mediated write through MCP server '${server}'.`
      });
      run.evidence.push({
        id: evidenceId,
        kind: "bytefence_apply_result",
        result: committed ? "pass" : "fail",
        excerpt: summary
          ? `status=${summary.status} exitCode=${summary.exitCode} effectiveGuaranteeLevel=${summary.effectiveGuaranteeLevel} receiptPersisted=${summary.receiptPersisted === true}`
          : `status=${item.status ?? "unknown"} (result was not a ByteFence JSON summary)`
      });
      return;
    }

    run.actions.push({
      id: actionId,
      type: tool === "bytefence_check" ? "read" : "mcp_tool",
      target: `mcp:${server}/${tool}`,
      approval: "not_recorded",
      outcome: statusOutcome(item.status),
      note: "MCP tool call dispatched by Codex. Arguments are not exported."
    });
    run.evidence.push({
      id: evidenceId,
      kind: "codex_mcp_tool_call",
      result: item.status === "completed" && !item.error ? "pass" : "fail",
      excerpt: summary
        ? `status=${summary.status} exitCode=${summary.exitCode} effectiveGuaranteeLevel=${summary.effectiveGuaranteeLevel}`
        : `status=${item.status ?? "unknown"}${item.error?.message ? ` error=${excerpt(item.error.message)}` : ""}`
    });
    return;
  }

  if (itemType === "web_search") {
    counters.search += 1;
    run.actions.push({
      id: `codex-web-search-${counters.search}`,
      type: "network",
      target: "web_search",
      approval: "not_recorded",
      outcome: phase === "incomplete" ? "incomplete" : "completed",
      note: "Web search requested by Codex. The query is not exported."
    });
    return;
  }

  if (itemType === "collab_tool_call") {
    counters.collab += 1;
    run.actions.push({
      id: `codex-subagent-${counters.collab}`,
      type: "subagent",
      target: `collab:${String(item.tool ?? "unknown")}`,
      approval: "not_recorded",
      outcome: statusOutcome(item.status),
      note: "Codex collaboration tool call. Prompts are not exported."
    });
    return;
  }

  if (itemType === "agent_message" && phase === "completed") {
    counters.message += 1;
    const evidenceId = `codex-message-${counters.message}-evidence`;
    run.evidence.push({
      id: evidenceId,
      kind: "codex_agent_message",
      result: "pass",
      excerpt: `agent_message item ${String(item.id ?? counters.message)}`
    });
    run.outputs.push({
      id: `codex-message-${counters.message}`,
      channel: "codex",
      content: String(item.text ?? ""),
      claims: [
        {
          text: "Codex emitted this agent message during the exec run.",
          evidence: evidenceId
        }
      ]
    });
    return;
  }

  if (itemType === "error") {
    counters.error += 1;
    run.evidence.push({
      id: `codex-item-error-${counters.error}`,
      kind: "codex_item_error",
      result: "warn",
      excerpt: excerpt(String(item.message ?? "unknown error"))
    });
    return;
  }

  // reasoning and todo_list items are deliberately not exported.
  if (itemType === "reasoning" || itemType === "todo_list" || itemType === "agent_message") return;

  // Unrecognized item types fail closed: they become actions whose type no
  // bundled policy classifies, so a newer Codex surface cannot pass silently.
  counters.unknown = (counters.unknown ?? 0) + 1;
  run.actions.push({
    id: `codex-unrecognized-${counters.unknown}`,
    type: `codex_item:${slug(itemType || "missing")}`,
    target: `codex.item:${String(item.id ?? counters.unknown)}`,
    approval: "not_recorded",
    outcome: phase === "incomplete" ? "incomplete" : "unknown",
    note: "Unrecognized codex exec item type. Classify it in policy.actionRisk after review."
  });
}

// A patch that only writes a ByteFence intent is part of the mediated path:
// the intent is an input to bytefence_apply, never the protected target.
function isByteFenceIntentPath(path) {
  if (typeof path !== "string") return false;
  const normalized = path.replace(/\\/g, "/");
  return normalized === ".bytefence/intents" ||
    normalized.startsWith(".bytefence/intents/") ||
    normalized.includes("/.bytefence/intents/");
}

function parseByteFenceToolResult(item) {
  const blocks = Array.isArray(item?.result?.content) ? item.result.content : [];
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string" && "exitCode" in parsed) {
        return parsed;
      }
    } catch {
      // Not a JSON ByteFence summary.
    }
  }
  return null;
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
