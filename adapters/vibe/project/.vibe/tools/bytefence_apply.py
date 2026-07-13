"""Mistral Vibe project tool delegating exact replacements to ByteFence."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import hashlib
import sys
from typing import ClassVar, Literal

from pydantic import BaseModel, Field, field_validator

from vibe.core.tools.base import (
    BaseTool,
    BaseToolConfig,
    BaseToolState,
    InvokeContext,
    ToolError,
    ToolPermission,
)
from vibe.core.types import ToolStreamEvent


def _load_runtime():
    path = Path(__file__).with_name("_bytefence_runtime.py")
    path_digest = hashlib.sha256(str(path.resolve()).encode("utf-8")).hexdigest()[:12]
    name = f"vibe_bytefence_runtime_{path_digest}"
    spec = spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError("Cannot load ByteFence Vibe runtime")
    module = module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_runtime = _load_runtime()


class ByteFenceApplyArgs(BaseModel):
    target_path: str = Field(
        min_length=1,
        max_length=_runtime.MAX_TARGET_PATH_CHARS,
        description=(
            "Protected file path, relative to the configured project root and using '/' "
            "separators. Absolute paths are accepted only when they remain below root."
        )
    )
    old_text: str = Field(
        min_length=1,
        max_length=_runtime.MAX_REPLACEMENT_CHARS,
        description="Unique UTF-8 text anchor expected exactly once in the raw target bytes.",
    )
    new_text: str = Field(
        max_length=_runtime.MAX_REPLACEMENT_CHARS,
        description="UTF-8 replacement text. ByteFence preserves every byte outside it."
    )


class ByteFenceApplyResult(BaseModel):
    status: Literal["committed-and-receipted"]
    receipt_path: str
    receipt_sha256: str
    message: str


class ByteFenceApplyConfig(BaseToolConfig):
    permission: ToolPermission = ToolPermission.ASK
    broker_command: list[str] = Field(
        default_factory=lambda: ["agent-proof", "bytefence-apply"],
        description="Executable and fixed subcommand. Invoked without a shell.",
    )
    root: str = "."
    policy_path: str = ".vibe/bytefence-policy.json"
    workspace_id: str = Field(default="", max_length=_runtime.MAX_WORKSPACE_ID_CHARS)
    receipt_directory: str = ".vibe/bytefence-receipts"
    receipt_profile: Literal["public", "local"] = "public"
    timeout_seconds: float = Field(default=60.0, gt=0, le=300)

    @field_validator("broker_command")
    @classmethod
    def validate_broker_command(cls, value: list[str]) -> list[str]:
        if not value or any(not isinstance(part, str) or not part.strip() for part in value):
            raise ValueError("broker_command must contain non-empty arguments")
        if any("\x00" in part for part in value):
            raise ValueError("broker_command must not contain NUL")
        return value


class ByteFenceApply(
    BaseTool[
        ByteFenceApplyArgs,
        ByteFenceApplyResult,
        ByteFenceApplyConfig,
        BaseToolState,
    ]
):
    description: ClassVar[str] = (
        "Apply one unique exact UTF-8 replacement through the ByteFence raw-byte broker. "
        "This tool cannot replace multiple matches and never mutates the target itself."
    )

    @classmethod
    def get_name(cls) -> str:
        return "bytefence_apply"

    async def run(
        self, args: ByteFenceApplyArgs, ctx: InvokeContext | None = None
    ) -> AsyncGenerator[ToolStreamEvent | ByteFenceApplyResult, None]:
        workspace_id = self.config.workspace_id.strip()
        if not workspace_id or workspace_id == "replace-with-stable-project-id":
            raise ToolError(
                "ByteFence workspace_id is not configured in .vibe/config.toml"
            )

        correlation = (
            f"{ctx.session_id or 'no-session-id'}:{ctx.tool_call_id}"
            if ctx is not None
            else "no-session-id:no-tool-call-id"
        )
        receipt_name = hashlib.sha256(correlation.encode("utf-8")).hexdigest()[:24]
        receipt_path = str(
            Path(self.config.receipt_directory) / f"vibe-{receipt_name}.json"
        )

        try:
            outcome = await _runtime.run_broker(
                _runtime.BrokerRequest(
                    command=tuple(self.config.broker_command),
                    root=self.config.root,
                    target_path=args.target_path,
                    old_text=args.old_text,
                    new_text=args.new_text,
                    policy_path=self.config.policy_path,
                    workspace_id=workspace_id,
                    receipt_path=receipt_path,
                    receipt_profile=self.config.receipt_profile,
                    timeout_seconds=self.config.timeout_seconds,
                )
            )
        except _runtime.BridgeInputError as error:
            raise ToolError(str(error)) from error

        if not outcome.ok or outcome.receipt_sha256 is None:
            raise ToolError(outcome.safe_message)

        yield ByteFenceApplyResult(
            status="committed-and-receipted",
            receipt_path=outcome.receipt_path,
            receipt_sha256=outcome.receipt_sha256,
            message=outcome.safe_message,
        )
