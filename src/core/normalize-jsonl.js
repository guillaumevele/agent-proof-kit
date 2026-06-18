export function normalizeJsonlTrace(text) {
  const events = parseJsonl(text);
  const run = {
    schemaVersion: 1,
    runId: "normalized-agent-run",
    subject: "Normalized synthetic agent trace",
    synthetic: true,
    generatedAt: null,
    agent: {
      name: "Unknown agent",
      provider: "normalized-jsonl"
    },
    objectives: [],
    inputs: [],
    actions: [],
    outputs: [],
    evidence: []
  };

  for (const event of events) {
    const eventType = event.event ?? event.type;
    if (eventType === "session") {
      Object.assign(run, pick(event, ["runId", "subject", "synthetic", "generatedAt"]));
      if (event.agent) run.agent = event.agent;
      continue;
    }
    if (eventType === "objective") {
      run.objectives.push(event.text);
      continue;
    }
    if (eventType === "input") {
      run.inputs.push(stripType(event));
      continue;
    }
    if (eventType === "action") {
      run.actions.push(stripType(event));
      continue;
    }
    if (eventType === "output") {
      run.outputs.push({
        claims: [],
        ...stripType(event)
      });
      continue;
    }
    if (eventType === "evidence") {
      run.evidence.push(stripType(event));
    }
  }

  return run;
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL on line ${index + 1}: ${error.message}`);
      }
    });
}

function stripType(event) {
  const { event: _event, ...rest } = event;
  return rest;
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
