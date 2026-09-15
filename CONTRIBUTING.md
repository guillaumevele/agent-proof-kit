# Contributing

Contributions should keep the project narrow, deterministic, and safe to review publicly.

## Getting Started

Node.js 22 or later is required.

```bash
git clone https://github.com/guillaumevele/agent-proof-kit.git
cd agent-proof-kit
npm ci
npm run verify
```

`npm run verify` runs every test suite and checks that generated artifacts are
current. Run a single suite while iterating, for example
`npm run test:adapter` or `npm run test:mcp`.

Issues labeled [`good first issue`](https://github.com/guillaumevele/agent-proof-kit/labels/good%20first%20issue)
are scoped to one file or behavior and name the test to add. Comment on the
issue before starting so work is not duplicated.

## Adding a Trace Adapter

1. Add the source name to `supportedTraceSources` in `src/core/trace-export.js`.
2. Base the mapping on the framework's published schema and link it in
   `docs/integrations/trace-adapters.md`.
3. Add a synthetic fixture under `examples/adapters/` and tests under
   `tests/adapter/`. Unknown record types should fail closed.
4. Never copy prompts, reasoning text, tool arguments or command output into the
   exported run unless the adapter documents why.

## Fixture Rules

- Use synthetic examples only.
- Use reserved domains such as `example.com`.
- Do not include real prompts, logs, user data, client names, private app names, or credentials.
- Prefer small fixtures that exercise one behavior clearly.
- Add new action types to `policy.actionRisk`; unknown completed action types fail closed by design.

## Pull Request Expectations

- Explain which invariant changed.
- Add or update a test for behavior changes.
- Regenerate `docs/generated/sample-agent-proof-report.md` when report output changes.
- Regenerate machine artifacts with `npm run artifacts:generate` when SARIF, diff, adapter or bundle output changes.
- `npm run verify` checks freshness and must not rewrite generated artifacts.
- Keep provider-specific integrations optional.

## Scope Discipline

This is not a general agent framework. Changes should make release gates, proof reports, or public-surface safety more reliable.
