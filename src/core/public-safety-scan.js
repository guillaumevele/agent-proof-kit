import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scanText } from "./text-scan.js";

const skippedDirectories = new Set([".git", "node_modules", ".next", "dist", "coverage"]);
const skippedExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".tgz"]);

export function scanPublicSurface(rootPath, policy = {}, options = {}) {
  const files = listFiles(rootPath);
  const findings = [];
  let filesScanned = 0;

  for (const file of files) {
    const rel = relative(options.rootDir ?? rootPath, file);
    const fileFindings = scanFileName(rel);
    findings.push(...fileFindings);

    const stats = statSync(file);
    if (stats.size > (policy.maxScannedFileBytes ?? 512_000)) continue;

    const content = readFileSync(file, "utf8");
    filesScanned += 1;
    findings.push(...scanText(content, rel, policy));
  }

  return {
    status: findings.length === 0 ? "pass" : "fail",
    rootPath,
    filesScanned,
    findings
  };
}

function listFiles(rootPath) {
  const files = [];
  const entries = readdirSync(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...listFiles(fullPath));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (skippedExtensions.has(extensionOf(entry.name))) continue;
    files.push(fullPath);
  }

  return files.sort();
}

function scanFileName(path) {
  const normalized = path.toLowerCase();
  const findings = [];
  if (normalized.endsWith(".env") || normalized.includes("/.env.")) {
    findings.push({
      id: "surface.env_file",
      severity: "critical",
      title: "Environment file included in public surface",
      location: path,
      recommendation: "Commit .env.example only; keep real environment files outside the repository."
    });
  }
  if (normalized.includes("id_rsa") || normalized.includes("private-key")) {
    findings.push({
      id: "surface.private_key_path",
      severity: "critical",
      title: "Private-key-like file path detected",
      location: path,
      recommendation: "Remove private key material from the repository."
    });
  }
  return findings;
}

function extensionOf(fileName) {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index).toLowerCase();
}
