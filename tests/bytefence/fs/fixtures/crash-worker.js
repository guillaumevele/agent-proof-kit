import { readFileSync, writeFileSync } from "node:fs";
import { applyByteFenceTransaction } from "../../../../src/core/bytefence-apply.js";
import { BYTEFENCE_INTENT_SCHEMA } from "../../../../src/core/bytefence-contract.js";

const [root, crashStage, readyPath] = process.argv.slice(2);
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

applyByteFenceTransaction({
  root,
  intentBytes,
  policyBytes,
  workspaceId: "example/crash-apply",
  observedAt: "2026-07-13T10:00:00Z",
  receiptProfile: "public",
  receiptPath: "receipts/crash.json",
  onStage(stage) {
    if (stage !== crashStage) return;
    writeFileSync(readyPath, `${stage}\n`);
    for (;;) Atomics.wait(waiter, 0, 0, 1_000);
  }
});
