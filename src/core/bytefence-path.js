import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32
} from "node:path";
import { BYTEFENCE_MAX_TARGET_BYTES } from "./bytefence-contract.js";

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const WINDOWS_INVALID_SEGMENT_CHARACTER = /[<>"|?*\u0000-\u001f]/u;
const POSIX_PRIVILEGED_MODE = 0o6000;

export class ByteFencePathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ByteFencePathError";
    this.code = code;
  }
}

export function inspectByteFenceTarget({ root, targetPath }) {
  const rootPath = resolveRoot(root);
  const segments = validatePortableRelativePath(targetPath);
  const absolutePath = resolve(rootPath, ...segments);
  assertContained(rootPath, absolutePath);

  let currentPath = rootPath;
  let targetStat = null;

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = join(currentPath, segments[index]);
    const stat = safeLstat(currentPath);

    if (stat.isSymbolicLink()) {
      throw new ByteFencePathError(
        "path.symlink_denied",
        "ByteFence v0.1 denies symbolic links in the target path."
      );
    }

    const isTarget = index === segments.length - 1;
    if (!isTarget && !stat.isDirectory()) {
      throw new ByteFencePathError(
        "path.parent_not_directory",
        "A ByteFence target parent is not a directory."
      );
    }
    if (isTarget) targetStat = stat;
  }

  validateTargetStat(targetStat);

  const parentPath = dirname(absolutePath);
  return {
    rootPath,
    targetPath: segments.join("/"),
    absolutePath,
    parentPath,
    parentRealPath: realpathSync(parentPath),
    stat: snapshotStat(targetStat)
  };
}

export function readByteFenceTarget(
  target,
  { maxBytes = BYTEFENCE_MAX_TARGET_BYTES } = {}
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ByteFencePathError(
      "path.read_limit_invalid",
      "The ByteFence read limit must be a non-negative safe integer."
    );
  }
  const noFollowFlag = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  let descriptor;

  try {
    descriptor = openSync(
      target.absolutePath,
      constants.O_RDONLY | noFollowFlag
    );
    const statBefore = fstatSync(descriptor, { bigint: true });
    validateTargetStat(statBefore);
    const before = snapshotStat(statBefore);
    if (!sameByteFenceFileIdentity(target.stat, before)) {
      throw new ByteFencePathError(
        "path.identity_changed",
        "The ByteFence target identity changed before it could be read."
      );
    }
    if (before.size > maxBytes) {
      throw new ByteFencePathError(
        "path.target_too_large",
        "The ByteFence target exceeds the configured raw-byte read limit."
      );
    }
    const bytes = readBoundedDescriptor(descriptor, maxBytes);
    const after = snapshotStat(fstatSync(descriptor, { bigint: true }));
    if (!sameByteFenceReadSnapshot(before, after)) {
      throw new ByteFencePathError(
        "path.changed_during_read",
        "The ByteFence target changed while its raw bytes were being read."
      );
    }
    return {
      bytes,
      stat: after,
      noFollow: noFollowFlag !== 0
    };
  } catch (error) {
    if (error instanceof ByteFencePathError) throw error;
    throw new ByteFencePathError(
      "path.open_failed",
      "The ByteFence target could not be opened safely."
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedDescriptor(descriptor, maxBytes) {
  const chunks = [];
  let total = 0;

  for (;;) {
    const remaining = maxBytes - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw new ByteFencePathError(
        "path.target_too_large",
        "The ByteFence target exceeded the configured raw-byte read limit while being read."
      );
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }

  return Buffer.concat(chunks, total);
}

function sameByteFenceReadSnapshot(left, right) {
  return (
    sameByteFenceFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function sameByteFenceFileIdentity(left, right) {
  if (!left || !right) return false;
  const leftDev = String(left.dev);
  const leftIno = String(left.ino);
  const rightDev = String(right.dev);
  const rightIno = String(right.ino);
  if (leftDev === "0" && leftIno === "0" && rightDev === "0" && rightIno === "0") {
    return false;
  }
  return leftDev === rightDev && leftIno === rightIno;
}

function resolveRoot(root) {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new ByteFencePathError(
      "path.root_invalid",
      "ByteFence root must be a non-empty filesystem path."
    );
  }

  let rootPath;
  try {
    rootPath = realpathSync(resolve(root));
  } catch {
    throw new ByteFencePathError(
      "path.root_missing",
      "ByteFence root does not exist or cannot be resolved."
    );
  }

  const stat = safeLstat(rootPath);
  if (!stat.isDirectory()) {
    throw new ByteFencePathError(
      "path.root_not_directory",
      "ByteFence root must resolve to a directory."
    );
  }
  return rootPath;
}

function validatePortableRelativePath(targetPath) {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new ByteFencePathError(
      "path.target_invalid",
      "ByteFence targetPath must be a non-empty relative path."
    );
  }
  if (targetPath.includes("\0")) {
    throw new ByteFencePathError(
      "path.nul_denied",
      "ByteFence targetPath cannot contain a NUL byte."
    );
  }
  if (
    isAbsolute(targetPath) ||
    posix.isAbsolute(targetPath) ||
    win32.isAbsolute(targetPath)
  ) {
    throw new ByteFencePathError(
      "path.absolute_denied",
      "ByteFence targetPath must be relative."
    );
  }
  if (targetPath.includes("\\")) {
    throw new ByteFencePathError(
      "path.separator_invalid",
      "ByteFence targetPath uses forward slashes on every platform."
    );
  }

  const segments = targetPath.split("/");
  if (
    segments.some((segment) => (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      WINDOWS_INVALID_SEGMENT_CHARACTER.test(segment) ||
      /[. ]$/.test(segment) ||
      WINDOWS_RESERVED_NAME.test(segment)
    ))
  ) {
    throw new ByteFencePathError(
      "path.segment_invalid",
      "ByteFence targetPath contains a non-portable or unsafe segment."
    );
  }
  return segments;
}

function assertContained(rootPath, absolutePath) {
  const childPath = relative(rootPath, absolutePath);
  if (
    childPath.length === 0 ||
    childPath === ".." ||
    childPath.startsWith(`..${sep}`) ||
    isAbsolute(childPath)
  ) {
    throw new ByteFencePathError(
      "path.escape_denied",
      "ByteFence targetPath must stay inside the configured root."
    );
  }
}

function safeLstat(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    throw new ByteFencePathError(
      "path.component_missing",
      "A ByteFence target path component does not exist or cannot be inspected."
    );
  }
}

function validateTargetStat(stat) {
  if (!stat?.isFile()) {
    throw new ByteFencePathError(
      "path.target_not_regular",
      "ByteFence v0.1 only supports existing regular files."
    );
  }
  if (stat.nlink > 1n) {
    throw new ByteFencePathError(
      "path.hardlink_denied",
      "ByteFence v0.1 denies targets with more than one hard link."
    );
  }
  if ((Number(stat.mode) & POSIX_PRIVILEGED_MODE) !== 0) {
    throw new ByteFencePathError(
      "path.privileged_mode_denied",
      "ByteFence v0.1 denies setuid and setgid targets."
    );
  }
}

function snapshotStat(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode),
    nlink: Number(stat.nlink),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs)
  };
}
