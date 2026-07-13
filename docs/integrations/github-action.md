# GitHub Action Integration

Agent Proof Kit ships a composite action in [action.yml](../../action.yml).

```yaml
name: Agent proof

on:
  pull_request:

permissions:
  contents: read

jobs:
  agent-proof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          node-version: 22.x
      - uses: guillaumevele/agent-proof-kit@v0.5.0
        with:
          input: examples/synthetic-agent-run.json
          policy: policies/default-policy.json
          report: agent-proof-report.md
          sarif: agent-proof-results.sarif
```

The action writes a Markdown report and a SARIF file. It fails when the underlying CLI gate fails.

The action is self-contained from a clean consumer checkout: before invoking
the CLI, it installs only the production dependency graph pinned by the
repository's `package-lock.json` inside `github.action_path`. The install uses
`npm ci --omit=dev --ignore-scripts --no-audit --no-fund`; callers therefore do
not need to install this repository's dependencies themselves. A Node.js 22 or
newer runtime and npm registry access (or a populated npm cache) are still
required.

Action inputs are passed to the CLI through environment variables and quoted
as single shell arguments. Paths containing spaces or shell metacharacters are
therefore treated as literal paths rather than executable shell syntax.

## Code Scanning

The generated SARIF is SARIF `2.1.0`. GitHub documents `github/codeql-action/upload-sarif@v4` for uploading third-party SARIF to code scanning, with `security-events: write`.

Official references:

- https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file
- https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support

## Gate Hardening

For downstream repositories, combine the action with:

- required status checks on protected branches
- unique job names
- least-privilege `GITHUB_TOKEN` permissions
- workflow `concurrency` for release gates

Official references:

- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- https://docs.github.com/en/actions/reference/security/secure-use
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
