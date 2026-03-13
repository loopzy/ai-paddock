// @paddock/types — shared type definitions

import type { AMPEventType } from './amp.js';

export * from './amp.js';
export * from './sandbox.js';
export * from './session.js';
export * from './resource-boundary.js';
export * from './hitl.js';
export * from './security.js';

// Legacy event types (kept for backward compat during migration)
export type EventType =
  | 'llm.request'
  | 'llm.response'
  | 'agent.thought'
  | 'tool.intent'
  | 'tool.result'
  | 'fs.change'
  | 'user.command'
  | 'hitl.request'
  | 'hitl.decision'
  | 'snapshot.created'
  | 'snapshot.restored'
  | 'session.status'
  | AMPEventType;

export interface PaddockEvent {
  id: string;
  sessionId: string;
  seq: number;
  timestamp: number;
  type: EventType;
  payload: Record<string, unknown>;
  correlationId?: string;
  causedBy?: string;
  snapshotRef?: string;
}

// LLM Proxy types
export interface LLMRequestPayload {
  model: string;
  provider: string;
  messages: unknown[];
  tools?: unknown[];
  tokensIn?: number;
}

export interface LLMResponsePayload {
  model: string;
  tokensIn: number;
  tokensOut: number;
  content: LLMContentBlock[];
  durationMs: number;
}

export interface LLMContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
}

// File System types
export type FSAction = 'create' | 'modify' | 'delete' | 'rename';

export interface FSChangePayload {
  action: FSAction;
  path: string;
  oldPath?: string;
  diff?: string;
  sizeBytes?: number;
}

// Snapshot types (legacy alias)
export type { SandboxSnapshot as Snapshot } from './sandbox.js';
