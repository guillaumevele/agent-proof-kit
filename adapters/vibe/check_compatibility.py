#!/usr/bin/env python3
"""Verify that a deployed Vibe project still matches the ByteFence profile."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
import hashlib
import inspect
from io import StringIO
from importlib import util as importlib_util
from importlib.metadata import PackageNotFoundError, version
import json
import os
from pathlib import Path
import stat
import sys
import tomllib


TARGET_DISTRIBUTION = "mistral-vibe"
TARGET_VERSION = "2.19.1"
TARGET_COMMIT = "30792a4cac2c2e5173c6b5a98739fbbf36324545"
ADAPTER_ROOT = Path(__file__).resolve().parent
DEFAULT_PROJECT_ROOT = ADAPTER_ROOT / "project"
MANIFEST_PATH = ADAPTER_ROOT / "adapter-manifest.json"
REQUIRED_CODE_PATHS = frozenset(
    {
        ".vibe/tools/_bytefence_runtime.py",
        ".vibe/tools/bytefence_apply.py",
        ".vibe/hooks/bytefence_guard.py",
    }
)
EXPECTED_ALLOWED_TOOL_NAMES = (
    "bytefence_apply",
    "read_file",
    "grep",
    "web_fetch",
    "web_search",
    "todo",
    "ask_user_question",
    "skill",
    "exit_plan_mode",
)
EXPECTED_PROJECT_TOOL_INVENTORY = (
    ".vibe/tools/_bytefence_runtime.py",
    ".vibe/tools/bytefence_apply.py",
)
EXPECTED_REMOTE_TOOL_SETTINGS = {
    "mcp_servers": [],
    "enable_connectors": False,
    "connectors": [],
}
EXPECTED_AGENT_SETTINGS = {
    "enable_config_orchestrator": False,
    "agent_paths": [],
    "default_agent": "default",
    "enabled_agents": ["default"],
    "disabled_agents": [],
    "installed_agents": [],
}
ALLOWED_NONEMPTY_VIBE_PROCESS_ENV = frozenset({"vibe_home"})
DISALLOWED_NONEMPTY_PROCESS_ENV = frozenset(
    {
        "pythonpath",
        "pythonhome",
        "node_options",
        "bash_env",
        "env",
        "ld_preload",
        "dyld_insert_libraries",
        "dyld_library_path",
    }
)
ALLOWED_VIBE_DOTENV_KEY = "MISTRAL_API_KEY"
MAX_VIBE_DOTENV_BYTES = 1024 * 1024


@dataclass(frozen=True)
class ToolClassEvidence:
    module: str
    class_name: str
    source_path: str | None
    sha256: str | None


@dataclass(frozen=True)
class ToolClassAttestation:
    name: str
    expected_module: str | None
    expected_class: str
    expected_source_path: str
    expected_sha256: str
    selected: ToolClassEvidence | None
    variants: tuple[ToolClassEvidence, ...]
    single_variant: bool
    origin_valid: bool
    integrity_valid: bool
    valid: bool


@dataclass(frozen=True)
class ToolSelectionProbe:
    context_established: bool
    context_error: str | None
    effective_config_exact: bool
    selected_config_file: str | None
    builtin_default_agent_exact: bool
    bytefence_apply_selected: bool
    allowed_tool_classes_exact: bool
    model_facing_tools_exact: bool
    model_facing_tools: tuple[str, ...]
    attestations: tuple[ToolClassAttestation, ...]
    search_paths: tuple[str, ...]


@dataclass(frozen=True)
class VibeDotenvProbe:
    context_established: bool
    context_error: str | None
    path: str
    disallowed_keys: tuple[str, ...]
    clean: bool


@dataclass(frozen=True)
class HookCompositionProbe:
    context_established: bool
    context_error: str | None
    effective_hooks_exact: bool
    hook_files: tuple[str, ...]
    external_entries: tuple[str, ...]
    issues: tuple[str, ...]


@dataclass(frozen=True)
class AgentInventoryProbe:
    context_established: bool
    context_error: str | None
    profile_contract_exact: bool
    search_paths: tuple[str, ...]
    external_entries: tuple[str, ...]


@dataclass(frozen=True)
class ProjectProfileFacts:
    project_root: str
    enabled_tools_exact: bool
    tool_paths_empty: bool
    remote_tool_sources_disabled: bool
    agent_profile_exact: bool
    project_tools_inventory_exact: bool
    tool_config_exact: bool
    experimental_hooks_enabled: bool
    hooks_exact: bool
    code_hashes_valid: bool
    config_document: dict[str, object] = field(repr=False)
    hook_documents: tuple[dict[str, object], ...] = field(repr=False)


@dataclass(frozen=True)
class RuntimeFacts:
    project_root: str
    detected_version: str | None
    project_tool_api: bool
    hooks_api: bool
    selection_priority_api: bool
    tool_module_importable: bool
    tool_config_valid: bool
    tool_selection_context_established: bool
    tool_selection_context_error: str | None
    effective_config_exact: bool
    selected_config_file: str | None
    builtin_default_agent_exact: bool
    bytefence_apply_selected: bool
    allowed_tool_classes_exact: bool
    model_facing_tools_exact: bool
    model_facing_tools: tuple[str, ...]
    tool_class_attestations: tuple[ToolClassAttestation, ...]
    tool_search_paths: tuple[str, ...]
    additional_dirs: tuple[str, ...]
    additional_dirs_empty: bool
    relevant_environment_overrides: tuple[str, ...]
    relevant_environment_overrides_absent: bool
    vibe_dotenv_context_established: bool
    vibe_dotenv_context_error: str | None
    vibe_dotenv_path: str
    vibe_dotenv_disallowed_keys: tuple[str, ...]
    vibe_dotenv_clean: bool
    hook_composition_context_established: bool
    hook_composition_context_error: str | None
    effective_hooks_exact: bool
    hook_files_observed: tuple[str, ...]
    external_hook_entries: tuple[str, ...]
    hook_config_issues: tuple[str, ...]
    agent_inventory_context_established: bool
    agent_inventory_context_error: str | None
    external_agent_entries: tuple[str, ...]
    agent_search_paths: tuple[str, ...]
    enabled_tools_exact: bool
    tool_paths_empty: bool
    remote_tool_sources_disabled: bool
    agent_profile_exact: bool
    project_tools_inventory_exact: bool
    tool_config_exact: bool
    experimental_hooks_enabled: bool
    hooks_exact: bool
    hooks_model_valid: bool
    code_hashes_valid: bool


@dataclass(frozen=True)
class CompatibilityReport:
    adapter_target: str
    upstream_commit: str
    project_root: str
    detected_version: str | None
    mode: str
    explicit_tool_supported: bool
    protected_profile_supported: bool
    edit_override_supported: bool
    edit_override_enabled: bool
    session_wide_enforcement_claimed: bool
    tool_module_importable: bool
    tool_config_valid: bool
    tool_selection_context_established: bool
    tool_selection_context_error: str | None
    effective_config_exact: bool
    selected_config_file: str | None
    builtin_default_agent_exact: bool
    bytefence_apply_selected: bool
    allowed_tool_classes_exact: bool
    model_facing_tools_exact: bool
    model_facing_tools: tuple[str, ...]
    tool_class_attestations: tuple[ToolClassAttestation, ...]
    tool_search_paths: tuple[str, ...]
    additional_dirs: tuple[str, ...]
    additional_dirs_empty: bool
    relevant_environment_overrides: tuple[str, ...]
    relevant_environment_overrides_absent: bool
    vibe_dotenv_context_established: bool
    vibe_dotenv_context_error: str | None
    vibe_dotenv_path: str
    vibe_dotenv_disallowed_keys: tuple[str, ...]
    vibe_dotenv_clean: bool
    hook_composition_context_established: bool
    hook_composition_context_error: str | None
    effective_hooks_exact: bool
    hook_files_observed: tuple[str, ...]
    external_hook_entries: tuple[str, ...]
    hook_config_issues: tuple[str, ...]
    agent_inventory_context_established: bool
    agent_inventory_context_error: str | None
    external_agent_entries: tuple[str, ...]
    agent_search_paths: tuple[str, ...]
    enabled_tools_exact: bool
    tool_paths_empty: bool
    remote_tool_sources_disabled: bool
    agent_profile_exact: bool
    project_tools_inventory_exact: bool
    tool_config_exact: bool
    experimental_hooks_enabled: bool
    hooks_exact: bool
    hooks_model_valid: bool
    code_hashes_valid: bool
    reasons: tuple[str, ...]


def inspect_project_profile(
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
) -> ProjectProfileFacts:
    root = Path(project_root).expanduser().resolve()
    manifest = _read_manifest()
    config = _read_toml(root / ".vibe" / "config.toml")
    hooks_document = _read_toml(root / ".vibe" / "hooks.toml")

    protected = manifest.get("protectedProfile", {})
    if not isinstance(protected, dict):
        protected = {}
    expected_tools = protected.get("enabledToolsExact")
    enabled_tools_exact = (
        isinstance(expected_tools, list)
        and expected_tools == list(EXPECTED_ALLOWED_TOOL_NAMES)
        and config.get("enabled_tools") == expected_tools
        and protected.get("disabledToolsExact") == []
        and config.get("disabled_tools") == []
    )
    tool_paths_empty = (
        protected.get("toolPathsExact") == [] and config.get("tool_paths") == []
    )
    remote_contract = protected.get("remoteToolSourcesExact")
    remote_tool_sources_disabled = (
        isinstance(remote_contract, dict)
        and remote_contract == EXPECTED_REMOTE_TOOL_SETTINGS
        and all(config.get(name) == value for name, value in remote_contract.items())
    )
    agent_contract = protected.get("agentProfileExact")
    agent_profile_exact = (
        isinstance(agent_contract, dict)
        and agent_contract == EXPECTED_AGENT_SETTINGS
        and all(config.get(name) == value for name, value in agent_contract.items())
        and protected.get("externalAgentProfilesAllowed") is False
    )
    project_tools_inventory_exact = _project_tools_inventory_matches(
        root, protected.get("projectToolsInventoryExact")
    )
    tool_config_exact = _tool_config_matches(config, manifest)
    experimental_hooks_enabled = (
        protected.get("experimentalHooksRequired") is True
        and config.get("enable_experimental_hooks") is True
    )

    expected_hooks = manifest.get("hookContract")
    actual_hooks = hooks_document.get("hooks")
    hooks_exact = (
        set(hooks_document) == {"hooks"}
        and protected.get("externalHookFilesAllowed") is False
        and isinstance(expected_hooks, list)
        and isinstance(actual_hooks, list)
        and actual_hooks == expected_hooks
    )
    hook_documents = tuple(
        hook for hook in actual_hooks or [] if isinstance(hook, dict)
    )

    return ProjectProfileFacts(
        project_root=str(root),
        enabled_tools_exact=enabled_tools_exact,
        tool_paths_empty=tool_paths_empty,
        remote_tool_sources_disabled=remote_tool_sources_disabled,
        agent_profile_exact=agent_profile_exact,
        project_tools_inventory_exact=project_tools_inventory_exact,
        tool_config_exact=tool_config_exact,
        experimental_hooks_enabled=experimental_hooks_enabled,
        hooks_exact=hooks_exact,
        code_hashes_valid=_code_hashes_match(root, manifest),
        config_document=config,
        hook_documents=hook_documents,
    )


def classify_runtime(facts: RuntimeFacts) -> CompatibilityReport:
    exact_version = facts.detected_version == TARGET_VERSION
    explicit_supported = (
        facts.project_tool_api
        and facts.tool_module_importable
        and facts.tool_config_valid
        and facts.tool_selection_context_established
        and facts.effective_config_exact
        and facts.builtin_default_agent_exact
        and facts.bytefence_apply_selected
        and facts.model_facing_tools_exact
        and facts.additional_dirs_empty
        and facts.relevant_environment_overrides_absent
        and facts.vibe_dotenv_context_established
        and facts.vibe_dotenv_clean
        and facts.hook_composition_context_established
        and facts.effective_hooks_exact
        and facts.agent_inventory_context_established
        and not facts.external_agent_entries
        and facts.agent_profile_exact
    )
    protected_supported = (
        exact_version
        and explicit_supported
        and facts.hooks_api
        and facts.allowed_tool_classes_exact
        and facts.enabled_tools_exact
        and facts.tool_paths_empty
        and facts.remote_tool_sources_disabled
        and facts.agent_profile_exact
        and facts.project_tools_inventory_exact
        and facts.tool_config_exact
        and facts.experimental_hooks_enabled
        and facts.hooks_exact
        and facts.hooks_model_valid
        and facts.code_hashes_valid
    )
    edit_override_supported = (
        protected_supported and facts.selection_priority_api
    )

    reasons: list[str] = []
    if facts.detected_version is None:
        reasons.append("mistral-vibe is not installed in this Python environment")
    elif not exact_version:
        reasons.append(
            f"detected mistral-vibe {facts.detected_version}; protected target is {TARGET_VERSION}"
        )
    if not facts.project_tool_api:
        reasons.append("required BaseTool project-tool API is unavailable")
    if not facts.tool_module_importable:
        reasons.append("deployed bytefence_apply project tool is not importable")
    if not facts.tool_config_valid:
        reasons.append("deployed bytefence_apply configuration is invalid")
    if not facts.tool_selection_context_established:
        detail = (
            f": {facts.tool_selection_context_error}"
            if facts.tool_selection_context_error
            else ""
        )
        reasons.append(
            "Vibe local tool-selection context could not be established" + detail
        )
    elif not facts.bytefence_apply_selected:
        reasons.append(
            "the selected bytefence_apply class does not match the reviewed project "
            "origin and SHA-256"
        )
    if not facts.effective_config_exact:
        reasons.append(
            "Vibe's effective selected project configuration differs from the "
            "reviewed security contract"
        )
    if not facts.builtin_default_agent_exact:
        reasons.append("the pinned builtin default agent contract is not established")
    if not facts.model_facing_tools_exact:
        reasons.append("the default agent's model-facing tool set is not exact")
    if not facts.allowed_tool_classes_exact:
        reasons.append(
            "one or more allowed tool names has a missing, shadowed or unexpected "
            "class variant"
        )
    if not facts.additional_dirs_empty:
        reasons.append("Vibe --add-dir is outside the protected profile")
    if not facts.relevant_environment_overrides_absent:
        reasons.append(
            "non-empty process overrides outside the protected environment "
            "contract are present: "
            + ", ".join(facts.relevant_environment_overrides)
        )
    if not facts.vibe_dotenv_context_established:
        reasons.append(
            "Vibe .env could not be inspected safely"
            + (
                f": {facts.vibe_dotenv_context_error}"
                if facts.vibe_dotenv_context_error
                else ""
            )
        )
    elif not facts.vibe_dotenv_clean:
        reasons.append(
            "Vibe .env contains keys outside the sole allowed non-empty "
            f"{ALLOWED_VIBE_DOTENV_KEY} entry: "
            + ", ".join(facts.vibe_dotenv_disallowed_keys)
        )
    if not facts.hook_composition_context_established:
        reasons.append(
            "Vibe's effective hook composition could not be established"
            + (
                f": {facts.hook_composition_context_error}"
                if facts.hook_composition_context_error
                else ""
            )
        )
    elif not facts.effective_hooks_exact:
        reasons.append(
            "effective hooks include external, invalid or non-reviewed entries"
        )
    if facts.external_hook_entries:
        reasons.append(
            "external hook entries are present: "
            + ", ".join(facts.external_hook_entries)
        )
    if not facts.agent_inventory_context_established:
        reasons.append(
            "Vibe agent-profile inventory could not be established"
            + (
                f": {facts.agent_inventory_context_error}"
                if facts.agent_inventory_context_error
                else ""
            )
        )
    if facts.external_agent_entries:
        reasons.append(
            "external agent profiles are present: "
            + ", ".join(facts.external_agent_entries)
        )
    if not facts.hooks_api:
        reasons.append("required experimental hook API is unavailable")
    if not facts.enabled_tools_exact:
        reasons.append("enabled_tools differs from the reviewed protected allowlist")
    if not facts.tool_paths_empty:
        reasons.append("tool_paths must be the explicit empty list")
    if not facts.remote_tool_sources_disabled:
        reasons.append(
            "MCP servers and connectors must remain explicitly empty and disabled"
        )
    if not facts.agent_profile_exact:
        reasons.append("default-agent and agent discovery settings are not exact")
    if not facts.project_tools_inventory_exact:
        reasons.append(".vibe/tools differs from the reviewed exact inventory")
    if not facts.tool_config_exact:
        reasons.append(
            "tools.bytefence_apply differs from the reviewed fixed security contract"
        )
    if not facts.experimental_hooks_enabled:
        reasons.append("experimental hooks are not explicitly enabled")
    if not facts.hooks_exact:
        reasons.append("hooks.toml differs from the reviewed hook contract")
    if exact_version and facts.hooks_api and not facts.hooks_model_valid:
        reasons.append("hooks.toml does not validate through Vibe 2.19.1 HookConfig")
    if not facts.code_hashes_valid:
        reasons.append("deployed ByteFence adapter code does not match manifest SHA-256 digests")
    if not facts.selection_priority_api:
        reasons.append("same-name tool selection_priority API is unavailable")
    if edit_override_supported:
        reasons.append(
            "the runtime could rank a same-name edit variant, but this adapter keeps the "
            "explicit bytefence_apply tool"
        )
    if protected_supported:
        reasons.append(
            "protected profile is compatible only while its exact allowlist, local "
            "tool-class selection, hooks and code-integrity contract remain unchanged"
        )

    if protected_supported:
        mode = "protected-explicit-tool"
    elif explicit_supported:
        mode = "explicit-tool-only-fallback"
    else:
        mode = "unsupported"

    return CompatibilityReport(
        adapter_target=f"{TARGET_DISTRIBUTION}=={TARGET_VERSION}",
        upstream_commit=TARGET_COMMIT,
        project_root=facts.project_root,
        detected_version=facts.detected_version,
        mode=mode,
        explicit_tool_supported=explicit_supported,
        protected_profile_supported=protected_supported,
        edit_override_supported=edit_override_supported,
        edit_override_enabled=False,
        session_wide_enforcement_claimed=False,
        tool_module_importable=facts.tool_module_importable,
        tool_config_valid=facts.tool_config_valid,
        tool_selection_context_established=facts.tool_selection_context_established,
        tool_selection_context_error=facts.tool_selection_context_error,
        effective_config_exact=facts.effective_config_exact,
        selected_config_file=facts.selected_config_file,
        builtin_default_agent_exact=facts.builtin_default_agent_exact,
        bytefence_apply_selected=facts.bytefence_apply_selected,
        allowed_tool_classes_exact=facts.allowed_tool_classes_exact,
        model_facing_tools_exact=facts.model_facing_tools_exact,
        model_facing_tools=facts.model_facing_tools,
        tool_class_attestations=facts.tool_class_attestations,
        tool_search_paths=facts.tool_search_paths,
        additional_dirs=facts.additional_dirs,
        additional_dirs_empty=facts.additional_dirs_empty,
        relevant_environment_overrides=facts.relevant_environment_overrides,
        relevant_environment_overrides_absent=(
            facts.relevant_environment_overrides_absent
        ),
        vibe_dotenv_context_established=facts.vibe_dotenv_context_established,
        vibe_dotenv_context_error=facts.vibe_dotenv_context_error,
        vibe_dotenv_path=facts.vibe_dotenv_path,
        vibe_dotenv_disallowed_keys=facts.vibe_dotenv_disallowed_keys,
        vibe_dotenv_clean=facts.vibe_dotenv_clean,
        hook_composition_context_established=(
            facts.hook_composition_context_established
        ),
        hook_composition_context_error=facts.hook_composition_context_error,
        effective_hooks_exact=facts.effective_hooks_exact,
        hook_files_observed=facts.hook_files_observed,
        external_hook_entries=facts.external_hook_entries,
        hook_config_issues=facts.hook_config_issues,
        agent_inventory_context_established=(
            facts.agent_inventory_context_established
        ),
        agent_inventory_context_error=facts.agent_inventory_context_error,
        external_agent_entries=facts.external_agent_entries,
        agent_search_paths=facts.agent_search_paths,
        enabled_tools_exact=facts.enabled_tools_exact,
        tool_paths_empty=facts.tool_paths_empty,
        remote_tool_sources_disabled=facts.remote_tool_sources_disabled,
        agent_profile_exact=facts.agent_profile_exact,
        project_tools_inventory_exact=facts.project_tools_inventory_exact,
        tool_config_exact=facts.tool_config_exact,
        experimental_hooks_enabled=facts.experimental_hooks_enabled,
        hooks_exact=facts.hooks_exact,
        hooks_model_valid=facts.hooks_model_valid,
        code_hashes_valid=facts.code_hashes_valid,
        reasons=tuple(reasons),
    )


def probe_runtime(
    project_root: str | Path = DEFAULT_PROJECT_ROOT,
    *,
    additional_dirs: tuple[str | Path, ...] = (),
) -> RuntimeFacts:
    profile = inspect_project_profile(project_root)
    normalized_additional_dirs = tuple(
        str(Path(path).expanduser().resolve()) for path in additional_dirs
    )
    relevant_environment_overrides = _relevant_environment_overrides()
    vibe_dotenv = _probe_vibe_dotenv()
    runtime_environment_clean = (
        not relevant_environment_overrides
        and vibe_dotenv.context_established
        and vibe_dotenv.clean
    )
    try:
        detected_version = version(TARGET_DISTRIBUTION)
    except PackageNotFoundError:
        detected_version = None

    project_tool_api = False
    hooks_api = False
    selection_priority_api = False
    tool_module_importable = False
    tool_config_valid = False
    hooks_model_valid = False
    tool_selection = ToolSelectionProbe(
        context_established=False,
        context_error="Vibe ToolManager API is unavailable",
        effective_config_exact=False,
        selected_config_file=None,
        builtin_default_agent_exact=False,
        bytefence_apply_selected=False,
        allowed_tool_classes_exact=False,
        model_facing_tools_exact=False,
        model_facing_tools=(),
        attestations=(),
        search_paths=(),
    )
    hook_composition = HookCompositionProbe(
        False, "Vibe hook loader API is unavailable", False, (), (), ()
    )
    agent_inventory = AgentInventoryProbe(
        False, "Vibe agent discovery API is unavailable", False, (), ()
    )
    base_tool = None
    base_tool_config = None
    hook_config = None

    try:
        from vibe.core.tools.base import BaseTool, BaseToolConfig, BaseToolState

        project_tool_api = all(
            hasattr(BaseTool, attribute)
            for attribute in ("get_name", "from_config", "invoke")
        ) and BaseToolConfig is not None and BaseToolState is not None
        selection_priority_api = hasattr(BaseTool, "selection_priority")
        base_tool = BaseTool
        base_tool_config = BaseToolConfig
    except Exception:
        pass

    try:
        from vibe.core.hooks.models import HookConfig, HookStructuredResponse

        fields = getattr(HookConfig, "model_fields", {})
        hooks_api = (
            "strict" in fields
            and "type" in fields
            and "command" in fields
            and HookStructuredResponse is not None
        )
        hook_config = HookConfig
    except Exception:
        pass

    if project_tool_api and base_tool is not None and base_tool_config is not None:
        try:
            module = _load_project_tool(Path(profile.project_root))
            tool_class = module.ByteFenceApply
            config_class = module.ByteFenceApplyConfig
            tool_module_importable = (
                issubclass(tool_class, base_tool)
                and issubclass(config_class, base_tool_config)
                and tool_class.get_name() == "bytefence_apply"
            )
            configured_tools = profile.config_document.get("tools")
            raw_tool_config = (
                configured_tools.get("bytefence_apply")
                if isinstance(configured_tools, dict)
                else None
            )
            if tool_module_importable and isinstance(raw_tool_config, dict):
                validated = config_class.model_validate(raw_tool_config)
                tool_config_valid = isinstance(validated, base_tool_config)
        except Exception:
            tool_module_importable = False
            tool_config_valid = False

    if project_tool_api:
        agent_inventory = _probe_agent_inventory(
            profile, tuple(Path(path) for path in normalized_additional_dirs)
        )
        tool_selection = _probe_local_tool_selection(
            profile,
            tuple(Path(path) for path in normalized_additional_dirs),
            runtime_environment_clean=runtime_environment_clean,
        )

    if hooks_api:
        hook_composition = _probe_effective_hooks(
            profile, tuple(Path(path) for path in normalized_additional_dirs)
        )

    if (
        detected_version == TARGET_VERSION
        and hooks_api
        and hook_config is not None
        and profile.hook_documents
    ):
        try:
            for hook in profile.hook_documents:
                hook_config.model_validate(hook)
            hooks_model_valid = True
        except Exception:
            hooks_model_valid = False

    return RuntimeFacts(
        project_root=profile.project_root,
        detected_version=detected_version,
        project_tool_api=project_tool_api,
        hooks_api=hooks_api,
        selection_priority_api=selection_priority_api,
        tool_module_importable=tool_module_importable,
        tool_config_valid=tool_config_valid,
        tool_selection_context_established=tool_selection.context_established,
        tool_selection_context_error=tool_selection.context_error,
        effective_config_exact=tool_selection.effective_config_exact,
        selected_config_file=tool_selection.selected_config_file,
        builtin_default_agent_exact=tool_selection.builtin_default_agent_exact,
        bytefence_apply_selected=tool_selection.bytefence_apply_selected,
        allowed_tool_classes_exact=tool_selection.allowed_tool_classes_exact,
        model_facing_tools_exact=tool_selection.model_facing_tools_exact,
        model_facing_tools=tool_selection.model_facing_tools,
        tool_class_attestations=tool_selection.attestations,
        tool_search_paths=tool_selection.search_paths,
        additional_dirs=normalized_additional_dirs,
        additional_dirs_empty=not normalized_additional_dirs,
        relevant_environment_overrides=relevant_environment_overrides,
        relevant_environment_overrides_absent=not relevant_environment_overrides,
        vibe_dotenv_context_established=vibe_dotenv.context_established,
        vibe_dotenv_context_error=vibe_dotenv.context_error,
        vibe_dotenv_path=vibe_dotenv.path,
        vibe_dotenv_disallowed_keys=vibe_dotenv.disallowed_keys,
        vibe_dotenv_clean=vibe_dotenv.clean,
        hook_composition_context_established=(
            hook_composition.context_established
        ),
        hook_composition_context_error=hook_composition.context_error,
        effective_hooks_exact=hook_composition.effective_hooks_exact,
        hook_files_observed=hook_composition.hook_files,
        external_hook_entries=hook_composition.external_entries,
        hook_config_issues=hook_composition.issues,
        agent_inventory_context_established=agent_inventory.context_established,
        agent_inventory_context_error=agent_inventory.context_error,
        external_agent_entries=agent_inventory.external_entries,
        agent_search_paths=agent_inventory.search_paths,
        enabled_tools_exact=profile.enabled_tools_exact,
        tool_paths_empty=profile.tool_paths_empty,
        remote_tool_sources_disabled=profile.remote_tool_sources_disabled,
        agent_profile_exact=(
            profile.agent_profile_exact and agent_inventory.profile_contract_exact
        ),
        project_tools_inventory_exact=profile.project_tools_inventory_exact,
        tool_config_exact=profile.tool_config_exact,
        experimental_hooks_enabled=profile.experimental_hooks_enabled,
        hooks_exact=profile.hooks_exact,
        hooks_model_valid=hooks_model_valid,
        code_hashes_valid=profile.code_hashes_valid,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify the deployed ByteFence profile for Mistral Vibe."
    )
    parser.add_argument(
        "--project-root",
        default=str(DEFAULT_PROJECT_ROOT),
        help="Project root containing the deployed .vibe profile.",
    )
    parser.add_argument(
        "--add-dir",
        action="append",
        default=[],
        help=(
            "Additional Vibe project directory to observe. Any value invalidates the "
            "protected profile, while still exposing same-name tool variants."
        ),
    )
    args = parser.parse_args(argv)
    report = classify_runtime(
        probe_runtime(args.project_root, additional_dirs=tuple(args.add_dir))
    )
    sys.stdout.write(json.dumps(asdict(report), indent=2, sort_keys=True) + "\n")
    if report.protected_profile_supported:
        return 0
    if report.explicit_tool_supported:
        return 1
    return 2


def _read_manifest() -> dict[str, object]:
    try:
        document = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return document if isinstance(document, dict) else {}


def _read_toml(path: Path) -> dict[str, object]:
    try:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            return {}
        document = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError):
        return {}
    return document if isinstance(document, dict) else {}


def _code_hashes_match(root: Path, manifest: dict[str, object]) -> bool:
    integrity = manifest.get("codeIntegrity")
    if not isinstance(integrity, dict) or integrity.get("algorithm") != "sha256":
        return False
    expected_files = integrity.get("files")
    if not isinstance(expected_files, dict) or set(expected_files) != REQUIRED_CODE_PATHS:
        return False

    for relative_path, expected_digest in expected_files.items():
        if (
            not isinstance(relative_path, str)
            or not isinstance(expected_digest, str)
            or len(expected_digest) != 64
            or any(character not in "0123456789abcdef" for character in expected_digest)
        ):
            return False
        relative = Path(relative_path)
        if relative.is_absolute() or ".." in relative.parts:
            return False
        path = root / relative
        try:
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                return False
            actual_digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            return False
        if actual_digest != expected_digest:
            return False
    return True


def _relevant_environment_overrides() -> tuple[str, ...]:
    names: list[str] = []
    for name, value in os.environ.items():
        normalized = name.casefold()
        if (
            (
                normalized in DISALLOWED_NONEMPTY_PROCESS_ENV
                or (
                    normalized.startswith("vibe_")
                    and normalized not in ALLOWED_NONEMPTY_VIBE_PROCESS_ENV
                )
            )
            and bool(value)
        ):
            names.append(name)
    return tuple(sorted(names, key=str.casefold))


def _probe_vibe_dotenv() -> VibeDotenvProbe:
    vibe_home = Path(
        os.environ.get("VIBE_HOME") or (Path.home() / ".vibe")
    ).expanduser().resolve()
    path = vibe_home / ".env"
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return VibeDotenvProbe(True, None, str(path), (), True)
    except OSError as error:
        return VibeDotenvProbe(
            False, f"{type(error).__name__}: {error}", str(path), (), False
        )

    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        return VibeDotenvProbe(
            False,
            "Vibe .env must be an ordinary regular file, not a symlink or special file",
            str(path),
            (),
            False,
        )
    if metadata.st_size > MAX_VIBE_DOTENV_BYTES:
        return VibeDotenvProbe(
            False,
            f"Vibe .env exceeds {MAX_VIBE_DOTENV_BYTES} bytes",
            str(path),
            (),
            False,
        )

    try:
        from dotenv import dotenv_values
        from dotenv.parser import parse_stream

        flags = os.O_RDONLY
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NONBLOCK", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError("Vibe .env changed to a non-regular file")
            if (opened.st_dev, opened.st_ino) != (
                metadata.st_dev,
                metadata.st_ino,
            ):
                raise ValueError("Vibe .env changed while it was inspected")
            if opened.st_size > MAX_VIBE_DOTENV_BYTES:
                raise ValueError("Vibe .env grew beyond the read bound")

            chunks: list[bytes] = []
            remaining = MAX_VIBE_DOTENV_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(64 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            payload = b"".join(chunks)
            if len(payload) > MAX_VIBE_DOTENV_BYTES:
                raise ValueError("Vibe .env grew beyond the read bound")
            closed = os.fstat(descriptor)
            if (
                closed.st_dev,
                closed.st_ino,
                closed.st_size,
                closed.st_mtime_ns,
            ) != (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
            ):
                raise ValueError("Vibe .env changed while it was read")
        finally:
            os.close(descriptor)

        text = payload.decode("utf-8")
        bindings = list(parse_stream(StringIO(text)))
        if any(binding.error for binding in bindings):
            raise ValueError("Vibe .env contains invalid dotenv syntax")
        assignments = [binding for binding in bindings if binding.key is not None]
        values = dotenv_values(stream=StringIO(text))
        disallowed = {
            name
            for name, value in values.items()
            if name != ALLOWED_VIBE_DOTENV_KEY or not value
        }
        if sum(
            binding.key == ALLOWED_VIBE_DOTENV_KEY for binding in assignments
        ) > 1:
            disallowed.add(ALLOWED_VIBE_DOTENV_KEY)
        disallowed_keys = tuple(sorted(disallowed, key=str.casefold))
    except Exception as error:
        return VibeDotenvProbe(
            False, f"{type(error).__name__}: {error}", str(path), (), False
        )
    return VibeDotenvProbe(
        True,
        None,
        str(path),
        disallowed_keys,
        not disallowed_keys,
    )


def _tool_config_matches(
    config: dict[str, object], manifest: dict[str, object]
) -> bool:
    contract = manifest.get("projectToolConfigContract")
    if not isinstance(contract, dict):
        return False
    fixed = contract.get("fixedFieldsExact")
    variables = contract.get("variableFields")
    if (
        not isinstance(fixed, dict)
        or not isinstance(variables, dict)
        or set(variables) != {"workspace_id"}
    ):
        return False
    workspace_contract = variables.get("workspace_id")
    if not isinstance(workspace_contract, dict):
        return False
    if set(workspace_contract) != {"type", "minLength", "maxLength"}:
        return False
    if (
        workspace_contract.get("type") != "string"
        or workspace_contract.get("minLength") != 1
        or workspace_contract.get("maxLength") != 1024
    ):
        return False

    configured_tools = config.get("tools")
    if not isinstance(configured_tools, dict) or set(configured_tools) != {
        "bytefence_apply"
    }:
        return False
    actual = configured_tools.get("bytefence_apply")
    if not isinstance(actual, dict) or set(actual) != {
        *fixed,
        "workspace_id",
    }:
        return False
    if any(actual.get(name) != value for name, value in fixed.items()):
        return False
    workspace_id = actual.get("workspace_id")
    return isinstance(workspace_id, str) and 1 <= len(workspace_id) <= 1024


def _project_tools_inventory_matches(root: Path, expected: object) -> bool:
    if (
        not isinstance(expected, list)
        or expected != list(EXPECTED_PROJECT_TOOL_INVENTORY)
    ):
        return False

    tools_directory = root / ".vibe" / "tools"
    try:
        metadata = tools_directory.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            return False
        actual: set[str] = set()
        for entry in tools_directory.iterdir():
            entry_metadata = entry.lstat()
            if (
                entry.name == "__pycache__"
                and not stat.S_ISLNK(entry_metadata.st_mode)
                and stat.S_ISDIR(entry_metadata.st_mode)
            ):
                continue
            actual.add(f".vibe/tools/{entry.name}")
    except OSError:
        return False

    expected_set = set(expected)
    if actual != expected_set:
        return False
    for relative_path in expected:
        relative = Path(relative_path)
        if (
            relative.is_absolute()
            or ".." in relative.parts
            or relative.parent != Path(".vibe/tools")
        ):
            return False
        try:
            file_metadata = (root / relative).lstat()
        except OSError:
            return False
        if stat.S_ISLNK(file_metadata.st_mode) or not stat.S_ISREG(file_metadata.st_mode):
            return False
    return True


def _valid_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _resolve_configured_tool_paths(
    project_root: Path, config_document: dict[str, object]
) -> list[Path]:
    raw_paths = config_document.get("tool_paths", [])
    if not isinstance(raw_paths, list):
        raise ValueError("tool_paths is not a list")

    resolved: list[Path] = []
    for raw_path in raw_paths:
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ValueError("tool_paths contains a non-path value")
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            path = project_root / path
        resolved.append(path.resolve())
    return resolved


def _class_evidence(tool_class: type[object]) -> ToolClassEvidence:
    source_path: str | None = None
    digest: str | None = None
    try:
        raw_source = inspect.getsourcefile(tool_class) or inspect.getfile(tool_class)
        path = Path(raw_source).expanduser()
        resolved = path.resolve()
        source_path = str(resolved)
        metadata = path.lstat()
        if not stat.S_ISLNK(metadata.st_mode) and stat.S_ISREG(metadata.st_mode):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except (OSError, TypeError):
        pass
    return ToolClassEvidence(
        module=str(getattr(tool_class, "__module__", "")),
        class_name=str(getattr(tool_class, "__qualname__", "")),
        source_path=source_path,
        sha256=digest,
    )


def _expected_tool_contract(
    project_root: Path, vibe_package_root: Path
) -> dict[str, tuple[str | None, str, Path, str]]:
    manifest = _read_manifest()
    contract = manifest.get("runtimeToolContract")
    if not isinstance(contract, dict):
        raise ValueError("manifest runtimeToolContract is absent")
    tools = contract.get("tools")
    if not isinstance(tools, dict) or set(tools) != set(EXPECTED_ALLOWED_TOOL_NAMES):
        raise ValueError("manifest runtime tool-name inventory is not exact")

    expected: dict[str, tuple[str | None, str, Path, str]] = {}
    for name in EXPECTED_ALLOWED_TOOL_NAMES:
        entry = tools.get(name)
        if not isinstance(entry, dict):
            raise ValueError(f"manifest tool contract for {name} is invalid")
        source_root = entry.get("sourceRoot")
        relative_path = entry.get("relativePath")
        class_name = entry.get("class")
        module_name = entry.get("module")
        digest = entry.get("sha256")
        if (
            source_root not in {"project", "vibe-package"}
            or not isinstance(relative_path, str)
            or not isinstance(class_name, str)
            or not class_name
            or (module_name is not None and not isinstance(module_name, str))
            or not _valid_sha256(digest)
        ):
            raise ValueError(f"manifest tool contract for {name} is invalid")
        relative = Path(relative_path)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"manifest tool source for {name} escapes its root")
        if source_root == "project":
            base = project_root
            if module_name is not None:
                raise ValueError("project tool modules are path-derived and must not be pinned")
        else:
            base = vibe_package_root
            if not module_name:
                raise ValueError(f"builtin module for {name} is not pinned")
        expected[name] = (module_name, class_name, (base / relative).resolve(), digest)
    return expected


def _effective_config_matches(config: object) -> bool:
    try:
        effective = {
            "enable_config_orchestrator": config.enable_config_orchestrator,
            "agent_paths": [str(path) for path in config.agent_paths],
            "default_agent": str(config.default_agent),
            "enabled_agents": list(config.enabled_agents),
            "disabled_agents": list(config.disabled_agents),
            "installed_agents": list(config.installed_agents),
        }
        return (
            list(config.enabled_tools) == list(EXPECTED_ALLOWED_TOOL_NAMES)
            and list(config.disabled_tools) == []
            and list(config.tool_paths) == []
            and list(config.mcp_servers) == []
            and config.enable_connectors is False
            and list(config.connectors) == []
            and config.enable_experimental_hooks is True
            and effective == EXPECTED_AGENT_SETTINGS
            and _tool_config_matches(
                {"tools": dict(config.tools)}, _read_manifest()
            )
        )
    except (AttributeError, TypeError, ValueError):
        return False


def _builtin_default_agent_matches(default_profile: object, vibe_root: Path) -> bool:
    contract = _read_manifest().get("runtimeAgentContract")
    if not isinstance(contract, dict):
        return False
    expected_keys = {
        "module",
        "relativePath",
        "sha256",
        "profile",
        "overridesExact",
        "modelFacingToolsExact",
    }
    if set(contract) != expected_keys or not _valid_sha256(contract.get("sha256")):
        return False
    relative_path = contract.get("relativePath")
    if not isinstance(relative_path, str):
        return False
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        return False
    path = vibe_root / relative
    try:
        metadata = path.lstat()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return False
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        return False
    return (
        contract.get("module") == type(default_profile).__module__
        and contract.get("profile") == str(default_profile.name)
        and contract.get("overridesExact") == default_profile.overrides
        and digest == contract.get("sha256")
    )


def _build_probe_harness(
    harness_class: type[object], project_root: Path, additional_dirs: tuple[Path, ...]
):
    class TrustedProjectHarness(harness_class):
        @property
        def _trusted_workdir(self) -> Path | None:
            return self.cwd

    return TrustedProjectHarness(
        sources=("user", "project"),
        cwd=project_root,
        _additional_dirs=additional_dirs,
    )


def _probe_effective_hooks(
    profile: ProjectProfileFacts, additional_dirs: tuple[Path, ...]
) -> HookCompositionProbe:
    old_manager = None
    harness_module = None
    try:
        import vibe.core.config.harness_files._harness_manager as harness_module
        from vibe.core.config.harness_files import HarnessFilesManager
        from vibe.core.hooks.config import load_hooks_from_fs
        from vibe.core.hooks.models import HookConfig

        old_manager = harness_module._manager
        project_root = Path(profile.project_root)
        harness = _build_probe_harness(
            HarnessFilesManager, project_root, additional_dirs
        )
        harness_module._manager = harness

        class HookConfigView:
            enable_experimental_hooks = True

        result = load_hooks_from_fs(HookConfigView())
        expected_contract = _read_manifest().get("hookContract")
        if not isinstance(expected_contract, list):
            raise ValueError("manifest hookContract is absent")
        expected = [
            HookConfig.model_validate(item).model_dump(mode="json")
            for item in expected_contract
        ]
        actual = [item.model_dump(mode="json") for item in result.hooks]
        hook_files = tuple(str(path.absolute()) for path in harness.hook_files)
        expected_project_hook = str(
            (project_root / ".vibe" / "hooks.toml").absolute()
        )
        external_entries: list[str] = []
        for path in harness.hook_files:
            absolute = str(path.absolute())
            if absolute == expected_project_hook:
                continue
            try:
                path.lstat()
            except FileNotFoundError:
                continue
            external_entries.append(absolute)
        issues = tuple(f"{item.file}: {item.message}" for item in result.issues)
        external = tuple(sorted(set(external_entries)))
        exact = actual == expected and not issues and not external
        return HookCompositionProbe(
            True, None, exact, hook_files, external, issues
        )
    except Exception as error:
        return HookCompositionProbe(
            False, f"{type(error).__name__}: {error}", False, (), (), ()
        )
    finally:
        if harness_module is not None:
            harness_module._manager = old_manager


def _probe_agent_inventory(
    profile: ProjectProfileFacts, additional_dirs: tuple[Path, ...]
) -> AgentInventoryProbe:
    old_manager = None
    harness_module = None
    try:
        import vibe.core.config.harness_files._harness_manager as harness_module
        from vibe.core.config.harness_files import HarnessFilesManager
        from vibe.core.paths import dedup_paths

        old_manager = harness_module._manager
        project_root = Path(profile.project_root)
        harness = _build_probe_harness(
            HarnessFilesManager, project_root, additional_dirs
        )
        harness_module._manager = harness
        raw_agent_paths = profile.config_document.get("agent_paths", [])
        if not isinstance(raw_agent_paths, list):
            raise ValueError("agent_paths is not a list")
        configured: list[Path] = []
        for raw_path in raw_agent_paths:
            if not isinstance(raw_path, str) or not raw_path.strip():
                raise ValueError("agent_paths contains a non-path value")
            path = Path(raw_path).expanduser()
            if not path.is_absolute():
                path = project_root / path
            configured.append(path.resolve())
        search_paths = dedup_paths(
            [
                *(path for path in configured if path.is_dir()),
                *harness.project_agents_dirs,
                *harness.user_agents_dirs,
            ]
        )
        entries = tuple(
            sorted(
                str(path.absolute())
                for base in search_paths
                for path in base.glob("*.toml")
            )
        )
        return AgentInventoryProbe(
            True,
            None,
            profile.agent_profile_exact and not entries,
            tuple(str(path) for path in search_paths),
            entries,
        )
    except Exception as error:
        return AgentInventoryProbe(
            False, f"{type(error).__name__}: {error}", False, (), ()
        )
    finally:
        if harness_module is not None:
            harness_module._manager = old_manager


def _probe_local_tool_selection(
    profile: ProjectProfileFacts,
    additional_dirs: tuple[Path, ...],
    *,
    runtime_environment_clean: bool,
) -> ToolSelectionProbe:
    old_manager = None
    old_api_key = os.environ.get("MISTRAL_API_KEY")
    replaced_api_key = False
    harness_module = None
    try:
        if not runtime_environment_clean:
            raise RuntimeError("Vibe environment or .env overrides are not clean")
        import vibe
        import vibe.core.config.harness_files._harness_manager as harness_module
        from vibe.core.agents.models import BUILTIN_AGENTS, BuiltinAgentName
        from vibe.core.config import VibeConfig
        from vibe.core.config.harness_files import HarnessFilesManager
        from vibe.core.tools.manager import ToolManager

        old_manager = harness_module._manager
        if not all(
            hasattr(ToolManager, attribute)
            for attribute in (
                "_tool_variants_for_name",
                "_select_registered_variant",
                "_compute_search_paths",
            )
        ):
            raise RuntimeError("required Vibe ToolManager selection API is unavailable")

        project_root = Path(profile.project_root)
        harness = _build_probe_harness(
            HarnessFilesManager, project_root, additional_dirs
        )
        harness_module._manager = harness
        selected_config_file = harness.config_file
        expected_config_file = project_root / ".vibe" / "config.toml"
        if (
            selected_config_file is None
            or selected_config_file.resolve() != expected_config_file.resolve()
        ):
            raise RuntimeError("Vibe did not select the named project config")
        if not old_api_key:
            os.environ["MISTRAL_API_KEY"] = "bytefence-compatibility-probe"
            replaced_api_key = True
        base_config = VibeConfig.load()
        effective_config_exact = _effective_config_matches(base_config)
        default_profile = BUILTIN_AGENTS[BuiltinAgentName.DEFAULT]
        builtin_default_agent_exact = _builtin_default_agent_matches(
            default_profile, Path(vibe.__file__).resolve().parent
        )
        effective_config = default_profile.apply_to_config(base_config)
        manager = ToolManager(lambda: effective_config, defer_mcp=True)

        vibe_package_root = Path(vibe.__file__).resolve().parent
        expected_contract = _expected_tool_contract(project_root, vibe_package_root)
        attestations: list[ToolClassAttestation] = []
        for name in EXPECTED_ALLOWED_TOOL_NAMES:
            expected_module, expected_class, expected_path, expected_digest = (
                expected_contract[name]
            )
            variants = tuple(manager._tool_variants_by_name.get(name, ()))
            fallback = manager._all_tools.get(name)
            selected_class = (
                manager._select_registered_variant(name, fallback)
                if fallback is not None
                else None
            )
            selected = (
                _class_evidence(selected_class) if selected_class is not None else None
            )
            variant_evidence = tuple(_class_evidence(item) for item in variants)
            origin_valid = (
                selected is not None
                and selected.source_path == str(expected_path)
                and selected.class_name == expected_class
                and (expected_module is None or selected.module == expected_module)
            )
            integrity_valid = selected is not None and selected.sha256 == expected_digest
            single_variant = len(variants) == 1
            attestations.append(
                ToolClassAttestation(
                    name=name,
                    expected_module=expected_module,
                    expected_class=expected_class,
                    expected_source_path=str(expected_path),
                    expected_sha256=expected_digest,
                    selected=selected,
                    variants=variant_evidence,
                    single_variant=single_variant,
                    origin_valid=origin_valid,
                    integrity_valid=integrity_valid,
                    valid=single_variant and origin_valid and integrity_valid,
                )
            )

        exact = len(attestations) == len(EXPECTED_ALLOWED_TOOL_NAMES) and all(
            item.valid for item in attestations
        )
        model_facing_tools = tuple(manager.available_tools)
        agent_contract = _read_manifest().get("runtimeAgentContract")
        expected_model_facing = (
            agent_contract.get("modelFacingToolsExact")
            if isinstance(agent_contract, dict)
            else None
        )
        model_facing_tools_exact = (
            isinstance(expected_model_facing, list)
            and len(model_facing_tools) == len(expected_model_facing)
            and set(model_facing_tools) == set(expected_model_facing)
        )
        broker = next(
            item for item in attestations if item.name == "bytefence_apply"
        )
        return ToolSelectionProbe(
            context_established=True,
            context_error=None,
            effective_config_exact=effective_config_exact,
            selected_config_file=str(selected_config_file.resolve()),
            builtin_default_agent_exact=builtin_default_agent_exact,
            bytefence_apply_selected=broker.valid,
            allowed_tool_classes_exact=exact,
            model_facing_tools_exact=model_facing_tools_exact,
            model_facing_tools=model_facing_tools,
            attestations=tuple(attestations),
            search_paths=tuple(str(path) for path in manager._search_paths),
        )
    except Exception as error:
        return ToolSelectionProbe(
            context_established=False,
            context_error=f"{type(error).__name__}: {error}",
            effective_config_exact=False,
            selected_config_file=None,
            builtin_default_agent_exact=False,
            bytefence_apply_selected=False,
            allowed_tool_classes_exact=False,
            model_facing_tools_exact=False,
            model_facing_tools=(),
            attestations=(),
            search_paths=(),
        )
    finally:
        if harness_module is not None:
            harness_module._manager = old_manager
        if replaced_api_key:
            if old_api_key is None:
                os.environ.pop("MISTRAL_API_KEY", None)
            else:
                os.environ["MISTRAL_API_KEY"] = old_api_key


def _load_project_tool(project_root: Path):
    path = project_root / ".vibe" / "tools" / "bytefence_apply.py"
    module_name = (
        "bytefence_apply_compat_"
        + hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]
    )
    spec = importlib_util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError("deployed bytefence_apply has no Python loader")
    module = importlib_util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(module_name, None)
    return module


if __name__ == "__main__":
    raise SystemExit(main())
