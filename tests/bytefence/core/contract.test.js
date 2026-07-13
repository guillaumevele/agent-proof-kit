import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BYTEFENCE_INTENT_SCHEMA,
  BYTEFENCE_MAX_INTENT_BYTES,
  BYTEFENCE_MAX_TARGET_BYTES,
  ByteFenceContractError,
  UTF8_BOM,
  canonicalByteFenceJson,
  countByteFenceLines,
  deriveByteFenceCandidate,
  deriveByteFenceMutation,
  findByteOccurrences,
  parseByteFenceJsonDocument,
  parseByteFenceIntent,
  parseByteFencePolicy
} from "../../../src/core/bytefence-contract.js";

function intentBytes(overrides = {}) {
  return Buffer.from(
    JSON.stringify({
      $schema: BYTEFENCE_INTENT_SCHEMA,
      operation: "exactReplace",
      targetPath: "src/example.txt",
      encoding: "utf-8",
      oldText: "enabled=false",
      newText: "enabled=true",
      expectedOccurrences: 1,
      ...overrides
    })
  );
}

test("parses strict raw-byte intent and policy contracts", () => {
  const intent = parseByteFenceIntent(intentBytes());
  const policy = parseByteFencePolicy(readFileSync("policies/bytefence-default.json"));

  assert.equal(intent.operation, "exactReplace");
  assert.equal(intent.expectedOccurrences, 1);
  assert.equal(policy.id, "bytefence-default");
  assert.equal(policy.maxDeletionRatio, 0.25);
  assert.ok(Object.isFrozen(intent));
  assert.ok(Object.isFrozen(policy));
});

test("rejects document BOMs, unknown keys, traversal and lone surrogates", () => {
  assertContractError(
    () => parseByteFenceIntent(Buffer.concat([UTF8_BOM, intentBytes()])),
    "intent.documentBom"
  );
  assertContractError(
    () => parseByteFenceIntent(intentBytes({ "private-source-fragment": true })),
    "intent.unknownKey",
    { absent: "private-source-fragment" }
  );
  assertContractError(
    () => parseByteFenceIntent(intentBytes({ targetPath: "../outside.txt" })),
    "intent.pathInvalid"
  );
  assertContractError(
    () => parseByteFenceIntent(intentBytes({ targetPath: "src/target?.txt" })),
    "intent.pathInvalid"
  );

  const loneSurrogate = intentBytes().toString().replace('"enabled=false"', '"\\ud800"');
  assertContractError(
    () => parseByteFenceIntent(Buffer.from(loneSurrogate)),
    "intent.surrogateInvalid"
  );
});

test("rejects duplicate JSON keys after escape decoding at every object depth", () => {
  const duplicateIntent = intentBytes()
    .toString()
    .replace(
      '"operation":"exactReplace"',
      '"operation":"exactReplace","\\u006fperation":"exactReplace"'
    );
  assertContractError(
    () => parseByteFenceIntent(Buffer.from(duplicateIntent)),
    "intent.duplicateKey"
  );
  assertContractError(
    () =>
      parseByteFenceJsonDocument(
        Buffer.from('{"outer":{"key":1,"\\u006bey":2}}')
      ),
    "document.duplicateKey"
  );
});

test("prevents policies from relaxing the seven fixed v0.1 safety flags", () => {
  const defaultPolicy = readFileSync("policies/bytefence-default.json", "utf8");
  const relaxations = [
    ['"denyFullTargetReplacement": true', '"denyFullTargetReplacement": false'],
    ['"allowSymlinks": false', '"allowSymlinks": true'],
    ['"allowHardlinks": false', '"allowHardlinks": true'],
    ['"requireUtf8": true', '"requireUtf8": false'],
    ['"allowNul": false', '"allowNul": true'],
    ['"preserveUtf8Bom": true', '"preserveUtf8Bom": false'],
    ['"preservePosixMode": true', '"preservePosixMode": false']
  ];

  for (const [from, to] of relaxations) {
    assertContractError(
      () => parseByteFencePolicy(Buffer.from(defaultPolicy.replace(from, to))),
      "policy.invariantUnsupported"
    );
  }
});

test("enforces absolute document and target limits before evaluation", () => {
  assertContractError(
    () => parseByteFenceIntent(Buffer.alloc(BYTEFENCE_MAX_INTENT_BYTES + 1, 0x20)),
    "intent.documentTooLarge"
  );

  const policy = JSON.parse(readFileSync("policies/bytefence-default.json", "utf8"));
  policy.maxTargetBytes = BYTEFENCE_MAX_TARGET_BYTES + 1;
  assertContractError(
    () => parseByteFencePolicy(Buffer.from(JSON.stringify(policy))),
    "policy.shapeInvalid"
  );
});

test("derives one raw-byte replacement without normalizing surrounding representation", () => {
  const intent = parseByteFenceIntent(
    intentBytes({ oldText: "cafe\u0301", newText: "café" })
  );
  const preimage = Buffer.concat([
    UTF8_BOM,
    Buffer.from("first\r\nsecond\nvalue=cafe\u0301\r\nastral=𐐀\n", "utf8")
  ]);
  const mutation = deriveByteFenceMutation(preimage, intent);

  assert.equal(
    mutation.candidate.toString("hex"),
    Buffer.concat([
      UTF8_BOM,
      Buffer.from("first\r\nsecond\nvalue=café\r\nastral=𐐀\n", "utf8")
    ]).toString("hex")
  );
  assert.ok(
    preimage
      .subarray(0, mutation.range.before.start)
      .equals(mutation.candidate.subarray(0, mutation.range.after.start))
  );
  assert.ok(
    preimage
      .subarray(mutation.range.before.end)
      .equals(mutation.candidate.subarray(mutation.range.after.end))
  );
  assert.ok(deriveByteFenceCandidate(preimage, intent).equals(mutation.candidate));
});

test("fails closed on ambiguous overlapping anchors and BOM intersections", () => {
  const overlap = parseByteFenceIntent(intentBytes({ oldText: "aa", newText: "b" }));
  assertContractError(() => deriveByteFenceCandidate(Buffer.from("aaa"), overlap), "occurrence.overlap");

  const bomIntent = parseByteFenceIntent(intentBytes({ oldText: "\ufeff", newText: "x" }));
  assertContractError(
    () => deriveByteFenceCandidate(Buffer.concat([UTF8_BOM, Buffer.from("payload")]), bomIntent),
    "bom.rangeOverlap"
  );
});

test("saturates occurrence discovery at two matches on adversarial repetitive input", () => {
  const repetitive = Buffer.alloc(BYTEFENCE_MAX_TARGET_BYTES, 0x61);
  const occurrences = findByteOccurrences(repetitive, Buffer.from("a"));

  assert.deepEqual(occurrences, [0, 1]);
  const intent = parseByteFenceIntent(intentBytes({ oldText: "a", newText: "b" }));
  assertContractError(
    () => deriveByteFenceCandidate(repetitive, intent),
    "occurrence.mismatch"
  );
});

test("canonical JSON is recursive, deterministic and rejects ambiguous values", () => {
  assert.equal(
    canonicalByteFenceJson({ z: [3, { b: true, a: null }], a: "é" }),
    '{"a":"é","z":[3,{"a":null,"b":true}]}'
  );
  assert.equal(canonicalByteFenceJson({ value: -0 }), '{"value":0}');
  assertContractError(() => canonicalByteFenceJson({ value: 0.25 }), "canonical.numberInvalid");
  assertContractError(() => canonicalByteFenceJson({ value: undefined }), "canonical.typeUnsupported");
  assertContractError(() => canonicalByteFenceJson({ value: "\ud800" }), "canonical.surrogateInvalid");
});

test("counts lines from LF bytes without normalizing CRLF", () => {
  assert.equal(countByteFenceLines(Buffer.alloc(0)), 0);
  assert.equal(countByteFenceLines(Buffer.from("one\r\ntwo\n")), 2);
  assert.equal(countByteFenceLines(Buffer.from("one\rtwo")), 1);
});

function assertContractError(fn, code, { absent } = {}) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ByteFenceContractError);
    assert.equal(error.code, code);
    if (absent) {
      assert.ok(!error.message.includes(absent));
      assert.ok(!error.location.includes(absent));
    }
    return true;
  });
}
