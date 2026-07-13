import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BYTEFENCE_INTENT_SCHEMA,
  UTF8_BOM,
  byteFenceCandidateMatches,
  deriveByteFenceMutation,
  parseByteFenceIntent
} from "../../../src/core/bytefence-contract.js";
import { evaluateByteFence } from "../../../src/core/bytefence-evaluate.js";

test("rejects 100,000 seeded out-of-range byte mutations with zero false allows", () => {
  const intentBytes = Buffer.from(
    JSON.stringify({
      $schema: BYTEFENCE_INTENT_SCHEMA,
      operation: "exactReplace",
      targetPath: "src/property-fixture.txt",
      encoding: "utf-8",
      oldText: "enabled=false",
      newText: "enabled=true",
      expectedOccurrences: 1
    })
  );
  const policyBytes = readFileSync("policies/bytefence-default.json");
  const preimage = Buffer.from(
    "prefix-preserved-0123456789\r\nconfig: enabled=false\nsuffix-preserved-𐐀-0123456789\n",
    "utf8"
  );
  const mutation = deriveByteFenceMutation(preimage, parseByteFenceIntent(intentBytes));
  const outsidePositions = Array.from({ length: mutation.candidate.length }, (_, index) => index).filter(
    (index) => index < mutation.range.after.start || index >= mutation.range.after.end
  );
  assert.ok(outsidePositions.length > 0);
  assert.equal(byteFenceCandidateMatches(mutation.candidate, mutation.candidate), true);

  let state = 0x7f4a7c15;
  let falseAllows = 0;
  let fullEvaluatorFalseAllows = 0;
  for (let iteration = 0; iteration < 100_000; iteration += 1) {
    state = xorshift32(state);
    const position = outsidePositions[state % outsidePositions.length];
    state = xorshift32(state);
    const delta = (state % 255) + 1;
    const candidate = Buffer.from(mutation.candidate);
    candidate[position] ^= delta;

    if (byteFenceCandidateMatches(candidate, mutation.candidate)) falseAllows += 1;

    // Sample the complete receipt-producing evaluator to prove that it is wired
    // to the same byte-exact primitive without making the 100k corpus CI-bound.
    if (iteration % 512 === 0) {
      const result = evaluateByteFence({
        preimage,
        candidate,
        intentBytes,
        policyBytes,
        workspaceId: "bytefence/property-fixture",
        observedAt: "2026-07-13T16:00:00Z"
      });
      if (result.allowed) fullEvaluatorFalseAllows += 1;
    }
  }

  assert.equal(falseAllows, 0);
  assert.equal(fullEvaluatorFalseAllows, 0);
});

test("allows 1,000 seeded in-scope edits with zero false blocks", () => {
  const policyBytes = readFileSync("policies/bytefence-default.json");
  let falseBlocks = 0;

  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const oldText = `slot-${iteration}=before`;
    const newText = iteration % 7 === 0
      ? `slot-${iteration}=after-longer`
      : `slot-${iteration}=after`;
    const eol = iteration % 3 === 0 ? "\r\n" : "\n";
    const isolatedEol = eol === "\r\n" ? "\n" : "\r\n";
    const payload = Buffer.from(
      [
        `prefix-${iteration}-preserved-cafe\u0301`,
        oldText,
        `middle-${iteration}-preserved${isolatedEol}astral-\u{10400}-preserved`,
        `suffix-${iteration}-preserved-with-enough-bytes`,
        ""
      ].join(eol),
      "utf8"
    );
    const preimage = iteration % 5 === 0
      ? Buffer.concat([UTF8_BOM, payload])
      : payload;
    const intentBytes = Buffer.from(JSON.stringify({
      $schema: BYTEFENCE_INTENT_SCHEMA,
      operation: "exactReplace",
      targetPath: `src/legitimate-${iteration}.txt`,
      encoding: "utf-8",
      oldText,
      newText,
      expectedOccurrences: 1
    }));
    const intent = parseByteFenceIntent(intentBytes);
    const candidate = deriveByteFenceMutation(preimage, intent).candidate;
    const result = evaluateByteFence({
      preimage,
      candidate,
      intentBytes,
      policyBytes,
      workspaceId: "bytefence/legitimate-property",
      observedAt: "2026-07-13T16:00:00Z"
    });

    if (!result.allowed) falseBlocks += 1;
  }

  assert.equal(falseBlocks, 0);
});

function xorshift32(value) {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}
