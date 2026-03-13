"""
Unit tests for agent configuration management.

Tests cover:
- Configuration loading from multiple sources (env vars, defaults)
- Configuration priority (env > defaults)
- Configuration validation
- Type conversion
- Error handling
"""

import os
import unittest
from unittest.mock import patch

from paddock_amp.config import AgentConfig, ConfigError


class TestAgentConfig(unittest.TestCase):
    """Test suite for AgentConfig."""

    def setUp(self):
        """Save original environment."""
        self.original_env = os.environ.copy()

    def tearDown(self):
        """Restore original environment."""
        os.environ.clear()
        os.environ.update(self.original_env)

    # ── Basic Configuration Loading ──

    def test_load_defaults(self):
        """Test loading with all default values."""
        # Clear all PADDOCK_ env vars
        for key in list(os.environ.keys()):
            if key.startswith("PADDOCK_"):
                del os.environ[key]

        with patch("os.path.isdir", return_value=False), patch(
            "os.getcwd", return_value="/tmp/paddock-host-workspace"
        ):
            config = AgentConfig.load()

        # Check defaults
        self.assertEqual(config.llm_provider, "anthropic")
        self.assertEqual(config.agent_model, "claude-3-5-haiku-latest")
        self.assertEqual(config.sidecar_url, "http://localhost:8801")
        self.assertEqual(config.command_file, "/tmp/paddock-commands.jsonl")
        self.assertEqual(config.agent_max_tokens, 256)
        self.assertEqual(config.agent_request_timeout_s, 60)
        self.assertEqual(config.workspace_root, "/tmp/paddock-host-workspace")
        self.assertEqual(config.max_file_size, 10 * 1024 * 1024)  # 10MB
        self.assertEqual(config.exec_timeout, 30)
        self.assertTrue(config.browser_enabled)
        self.assertTrue(config.browser_headless)
        self.assertEqual(config.browser_default_timeout_ms, 15000)
        self.assertEqual(config.browser_output_dir, "/tmp/paddock-host-workspace/.paddock/browser")

    def test_prefers_sandbox_workspace_when_available(self):
        """Test that sandbox runtime keeps /workspace as the default root."""
        for key in list(os.environ.keys()):
            if key.startswith("PADDOCK_"):
                del os.environ[key]

        with patch("os.path.isdir", return_value=True), patch(
            "os.access", return_value=True
        ), patch("os.getcwd", return_value="/tmp/paddock-host-workspace"):
            config = AgentConfig.load()

        self.assertEqual(config.workspace_root, "/workspace")

    def test_load_from_env_vars(self):
        """Test loading configuration from environment variables."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "openai"
        os.environ["PADDOCK_AGENT_MODEL"] = "gpt-4"
        os.environ["PADDOCK_SIDECAR_URL"] = "http://sidecar:9000"
        os.environ["PADDOCK_COMMAND_FILE"] = "/custom/commands.jsonl"
        os.environ["PADDOCK_AGENT_MAX_TOKENS"] = "512"
        os.environ["PADDOCK_AGENT_REQUEST_TIMEOUT_S"] = "120"
        os.environ["PADDOCK_WORKSPACE_ROOT"] = "/custom/workspace"
        os.environ["PADDOCK_MAX_FILE_SIZE"] = "5242880"  # 5MB
        os.environ["PADDOCK_EXEC_TIMEOUT"] = "60"
        os.environ["PADDOCK_BROWSER_ENABLED"] = "false"
        os.environ["PADDOCK_BROWSER_HEADLESS"] = "false"
        os.environ["PADDOCK_BROWSER_DEFAULT_TIMEOUT_MS"] = "25000"
        os.environ["PADDOCK_BROWSER_OUTPUT_DIR"] = "/custom/browser-output"

        config = AgentConfig.load()

        self.assertEqual(config.llm_provider, "openai")
        self.assertEqual(config.agent_model, "gpt-4")
        self.assertEqual(config.sidecar_url, "http://sidecar:9000")
        self.assertEqual(config.command_file, "/custom/commands.jsonl")
        self.assertEqual(config.agent_max_tokens, 512)
        self.assertEqual(config.agent_request_timeout_s, 120)
        self.assertEqual(config.workspace_root, "/custom/workspace")
        self.assertEqual(config.max_file_size, 5242880)
        self.assertEqual(config.exec_timeout, 60)
        self.assertFalse(config.browser_enabled)
        self.assertFalse(config.browser_headless)
        self.assertEqual(config.browser_default_timeout_ms, 25000)
        self.assertEqual(config.browser_output_dir, "/custom/browser-output")

    def test_env_vars_override_defaults(self):
        """Test that environment variables override defaults."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "google"

        config = AgentConfig.load()

        self.assertEqual(config.llm_provider, "google")
        # Other values should still be defaults
        self.assertEqual(config.sidecar_url, "http://localhost:8801")

    # ── Provider-Specific Defaults ──

    def test_default_model_for_anthropic(self):
        """Test default model for Anthropic provider."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "anthropic"
        if "PADDOCK_AGENT_MODEL" in os.environ:
            del os.environ["PADDOCK_AGENT_MODEL"]

        config = AgentConfig.load()

        self.assertEqual(config.agent_model, "claude-3-5-haiku-latest")

    def test_default_model_for_openai(self):
        """Test default model for OpenAI provider."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "openai"
        if "PADDOCK_AGENT_MODEL" in os.environ:
            del os.environ["PADDOCK_AGENT_MODEL"]

        config = AgentConfig.load()

        self.assertEqual(config.agent_model, "gpt-4o-mini")

    def test_default_model_for_openrouter(self):
        """Test default model for OpenRouter provider."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "openrouter"
        if "PADDOCK_AGENT_MODEL" in os.environ:
            del os.environ["PADDOCK_AGENT_MODEL"]

        config = AgentConfig.load()

        self.assertEqual(config.agent_model, "anthropic/claude-3.5-haiku")

    def test_default_model_for_google(self):
        """Test default model for Google provider."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "google"
        if "PADDOCK_AGENT_MODEL" in os.environ:
            del os.environ["PADDOCK_AGENT_MODEL"]

        config = AgentConfig.load()

        self.assertEqual(config.agent_model, "gemini-2.0-flash-exp")

    # ── Validation ──

    def test_invalid_provider_raises_error(self):
        """Test that invalid provider raises ConfigError."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "invalid_provider"

        with self.assertRaises(ConfigError) as ctx:
            AgentConfig.load()
        self.assertIn("unsupported", str(ctx.exception).lower())
        self.assertIn("invalid_provider", str(ctx.exception))

    def test_invalid_integer_raises_error(self):
        """Test that invalid integer value raises ConfigError."""
        os.environ["PADDOCK_AGENT_MAX_TOKENS"] = "not_a_number"

        with self.assertRaises(ConfigError) as ctx:
            AgentConfig.load()
        self.assertIn("invalid", str(ctx.exception).lower())

    def test_negative_timeout_raises_error(self):
        """Test that negative timeout raises ConfigError."""
        os.environ["PADDOCK_AGENT_REQUEST_TIMEOUT_S"] = "-10"

        with self.assertRaises(ConfigError) as ctx:
            AgentConfig.load()
        self.assertIn("must be positive", str(ctx.exception).lower())

    def test_negative_max_tokens_raises_error(self):
        """Test that negative max_tokens raises ConfigError."""
        os.environ["PADDOCK_AGENT_MAX_TOKENS"] = "-100"

        with self.assertRaises(ConfigError) as ctx:
            AgentConfig.load()
        self.assertIn("must be positive", str(ctx.exception).lower())

    # ── String Trimming ──

    def test_string_values_are_trimmed(self):
        """Test that string values are trimmed of whitespace."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "  openai  "
        os.environ["PADDOCK_AGENT_MODEL"] = "  gpt-4  "
        os.environ["PADDOCK_SIDECAR_URL"] = "  http://localhost:8801  "

        config = AgentConfig.load()

        self.assertEqual(config.llm_provider, "openai")
        self.assertEqual(config.agent_model, "gpt-4")
        self.assertEqual(config.sidecar_url, "http://localhost:8801")

    # ── Optional Values ──

    def test_optional_llm_base_url(self):
        """Test optional LLM base URL."""
        # Not set
        config = AgentConfig.load()
        self.assertIsNone(config.llm_base_url)

        # Set
        os.environ["PADDOCK_LLM_BASE_URL"] = "http://custom-llm:8000"
        config = AgentConfig.load()
        self.assertEqual(config.llm_base_url, "http://custom-llm:8000")

    def test_optional_llm_api_key(self):
        """Test optional LLM API key."""
        # Not set
        config = AgentConfig.load()
        self.assertIsNone(config.llm_api_key)

        # Set
        os.environ["PADDOCK_LLM_API_KEY"] = "sk-test-key"
        config = AgentConfig.load()
        self.assertEqual(config.llm_api_key, "sk-test-key")

    # ── to_dict Method ──

    def test_to_dict(self):
        """Test converting config to dictionary."""
        os.environ["PADDOCK_LLM_PROVIDER"] = "openai"
        os.environ["PADDOCK_AGENT_MODEL"] = "gpt-4"

        config = AgentConfig.load()
        config_dict = config.to_dict()

        self.assertIsInstance(config_dict, dict)
        self.assertEqual(config_dict["llm_provider"], "openai")
        self.assertEqual(config_dict["agent_model"], "gpt-4")
        self.assertIn("sidecar_url", config_dict)
        self.assertIn("workspace_root", config_dict)

    def test_to_dict_excludes_sensitive_data(self):
        """Test that to_dict can exclude sensitive data."""
        os.environ["PADDOCK_LLM_API_KEY"] = "sk-secret-key"

        config = AgentConfig.load()
        config_dict = config.to_dict(include_sensitive=False)

        # API key should be masked or excluded
        if "llm_api_key" in config_dict:
            self.assertNotEqual(config_dict["llm_api_key"], "sk-secret-key")
            self.assertIn("***", config_dict["llm_api_key"])

    # ── Repr ──

    def test_repr(self):
        """Test string representation."""
        config = AgentConfig.load()
        repr_str = repr(config)

        self.assertIn("AgentConfig", repr_str)
        self.assertIn("llm_provider", repr_str)


if __name__ == "__main__":
    unittest.main()
