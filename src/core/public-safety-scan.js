import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { scanText } from "./text-scan.js";

const skippedDirectories = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "coverage",
  "__pycache__"
]);
const skippedExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".tgz"]);

export function scanPublicSurface(rootPath, policy = {}, options = {}) {
  const files = listFiles(rootPath);
  const includedPaths = normalizeIncludedPaths(options.includedPaths);
  const findings = [];
  const skippedFiles = [];
  let filesScanned = 0;

  for (const file of files) {
    const rootRelativePath = relative(rootPath, file).split(sep).join("/");
    if (includedPaths && !includedPaths.has(rootRelativePath)) continue;
    const rel = relative(options.rootDir ?? rootPath, file);
    const fileFindings = scanFileName(rel);
    findings.push(...fileFindings);

    const stats = statSync(file);
    if (stats.size > (policy.maxScannedFileBytes ?? 512_000)) {
      skippedFiles.push({ path: rel, bytes: stats.size });
      findings.push({
        id: "surface.file_not_scanned",
        severity: "high",
        title: "File exceeded scan size limit",
        location: rel,
        evidence: `${stats.size} bytes`,
        recommendation: "Scan the file separately, lower the file size, or raise maxScannedFileBytes deliberately in policy."
      });
      continue;
    }

    const content = readFileSync(file, "utf8");
    filesScanned += 1;
    findings.push(...scanText(content, rel, policy));
  }

  return {
    status: findings.length === 0 ? "pass" : "fail",
    rootPath: options.displayRoot ?? rootPath,
    filesScanned,
    skippedFiles,
    findings
  };
}

function normalizeIncludedPaths(paths) {
  if (paths === undefined) return null;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new TypeError("includedPaths must be an array of repository-relative paths.");
  }
  return new Set(paths.map((path) => path.split("\\").join("/")));
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
