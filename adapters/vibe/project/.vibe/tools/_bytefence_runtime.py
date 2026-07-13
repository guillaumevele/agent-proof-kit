"""Standard-library bridge between a Vibe project tool and ByteFence.

This module never writes the protected target. It creates a private temporary
intent (mode 0600 on POSIX), invokes the configured broker without a shell,
verifies that a fresh receipt exists after exit 0, and removes the temporary
intent in every path.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
from typing import Literal


INTENT_SCHEMA = (
    "https://raw.githubusercontent.com/guillaumevele/agent-proof-kit/"
    "v0.5.0/schemas/bytefence-intent-v0.1.schema.json"
)
RECEIPT_PROFILES = frozenset({"public", "local"})
MAX_TARGET_PATH_CHARS = 4096
MAX_REPLACEMENT_CHARS = 65_536
MAX_WORKSPACE_ID_CHARS = 1024
MAX_RECEIPT_BYTES = 4 * 1024 * 1024


class BridgeInputError(ValueError):
    """The adapter request cannot be delegated safely."""


@dataclass(frozen=True)
class BrokerRequest:
    command: tuple[str, ...]
    root: str
    target_path: str
    old_text: str
    new_text: str
    policy_path: str
    workspace_id: str
    receipt_path: str
    receipt_profile: Literal["public", "local"] = "public"
    timeout_seconds: float = 60.0


@dataclass(frozen=True)
class BrokerOutcome:
    status: str
    exit_code: int | None
    receipt_path: str
    receipt_sha256: str | None
    safe_message: str
    retry_automatically: bool

    @property
    def ok(self) -> bool:
        return self.status == "committed-and-receipted"


def _require_text(value: object, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise BridgeInputError(f"{label} must be a string")
    if "\x00" in value:
        raise BridgeInputError(f"{label} must not contain NUL")
    if not allow_empty and value == "":
        raise BridgeInputError(f"{label} must not be empty")
    return value


def _require_nonblank(value: object, label: str) -> str:
    text = _require_text(value, label)
    if not text.strip():
        raise BridgeInputError(f"{label} must not be blank")
    return text


def _require_max_length(value: str, label: str, maximum: int) -> str:
    if len(value) > maximum:
        raise BridgeInputError(f"{label} exceeds the adapter character limit")
    return value


def resolve_root(root: str) -> Path:
    value = _require_nonblank(root, "root")
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise BridgeInputError("root must name an existing directory")
    return path


def resolve_input_file(root: Path, value: str, label: str) -> Path:
    text = _require_nonblank(value, label)
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = root / path
    path = path.resolve()
    if not path.is_file():
        raise BridgeInputError(f"{label} must name an existing regular file")
    return path


def resolve_output_path(root: Path, value: str) -> Path:
    text = _require_nonblank(value, "receipt_path")
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = root / path
    resolved = Path(os.path.abspath(os.fspath(path)))
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise BridgeInputError("receipt_path must remain inside root") from error
    return resolved


def _lstat_or_none(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def validate_receipt_parent(
    root: Path, receipt_path: Path, *, create_missing: bool
) -> None:
    try:
        relative_parent = receipt_path.parent.relative_to(root)
    except ValueError as error:
        raise BridgeInputError("receipt parent must remain inside root") from error

    current = root
    for part in relative_parent.parts:
        current = current / part
        try:
            metadata = _lstat_or_none(current)
        except OSError as error:
            raise BridgeInputError("receipt parent could not be inspected") from error
        if metadata is None and create_missing:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
            except OSError as error:
                raise BridgeInputError("receipt parent could not be created") from error
            try:
                metadata = _lstat_or_none(current)
            except OSError as error:
                raise BridgeInputError("receipt parent could not be inspected") from error
        if metadata is None:
            raise BridgeInputError("receipt parent disappeared during validation")
        if stat.S_ISLNK(metadata.st_mode):
            raise BridgeInputError("receipt parent must not traverse a symlink")
        if not stat.S_ISDIR(metadata.st_mode):
            raise BridgeInputError("receipt parent components must be directories")


def require_fresh_receipt_path(receipt_path: Path) -> None:
    try:
        metadata = _lstat_or_none(receipt_path)
    except OSError as error:
        raise BridgeInputError("receipt_path could not be inspected") from error
    if metadata is not None:
        raise BridgeInputError("receipt_path must not already exist")


def normalize_target_path(root: Path, value: str) -> str:
    text = _require_nonblank(value, "target_path")
    _require_max_length(text, "target_path", MAX_TARGET_PATH_CHARS)
    if "\\" in text:
        raise BridgeInputError("target_path must use portable '/' separators")

    path = Path(text).expanduser()
    if path.is_absolute():
        resolved = path.resolve(strict=False)
        try:
            relative = resolved.relative_to(root)
        except ValueError as error:
            raise BridgeInputError("target_path must remain inside root") from error
    else:
        relative = path

    portable = relative.as_posix()
    parts = relative.parts
    if not parts or portable in {"", "."}:
        raise BridgeInputError("target_path must name a file below root")
    if any(part in {"", ".", ".."} for part in parts):
        raise BridgeInputError("target_path must not contain dot traversal")
    return portable


def build_intent_document(target_path: str, old_text: str, new_text: str) -> dict:
    _require_text(old_text, "old_text")
    _require_text(new_text, "new_text", allow_empty=True)
    _require_max_length(old_text, "old_text", MAX_REPLACEMENT_CHARS)
    _require_max_length(new_text, "new_text", MAX_REPLACEMENT_CHARS)
    if old_text == new_text:
        raise BridgeInputError("old_text and new_text must differ")
    return {
        "$schema": INTENT_SCHEMA,
        "operation": "exactReplace",
        "targetPath": target_path,
        "encoding": "utf-8",
        "oldText": old_text,
        "newText": new_text,
        "expectedOccurrences": 1,
    }


def encode_intent(document: dict) -> bytes:
    return (
        json.dumps(
            document,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def write_private_intent(payload: bytes) -> Path:
    descriptor, raw_path = tempfile.mkstemp(
        prefix="bytefence-vibe-", suffix=".intent.json"
    )
    path = Path(raw_path)
    try:
        if os.name == "posix":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise
    return path


def validate_command(command: tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(command, tuple) or not command:
        raise BridgeInputError("broker command must be a non-empty tuple")
    return tuple(
        _require_nonblank(part, "broker command argument") for part in command
    )


def build_broker_argv(
    request: BrokerRequest,
    *,
    root: Path,
    intent_path: Path,
    policy_path: Path,
    receipt_path: Path,
) -> tuple[str, ...]:
    command = validate_command(request.command)
    return (
        *command,
        "--intent",
        str(intent_path),
        "--policy",
        str(policy_path),
        "--workspace-id",
        request.workspace_id,
        "--receipt-profile",
        request.receipt_profile,
        "--root",
        str(root),
        "--out",
        str(receipt_path),
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    before = path.lstat()
    if (
        stat.S_ISLNK(before.st_mode)
        or not stat.S_ISREG(before.st_mode)
        or before.st_nlink != 1
        or before.st_size > MAX_RECEIPT_BYTES
    ):
        raise OSError("receipt is not a regular non-symlink file")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb", closefd=True) as stream:
        opened = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_size > MAX_RECEIPT_BYTES
        ):
            raise OSError("opened receipt is not a regular file")
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise OSError("receipt identity changed while opening")
        total = 0
        for chunk in iter(lambda: stream.read(min(1024 * 1024, MAX_RECEIPT_BYTES + 1 - total)), b""):
            total += len(chunk)
            if total > MAX_RECEIPT_BYTES:
                raise OSError("receipt exceeds the byte limit")
            digest.update(chunk)
        after = os.fstat(stream.fileno())
        if (
            (opened.st_dev, opened.st_ino) != (after.st_dev, after.st_ino)
            or after.st_nlink != 1
            or after.st_size != opened.st_size
            or after.st_mtime_ns != opened.st_mtime_ns
            or after.st_ctime_ns != opened.st_ctime_ns
            or total != opened.st_size
        ):
            raise OSError("receipt changed while hashing")
    final = path.lstat()
    if (
        stat.S_ISLNK(final.st_mode)
        or (before.st_dev, before.st_ino) != (final.st_dev, final.st_ino)
        or final.st_nlink != 1
        or final.st_size != before.st_size
        or final.st_mtime_ns != before.st_mtime_ns
        or final.st_ctime_ns != before.st_ctime_ns
    ):
        raise OSError("receipt changed after hashing")
    return digest.hexdigest()


async def stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    try:
        await process.wait()
    except ProcessLookupError:
        pass


def _outcome_for_exit(exit_code: int, receipt_path: Path) -> BrokerOutcome:
    display_path = str(receipt_path)
    if exit_code == 1:
        return BrokerOutcome(
            status="denied",
            exit_code=exit_code,
            receipt_path=display_path,
            receipt_sha256=None,
            safe_message="ByteFence denied the proposed write; the target was not authorized.",
            retry_automatically=False,
        )
    if exit_code == 2:
        return BrokerOutcome(
            status="invalid-input",
            exit_code=exit_code,
            receipt_path=display_path,
            receipt_sha256=None,
            safe_message="ByteFence rejected invalid input or an unsupported environment.",
            retry_automatically=False,
        )
    if exit_code == 3:
        return BrokerOutcome(
            status="committed-unreceipted",
            exit_code=exit_code,
            receipt_path=display_path,
            receipt_sha256=None,
            safe_message=(
                "ByteFence reports committed-unreceipted. Inspect the target and receipt "
                "manually; do not retry this edit automatically."
            ),
            retry_automatically=False,
        )
    return BrokerOutcome(
        status="broker-failure-unknown-state",
        exit_code=exit_code,
        receipt_path=display_path,
        receipt_sha256=None,
        safe_message=(
            "The ByteFence broker failed with an unknown state. Inspect the target and "
            "receipt manually; do not retry this edit automatically."
        ),
        retry_automatically=False,
    )


async def run_broker(request: BrokerRequest) -> BrokerOutcome:
    root = resolve_root(request.root)
    target_path = normalize_target_path(root, request.target_path)
    policy_path = resolve_input_file(root, request.policy_path, "policy_path")
    workspace_id = _require_nonblank(request.workspace_id, "workspace_id")
    _require_max_length(workspace_id, "workspace_id", MAX_WORKSPACE_ID_CHARS)
    if request.receipt_profile not in RECEIPT_PROFILES:
        raise BridgeInputError("receipt_profile must be 'public' or 'local'")
    if not isinstance(request.timeout_seconds, (int, float)) or not (
        0 < request.timeout_seconds <= 300
    ):
        raise BridgeInputError("timeout_seconds must be greater than 0 and at most 300")

    receipt_path = resolve_output_path(root, request.receipt_path)
    validate_receipt_parent(root, receipt_path, create_missing=True)
    require_fresh_receipt_path(receipt_path)

    document = build_intent_document(target_path, request.old_text, request.new_text)
    intent_path = write_private_intent(encode_intent(document))
    argv = build_broker_argv(
        request,
        root=root,
        intent_path=intent_path,
        policy_path=policy_path,
        receipt_path=receipt_path,
    )

    try:
        try:
            validate_receipt_parent(root, receipt_path, create_missing=False)
            require_fresh_receipt_path(receipt_path)
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(root),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError:
            return BrokerOutcome(
                status="broker-not-started",
                exit_code=None,
                receipt_path=str(receipt_path),
                receipt_sha256=None,
                safe_message="The configured ByteFence broker could not be started.",
                retry_automatically=False,
            )

        try:
            exit_code = await asyncio.wait_for(
                process.wait(), timeout=float(request.timeout_seconds)
            )
        except TimeoutError:
            await stop_process(process)
            return BrokerOutcome(
                status="broker-timeout-unknown-state",
                exit_code=None,
                receipt_path=str(receipt_path),
                receipt_sha256=None,
                safe_message=(
                    "The ByteFence broker timed out. Its commit state is unknown; inspect "
                    "the target and receipt manually and do not retry automatically."
                ),
                retry_automatically=False,
            )
        except asyncio.CancelledError:
            await stop_process(process)
            raise

        if exit_code != 0:
            return _outcome_for_exit(exit_code, receipt_path)

        try:
            receipt_metadata = _lstat_or_none(receipt_path)
        except OSError:
            return BrokerOutcome(
                status="receipt-unreadable-unknown-state",
                exit_code=0,
                receipt_path=str(receipt_path),
                receipt_sha256=None,
                safe_message=(
                    "The broker exited successfully but its receipt cannot be inspected. "
                    "Inspect the target manually and do not retry automatically."
                ),
                retry_automatically=False,
            )
        if receipt_metadata is None or not stat.S_ISREG(receipt_metadata.st_mode):
            return BrokerOutcome(
                status="success-without-receipt-unknown-state",
                exit_code=0,
                receipt_path=str(receipt_path),
                receipt_sha256=None,
                safe_message=(
                    "The broker exited successfully but no fresh receipt exists. Inspect "
                    "the target manually and do not retry automatically."
                ),
                retry_automatically=False,
            )

        try:
            receipt_digest = sha256_file(receipt_path)
        except OSError:
            return BrokerOutcome(
                status="receipt-unreadable-unknown-state",
                exit_code=0,
                receipt_path=str(receipt_path),
                receipt_sha256=None,
                safe_message=(
                    "The broker exited successfully but its receipt cannot be hashed. "
                    "Inspect the target manually and do not retry automatically."
                ),
                retry_automatically=False,
            )

        return BrokerOutcome(
            status="committed-and-receipted",
            exit_code=0,
            receipt_path=str(receipt_path),
            receipt_sha256=receipt_digest,
            safe_message="ByteFence committed the exact replacement and emitted a receipt.",
            retry_automatically=False,
        )
    finally:
        try:
            intent_path.unlink()
        except FileNotFoundError:
            pass
