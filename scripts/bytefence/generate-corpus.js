#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INTENT_SCHEMA =
  "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/v0.5.0/schemas/bytefence-intent-v0.1.schema.json";
const CORPUS_TYPE = "ByteFenceAdversarialCorpus/v0.1";
const SCRIPT_PATH = "scripts/bytefence/generate-corpus.js";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const corpusRoot = resolve(repoRoot, "examples/bytefence");
const casesRoot = resolve(corpusRoot, "cases");

const mode = process.argv[2] ?? "--check";
if (!new Set(["--check", "--write"]).has(mode) || process.argv.length > 3) {
  process.stderr.write(`Usage: node ${SCRIPT_PATH} [--check|--write]\n`);
  process.exit(2);
}

const corpus = buildCorpus();
const expectedFiles = new Map();

for (const testCase of corpus.cases) {
  for (const [name, artifact] of Object.entries(testCase.artifacts)) {
    expectedFiles.set(artifact.path, testCase.generatedFiles[name]);
  }
  delete testCase.generatedFiles;
}

const manifestBytes = jsonBytes(corpus);
expectedFiles.set("corpus-v0.1.json", manifestBytes);

if (mode === "--write") {
  for (const [path, bytes] of expectedFiles) {
    const absolutePath = resolve(corpusRoot, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, bytes);
  }
}

const errors = verifyGeneratedFiles(expectedFiles);
if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}

const fixtureBytes = [...expectedFiles.values()].reduce((sum, bytes) => sum + bytes.length, 0);
process.stdout.write(
  `ByteFence corpus v0.1 verified: ${corpus.cases.length} cases, ` +
    `${expectedFiles.size} generated files, ${fixtureBytes} bytes.\n`
);

function buildCorpus() {
  const cases = [
    buildExactReplaceCase(),
    buildTruncationCase(),
    buildAmbiguousOccurrenceCase(),
    buildMixedEolCase(),
    buildBomRemovalCase(),
    buildUnicodeNormalizationCase(),
    buildFullRewriteCase()
  ];

  return {
    _type: CORPUS_TYPE,
    version: "0.1.0",
    generatedBy: SCRIPT_PATH,
    hashAlgorithm: "sha256",
    byteContract:
      "Every .bin artifact is compared as raw bytes. Decoding, EOL conversion and Unicode normalization are forbidden during verification.",
    policyPath: "policies/bytefence-default.json",
    cases
  };
}

function buildExactReplaceCase() {
  const id = "exact-replace-allowed";
  const preimage = Buffer.from(
    'export const mode = "safe";\nexport const retries = 3;\n',
    "utf8"
  );
  const intent = makeIntent("workspace/config.js", 'mode = "safe"', 'mode = "strict"');
  const expectedCandidate = replaceUnique(preimage, intent.oldText, intent.newText);

  return makeCase({
    id,
    title: "Unique exact replacement",
    threat: "control",
    description:
      "A unique local replacement is accepted and the candidate is exactly derivable from the preimage.",
    preimage,
    candidate: expectedCandidate,
    expectedCandidate,
    intent,
    expectation: expected("allow", []),
    assertions: {
      expectedOccurrences: 1,
      candidateMatchesExactDerivation: true,
      outOfScopeMutation: false
    }
  });
}

function buildTruncationCase() {
  const id = "synthetic-truncation-377-to-58";
  const lines = Array.from({ length: 377 }, (_, index) => {
    const line = index + 1;
    if (line === 24) return "line-024: mode=before";
    return `line-${String(line).padStart(3, "0")}: payload=stable-${String(line).padStart(3, "0")}`;
  });
  const preimage = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  const intent = makeIntent("workspace/large-config.txt", "line-024: mode=before", "line-024: mode=after");
  const expectedCandidate = replaceUnique(preimage, intent.oldText, intent.newText);
  const truncatedLines = lines.slice(0, 58);
  truncatedLines[23] = "line-024: mode=after";
  const candidate = Buffer.from(`${truncatedLines.join("\n")}\n`, "utf8");

  return makeCase({
    id,
    title: "Synthetic 377-to-58-line truncation",
    threat: "truncation",
    description:
      "A synthetic candidate keeps the requested edit but drops lines 59 through 377. It models the shape of a historical report; it is not attributed to a current editor.",
    preimage,
    candidate,
    expectedCandidate,
    intent,
    expectation: expected("deny", ["candidate.derivationMismatch"]),
    assertions: {
      beforeLines: 377,
      proposedLines: 58,
      expectedOccurrences: 1,
      candidateMatchesExactDerivation: false,
      outOfScopeMutation: true
    },
    provenance: {
      kind: "synthetic-historical-shape",
      qualification: "unconfirmed and not a current native-tool claim"
    }
  });
}

function buildAmbiguousOccurrenceCase() {
  const id = "ambiguous-occurrences-denied";
  const preimage = Buffer.from(
    "service=alpha\nrole=reader\nservice=beta\nrole=reader\n",
    "utf8"
  );
  const intent = makeIntent("workspace/roles.conf", "role=reader", "role=writer");
  const candidate = Buffer.from(
    "service=alpha\nrole=writer\nservice=beta\nrole=reader\n",
    "utf8"
  );

  return makeCase({
    id,
    title: "Ambiguous replacement anchor",
    threat: "ambiguous-scope",
    description:
      "The declared anchor occurs twice while the v0.1 contract requires exactly one occurrence.",
    preimage,
    candidate,
    intent,
    expectation: expected("deny", ["occurrence.mismatch"]),
    assertions: {
      expectedOccurrences: 1,
      observedOccurrences: 2,
      candidateMatchesExactDerivation: false,
      outOfScopeMutation: true
    }
  });
}

function buildMixedEolCase() {
  const id = "vibe-mixed-eol-out-of-scope";
  const preimage = Buffer.from(
    'const alpha = 1;\r\nconst target = "before";\r\nconst minority = "lf-only";\nconst omega = 4;\r\n',
    "utf8"
  );
  const intent = makeIntent(
    "workspace/mixed-eol.js",
    'target = "before"',
    'target = "after"'
  );
  const expectedCandidate = replaceUnique(preimage, intent.oldText, intent.newText);
  const candidate = Buffer.from(
    expectedCandidate
      .toString("utf8")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .replaceAll("\n", "\r\n"),
    "utf8"
  );

  return makeCase({
    id,
    title: "Mixed-EOL normalization outside the anchor",
    threat: "representation-normalization",
    description:
      "The proposed candidate contains the requested edit but converts the isolated LF to CRLF outside the declared range.",
    preimage,
    candidate,
    expectedCandidate,
    intent,
    expectation: expected("deny", ["candidate.derivationMismatch"]),
    assertions: {
      expectedOccurrences: 1,
      majorityEol: "CRLF",
      minorityEol: "LF",
      candidateMatchesExactDerivation: false,
      outOfScopeMutation: true
    },
    provenance: {
      kind: "version-pinned-interoperability-reproduction",
      producer: "Mistral Vibe",
      rfcAdapterTarget: "2.19.1",
      locallyReproducedWith: "2.19.0",
      localReproductionScript: "scripts/bytefence/reproduce-vibe-mixed-eol.js",
      networkOrModelRequired: false,
      ciDependency: false
    }
  });
}

function buildBomRemovalCase() {
  const id = "utf8-bom-removal-denied";
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const preimage = Buffer.concat([
    bom,
    Buffer.from(
      'title = "stable"\npadding = "stable"\nmode = "before"\nfooter = "stable"\n',
      "utf8"
    )
  ]);
  const intent = makeIntent("workspace/bom.txt", 'mode = "before"', 'mode = "after"');
  const expectedCandidate = replaceUnique(preimage, intent.oldText, intent.newText);
  const candidate = Buffer.from(expectedCandidate.subarray(bom.length));

  return makeCase({
    id,
    title: "UTF-8 BOM removal",
    threat: "representation-normalization",
    description:
      "The local text edit is present, but the initial UTF-8 BOM has been removed outside the declared mutation range.",
    preimage,
    candidate,
    expectedCandidate,
    intent,
    expectation: expected("deny", ["candidate.derivationMismatch", "candidate.bomChanged"]),
    assertions: {
      expectedOccurrences: 1,
      preimageStartsWithUtf8Bom: true,
      candidateStartsWithUtf8Bom: false,
      candidateMatchesExactDerivation: false,
      outOfScopeMutation: true
    }
  });
}

function buildUnicodeNormalizationCase() {
  const id = "unicode-nfc-nfd-out-of-scope";
  const preimage = Buffer.from(
    'label_nfd = "cafe\u0301"\nmode = "before"\nlabel_nfc = "caf\u00e9"\nmarker = "\u{10400}"\n',
    "utf8"
  );
  const intent = makeIntent(
    "workspace/unicode.txt",
    'mode = "before"',
    'mode = "after"'
  );
  const expectedCandidate = replaceUnique(preimage, intent.oldText, intent.newText);
  const candidate = Buffer.from(expectedCandidate.toString("utf8").normalize("NFC"), "utf8");

  return makeCase({
    id,
    title: "NFC normalization of an out-of-range NFD sequence",
    threat: "representation-normalization",
    description:
      "The requested ASCII edit is present, but an NFD e-plus-combining-acute sequence outside the range is normalized to NFC. The astral marker remains intact.",
    preimage,
    candidate,
    expectedCandidate,
    intent,
    expectation: expected("deny", ["candidate.derivationMismatch"]),
    assertions: {
      expectedOccurrences: 1,
      containsNfcAndNfd: true,
      containsAstralUtf8: true,
      candidateMatchesExactDerivation: false,
      outOfScopeMutation: true
    }
  });
}

function buildFullRewriteCase() {
  const id = "full-target-rewrite-denied";
  const preimage = Buffer.from(
    [
      "policy=strict",
      "owner=human",
      "network=denied",
      "audit=required",
      "retention=30d",
      "region=eu",
      "status=active",
      ""
    ].join("\n"),
    "utf8"
  );
  const replacement = [
    "agent_claim=approved",
    "policy=permissive",
    "owner=agent",
    "network=allowed",
    "audit=optional",
    "retention=none",
    "region=global",
    "status=active",
    ""
  ].join("\n");
  const intent = makeIntent("workspace/policy.conf", preimage.toString("utf8"), replacement);
  const candidate = Buffer.from(replacement, "utf8");

  return makeCase({
    id,
    title: "Self-declared full-target rewrite",
    threat: "full-rewrite",
    description:
      "The candidate exactly matches the declared replacement, but v0.1 policy denies full-target rewrites and the embedded approval claim has no authority.",
    preimage,
    candidate,
    expectedCandidate: candidate,
    intent,
    expectation: expected("deny", [
      "change.fullTargetDenied",
      "change.deletionRatioExceeded"
    ]),
    assertions: {
      expectedOccurrences: 1,
      replacesFullTarget: true,
      candidateMatchesExactDerivation: true,
      outOfScopeMutation: false,
      selfDeclaredApprovalHasAuthority: false
    }
  });
}

function makeCase({
  id,
  title,
  threat,
  description,
  preimage,
  candidate,
  expectedCandidate,
  intent,
  expectation,
  assertions,
  provenance
}) {
  const prefix = `cases/${id}`;
  const intentBytes = jsonBytes(intent);
  const generatedFiles = {
    preimage: preimage,
    candidate: candidate,
    intent: intentBytes,
    ...(expectedCandidate ? { expectedCandidate } : {})
  };
  const artifacts = Object.fromEntries(
    Object.entries(generatedFiles).map(([name, bytes]) => {
      const filename =
        name === "expectedCandidate"
          ? "expected-candidate.bin"
          : name === "intent"
            ? "intent.json"
            : `${name}.bin`;
      return [
        name,
        {
          path: `${prefix}/${filename}`,
          bytes: bytes.length,
          sha256: sha256(bytes),
          ...(filename.endsWith(".bin") ? { lines: countLines(bytes) } : {})
        }
      ];
    })
  );

  return {
    id,
    title,
    threat,
    description,
    artifacts,
    expectation,
    assertions,
    ...(provenance ? { provenance } : {}),
    generatedFiles
  };
}

function makeIntent(targetPath, oldText, newText) {
  return {
    $schema: INTENT_SCHEMA,
    operation: "exactReplace",
    targetPath,
    encoding: "utf-8",
    oldText,
    newText,
    expectedOccurrences: 1
  };
}

function expected(status, findingCodes) {
  const allowed = status === "allow";
  return {
    status,
    allowed,
    exitCode: allowed ? 0 : 1,
    effectiveGuaranteeLevel: allowed ? "CORE_PROVEN" : "OUT_OF_SCOPE",
    findingCodes
  };
}

function replaceUnique(preimage, oldText, newText) {
  const before = Buffer.from(preimage);
  const oldBytes = Buffer.from(oldText, "utf8");
  const newBytes = Buffer.from(newText, "utf8");
  const start = before.indexOf(oldBytes);
  if (start === -1 || before.indexOf(oldBytes, start + 1) !== -1) {
    throw new Error("Generator invariant failed: replacement anchor is not unique");
  }
  return Buffer.concat([
    before.subarray(0, start),
    newBytes,
    before.subarray(start + oldBytes.length)
  ]);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function countLines(bytes) {
  if (bytes.length === 0) return 0;
  let lineFeeds = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) lineFeeds += 1;
  }
  return lineFeeds + 1 - (bytes.at(-1) === 0x0a ? 1 : 0);
}

function verifyGeneratedFiles(expected) {
  const errors = [];
  for (const [path, expectedBytes] of expected) {
    const absolutePath = resolve(corpusRoot, path);
    let actualBytes;
    try {
      actualBytes = readFileSync(absolutePath);
    } catch (error) {
      errors.push(`Missing generated corpus file: ${path} (${error.code ?? error.message})`);
      continue;
    }
    if (!actualBytes.equals(expectedBytes)) {
      errors.push(
        `Generated corpus drift: ${path} ` +
          `(expected sha256:${sha256(expectedBytes)}, received sha256:${sha256(actualBytes)})`
      );
    }
  }

  const expectedCasePaths = new Set(
    [...expected.keys()].filter((path) => path.startsWith("cases/"))
  );
  for (const path of listFiles(casesRoot)) {
    const relativePath = `cases/${relative(casesRoot, path).split("\\").join("/")}`;
    if (!expectedCasePaths.has(relativePath)) {
      errors.push(`Unexpected generated corpus file: ${relativePath}`);
    }
  }
  return errors;
}

function listFiles(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return statSync(path).isFile() ? [path] : [];
  });
}
