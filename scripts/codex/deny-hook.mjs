#!/usr/bin/env node
// Unconditional PreToolUse deny, used by hook-conformance.sh to measure whether
// a Codex CLI build actually enforces a denial. AGENT_PROOF_DENY_MODE selects
// the documented channel: "exit2" (exit code 2 + reason on stderr) or "json"
// (exit 0 + hookSpecificOutput.permissionDecision = "deny").
const mode = process.env.AGENT_PROOF_DENY_MODE ?? "exit2";
const reason = "conformance probe: this tool call must not run";
if (mode === "json") {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  })}\n`);
  process.exit(0);
}
process.stderr.write(`${reason}\n`);
process.exit(2);
