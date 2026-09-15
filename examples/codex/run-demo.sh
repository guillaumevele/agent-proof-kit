#!/usr/bin/env bash
# End-to-end Codex CLI + ByteFence demo.
#
# Creates a throwaway git workspace, lets `codex exec` change one protected line
# through the agent_proof_kit MCP server, then checks the result three ways:
#   1. the target bytes equal the single authorized candidate,
#   2. the ByteFence receipt verifies independently,
#   3. the exported Codex trace passes the strict ByteFence policy.
#
# Requirements: Node.js 22+, a logged-in Codex CLI, and `npm ci` in this repo.
# The run uses the Codex account's normal model quota. Nothing leaves the
# temporary workspace except the model request made by Codex itself.
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CODEX_BIN="${CODEX_BIN:-codex}"
WS="${1:-$(mktemp -d "${TMPDIR:-/tmp}/codex-bytefence-demo.XXXXXX")}"
WORKSPACE_ID="example/codex-bytefence-demo"
INTENT_SCHEMA="https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json"

mkdir -p "$WS/src" "$WS/.bytefence/intents" "$WS/.bytefence/receipts" "$WS/.bytefence/snapshots"
cat > "$WS/src/config.js" <<'JS'
// Synthetic demo configuration.
export const config = {
  service: "example-api",
  baseUrl: "https://api.example.com",
  retries: 2,
  timeoutMs: 1000,
  featureFlag: false,
};
JS
cp "$KIT/policies/bytefence-default.json" "$WS/.bytefence/policy.json"
cp "$WS/src/config.js" "$WS/.bytefence/snapshots/config.before"
sed -n '/^# ByteFence edit protocol/,$p' "$KIT/examples/codex/AGENTS.md" > "$WS/AGENTS.md"
git -C "$WS" init -q
git -C "$WS" add -A
git -C "$WS" -c user.name=demo -c user.email=demo@example.com commit -qm "demo baseline"

echo "workspace: $WS"

"$CODEX_BIN" exec --json --skip-git-repo-check --cd "$WS" -s workspace-write \
  -c "mcp_servers.agent_proof_kit.command=\"$(command -v node)\"" \
  -c "mcp_servers.agent_proof_kit.args=[\"$KIT/bin/agent-proof-mcp.js\"]" \
  -c "mcp_servers.agent_proof_kit.env={AGENT_PROOF_ROOT=\"$WS\"}" \
  -c 'mcp_servers.agent_proof_kit.required=true' \
  -c 'mcp_servers.agent_proof_kit.enabled_tools=["agent_proof_status","bytefence_check","bytefence_apply"]' \
  -c 'mcp_servers.agent_proof_kit.tools.bytefence_check.approval_mode="approve"' \
  -c 'mcp_servers.agent_proof_kit.tools.bytefence_apply.approval_mode="approve"' \
  "Set featureFlag to true in src/config.js. src/config.js is a protected file: follow the ByteFence edit protocol in AGENTS.md exactly, use workspace_id $WORKSPACE_ID, and do not edit the file any other way." \
  < /dev/null > "$WS/codex-exec.jsonl"

node - "$WS" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const ws = process.argv[2];
const before = readFileSync(`${ws}/.bytefence/snapshots/config.before`, "utf8");
writeFileSync(`${ws}/.bytefence/snapshots/config.candidate`, before.replace("featureFlag: false", "featureFlag: true"));
JS
cmp "$WS/src/config.js" "$WS/.bytefence/snapshots/config.candidate"
echo "target matches the authorized candidate"

receipt="$(ls -t "$WS"/.bytefence/receipts/*.json | head -n 1)"
intent="$(ls -t "$WS"/.bytefence/intents/*.json | head -n 1)"
grep -qF "$INTENT_SCHEMA" "$intent"
node "$KIT/bin/agent-proof.js" bytefence-verify \
  --receipt "$receipt" \
  --before "$WS/.bytefence/snapshots/config.before" \
  --candidate "$WS/.bytefence/snapshots/config.candidate" \
  --intent "$intent" \
  --policy "$WS/.bytefence/policy.json" \
  --workspace-id "$WORKSPACE_ID" \
  --root "$WS" > "$WS/bytefence-verify.json"
node -e 'const r=require(process.argv[1]); if (r.status !== "verified") { console.error(r); process.exit(1); } console.log(`receipt verified (${r.effectiveGuaranteeLevel})`);' "$WS/bytefence-verify.json"

node "$KIT/bin/agent-proof.js" export --from codex-exec-jsonl \
  --input "$WS/codex-exec.jsonl" --out "$WS/codex-run.json" > /dev/null
node "$KIT/bin/agent-proof.js" verify \
  --input "$WS/codex-run.json" \
  --policy "$KIT/policies/codex-bytefence-strict-policy.json"
