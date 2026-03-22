import { LLMReviewClient } from './llm-review-client.js';

export type LLMObservationPhase = 'request' | 'response';

export interface SanitizedLLMObservation {
  phase: LLMObservationPhase;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  source: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface LLMObservationSanitizer {
  sanitizeRequest(payload: Record<string, unknown>): Promise<SanitizedLLMObservation>;
  sanitizeResponse(payload: Record<string, unknown>): Promise<SanitizedLLMObservation>;
}

interface LLMSanitizerEnvelope {
  summary?: unknown;
  labels?: unknown;
  confidence?: unknown;
}

function truncate(value: string | undefined, maxChars = 240): string | undefined {
  if (!value) {
    return value;
  }
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getMessagePreviews(payload: Record<string, unknown>) {
  return Array.isArray(payload.messagesPreview)
    ? payload.messagesPreview
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 8)
        .map((item) => ({
          role: getString(item.role) ?? 'unknown',
          text: truncate(getString(item.text), 180),
        }))
    : [];
}

function buildHeuristicRequestObservation(payload: Record<string, unknown>): SanitizedLLMObservation {
  const previews = getMessagePreviews(payload);
  const lastPreview = previews[previews.length - 1];
  const details: Record<string, unknown> = {
    messageCount: typeof payload.messageCount === 'number' ? payload.messageCount : previews.length,
    imagesCount: typeof payload.imagesCount === 'number' ? payload.imagesCount : 0,
    messagesPreview: previews,
    vault: payload.vault,
  };

  return {
    phase: 'request',
    provider: getString(payload.provider) ?? 'unknown',
    model: getString(payload.model) ?? 'unknown',
    runId: getString(payload.runId),
    sessionId: getString(payload.sessionId),
    sessionKey: getString(payload.sessionKey),
    agentId: getString(payload.agentId),
    source: 'heuristic',
    summary:
      `Model request via ${getString(payload.provider) ?? 'unknown'} ` +
      `${getString(payload.model) ?? 'unknown'} with ${previews.length} previewed messages` +
      `${lastPreview?.text ? `. Latest prompt: ${lastPreview.text}` : '.'}`,
    details,
  };
}

function buildHeuristicResponseObservation(payload: Record<string, unknown>): SanitizedLLMObservation {
  const responseText = truncate(getString(payload.responseText) ?? getString(payload.responsePreview), 320);
  const details: Record<string, unknown> = {
    tokensIn: typeof payload.tokensIn === 'number' ? payload.tokensIn : 0,
    tokensOut: typeof payload.tokensOut === 'number' ? payload.tokensOut : 0,
    streamed: payload.streamed === true,
    responsePreview: responseText,
    vault: payload.vault,
  };

  return {
    phase: 'response',
    provider: getString(payload.provider) ?? 'unknown',
    model: getString(payload.model) ?? 'unknown',
    runId: getString(payload.runId),
    sessionId: getString(payload.sessionId),
    sessionKey: getString(payload.sessionKey),
    agentId: getString(payload.agentId),
    source: 'heuristic',
    summary:
      `Model response from ${getString(payload.provider) ?? 'unknown'} ` +
      `${getString(payload.model) ?? 'unknown'} (${details.tokensIn}/${details.tokensOut} tokens)` +
      `${responseText ? `. Preview: ${responseText}` : '.'}`,
    details,
  };
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 8)
    .map((item) =>
      item
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, ''),
    )
    .filter(Boolean);
}

function clampConfidence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

async function summarizeWithLLM(
  client: LLMReviewClient,
  base: SanitizedLLMObservation,
): Promise<SanitizedLLMObservation> {
  const systemPrompt = [
    'You are the Paddock LLM observation sanitizer.',
    'Produce a compact, factual, safe audit summary for a model request or response.',
    'Never restate raw secrets, credentials, long prompts, full responses, or personally identifying details.',
    'If placeholders such as {{PADDOCK_SECRET_1}} appear, keep them as placeholders and never speculate about the original value.',
    'Preserve risk-relevant facts such as requested action, critical file paths, external URLs, tool names, and whether the content is a request or response.',
    'Do not give a safety verdict, policy judgment, or moral commentary. Summarize only what the content is about.',
    'Return strict JSON only with this shape:',
    '{"summary": string, "labels": string[], "confidence": number}',
    'Rules:',
    '- summary must be concise, factual, and safe for dashboards and audit logs',
    '- summary should be one or two short sentences, not a paragraph',
    '- do not say the content is safe, benign, accurate, complete, or acceptable',
    '- labels should be short snake_case tags',
    '- confidence must be between 0 and 1',
    '- do not include markdown or prose outside the JSON object',
    'Examples:',
    'Example 1 input: request asking to delete /usr/bin',
    'Example 1 output: {"summary":"Model request asking whether the assistant can delete the critical system path /usr/bin.","labels":["request","critical_system_path","destructive_action"],"confidence":0.97}',
    'Example 2 input: response suggesting archiving ~/.ssh and uploading it later',
    'Example 2 output: {"summary":"Model response suggests archiving ~/.ssh and uploading it later.","labels":["response","ssh_path","external_upload"],"confidence":0.95}',
  ].join('\n');

  const userPrompt = JSON.stringify(
    {
      phase: base.phase,
      provider: base.provider,
      model: base.model,
      details: base.details,
      heuristicSummary: base.summary,
    },
    null,
    2,
  );

  try {
    const raw = await client.review({ systemPrompt, userPrompt });
    const parsed = JSON.parse(stripMarkdownFence(raw)) as LLMSanitizerEnvelope;
    const summary = getString(parsed.summary);
    if (!summary) {
      return base;
    }
    return {
      ...base,
      source: client.getProviderLabel(),
      summary,
      details: {
        ...base.details,
        sanitizerLabels: normalizeLabels(parsed.labels),
        sanitizerConfidence: clampConfidence(parsed.confidence),
      },
    };
  } catch {
    return base;
  }
}

export class HeuristicLLMObservationSanitizer implements LLMObservationSanitizer {
  async sanitizeRequest(payload: Record<string, unknown>): Promise<SanitizedLLMObservation> {
    return buildHeuristicRequestObservation(payload);
  }

  async sanitizeResponse(payload: Record<string, unknown>): Promise<SanitizedLLMObservation> {
    return buildHeuristicResponseObservation(payload);
  }
}

export class LLMSemanticObservationSanitizer implements LLMObservationSanitizer {
  private readonly fallback: LLMObservationSanitizer;

  constructor(
    private readonly client: LLMReviewClient,
    fallback: LLMObservationSanitizer = new HeuristicLLMObservationSanitizer(),
  ) {
    this.fallback = fallback;
  }

  async sanitizeRequest(payload: Record<string, unknown>): Promise<SanitizedLLMObservation> {
    const base = await this.fallback.sanitizeRequest(payload);
    return summarizeWithLLM(this.client, base);
  }

  async sanitizeResponse(payload: Record<string, unknown>): Promise<SanitizedLLMObservation> {
    const base = await this.fallback.sanitizeResponse(payload);
    return summarizeWithLLM(this.client, base);
  }
}
