# Security Policy

## Supported Versions

The default branch is the supported development line.

## Reporting a Vulnerability

Please use [private vulnerability reporting](https://github.com/guillaumevele/agent-proof-kit/security/advisories/new).
Do not open a public issue for a vulnerability. Expect an acknowledgement within
seven days. ByteFence path confinement, receipt verification and the MCP
workspace boundary are in scope; see the [threat model](docs/threat-model.md).

## Public Data Boundary

This repository must not contain:

- API keys or access tokens.
- Real environment files.
- Private app, customer, or user data.
- Production logs.
- Internal URLs or staging domains.

Run the local gate before opening a pull request:

```bash
npm run verify
```

If a real secret was committed, remove it from history and rotate the credential.
