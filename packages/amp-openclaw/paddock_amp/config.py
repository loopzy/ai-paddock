"""
Agent configuration management.

Provides centralized configuration loading from environment variables with:
- Type conversion and validation
- Default values
- Provider-specific defaults
- Clear error messages
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


class ConfigError(Exception):
    """Raised when configuration is invalid or missing."""
    pass


# Default models for each provider
DEFAULT_MODELS = {
    "anthropic": "claude-3-5-haiku-latest",
    "openai": "gpt-4o-mini",
    "openrouter": "anthropic/claude-3.5-haiku",
    "google": "gemini-2.0-flash-exp",
}

SUPPORTED_PROVIDERS = {"anthropic", "openai", "openrouter", "google"}


@dataclass
class AgentConfig:
    """Agent configuration loaded from environment variables."""

    # LLM Configuration
    llm_provider: str
    agent_model: str
    llm_base_url: Optional[str]
    llm_api_key: Optional[str]
    agent_max_tokens: int
    agent_request_timeout_s: int

    # Agent Configuration
    sidecar_url: str
    command_file: str
    workspace_root: str
    max_file_size: int
    exec_timeout: int
    browser_enabled: bool = True
    browser_headless: bool = True
    browser_default_timeout_ms: int = 15000
    browser_output_dir: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.browser_output_dir:
            self.browser_output_dir = self._default_browser_output_dir(
                self.workspace_root
            )

    @classmethod
    def load(cls) -> AgentConfig:
        """
        Load configuration from environment variables.

        Returns:
            AgentConfig instance

        Raises:
            ConfigError: If configuration is invalid
        """
        try:
            # Load LLM provider
            llm_provider = os.environ.get("PADDOCK_LLM_PROVIDER", "anthropic").strip().lower()
            if llm_provider not in SUPPORTED_PROVIDERS:
                raise ConfigError(
                    f"Unsupported LLM provider '{llm_provider}'. "
                    f"Supported: {', '.join(sorted(SUPPORTED_PROVIDERS))}"
                )

            # Load model (with provider-specific default)
            agent_model = os.environ.get("PADDOCK_AGENT_MODEL", "").strip()
            if not agent_model:
                agent_model = DEFAULT_MODELS[llm_provider]

            # Load LLM connection details (optional)
            llm_base_url = os.environ.get("PADDOCK_LLM_BASE_URL", "").strip() or None
            llm_api_key = os.environ.get("PADDOCK_LLM_API_KEY", "").strip() or None

            # Load integer configs with validation
            agent_max_tokens = cls._load_int(
                "PADDOCK_AGENT_MAX_TOKENS", 256, min_value=1
            )
            agent_request_timeout_s = cls._load_int(
                "PADDOCK_AGENT_REQUEST_TIMEOUT_S", 60, min_value=1
            )

            # Load agent configuration
            sidecar_url = os.environ.get(
                "PADDOCK_SIDECAR_URL", "http://localhost:8801"
            ).strip()
            command_file = os.environ.get(
                "PADDOCK_COMMAND_FILE", "/tmp/paddock-commands.jsonl"
            ).strip()
            workspace_root = (
                os.environ.get("PADDOCK_WORKSPACE_ROOT", "").strip()
                or cls._default_workspace_root()
            )

            # Load file and execution limits
            max_file_size = cls._load_int(
                "PADDOCK_MAX_FILE_SIZE", 10 * 1024 * 1024, min_value=1
            )
            exec_timeout = cls._load_int("PADDOCK_EXEC_TIMEOUT", 30, min_value=1)
            browser_enabled = cls._load_bool("PADDOCK_BROWSER_ENABLED", True)
            browser_headless = cls._load_bool("PADDOCK_BROWSER_HEADLESS", True)
            browser_default_timeout_ms = cls._load_int(
                "PADDOCK_BROWSER_DEFAULT_TIMEOUT_MS", 15000, min_value=1
            )
            browser_output_dir = (
                os.environ.get("PADDOCK_BROWSER_OUTPUT_DIR", "").strip()
                or cls._default_browser_output_dir(workspace_root)
            )

            return cls(
                llm_provider=llm_provider,
                agent_model=agent_model,
                llm_base_url=llm_base_url,
                llm_api_key=llm_api_key,
                agent_max_tokens=agent_max_tokens,
                agent_request_timeout_s=agent_request_timeout_s,
                sidecar_url=sidecar_url,
                command_file=command_file,
                workspace_root=workspace_root,
                max_file_size=max_file_size,
                exec_timeout=exec_timeout,
                browser_enabled=browser_enabled,
                browser_headless=browser_headless,
                browser_default_timeout_ms=browser_default_timeout_ms,
                browser_output_dir=browser_output_dir,
            )
        except ConfigError:
            raise
        except Exception as e:
            raise ConfigError(f"Failed to load configuration: {e}")

    @staticmethod
    def _default_workspace_root() -> str:
        """
        Prefer the sandbox workspace when it exists and is writable.

        Local unit tests and host-side tooling often run outside the VM, where
        `/workspace` is absent or read-only. In those environments we fall back
        to the current working directory so the native runtime can still start.
        """
        sandbox_workspace = "/workspace"
        if os.path.isdir(sandbox_workspace) and os.access(sandbox_workspace, os.W_OK):
            return sandbox_workspace
        return os.getcwd()

    @staticmethod
    def _default_browser_output_dir(workspace_root: str) -> str:
        return str(Path(workspace_root) / ".paddock" / "browser")

    @staticmethod
    def _load_int(env_var: str, default: int, min_value: Optional[int] = None) -> int:
        """
        Load integer from environment variable with validation.

        Args:
            env_var: Environment variable name
            default: Default value if not set
            min_value: Minimum allowed value (optional)

        Returns:
            Integer value

        Raises:
            ConfigError: If value is invalid
        """
        value_str = os.environ.get(env_var, "").strip()
        if not value_str:
            return default

        try:
            value = int(value_str)
        except ValueError:
            raise ConfigError(f"Invalid integer value for {env_var}: '{value_str}'")

        if min_value is not None and value < min_value:
            raise ConfigError(
                f"{env_var} must be positive (got {value}, min {min_value})"
            )

        return value

    @staticmethod
    def _load_bool(env_var: str, default: bool) -> bool:
        value_str = os.environ.get(env_var, "").strip().lower()
        if not value_str:
            return default
        if value_str in {"1", "true", "yes", "on"}:
            return True
        if value_str in {"0", "false", "no", "off"}:
            return False
        raise ConfigError(f"Invalid boolean value for {env_var}: '{value_str}'")

    def to_dict(self, include_sensitive: bool = True) -> dict:
        """
        Convert configuration to dictionary.

        Args:
            include_sensitive: If False, exclude sensitive data like API keys
        """
        config_dict = {
            "llm_provider": self.llm_provider,
            "agent_model": self.agent_model,
            "llm_base_url": self.llm_base_url,
            "agent_max_tokens": self.agent_max_tokens,
            "agent_request_timeout_s": self.agent_request_timeout_s,
            "sidecar_url": self.sidecar_url,
            "command_file": self.command_file,
            "workspace_root": self.workspace_root,
            "max_file_size": self.max_file_size,
            "exec_timeout": self.exec_timeout,
            "browser_enabled": self.browser_enabled,
            "browser_headless": self.browser_headless,
            "browser_default_timeout_ms": self.browser_default_timeout_ms,
            "browser_output_dir": self.browser_output_dir,
        }

        if include_sensitive:
            config_dict["llm_api_key"] = "***" if self.llm_api_key else None

        return config_dict
