import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalByteFenceJsonBytes } from "../../src/core/bytefence-contract.js";
import { verifyByteFenceReceipt } from "../../src/core/bytefence-receipt.js";

const serverPath = resolve("bin/agent-proof-mcp.js");
const policyBytes = readFileSync(resolve("policies/bytefence-default.json"));
const intentSchema =
  "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json";

test("discovers ByteFence tools with honest MCP annotations", async () => {
  const workspace = fixtureWorkspace();
  const client = await connectClient(workspace.root);
  try {
    const listed = await client.listTools();
    const check = listed.tools.find((tool) => tool.name === "bytefence_check");
    const apply = listed.tools.find((tool) => tool.name === "bytefence_apply");

    assert.ok(check);
    assert.deepEqual(check.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    assert.deepEqual(check.inputSchema.required.sort(), [
      "candidate_path",
      "intent_path",
      "policy_path",
      "workspace_id"
    ]);

    assert.ok(apply);
    assert.deepEqual(apply.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    });
    assert.deepEqual(apply.inputSchema.required.sort(), [
      "intent_path",
      "policy_path",
      "receipt_path",
      "workspace_id"
    ]);
  } finally {
    await client.close();
  }
});

test("checks an allowed raw-byte candidate without changing the target", async () => {
  const workspace = fixtureWorkspace();
  const before = readFileSync(workspace.targetPath);
  const client = await connectClient(workspace.root);
  try {
    const result = await client.callTool({
      name: "bytefence_check",
      arguments: checkArguments()
    });
    const responseText = textContent(result);
    const payload = JSON.parse(responseText);

    assert.equal(result.isError, undefined);
    assert.equal(payload.status, "allow");
    assert.equal(payload.allowed, true);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.effectiveGuaranteeLevel, "CORE_PROVEN");
    assert.match(payload.receiptDigest, /^[a-f0-9]{64}$/);
    const receiptBytes = canonicalByteFenceJsonBytes(payload.receipt);
    assert.equal(sha256(receiptBytes), payload.receiptDigest);
    const verification = verifyByteFenceReceipt({
      receipt: receiptBytes,
      preimage: workspace.before,
      candidate: workspace.expectedCandidate,
      intentBytes: readFileSync(join(workspace.root, "intent.json")),
      policyBytes,
      workspaceId: "tests/mcp-bytefence",
      expectedReceiptDigest: payload.receiptDigest
    });
    assert.equal(verification.status, "verified");
    assert.equal(verification.verified, true);
    assert.equal(verification.authorized, true);
    assert.deepEqual(readFileSync(workspace.targetPath), before);
    assertNoSourceDisclosure(responseText, workspace);
  } finally {
    await client.close();
  }
});

test("denies a candidate with an out-of-scope raw-byte mutation", async () => {
  const workspace = fixtureWorkspace({
    candidate: Buffer.from(
      "private-prefix-preserved\r\nanchor=new\r\nisolated\nprivate-suffix-corrupted\r\n",
      "utf8"
    )
  });
  const before = readFileSync(workspace.targetPath);
  const client = await connectClient(workspace.root);
  try {
    const result = await client.callTool({
      name: "bytefence_check",
      arguments: checkArguments()
    });
    const responseText = textContent(result);
    const payload = JSON.parse(responseText);

    assert.equal(payload.status, "deny");
    assert.equal(payload.allowed, false);
    assert.equal(payload.exitCode, 1);
    assert.ok(payload.findings.some((finding) => finding.code === "candidate.derivationMismatch"));
    assert.deepEqual(readFileSync(workspace.targetPath), before);
    assertNoSourceDisclosure(responseText, workspace);
    assert.equal(responseText.includes("private-suffix-corrupted"), false);
  } finally {
    await client.close();
  }
});

test("applies one exact replacement and persists a fresh public transaction receipt", async () => {
  const workspace = fixtureWorkspace();
  const client = await connectClient(workspace.root);
  try {
    const result = await client.callTool({
      name: "bytefence_apply",
      arguments: applyArguments()
    });
    const responseText = textContent(result);
    const payload = JSON.parse(responseText);
    const receiptBytes = readFileSync(workspace.receiptPath);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));

    assert.equal(result.isError, undefined);
    assert.equal(payload.status, "allow");
    assert.equal(payload.allowed, true);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.declaredGuaranteeLevel, "MEDIATED_PROVEN");
    assert.equal(payload.effectiveGuaranteeLevel, "CORE_PROVEN");
    assert.equal(payload.mediationEnvironmentTrusted, false);
    assert.equal(payload.phase, "postApply");
    assert.equal(payload.receiptPersisted, true);
    assert.equal(payload.retryAutomatically, false);
    assert.equal(payload.receiptDigest, sha256(receiptBytes));
    assert.deepEqual(readFileSync(workspace.targetPath), workspace.expectedCandidate);
    assert.equal(receipt._type, "ByteFenceTransactionReceipt/v0.1");
    assert.equal(receipt.preflight.predicate.receiptProfile, "public");
    assert.equal(receipt.postApply.predicate.phase, "postApply");
    assertNoSourceDisclosure(responseText, workspace);
    assertNoSourceDisclosure(receiptBytes.toString("utf8"), workspace);
  } finally {
    await client.close();
  }
});

test("fails closed before mutation when the immutable receipt path already exists", async () => {
  const workspace = fixtureWorkspace();
  const sentinel = Buffer.from("existing-receipt-must-survive\n", "utf8");
  const before = readFileSync(workspace.targetPath);
  writeFileSync(workspace.receiptPath, sentinel);
  const client = await connectClient(workspace.root);
  try {
    const result = await client.callTool({
      name: "bytefence_apply",
      arguments: applyArguments()
    });
    const payload = JSON.parse(textContent(result));

    assert.equal(payload.status, "invalid");
    assert.equal(payload.allowed, false);
    assert.equal(payload.exitCode, 2);
    assert.equal(payload.receiptPersisted, false);
    assert.equal(payload.receiptDigest, null);
    assert.equal(payload.retryAutomatically, false);
    assert.ok(payload.findings.some((finding) => finding.code === "receipt.exists"));
    assert.deepEqual(readFileSync(workspace.targetPath), before);
    assert.deepEqual(readFileSync(workspace.receiptPath), sentinel);
  } finally {
    await client.close();
  }
});

test("fails closed without disclosure when a candidate exceeds policy byte limits", async () => {
  const oversizedSecret = "private-oversized-candidate-fragment";
  const policy = JSON.parse(policyBytes.toString("utf8"));
  policy.maxTargetBytes = 128;
  const workspace = fixtureWorkspace({
    candidate: Buffer.from(`${oversizedSecret}${"x".repeat(256)}`, "utf8"),
    policy
  });
  const before = readFileSync(workspace.targetPath);
  const client = await connectClient(workspace.root);
  try {
    const result = await client.callTool({
      name: "bytefence_check",
      arguments: checkArguments()
    });
    const responseText = textContent(result);

    assert.equal(result.isError, true);
    assert.match(responseText, /limit|too large|maximum/i);
    assert.equal(responseText.includes(oversizedSecret), false);
    assert.deepEqual(readFileSync(workspace.targetPath), before);
  } finally {
    await client.close();
  }
});

test("confines candidate and receipt paths to AGENT_PROOF_ROOT", async () => {
  const workspace = fixtureWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "bytefence-mcp-outside-"));
  writeFileSync(join(outside, "candidate.bin"), workspace.expectedCandidate);
  const before = readFileSync(workspace.targetPath);
  const client = await connectClient(workspace.root);
  try {
    const escapedCandidate = await client.callTool({
      name: "bytefence_check",
      arguments: {
        ...checkArguments(),
        candidate_path: join(outside, "candidate.bin")
      }
    });
    assert.equal(escapedCandidate.isError, true);
    assert.match(textContent(escapedCandidate), /relative path|workspace root/i);

    const escapedReceipt = await client.callTool({
      name: "bytefence_apply",
      arguments: {
        ...applyArguments(),
        receipt_path: join(outside, "receipt.json")
      }
    });
    const payload = JSON.parse(textContent(escapedReceipt));
    assert.equal(payload.status, "invalid");
    assert.ok(payload.findings.some((finding) => finding.code === "receipt.pathOutsideRoot"));
    assert.equal(payload.retryAutomatically, false);
    assert.deepEqual(readFileSync(workspace.targetPath), before);
  } finally {
    await client.close();
  }
});

function fixtureWorkspace({ candidate, policy } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bytefence-mcp-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "receipts"));
  const before = Buffer.from(
    "private-prefix-preserved\r\nanchor=old\r\nisolated\nprivate-suffix-preserved\r\n",
    "utf8"
  );
  const expectedCandidate = Buffer.from(
    "private-prefix-preserved\r\nanchor=new\r\nisolated\nprivate-suffix-preserved\r\n",
    "utf8"
  );
  const targetPath = join(root, "src", "private-target.txt");
  const receiptPath = join(root, "receipts", "transaction.json");
  writeFileSync(targetPath, before);
  writeFileSync(join(root, "candidate.bin"), candidate ?? expectedCandidate);
  writeFileSync(
    join(root, "policy.json"),
    policy ? Buffer.from(JSON.stringify(policy), "utf8") : policyBytes
  );
  writeFileSync(join(root, "intent.json"), JSON.stringify({
    $schema: intentSchema,
    operation: "exactReplace",
    targetPath: "src/private-target.txt",
    encoding: "utf-8",
    oldText: "anchor=old",
    newText: "anchor=new",
    expectedOccurrences: 1
  }));
  return {
    root,
    before,
    expectedCandidate,
    targetPath,
    receiptPath,
    sourceFragments: [
      "private-prefix-preserved",
      "anchor=old",
      "anchor=new",
      "private-suffix-preserved"
    ]
  };
}

function checkArguments() {
  return {
    intent_path: "intent.json",
    policy_path: "policy.json",
    candidate_path: "candidate.bin",
    workspace_id: "tests/mcp-bytefence"
  };
}

function applyArguments() {
  return {
    intent_path: "intent.json",
    policy_path: "policy.json",
    workspace_id: "tests/mcp-bytefence",
    receipt_path: "receipts/transaction.json"
  };
}

async function connectClient(workspaceRoot) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      AGENT_PROOF_ROOT: workspaceRoot
    }
  });
  const client = new Client({
    name: "bytefence-mcp-test",
    version: "1.0.0"
  });
  await client.connect(transport);
  return client;
}

function textContent(result) {
  return result.content.map((item) => item.text ?? "").join("\n");
}

function assertNoSourceDisclosure(text, workspace) {
  for (const fragment of workspace.sourceFragments) {
    assert.equal(text.includes(fragment), false, `response disclosed ${fragment}`);
  }
  assert.equal(/prompt/i.test(text), false);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
