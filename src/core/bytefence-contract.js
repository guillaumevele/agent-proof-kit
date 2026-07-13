import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const BYTEFENCE_INTENT_SCHEMA =
  "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json";
export const BYTEFENCE_POLICY_SCHEMA =
  "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-policy-v0.1.schema.json";
export const BYTEFENCE_STATEMENT_SCHEMA =
  "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-statement-v0.1.schema.json";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const BYTEFENCE_MANIFEST_TYPE = "ByteFenceMutationManifest/v0.1";
export const BYTEFENCE_TRANSACTION_TYPE = "ByteFenceTransactionReceipt/v0.1";
export const BYTEFENCE_LOCK_PROTOCOL = "ByteFenceCooperativeLock/v0.1";
export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const BYTEFENCE_MAX_INTENT_BYTES = 1024 * 1024;
export const BYTEFENCE_MAX_POLICY_BYTES = 64 * 1024;
export const BYTEFENCE_MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
export const BYTEFENCE_MAX_TARGET_BYTES = 16 * 1024 * 1024;
export const BYTEFENCE_MAX_REPLACEMENT_BYTES = 64 * 1024;
const BYTEFENCE_MAX_JSON_NODES = 10_000;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const intentKeys = new Set([
  "$schema",
  "operation",
  "targetPath",
  "encoding",
  "oldText",
  "newText",
  "expectedOccurrences"
]);
const policyKeys = new Set([
  "$schema",
  "id",
  "maxTargetBytes",
  "maxOldBytes",
  "maxNewBytes",
  "maxDeletionRatio",
  "denyFullTargetReplacement",
  "allowSymlinks",
  "allowHardlinks",
  "requireUtf8",
  "allowNul",
  "preserveUtf8Bom",
  "preservePosixMode"
]);

export class ByteFenceContractError extends Error {
  constructor(code, message, location = "$") {
    super(message);
    this.name = "ByteFenceContractError";
    this.code = code;
    this.location = location;
  }
}

export function parseByteFenceJsonDocument(documentBytes, kind = "document") {
  const bytes = copyBytes(documentBytes, `${kind} document`);
  const maximumBytes = documentLimit(kind);
  if (bytes.length > maximumBytes) {
    throw new ByteFenceContractError(
      `${kind}.documentTooLarge`,
      `The ${kind} document exceeds the ByteFence v0.1 byte limit.`,
      "$"
    );
  }
  if (hasUtf8Bom(bytes)) {
    throw new ByteFenceContractError(
      `${kind}.documentBom`,
      `The ${kind} document must not begin with a UTF-8 BOM.`,
      "$"
    );
  }

  let text;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    throw new ByteFenceContractError(
      `${kind}.documentUtf8`,
      `The ${kind} document is not valid UTF-8.`,
      "$"
    );
  }
  return parseStrictJson(text, kind);
}

export function parseByteFenceIntent(intentBytes) {
  const intent = parseJsonBytes(intentBytes, "intent");
  assertExactKeys(intent, intentKeys, "intent");
  assertEqual(intent.$schema, BYTEFENCE_INTENT_SCHEMA, "intent.schemaUnsupported", "$.$schema");
  assertEqual(intent.operation, "exactReplace", "intent.operationUnsupported", "$.operation");
  assertString(intent.targetPath, "intent.shapeInvalid", "$.targetPath", { min: 1, max: 4096 });
  validateTargetPath(intent.targetPath);
  assertEqual(intent.encoding, "utf-8", "intent.encodingUnsupported", "$.encoding");
  assertString(intent.oldText, "intent.shapeInvalid", "$.oldText", { min: 1 });
  assertString(intent.newText, "intent.shapeInvalid", "$.newText");
  assertNoLoneSurrogates(intent.oldText, "intent.surrogateInvalid", "$.oldText");
  assertNoLoneSurrogates(intent.newText, "intent.surrogateInvalid", "$.newText");
  if (intent.oldText === intent.newText) {
    throw new ByteFenceContractError(
      "intent.replacementNoop",
      "The replacement must change the declared byte sequence.",
      "$.newText"
    );
  }
  assertEqual(
    intent.expectedOccurrences,
    1,
    "intent.expectedOccurrencesUnsupported",
    "$.expectedOccurrences"
  );
  return deepFreeze(intent);
}

export function parseByteFencePolicy(policyBytes) {
  const policy = parseJsonBytes(policyBytes, "policy");
  assertExactKeys(policy, policyKeys, "policy");
  assertEqual(policy.$schema, BYTEFENCE_POLICY_SCHEMA, "policy.schemaUnsupported", "$.$schema");
  assertString(policy.id, "policy.shapeInvalid", "$.id", { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(policy.id)) {
    throw new ByteFenceContractError(
      "policy.idInvalid",
      "The policy identifier does not match the v0.1 identifier grammar.",
      "$.id"
    );
  }

  assertSafeInteger(
    policy.maxTargetBytes,
    "$.maxTargetBytes",
    1,
    BYTEFENCE_MAX_TARGET_BYTES
  );
  assertSafeInteger(
    policy.maxOldBytes,
    "$.maxOldBytes",
    1,
    BYTEFENCE_MAX_REPLACEMENT_BYTES
  );
  assertSafeInteger(
    policy.maxNewBytes,
    "$.maxNewBytes",
    0,
    BYTEFENCE_MAX_REPLACEMENT_BYTES
  );
  assertFiniteNumber(policy.maxDeletionRatio, "$.maxDeletionRatio", 0, 1);
  for (const key of [
    "denyFullTargetReplacement",
    "allowSymlinks",
    "allowHardlinks",
    "requireUtf8",
    "allowNul",
    "preserveUtf8Bom",
    "preservePosixMode"
  ]) {
    if (typeof policy[key] !== "boolean") {
      throw new ByteFenceContractError(
        "policy.shapeInvalid",
        "A required policy flag is not a boolean.",
        `$.${key}`
      );
    }
  }
  const fixedSafetyFlags = {
    denyFullTargetReplacement: true,
    allowSymlinks: false,
    allowHardlinks: false,
    requireUtf8: true,
    allowNul: false,
    preserveUtf8Bom: true,
    preservePosixMode: true
  };
  for (const [key, expected] of Object.entries(fixedSafetyFlags)) {
    if (policy[key] !== expected) {
      throw new ByteFenceContractError(
        "policy.invariantUnsupported",
        "A fixed ByteFence v0.1 safety invariant cannot be relaxed by policy.",
        `$.${key}`
      );
    }
  }
  return deepFreeze(policy);
}

export function deriveByteFenceCandidate(preimage, intent) {
  return deriveByteFenceMutation(preimage, intent).candidate;
}

export function byteFenceCandidateMatches(candidate, expectedCandidate) {
  return copyBytes(candidate, "candidate").equals(copyBytes(expectedCandidate, "expected candidate"));
}

export function deriveByteFenceMutation(preimage, intent) {
  const before = copyBytes(preimage, "preimage");
  validateParsedIntent(intent);
  const oldBytes = Buffer.from(intent.oldText, "utf8");
  const newBytes = Buffer.from(intent.newText, "utf8");
  const starts = scanByteOccurrences(before, oldBytes);

  if (starts.some((start, index) => index > 0 && start < starts[index - 1] + oldBytes.length)) {
    throw new ByteFenceContractError(
      "occurrence.overlap",
      "The declared byte sequence has overlapping matches and is ambiguous.",
      "$.oldText"
    );
  }

  if (starts.length !== intent.expectedOccurrences) {
    throw new ByteFenceContractError(
      "occurrence.mismatch",
      "The target does not contain exactly one declared byte sequence.",
      "$.oldText"
    );
  }

  const start = starts[0];
  const end = start + oldBytes.length;
  if (hasUtf8Bom(before) && start < UTF8_BOM.length && end > 0) {
    throw new ByteFenceContractError(
      "bom.rangeOverlap",
      "The declared mutation range intersects the initial UTF-8 BOM.",
      "$.oldText"
    );
  }

  const candidate = Buffer.concat([before.subarray(0, start), newBytes, before.subarray(end)]);
  return {
    candidate,
    occurrenceCount: starts.length,
    oldBytes,
    newBytes,
    range: {
      before: { start, end },
      after: { start, end: start + newBytes.length }
    }
  };
}

/**
 * Return at most the first two overlapping byte matches. v0.1 only needs to
 * distinguish zero, one and multiple occurrences, so the saturated result
 * keeps adversarial repetitive inputs memory-bounded.
 */
export function findByteOccurrences(haystack, needle) {
  const source = copyBytes(haystack, "haystack");
  const match = copyBytes(needle, "needle");
  if (match.length === 0) {
    throw new ByteFenceContractError(
      "intent.oldTextEmpty",
      "The exact replacement anchor must not be empty.",
      "$.oldText"
    );
  }

  return scanByteOccurrences(source, match);
}

function scanByteOccurrences(source, match) {
  const starts = [];
  let offset = 0;
  while (starts.length < 2 && offset <= source.length - match.length) {
    const start = source.indexOf(match, offset);
    if (start === -1) break;
    starts.push(start);
    offset = start + 1;
  }
  return starts;
}

export function canonicalByteFenceJson(value) {
  return serializeCanonical(value, "$", new Set());
}

export function canonicalByteFenceJsonBytes(value) {
  return Buffer.from(canonicalByteFenceJson(value), "utf8");
}

export function sha256Hex(bytes) {
  const input =
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : copyBytes(bytes, "digest input");
  return createHash("sha256").update(input).digest("hex");
}

export function hasUtf8Bom(bytes) {
  const input = copyBytes(bytes, "bytes");
  return input.length >= UTF8_BOM.length && input.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
}

export function isValidUtf8(bytes) {
  try {
    utf8Decoder.decode(copyBytes(bytes, "bytes"));
    return true;
  } catch {
    return false;
  }
}

export function countByteFenceLines(bytes) {
  const input = copyBytes(bytes, "bytes");
  if (input.length === 0) return 0;
  let lineFeeds = 0;
  for (const byte of input) {
    if (byte === 0x0a) lineFeeds += 1;
  }
  return lineFeeds + 1 - (input[input.length - 1] === 0x0a ? 1 : 0);
}

export function copyByteFenceBytes(value, label = "input") {
  return copyBytes(value, label);
}

export function assertNoLoneSurrogates(value, code = "canonical.surrogateInvalid", location = "$") {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ByteFenceContractError(code, "A string contains an isolated UTF-16 surrogate.", location);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ByteFenceContractError(code, "A string contains an isolated UTF-16 surrogate.", location);
    }
  }
}

function parseJsonBytes(value, kind) {
  const parsed = parseByteFenceJsonDocument(value, kind);
  if (!isPlainRecord(parsed)) {
    throw new ByteFenceContractError(`${kind}.shapeInvalid`, `The ${kind} document must be an object.`, "$");
  }
  validateJsonStrings(parsed, `${kind}.surrogateInvalid`, "$", new Set());
  return parsed;
}

function parseStrictJson(text, kind) {
  let index = 0;
  let nodeCount = 0;

  const fail = (code = `${kind}.jsonInvalid`, message = `The ${kind} document is not valid JSON.`) => {
    throw new ByteFenceContractError(code, message, "$");
  };

  const skipWhitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) index += 1;
  };

  const parseString = () => {
    if (text[index] !== '"') fail();
    index += 1;
    let result = "";
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return result;
      }
      if (character === "\\") {
        index += 1;
        if (index >= text.length) fail();
        const escape = text[index];
        index += 1;
        const simpleEscapes = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t"
        };
        if (Object.hasOwn(simpleEscapes, escape)) {
          result += simpleEscapes[escape];
          continue;
        }
        if (escape !== "u") fail();
        const hexadecimal = text.slice(index, index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hexadecimal)) fail();
        result += String.fromCharCode(Number.parseInt(hexadecimal, 16));
        index += 4;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail();
      result += character;
      index += 1;
    }
    fail();
  };

  const parseNumber = () => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (!match) fail();
    index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail();
    return number;
  };

  const parseValue = (depth) => {
    nodeCount += 1;
    if (nodeCount > BYTEFENCE_MAX_JSON_NODES) {
      fail(
        `${kind}.nodeLimitExceeded`,
        `The ${kind} document exceeds the maximum JSON value budget.`
      );
    }
    if (depth > 256) {
      fail(`${kind}.depthExceeded`, `The ${kind} document exceeds the maximum nesting depth.`);
    }
    skipWhitespace();
    const character = text[index];
    if (character === '"') return parseString();
    if (character === "{") return parseObject(depth + 1);
    if (character === "[") return parseArray(depth + 1);
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    if (character === "-" || (character >= "0" && character <= "9")) return parseNumber();
    fail();
  };

  const parseObject = (depth) => {
    index += 1;
    skipWhitespace();
    const result = Object.create(null);
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = parseString();
      nodeCount += 1;
      if (nodeCount > BYTEFENCE_MAX_JSON_NODES) {
        fail(
          `${kind}.nodeLimitExceeded`,
          `The ${kind} document exceeds the maximum JSON value budget.`
        );
      }
      if (keys.has(key)) {
        fail(
          `${kind}.duplicateKey`,
          `The ${kind} document contains a duplicate object key after JSON escape decoding.`
        );
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") fail();
      index += 1;
      const value = parseValue(depth);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") fail();
      index += 1;
    }
    fail();
  };

  const parseArray = (depth) => {
    index += 1;
    skipWhitespace();
    const result = [];
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      result.push(parseValue(depth));
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") fail();
      index += 1;
    }
    fail();
  };

  skipWhitespace();
  const value = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail();
  return value;
}

function validateParsedIntent(intent) {
  if (!isPlainRecord(intent)) {
    throw new ByteFenceContractError("intent.shapeInvalid", "The parsed intent must be an object.", "$");
  }
  assertExactKeys(intent, intentKeys, "intent");
  assertEqual(intent.$schema, BYTEFENCE_INTENT_SCHEMA, "intent.schemaUnsupported", "$.$schema");
  assertEqual(intent.operation, "exactReplace", "intent.operationUnsupported", "$.operation");
  assertString(intent.targetPath, "intent.shapeInvalid", "$.targetPath", { min: 1, max: 4096 });
  validateTargetPath(intent.targetPath);
  assertEqual(intent.encoding, "utf-8", "intent.encodingUnsupported", "$.encoding");
  assertString(intent.oldText, "intent.shapeInvalid", "$.oldText", { min: 1 });
  assertString(intent.newText, "intent.shapeInvalid", "$.newText");
  assertNoLoneSurrogates(intent.oldText, "intent.surrogateInvalid", "$.oldText");
  assertNoLoneSurrogates(intent.newText, "intent.surrogateInvalid", "$.newText");
  if (intent.oldText === intent.newText) {
    throw new ByteFenceContractError(
      "intent.replacementNoop",
      "The replacement must change the declared byte sequence.",
      "$.newText"
    );
  }
  assertEqual(intent.expectedOccurrences, 1, "intent.expectedOccurrencesUnsupported", "$.expectedOccurrences");
}

function validateTargetPath(targetPath) {
  const segments = targetPath.split("/");
  const invalid =
    targetPath.startsWith("/") ||
    targetPath.startsWith("\\") ||
    /^[A-Za-z]:/.test(targetPath) ||
    targetPath.includes("\\") ||
    targetPath.includes("\0") ||
    segments.some((part) => (
      part === "" ||
      part === "." ||
      part === ".." ||
      part.includes(":") ||
      /[<>"|?*\u0000-\u001f]/u.test(part) ||
      /[. ]$/u.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(part)
    )) ||
    /[\u0000-\u001f\u007f]/u.test(targetPath);
  if (invalid) {
    throw new ByteFenceContractError(
      "intent.pathInvalid",
      "The target path must be a normalized relative path inside the workspace.",
      "$.targetPath"
    );
  }
  assertNoLoneSurrogates(targetPath, "intent.surrogateInvalid", "$.targetPath");
}

function assertExactKeys(value, allowed, kind) {
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new ByteFenceContractError(
        `${kind}.shapeInvalid`,
        `The ${kind} document is missing a required property.`,
        `$.${key}`
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ByteFenceContractError(
        `${kind}.unknownKey`,
        `The ${kind} document contains an unknown property.`,
        "$.<unknown>"
      );
    }
  }
}

function assertString(value, code, location, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ByteFenceContractError(code, "A required string does not satisfy the v0.1 contract.", location);
  }
}

function assertEqual(value, expected, code, location) {
  if (value !== expected) {
    throw new ByteFenceContractError(code, "A value is not supported by the v0.1 contract.", location);
  }
}

function assertSafeInteger(value, location, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ByteFenceContractError(
      "policy.shapeInvalid",
      "A byte limit must be a non-negative safe integer in the supported range.",
      location
    );
  }
}

function documentLimit(kind) {
  if (kind === "intent") return BYTEFENCE_MAX_INTENT_BYTES;
  if (kind === "policy") return BYTEFENCE_MAX_POLICY_BYTES;
  if (kind === "receipt") return BYTEFENCE_MAX_RECEIPT_BYTES;
  return BYTEFENCE_MAX_RECEIPT_BYTES;
}

function assertFiniteNumber(value, location, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ByteFenceContractError(
      "policy.shapeInvalid",
      "A numeric policy value is outside the supported range.",
      location
    );
  }
}

function serializeCanonical(value, location, seen) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertNoLoneSurrogates(value, "canonical.surrogateInvalid", location);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ByteFenceContractError(
        "canonical.numberInvalid",
        "Canonical ByteFence JSON accepts safe integers only.",
        location
      );
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value !== "object") {
    throw new ByteFenceContractError(
      "canonical.typeUnsupported",
      "Canonical ByteFence JSON contains an unsupported value type.",
      location
    );
  }
  if (seen.has(value)) {
    throw new ByteFenceContractError("canonical.cycle", "Canonical ByteFence JSON cannot contain cycles.", location);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new ByteFenceContractError(
          "canonical.arrayProperty",
          "Canonical ByteFence JSON arrays cannot contain symbol properties.",
          location
        );
      }
      const ownKeys = Object.keys(value);
      if (ownKeys.some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        throw new ByteFenceContractError(
          "canonical.arrayProperty",
          "Canonical ByteFence JSON arrays cannot contain named properties.",
          location
        );
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new ByteFenceContractError(
            "canonical.arrayHole",
            "Canonical ByteFence JSON cannot contain array holes.",
            `${location}[${index}]`
          );
        }
      }
      return `[${value.map((item, index) => serializeCanonical(item, `${location}[${index}]`, seen)).join(",")}]`;
    }
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new ByteFenceContractError(
        "canonical.objectUnsupported",
        "Canonical ByteFence JSON accepts plain string-keyed objects only.",
        location
      );
    }
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        assertNoLoneSurrogates(key, "canonical.surrogateInvalid", location);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new ByteFenceContractError(
            "canonical.objectUnsupported",
            "Canonical ByteFence JSON does not evaluate object accessors.",
            location
          );
        }
        return `${JSON.stringify(key)}:${serializeCanonical(descriptor.value, `${location}.${key}`, seen)}`;
      })
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function validateJsonStrings(value, code, location, seen) {
  if (typeof value === "string") {
    assertNoLoneSurrogates(value, code, location);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonStrings(item, code, `${location}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertNoLoneSurrogates(key, code, location);
      validateJsonStrings(item, code, `${location}.${key}`, seen);
    }
  }
}

function copyBytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new ByteFenceContractError(
      "input.bytesRequired",
      `The ${label} must be supplied as raw bytes.`,
      "$"
    );
  }
  return Buffer.from(value);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}
