"""
Provider-aware LLM client abstractions for the built-in AMP compatibility runner.

This module keeps transport-specific HTTP details out of the AMP adapter itself.
The adapter chooses a provider/model, sends messages through a client, and lets
the Sidecar remain the main LLM boundary when local proxy URLs are used.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence

import requests

from .config import AgentConfig


DEFAULT_MODELS: dict[str, str] = {
    "anthropic": "claude-3-5-haiku-latest",
    "openai": "gpt-4o-mini",
    "openrouter": "openai/gpt-4o-mini",
}

DEFAULT_BASE_URLS: dict[str, str] = {
    "anthropic": "http://localhost:8800/anthropic",
    "openai": "http://localhost:8800/openai",
    "openrouter": "http://localhost:8800/openrouter",
}

PROVIDER_API_KEY_ENV_KEYS: dict[str, tuple[str, ...]] = {
    "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"),
    "openai": ("OPENAI_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
}

PROVIDER_BASE_URL_ENV_KEYS: dict[str, str] = {
    "anthropic": "ANTHROPIC_BASE_URL",
    "openai": "OPENAI_BASE_URL",
    "openrouter": "OPENROUTER_BASE_URL",
}


def _first_env(*keys: str) -> str | None:
    for key in keys:
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return None


def _normalize_payload(
    response: requests.Response, fallback_model: str, provider: str
) -> Dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        body = {"error": response.text}

    if isinstance(body, dict):
        body.setdefault("status", response.status_code)
        body.setdefault("model", fallback_model)
        body.setdefault("provider", provider)
        return body

    return {
        "status": response.status_code,
        "model": fallback_model,
        "provider": provider,
        "content": body,
    }


def extract_text(payload: Dict[str, Any]) -> str:
    content = payload.get("content", [])

    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        if parts:
            return "\n".join(parts).strip()

    if isinstance(content, str):
        return content.strip()

    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                message_content = message.get("content")
                if isinstance(message_content, str):
                    return message_content.strip()
                if isinstance(message_content, list):
                    parts: list[str] = []
                    for item in message_content:
                        if isinstance(item, dict):
                            text = item.get("text")
                            if isinstance(text, str):
                                parts.append(text)
                    if parts:
                        return "\n".join(parts).strip()

    return json.dumps(content)[:500] if content else ""


@dataclass(frozen=True)
class LLMClientConfig:
    provider: str
    model: str
    base_url: str
    api_key: str
    max_tokens: int
    timeout_seconds: int

    @classmethod
    def from_env(cls) -> "LLMClientConfig":
        """Load LLM client config from AgentConfig."""
        agent_config = AgentConfig.load()

        provider = agent_config.llm_provider
        model = agent_config.agent_model

        # Determine base URL
        if agent_config.llm_base_url:
            base_url = agent_config.llm_base_url
        else:
            # Try provider-specific env vars, then fall back to default
            base_url = (
                _first_env(PROVIDER_BASE_URL_ENV_KEYS.get(provider, ""))
                or DEFAULT_BASE_URLS.get(provider, "http://localhost:8800")
            )

        # Determine API key
        if agent_config.llm_api_key:
            api_key = agent_config.llm_api_key
        else:
            # Try provider-specific env vars, then fall back to proxy placeholder
            api_key = (
                _first_env(*PROVIDER_API_KEY_ENV_KEYS.get(provider, ()))
                or "paddock-proxy"
            )

        return cls(
            provider=provider,
            model=model,
            base_url=base_url.rstrip("/"),
            api_key=api_key,
            max_tokens=agent_config.agent_max_tokens,
            timeout_seconds=agent_config.agent_request_timeout_s,
        )


@dataclass(frozen=True)
class LLMClientResult:
    status: int
    payload: Dict[str, Any]
    text: str
    tool_calls: List["ToolCall"] = field(default_factory=list)
    stop_reason: str | None = None


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    input: Dict[str, Any]


class BaseLLMClient:
    def __init__(
        self,
        config: LLMClientConfig,
        session: requests.Session | None = None,
    ) -> None:
        self.config = config
        self.session = session or requests.Session()

    def complete(
        self,
        messages: Sequence[Dict[str, Any]],
        tools: Sequence[Dict[str, Any]] | None = None,
    ) -> LLMClientResult:
        raise NotImplementedError


class AnthropicMessagesClient(BaseLLMClient):
    def complete(
        self,
        messages: Sequence[Dict[str, Any]],
        tools: Sequence[Dict[str, Any]] | None = None,
    ) -> LLMClientResult:
        system_prompt, anthropic_messages = _to_anthropic_messages(messages)
        payload: Dict[str, Any] = {
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "messages": anthropic_messages,
        }
        if system_prompt:
            payload["system"] = system_prompt
        if tools:
            payload["tools"] = [
                {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("input_schema") or tool.get("parameters") or {},
                }
                for tool in tools
            ]
        response = self.session.post(
            f"{self.config.base_url}/v1/messages",
            headers={
                "content-type": "application/json",
                "x-api-key": self.config.api_key,
                "anthropic-version": "2023-06-01",
            },
            json=payload,
            timeout=self.config.timeout_seconds,
        )
        payload = _normalize_payload(response, self.config.model, self.config.provider)
        return LLMClientResult(
            status=response.status_code,
            payload=payload,
            text=extract_text(payload),
            tool_calls=_extract_anthropic_tool_calls(payload),
            stop_reason=str(payload.get("stop_reason")) if payload.get("stop_reason") else None,
        )


class OpenAICompatibleClient(BaseLLMClient):
    def __init__(
        self,
        config: LLMClientConfig,
        path: str,
        session: requests.Session | None = None,
    ) -> None:
        super().__init__(config, session=session)
        self.path = path

    def complete(
        self,
        messages: Sequence[Dict[str, Any]],
        tools: Sequence[Dict[str, Any]] | None = None,
    ) -> LLMClientResult:
        payload: Dict[str, Any] = {
            "model": self.config.model,
            "messages": _to_openai_messages(messages),
            "max_tokens": self.config.max_tokens,
        }
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool.get("description", ""),
                        "parameters": tool.get("input_schema") or tool.get("parameters") or {},
                    },
                }
                for tool in tools
            ]
        response = self.session.post(
            f"{self.config.base_url}{self.path}",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.config.api_key}",
            },
            json=payload,
            timeout=self.config.timeout_seconds,
        )
        payload = _normalize_payload(response, self.config.model, self.config.provider)
        return LLMClientResult(
            status=response.status_code,
            payload=payload,
            text=extract_text(payload),
            tool_calls=_extract_openai_tool_calls(payload),
            stop_reason=_extract_openai_stop_reason(payload),
        )


def create_llm_client(
    config: LLMClientConfig | None = None,
    session: requests.Session | None = None,
) -> BaseLLMClient:
    resolved = config or LLMClientConfig.from_env()
    if resolved.provider == "anthropic":
        return AnthropicMessagesClient(resolved, session=session)
    if resolved.provider == "openai":
        return OpenAICompatibleClient(resolved, path="/v1/chat/completions", session=session)
    if resolved.provider == "openrouter":
        return OpenAICompatibleClient(resolved, path="/api/v1/chat/completions", session=session)
    raise ValueError(f"Unsupported PADDOCK_LLM_PROVIDER '{resolved.provider}'")


def _to_anthropic_messages(
    messages: Sequence[Dict[str, Any]],
) -> tuple[str | None, List[Dict[str, Any]]]:
    system_parts: List[str] = []
    converted: List[Dict[str, Any]] = []

    for message in messages:
        role = str(message.get("role", "user"))
        if role == "system":
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                system_parts.append(content.strip())
            continue

        if role == "tool":
            converted.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.get("tool_call_id"),
                            "content": str(message.get("content", "")),
                        }
                    ],
                }
            )
            continue

        tool_calls = message.get("tool_calls")
        if role == "assistant" and isinstance(tool_calls, list):
            content_blocks: List[Dict[str, Any]] = []
            if isinstance(message.get("content"), str) and message["content"].strip():
                content_blocks.append({"type": "text", "text": message["content"]})
            for tool_call in tool_calls:
                if not isinstance(tool_call, dict):
                    continue
                content_blocks.append(
                    {
                        "type": "tool_use",
                        "id": tool_call.get("id"),
                        "name": tool_call.get("name"),
                        "input": tool_call.get("input", {}),
                    }
                )
            converted.append({"role": "assistant", "content": content_blocks})
            continue

        converted.append({"role": role, "content": message.get("content", "")})

    return ("\n\n".join(system_parts) if system_parts else None, converted)


def _to_openai_messages(messages: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    converted: List[Dict[str, Any]] = []

    for message in messages:
        role = str(message.get("role", "user"))
        if role == "assistant" and isinstance(message.get("tool_calls"), list):
            converted.append(
                {
                    "role": "assistant",
                    "content": message.get("content") or "",
                    "tool_calls": [
                        {
                            "id": tool_call.get("id"),
                            "type": "function",
                            "function": {
                                "name": tool_call.get("name"),
                                "arguments": json.dumps(tool_call.get("input", {})),
                            },
                        }
                        for tool_call in message.get("tool_calls", [])
                        if isinstance(tool_call, dict)
                    ],
                }
            )
            continue

        if role == "tool":
            converted.append(
                {
                    "role": "tool",
                    "tool_call_id": message.get("tool_call_id"),
                    "content": str(message.get("content", "")),
                }
            )
            continue

        converted.append({"role": role, "content": message.get("content", "")})

    return converted


def _extract_anthropic_tool_calls(payload: Dict[str, Any]) -> List[ToolCall]:
    tool_calls: List[ToolCall] = []
    for block in payload.get("content", []) or []:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        tool_calls.append(
            ToolCall(
                id=str(block.get("id") or f"tool_{len(tool_calls) + 1}"),
                name=str(block.get("name") or ""),
                input=block.get("input", {}) if isinstance(block.get("input"), dict) else {},
            )
        )
    return tool_calls


def _extract_openai_tool_calls(payload: Dict[str, Any]) -> List[ToolCall]:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return []
    first = choices[0]
    if not isinstance(first, dict):
        return []
    message = first.get("message")
    if not isinstance(message, dict):
        return []

    parsed_tool_calls: List[ToolCall] = []
    for tool_call in message.get("tool_calls", []) or []:
        if not isinstance(tool_call, dict):
            continue
        fn = tool_call.get("function", {})
        if not isinstance(fn, dict):
            continue
        arguments = fn.get("arguments", {})
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except ValueError:
                arguments = {}
        parsed_tool_calls.append(
            ToolCall(
                id=str(tool_call.get("id") or f"call_{len(parsed_tool_calls) + 1}"),
                name=str(fn.get("name") or ""),
                input=arguments if isinstance(arguments, dict) else {},
            )
        )
    return parsed_tool_calls


def _extract_openai_stop_reason(payload: Dict[str, Any]) -> str | None:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    finish_reason = first.get("finish_reason")
    return str(finish_reason) if finish_reason else None
