#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(
  repoRoot,
  "examples/bytefence/cases/vibe-mixed-eol-out-of-scope"
);
const preimagePath = resolve(fixtureRoot, "preimage.bin");
const pinnedCandidatePath = resolve(fixtureRoot, "candidate.bin");
const expectedCandidatePath = resolve(fixtureRoot, "expected-candidate.bin");
const intentPath = resolve(fixtureRoot, "intent.json");
const VIBE_PIPELINE = [
  "vibe.core.utils.io.read_safe",
  "vibe.core.tools.builtins.edit.Edit._apply_edit",
  "vibe.core.utils.io.atomic_replace"
];
const PYTHON_REPRODUCTION = String.raw`
import asyncio
import json
import sys
from pathlib import Path

from vibe.core.tools.builtins.edit import Edit
from vibe.core.utils.io import atomic_replace, read_safe

path = Path(sys.argv[1])
old_text = sys.argv[2]
new_text = sys.argv[3]

async def main():
    raw = path.read_bytes()
    result = read_safe(path, raise_on_error=True)
    if result.text.count(old_text) != 1:
        raise RuntimeError("fixture anchor is not unique after Vibe read_safe")
    modified = Edit._apply_edit(result.text, old_text, new_text, False)
    await atomic_replace(path, modified, encoding=result.encoding, newline=result.newline)
    crlf = raw.count(b"\r\n")
    isolated_lf = raw.count(b"\n") - crlf
    print(json.dumps({
        "encoding": result.encoding,
        "detectedNewline": result.newline.encode("unicode_escape").decode("ascii"),
        "inputCrlfCount": crlf,
        "inputIsolatedLfCount": isolated_lf,
        "readResultContainsCarriageReturn": "\r" in result.text
    }, sort_keys=True))

asyncio.run(main())
`;

const vibeExecutable = findExecutable(process.env.VIBE_BIN ?? "vibe");
if (!vibeExecutable) {
  print({
    status: "skipped",
    reason: "Vibe executable not found; the deterministic corpus remains independently verifiable.",
    ciDependency: false
  });
  process.exit(0);
}

const pythonExecutable = pythonFromShebang(vibeExecutable);
if (!pythonExecutable) {
  print({
    status: "skipped",
    reason: "The Vibe launcher does not expose a directly executable Python shebang.",
    vibeExecutable,
    ciDependency: false
  });
  process.exit(0);
}

const versionRun = spawnSync(vibeExecutable, ["--version"], {
  encoding: "utf8",
  timeout: 30_000
});
const vibeVersion = `${versionRun.stdout ?? ""}${versionRun.stderr ?? ""}`.trim() || "unknown";
const preimage = readFileSync(preimagePath);
const pinnedCandidate = readFileSync(pinnedCandidatePath);
const expectedCandidate = readFileSync(expectedCandidatePath);
const intent = JSON.parse(readFileSync(intentPath, "utf8"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "bytefence-vibe-eol-"));
const targetPath = resolve(temporaryRoot, "mixed-eol.js");

try {
  copyFileSync(preimagePath, targetPath);
  const nativeRun = spawnSync(
    pythonExecutable,
    ["-c", PYTHON_REPRODUCTION, targetPath, intent.oldText, intent.newText],
    { encoding: "utf8", timeout: 30_000 }
  );
  if (nativeRun.error || nativeRun.status !== 0) {
    print({
      status: "failed",
      vibeVersion,
      pipeline: VIBE_PIPELINE,
      reason: nativeRun.error?.message ?? nativeRun.stderr.trim() ?? "Native Vibe path failed",
      ciDependency: false
    });
    process.exitCode = 1;
  } else {
    const actualCandidate = readFileSync(targetPath);
    const nativeMetadata = JSON.parse(nativeRun.stdout);
    const outsideRangeChanged = changedOutsideDeclaredRange({
      preimage,
      candidate: actualCandidate,
      oldText: intent.oldText,
      newText: intent.newText
    });
    const matchesPinnedCandidate = actualCandidate.equals(pinnedCandidate);
    const differsFromExactCandidate = !actualCandidate.equals(expectedCandidate);
    const verified =
      matchesPinnedCandidate && differsFromExactCandidate && outsideRangeChanged;

    print({
      status: verified ? "verified" : "failed",
      vibeVersion,
      pipeline: VIBE_PIPELINE,
      nativeMetadata,
      digests: {
        preimage: sha256(preimage),
        byteFenceExpectedCandidate: sha256(expectedCandidate),
        pinnedVibeCandidate: sha256(pinnedCandidate),
        actualVibeCandidate: sha256(actualCandidate)
      },
      matchesPinnedCandidate,
      differsFromExactCandidate,
      changedOutsideDeclaredRange: outsideRangeChanged,
      networkOrModelUsed: false,
      ciDependency: false
    });
    if (!verified) process.exitCode = 1;
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function changedOutsideDeclaredRange({ preimage, candidate, oldText, newText }) {
  const oldBytes = Buffer.from(oldText, "utf8");
  const newBytes = Buffer.from(newText, "utf8");
  const beforeStart = preimage.indexOf(oldBytes);
  const afterStart = candidate.indexOf(newBytes);
  if (
    beforeStart === -1 ||
    afterStart === -1 ||
    preimage.indexOf(oldBytes, beforeStart + 1) !== -1 ||
    candidate.indexOf(newBytes, afterStart + 1) !== -1
  ) {
    return true;
  }
  const beforePrefix = preimage.subarray(0, beforeStart);
  const beforeSuffix = preimage.subarray(beforeStart + oldBytes.length);
  const afterPrefix = candidate.subarray(0, afterStart);
  const afterSuffix = candidate.subarray(afterStart + newBytes.length);
  return !beforePrefix.equals(afterPrefix) || !beforeSuffix.equals(afterSuffix);
}

function findExecutable(command) {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

function pythonFromShebang(executable) {
  const firstLine = readFileSync(executable, "utf8").split(/\r?\n/, 1)[0];
  if (!firstLine.startsWith("#!")) return undefined;
  const command = firstLine.slice(2).trim();
  if (!command || command.includes(" ")) return undefined;
  return findExecutable(command);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
