# Security Policy

## Supported Versions

The default branch is the supported development line.

## Reporting a Vulnerability

Please open a private vulnerability report through GitHub Security Advisories if available. If not, open a minimal issue that describes the affected area without posting secrets or exploit material.

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
