import { describe, it, expect, beforeEach } from 'vitest';
import { SensitiveDataVault } from '../vault/sensitive-data-vault.js';

describe('SensitiveDataVault', () => {
  let vault: SensitiveDataVault;

  beforeEach(() => {
    vault = new SensitiveDataVault();
  });

  describe('mask', () => {
    it('should mask Anthropic API keys', () => {
      const result = vault.mask('My key is sk-ant-abcdefghijklmnopqrstuvwxyz');
      expect(result.masked).not.toContain('sk-ant-');
      expect(result.masked).toContain('{{PADDOCK_SECRET_');
      expect(result.secretsFound).toBe(1);
      expect(result.categories).toContain('anthropic_key');
    });

    it('should mask OpenAI API keys', () => {
      const result = vault.mask('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz');
      expect(result.masked).not.toContain('sk-proj-');
      expect(result.secretsFound).toBeGreaterThanOrEqual(1);
    });

    it('should mask GitHub tokens', () => {
      const result = vault.mask('token: ghp_abcdefghijklmnopqrstuvwxyz1234567890');
      expect(result.masked).not.toContain('ghp_');
      expect(result.secretsFound).toBe(1);
    });

    it('should mask emails', () => {
      const result = vault.mask('Contact user@example.com for help');
      expect(result.masked).not.toContain('user@example.com');
      expect(result.categories).toContain('email');
    });

    it('should mask SSH private keys', () => {
      const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      const result = vault.mask(key);
      expect(result.masked).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(result.categories).toContain('ssh_private_key');
    });

    it('should not mask allowlisted values', () => {
      const result = vault.mask('API_KEY=paddock-proxy');
      // paddock-proxy is allowlisted
      expect(result.masked).toContain('paddock-proxy');
    });

    it('should reuse placeholders for same value', () => {
      const text = 'key1=sk-ant-abcdefghijklmnopqrstuvwxyz key2=sk-ant-abcdefghijklmnopqrstuvwxyz';
      const result = vault.mask(text);
      // Both occurrences should use the same placeholder
      const matches = result.masked.match(/\{\{PADDOCK_SECRET_\d+\}\}/g);
      expect(matches).toHaveLength(2);
      expect(matches![0]).toBe(matches![1]);
    });
  });

  describe('unmask', () => {
    it('should restore masked values', () => {
      const original = 'My key is sk-ant-abcdefghijklmnopqrstuvwxyz';
      const { masked } = vault.mask(original);
      const restored = vault.unmask(masked);
      expect(restored).toBe(original);
    });

    it('should handle text with no placeholders', () => {
      const text = 'no secrets here';
      expect(vault.unmask(text)).toBe(text);
    });
  });

  describe('getStats', () => {
    it('should return correct stats', () => {
      vault.mask('sk-ant-abcdefghijklmnopqrstuvwxyz and user@example.com');
      const stats = vault.getStats();
      expect(stats.totalSecrets).toBeGreaterThanOrEqual(2);
      expect(stats.categories['anthropic_key']).toBe(1);
      expect(stats.categories['email']).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all secrets', () => {
      vault.mask('sk-ant-abcdefghijklmnopqrstuvwxyz');
      vault.clear();
      expect(vault.getStats().totalSecrets).toBe(0);
    });
  });
});
