import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyByteFenceTransaction } from "../../../../src/core/bytefence-apply.js";
import { BYTEFENCE_INTENT_SCHEMA } from "../../../../src/core/bytefence-contract.js";

const [root, readyPath, releasePath, receiptPath] = process.argv.slice(2);
const waiter = new Int32Array(new SharedArrayBuffer(4));
const policyBytes = readFileSync(
  new URL("../../../../policies/bytefence-default.json", import.meta.url)
);
const intentBytes = Buffer.from(JSON.stringify({
  $schema: BYTEFENCE_INTENT_SCHEMA,
  operation: "exactReplace",
  targetPath: "target.txt",
  encoding: "utf-8",
  oldText: "value=old",
  newText: "value=new",
  expectedOccurrences: 1
}), "utf8");

const result = applyByteFenceTransaction({
  root,
  intentBytes,
  policyBytes,
  workspaceId: "example/concurrent-apply",
  observedAt: "2026-07-13T10:00:00Z",
  receiptProfile: "public",
  receiptPath,
  onStage(stage) {
    if (stage !== "after-preflight") return;
    writeFileSync(readyPath, "ready\n");
    const deadline = Date.now() + 10_000;
    while (!existsSync(releasePath)) {
      if (Date.now() > deadline) throw new Error("concurrency barrier timeout");
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
});

process.stdout.write(JSON.stringify({
  status: result.status,
  exitCode: result.exitCode,
  findingIds: (result.findings ?? []).map((finding) => finding.id)
}));
