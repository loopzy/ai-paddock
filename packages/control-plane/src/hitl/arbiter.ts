import { nanoid } from 'nanoid';
import { EventStore } from '../events/event-store.js';
import type { HITLPolicy, HITLRequest, HITLDecision } from '../types.js';
import { DEFAULT_POLICIES } from '../types.js';

/**
 * HITL Arbiter — Human-in-the-Loop decision engine.
 *
 * Intercepts tool calls that match policy rules and blocks execution
 * until user approves/rejects via Dashboard.
 */

export class HITLArbiter {
  private eventStore: EventStore;
  private policies: HITLPolicy[];
  private pendingRequests = new Map<string, HITLRequest>();
  private decisions = new Map<string, HITLDecision>();

  constructor(eventStore: EventStore, policies: HITLPolicy[] = DEFAULT_POLICIES) {
    this.eventStore = eventStore;
    this.policies = policies;
  }

  /**
   * Check if a tool call requires approval.
   */
  requiresApproval(toolName: string): boolean {
    for (const policy of this.policies) {
      if (this.matchesPattern(toolName, policy.toolPattern)) {
        return policy.action === 'ask';
      }
    }
    return false; // Default: approve
  }

  /**
   * Request approval for a tool call.
   * Returns a promise that resolves when user makes a decision.
   */
  async requestApproval(
    sessionId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    reason: string
  ): Promise<HITLDecision> {
    const request: HITLRequest = {
      id: nanoid(),
      sessionId,
      toolName,
      toolArgs,
      reason,
      timestamp: Date.now(),
    };

    this.pendingRequests.set(request.id, request);

    // Log HITL request event
    this.eventStore.append(sessionId, 'hitl.request', {
      requestId: request.id,
      toolName,
      toolArgs,
      reason,
    });

    // Wait for decision (with timeout)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error('HITL approval timeout'));
      }, 300000); // 5 minutes

      const checkInterval = setInterval(() => {
        const decision = this.decisions.get(request.id);
        if (decision) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          this.pendingRequests.delete(request.id);
          this.decisions.delete(request.id);
          resolve(decision);
        }
      }, 500);
    });
  }

  /**
   * Submit a decision for a pending request.
   */
  decide(requestId: string, verdict: 'approved' | 'rejected' | 'modified', modifiedArgs?: Record<string, unknown>): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      throw new Error(`HITL request ${requestId} not found`);
    }

    const decision: HITLDecision = {
      requestId,
      verdict,
      modifiedArgs,
      decidedAt: Date.now(),
    };

    this.decisions.set(requestId, decision);

    // Log decision event
    this.eventStore.append(request.sessionId, 'hitl.decision', {
      requestId,
      verdict,
      modifiedArgs,
      decidedAt: decision.decidedAt,
    });
  }

  /**
   * Get all pending requests for a session.
   */
  getPendingRequests(sessionId: string): HITLRequest[] {
    return Array.from(this.pendingRequests.values()).filter((r) => r.sessionId === sessionId);
  }

  /**
   * Pattern matching for tool names (supports wildcards).
   */
  private matchesPattern(toolName: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return toolName.startsWith(prefix);
    }
    return toolName === pattern;
  }
}
