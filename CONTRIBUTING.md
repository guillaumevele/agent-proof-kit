# Contributing

Contributions should keep the project narrow, deterministic, and safe to review publicly.

## Local Verification

```bash
npm run verify
```

## Fixture Rules

- Use synthetic examples only.
- Use reserved domains such as `example.com`.
- Do not include real prompts, logs, user data, client names, private app names, or credentials.
- Prefer small fixtures that exercise one behavior clearly.

## Pull Request Expectations

- Explain which invariant changed.
- Add or update a test for behavior changes.
- Regenerate `docs/generated/sample-agent-proof-report.md` when report output changes.
- Keep provider-specific integrations optional.

## Scope Discipline

This is not a general agent framework. Changes should make release gates, proof reports, or public-surface safety more reliable.
