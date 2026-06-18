import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("npm package exposes a working agent-proof binary", () => {
  const packDir = mkdtempSync(join(tmpdir(), "agent-proof-pack-"));
  const projectDir = mkdtempSync(join(tmpdir(), "agent-proof-install-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: resolve("."),
    encoding: "utf8"
  });
  assert.equal(pack.status, 0, pack.stderr);

  const tarball = join(packDir, pack.stdout.trim().split(/\r?\n/).at(-1));
  const install = spawnSync("npm", ["install", tarball, "--ignore-scripts"], {
    cwd: projectDir,
    encoding: "utf8"
  });
  assert.equal(install.status, 0, install.stderr);

  const binary = join(projectDir, "node_modules", ".bin", "agent-proof");
  const help = spawnSync(binary, ["--help"], {
    cwd: projectDir,
    encoding: "utf8"
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Deterministic release gates/);

  const packageRoot = join(projectDir, "node_modules", "agent-proof-kit");
  const verify = spawnSync(
    binary,
    [
      "verify",
      "--input",
      join(packageRoot, "examples", "synthetic-agent-run.json"),
      "--policy",
      join(packageRoot, "policies", "default-policy.json"),
      "--format",
      "json"
    ],
    {
      cwd: projectDir,
      encoding: "utf8"
    }
  );
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).status, "pass");
});
