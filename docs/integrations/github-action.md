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
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22.x
      - uses: guillaumevele/agent-proof-kit@v0.2.0
        with:
          input: examples/synthetic-agent-run.json
          policy: policies/default-policy.json
          report: agent-proof-report.md
          sarif: agent-proof-results.sarif
```

The action writes a Markdown report and a SARIF file. It fails when the underlying CLI gate fails.

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
