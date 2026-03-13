import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../events/event-store.js';
import { HITLArbiter } from '../hitl/arbiter.js';
import type { HITLPolicy } from '@paddock/types';

describe('HITLArbiter', () => {
  let eventStore: EventStore;
  let arbiter: HITLArbiter;

  beforeEach(() => {
    eventStore = new EventStore(':memory:');
    arbiter = new HITLArbiter(eventStore);
  });

  afterEach(() => {
    eventStore.close();
  });

  describe('requiresApproval', () => {
    it('should approve read/edit/write/web_search by default', () => {
      expect(arbiter.requiresApproval('read')).toBe(false);
      expect(arbiter.requiresApproval('edit')).toBe(false);
      expect(arbiter.requiresApproval('write')).toBe(false);
      expect(arbiter.requiresApproval('web_search')).toBe(false);
      expect(arbiter.requiresApproval('web_fetch')).toBe(false);
    });

    it('should require approval for exec', () => {
      expect(arbiter.requiresApproval('exec')).toBe(true);
    });

    it('should require approval for browser', () => {
      expect(arbiter.requiresApproval('browser')).toBe(true);
    });

    it('should require approval for host.* tools', () => {
      expect(arbiter.requiresApproval('host.clipboard')).toBe(true);
      expect(arbiter.requiresApproval('host.browser')).toBe(true);
    });

    it('should approve unknown tools by default', () => {
      expect(arbiter.requiresApproval('some_unknown_tool')).toBe(false);
    });
  });

  describe('requestApproval + decide', () => {
    it('should resolve when decision is made', async () => {
      const promise = arbiter.requestApproval('sess-1', 'exec', { command: 'rm -rf /' }, 'dangerous');

      // Get pending requests
      const pending = arbiter.getPendingRequests('sess-1');
      expect(pending).toHaveLength(1);
      expect(pending[0].toolName).toBe('exec');

      // Decide
      arbiter.decide(pending[0].id, 'approved');

      const decision = await promise;
      expect(decision.verdict).toBe('approved');
      expect(decision.requestId).toBe(pending[0].id);
    });

    it('should handle rejection', async () => {
      const promise = arbiter.requestApproval('sess-1', 'exec', { command: 'rm -rf /' }, 'dangerous');
      const pending = arbiter.getPendingRequests('sess-1');
      arbiter.decide(pending[0].id, 'rejected');

      const decision = await promise;
      expect(decision.verdict).toBe('rejected');
    });

    it('should throw when deciding on unknown request', () => {
      expect(() => arbiter.decide('nonexistent', 'approved')).toThrow('not found');
    });

    it('should emit hitl.request event', async () => {
      const promise = arbiter.requestApproval('sess-1', 'exec', { command: 'ls' }, 'test');
      const pending = arbiter.getPendingRequests('sess-1');
      arbiter.decide(pending[0].id, 'approved');
      await promise;

      const events = eventStore.getEvents('sess-1');
      expect(events.some(e => e.type === 'hitl.request')).toBe(true);
    });

    it('should emit hitl.decision event', async () => {
      const promise = arbiter.requestApproval('sess-1', 'exec', { command: 'ls' }, 'test');
      const pending = arbiter.getPendingRequests('sess-1');
      arbiter.decide(pending[0].id, 'approved');
      await promise;

      const events = eventStore.getEvents('sess-1');
      expect(events.some(e => e.type === 'hitl.decision')).toBe(true);
    });
  });

  describe('getPendingRequests', () => {
    it('should filter by session', async () => {
      arbiter.requestApproval('sess-1', 'exec', {}, 'test');
      arbiter.requestApproval('sess-2', 'exec', {}, 'test');

      expect(arbiter.getPendingRequests('sess-1')).toHaveLength(1);
      expect(arbiter.getPendingRequests('sess-2')).toHaveLength(1);
      expect(arbiter.getPendingRequests('sess-3')).toHaveLength(0);
    });
  });

  describe('custom policies', () => {
    it('should use custom policies', () => {
      const policies: HITLPolicy[] = [
        { toolPattern: '*', action: 'ask' },
      ];
      const customArbiter = new HITLArbiter(eventStore, policies);
      expect(customArbiter.requiresApproval('read')).toBe(true);
      expect(customArbiter.requiresApproval('anything')).toBe(true);
    });
  });
});
