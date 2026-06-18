# MCP Integration

Agent Proof Kit ships a local stdio MCP server in [bin/agent-proof-mcp.js](../../bin/agent-proof-mcp.js).
It is designed for assistants that need to inspect or run release gates without memorizing CLI flags.

The server is local-only by default. It does not call model providers, external APIs, or remote services.
Workspace paths are constrained to `AGENT_PROOF_ROOT` or the process working directory.

## Install

From a repository that wants to run proof gates:

```bash
npm install --save-dev agent-proof-kit
```

For local development from this repository:

```bash
node bin/agent-proof-mcp.js
```

Do not run the server directly in a normal terminal unless you expect it to wait on stdio. MCP clients
spawn it as a subprocess.

## Claude Desktop Example

```json
{
  "mcpServers": {
    "agent-proof-kit": {
      "command": "npx",
      "args": ["--yes", "--package", "agent-proof-kit", "agent-proof-mcp"],
      "env": {
        "AGENT_PROOF_ROOT": "/absolute/path/to/repository"
      }
    }
  }
}
```

When developing this repository locally, use:

```json
{
  "mcpServers": {
    "agent-proof-kit-local": {
      "command": "node",
      "args": ["/absolute/path/to/agent-proof-kit/bin/agent-proof-mcp.js"],
      "env": {
        "AGENT_PROOF_ROOT": "/absolute/path/to/agent-proof-kit"
      }
    }
  }
}
```

## Tools

| Tool | Purpose | Side effect |
| --- | --- | --- |
| `agent_proof_status` | Summarizes package version, workspace root, bundled examples and generated artifacts. | None |
| `agent_proof_verify_run` | Evaluates an agent-run JSON file against a policy. | None |
| `agent_proof_scan_surface` | Scans a workspace directory for secret-shaped values, configured private terms, unsafe filenames and oversized files. | None |
| `agent_proof_compile_policy` | Compiles YAML/JSON policy definitions into the public policy JSON contract. | Optional write |
| `agent_proof_export_trace` | Converts a supported JSONL trace into an Agent Proof Kit fixture, with optional term redaction and file output. | Optional write |
| `agent_proof_diff_runs` | Compares a baseline run and candidate run under the same policy. | None |
| `agent_proof_create_bundle` | Creates a combined proof bundle and can optionally write it under the workspace root. | Optional write |
| `agent_proof_sign_bundle` | Creates a detached SHA-256 attestation, with optional local RSA-SHA256 signing. | Optional write |
| `agent_proof_verify_bundle_signature` | Verifies proof bundle digest and optional RSA signature against an attestation. | None |
| `agent_proof_render_dashboard` | Renders a local HTML proof dashboard from bundle, coverage and attestation inputs. | Optional write |
| `agent_proof_read_artifact` | Reads one checked-in generated proof artifact by logical name. | None |

## Recommended Assistant Workflow

1. Call `agent_proof_status` to confirm the package and workspace roots.
2. Call `agent_proof_scan_surface` with project-specific `private_terms` before publishing.
3. Call `agent_proof_compile_policy` when a YAML policy DSL file needs to become reviewable JSON.
4. Call `agent_proof_export_trace` when the team has LangGraph, CrewAI, AutoGen or JSONL traces but not yet an Agent Proof Kit fixture.
5. Call `agent_proof_verify_run` on the run fixture or exported agent trace.
6. Call `agent_proof_diff_runs` when comparing a candidate run with a known-good baseline.
7. Call `agent_proof_create_bundle` when a single JSON proof object is needed for CI artifacts or review.
8. Call `agent_proof_sign_bundle` and `agent_proof_verify_bundle_signature` when the bundle needs provenance.
9. Call `agent_proof_render_dashboard` when a reviewer needs a local HTML proof artifact.
10. Call `agent_proof_read_artifact` to inspect the checked-in sample proof bundle, SARIF export, attestation, dashboard or gate coverage matrix.

## Security Boundary

- The server never shells out to arbitrary commands.
- Workspace paths are resolved under `AGENT_PROOF_ROOT` or the process working directory.
- If a tool path resolves outside the workspace root, the tool returns an error instead of reading or writing.
- The default scanner detects common secret-shaped values and configured `privateTerms`; downstream projects should pass their own internal names through `private_terms`.
- `agent_proof_export_trace`, `agent_proof_compile_policy`, `agent_proof_create_bundle`, `agent_proof_sign_bundle` and `agent_proof_render_dashboard` write only when `write_path` is provided and that path stays under the workspace root.
- `agent_proof_sign_bundle` reads a private key only when `private_key` is explicitly provided and the key path stays under the workspace root.

## Example Prompts

- "Use Agent Proof Kit to scan this repository before I publish it. Add these private terms: alpha-internal, staging.example."
- "Export `traces/langgraph-stream.json` with source `langgraph-stream`, redact `alpha-internal`, then verify the result."
- "Compile `policies/high-stakes.yaml`, then verify `agent-runs/candidate.json` against the compiled policy."
- "Verify `agent-runs/candidate.json` against `policies/default-policy.json` and summarize the blocking findings."
- "Compare `agent-runs/baseline.json` and `agent-runs/candidate.json`, then create a proof bundle under `artifacts/proof-bundle.json`."
- "Sign `artifacts/proof-bundle.json`, verify the attestation, then render a dashboard under `artifacts/proof-dashboard.html`."
- "Read the gate coverage matrix and tell me which public claims are backed by tests."
