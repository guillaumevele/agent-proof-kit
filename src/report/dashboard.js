export function renderProofDashboard({ bundle, gateCoverageMarkdown, attestation }) {
  const findings = [
    ...(bundle.evaluation?.findings ?? []),
    ...(bundle.scan?.findings ?? []),
    ...(bundle.diff?.newFindings ?? [])
  ];
  const counts = countBySeverity(findings);
  const status = String(bundle.status ?? "unknown");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Proof Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172026;
      --muted: #5b6770;
      --line: #d8dee4;
      --panel: #f7f9fb;
      --pass: #116b4f;
      --fail: #9a3412;
      --critical: #8f1d1d;
      --high: #b45309;
      --medium: #856404;
      --low: #4b5563;
    }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: #fff;
      line-height: 1.45;
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    header {
      border-bottom: 1px solid var(--line);
      padding-bottom: 20px;
      margin-bottom: 24px;
    }
    h1, h2 {
      margin: 0;
      letter-spacing: 0;
    }
    h1 {
      font-size: 32px;
      line-height: 1.12;
    }
    h2 {
      font-size: 18px;
      margin-bottom: 12px;
    }
    .meta {
      color: var(--muted);
      margin-top: 8px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin: 20px 0 28px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: var(--panel);
      min-height: 84px;
    }
    .label {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
    }
    .value {
      font-size: 24px;
      font-weight: 700;
    }
    .status-pass { color: var(--pass); }
    .status-fail { color: var(--fail); }
    section {
      margin-top: 28px;
      border-top: 1px solid var(--line);
      padding-top: 24px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
    }
    code {
      background: #eef2f6;
      border-radius: 4px;
      padding: 2px 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Agent Proof Dashboard</h1>
      <div class="meta">${escapeHtml(bundle.subject ?? "Unknown subject")} · ${escapeHtml(bundle.tool?.name ?? "agent-proof-kit")} ${escapeHtml(bundle.tool?.version ?? "")}</div>
    </header>

    <div class="grid">
      ${metric("Status", status.toUpperCase(), `status-${status}`)}
      ${metric("Score", String(bundle.evaluation?.score ?? "n/a"))}
      ${metric("Run", bundle.evaluation?.runId ?? "n/a")}
      ${metric("Files scanned", String(bundle.scan?.filesScanned ?? 0))}
      ${metric("Findings", String(findings.length))}
      ${metric("Digest", attestation?.digest?.value ? attestation.digest.value.slice(0, 12) : "not generated")}
    </div>

    <section>
      <h2>Finding Severity</h2>
      <div class="grid">
        ${metric("Critical", String(counts.critical), "critical")}
        ${metric("High", String(counts.high), "high")}
        ${metric("Medium", String(counts.medium), "medium")}
        ${metric("Low", String(counts.low), "low")}
      </div>
    </section>

    <section>
      <h2>Findings</h2>
      ${renderFindingsTable(findings)}
    </section>

    <section>
      <h2>Proof Bundle Attestation</h2>
      <table>
        <tbody>
          <tr><th>Digest algorithm</th><td>${escapeHtml(attestation?.digest?.algorithm ?? "not generated")}</td></tr>
          <tr><th>Digest value</th><td><code>${escapeHtml(attestation?.digest?.value ?? "not generated")}</code></td></tr>
          <tr><th>Signature</th><td>${attestation?.signature ? escapeHtml(attestation.signature.algorithm) : "not present"}</td></tr>
        </tbody>
      </table>
    </section>

    <section>
      <h2>Gate Coverage</h2>
      <pre>${escapeHtml(gateCoverageMarkdown ?? "Gate coverage not provided.")}</pre>
    </section>
  </main>
</body>
</html>
`;
}

function metric(label, value, className = "") {
  return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value ${escapeHtml(className)}">${escapeHtml(value)}</div></div>`;
}

function renderFindingsTable(findings) {
  if (!findings.length) {
    return "<p>No findings in the proof bundle.</p>";
  }
  const rows = findings.map((finding) => `<tr>
    <td>${escapeHtml(finding.severity ?? "unknown")}</td>
    <td>${escapeHtml(finding.id ?? "unknown")}</td>
    <td>${escapeHtml(finding.title ?? "")}</td>
    <td><code>${escapeHtml(finding.location ?? "unknown")}</code></td>
  </tr>`).join("\n");
  return `<table>
    <thead><tr><th>Severity</th><th>ID</th><th>Title</th><th>Location</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1;
  }
  return counts;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
