# Public Boundary

This repository is built to demonstrate AI-agent evaluation work without exposing private product work.

## Included

- Synthetic agent traces.
- Reserved domains such as `example.com`.
- Generic policy gates.
- Deterministic tests.
- Reproducible Markdown, SARIF and JSON proof artifacts.

## Excluded

- Private app names.
- Customer or patient data.
- Real prompts from commercial work.
- Production logs.
- Screenshots of private tools.
- API keys, access tokens, or environment files.
- Internal URLs, staging domains, or private package names.

## Review Rule

If an example cannot be understood without private context, it does not belong in this repository. It should be replaced with a synthetic fixture that preserves the behavior under test.

## Release Checklist

Before publishing a change:

```bash
npm run verify
git diff --check
git grep -nE 'sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{30,}|AIza[0-9A-Za-z_-]{20,}' -- . ':!docs/public-boundary.md'
```

The project scan is the source of truth; the manual grep is an extra reviewer convenience.

Downstream repositories should populate `policy.privateTerms` with internal product names, customer names,
staging domains and codenames before relying on the public-surface scan. The default policy cannot detect
private terms it has not been given.
