#!/usr/bin/env python3
"""Vibe hook with a strict before guard and an audit-only after phase.

The hook consumes Vibe's JSON invocation on stdin and emits only the documented
structured hook response. It never rewrites tool input, runs a mutation, or
copies tool arguments/results into its response.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from typing import Any


MAX_STDIN_BYTES = 1024 * 1024
DEFAULT_DENY_PATTERNS = ("edit", "write_file", "bash", "task")
DEFAULT_ALLOWED_TOOLS = (
    "read_file",
    "grep",
    "web_fetch",
    "web_search",
    "todo",
    "ask_user_question",
    "skill",
    "exit_plan_mode",
)


def response(
    decision: str,
    *,
    reason: str | None = None,
    system_message: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"decision": decision}
    if reason is not None:
        payload["reason"] = reason
    if system_message is not None:
        payload["system_message"] = system_message
    return payload


def matches_any(tool_name: str, patterns: tuple[str, ...]) -> bool:
    normalized = tool_name.casefold()
    return any(
        fnmatch.fnmatchcase(normalized, pattern.casefold()) for pattern in patterns
    )


def evaluate_invocation(
    invocation: object,
    *,
    deny_patterns: tuple[str, ...],
    allowed_tools: tuple[str, ...],
    allowed_broker: str,
    expected_phase: str,
) -> dict[str, Any]:
    if not isinstance(invocation, dict):
        return invalid_input_response(expected_phase, "input was not a JSON object")

    event = invocation.get("hook_event_name")
    tool_name = invocation.get("tool_name")
    if event != f"{expected_phase}_tool":
        return invalid_input_response(expected_phase, "hook event did not match its phase")

    if event == "before_tool":
        if not isinstance(tool_name, str) or not tool_name:
            return response(
                "deny",
                reason="ByteFence before_tool input omitted the tool name; failing closed.",
            )
        if tool_name.casefold() == allowed_broker.casefold():
            return response(
                "allow",
                system_message="ByteFence broker path selected for the proposed write.",
            )
        if matches_any(tool_name, deny_patterns):
            return response(
                "deny",
                reason=(
                    "An unmediated mutation surface is disabled by the ByteFence Vibe "
                    "profile. Use bytefence_apply for an exact replacement."
                ),
                system_message="ByteFence blocked an unmediated mutation surface.",
            )
        if tool_name.casefold() in {name.casefold() for name in allowed_tools}:
            return response("allow")
        return response(
            "deny",
            reason=(
                "The tool is not in the reviewed ByteFence protected-profile "
                "allowlist. Review its mutation surface before enabling it."
            ),
            system_message="ByteFence blocked an unreviewed tool surface.",
        )

    if event == "after_tool":
        if isinstance(tool_name, str) and tool_name.casefold() == allowed_broker.casefold():
            return response(
                "allow",
                system_message=(
                    "ByteFence broker completion observed. The receipt, not this "
                    "after_tool hook, carries the integrity evidence."
                ),
            )
        if isinstance(tool_name, str) and matches_any(tool_name, deny_patterns):
            return response(
                "allow",
                system_message=(
                    "An unmediated mutation surface was observed after execution. This "
                    "audit hook cannot roll back side effects."
                ),
            )
        return response("allow")

    return invalid_input_response(expected_phase, "hook event was unsupported")


def invalid_input_response(expected_phase: str, detail: str) -> dict[str, Any]:
    if expected_phase == "after":
        return response(
            "allow",
            system_message=(
                f"ByteFence audit could not validate its {detail}. The after_tool hook "
                "cannot roll back side effects."
            ),
        )
    return response(
        "deny",
        reason=f"ByteFence {detail}; the before_tool guard is failing closed.",
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--deny-pattern", action="append", default=[])
    parser.add_argument("--allow-tool", action="append", default=[])
    parser.add_argument("--allowed-broker", default="bytefence_apply")
    parser.add_argument("--phase", choices=("before", "after"), default="before")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    options = parse_args(sys.argv[1:] if argv is None else argv)
    deny_patterns = tuple(options.deny_pattern) or DEFAULT_DENY_PATTERNS
    allowed_tools = tuple(options.allow_tool) or DEFAULT_ALLOWED_TOOLS
    raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(raw) > MAX_STDIN_BYTES:
        result = invalid_input_response(options.phase, "input exceeded the size limit")
    else:
        try:
            invocation = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            result = invalid_input_response(options.phase, "input was invalid JSON")
        else:
            result = evaluate_invocation(
                invocation,
                deny_patterns=deny_patterns,
                allowed_tools=allowed_tools,
                allowed_broker=options.allowed_broker,
                expected_phase=options.phase,
            )

    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
