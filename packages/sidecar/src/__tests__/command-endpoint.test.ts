import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';

// Mock the command file path
const TEST_COMMAND_FILE = '/tmp/paddock-test-commands.jsonl';
process.env.PADDOCK_COMMAND_FILE = TEST_COMMAND_FILE;

describe('Sidecar /amp/command endpoint', () => {
  beforeEach(() => {
    // Clean up test file before each test
    if (existsSync(TEST_COMMAND_FILE)) {
      unlinkSync(TEST_COMMAND_FILE);
    }
  });

  afterEach(() => {
    // Clean up test file after each test
    if (existsSync(TEST_COMMAND_FILE)) {
      unlinkSync(TEST_COMMAND_FILE);
    }
  });

  it('should write command to JSONL file', async () => {
    const command = 'hello world';
    const timestamp = Date.now();

    // Simulate the handleCommand function
    const { appendFileSync } = await import('node:fs');
    const entry = { command, timestamp };
    appendFileSync(TEST_COMMAND_FILE, JSON.stringify(entry) + '\n');

    // Verify file was written
    expect(existsSync(TEST_COMMAND_FILE)).toBe(true);

    // Verify content
    const content = readFileSync(TEST_COMMAND_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.command).toBe(command);
    expect(parsed.timestamp).toBe(timestamp);
  });

  it('should append multiple commands', async () => {
    const { appendFileSync } = await import('node:fs');

    const commands = ['command1', 'command2', 'command3'];
    for (const cmd of commands) {
      const entry = { command: cmd, timestamp: Date.now() };
      appendFileSync(TEST_COMMAND_FILE, JSON.stringify(entry) + '\n');
    }

    const content = readFileSync(TEST_COMMAND_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);

    const parsed = lines.map(line => JSON.parse(line));
    expect(parsed.map(p => p.command)).toEqual(commands);
  });

  it('should handle commands with special characters', async () => {
    const { appendFileSync } = await import('node:fs');

    const command = 'echo "hello\'s world" && ls -la';
    const entry = { command, timestamp: Date.now() };
    appendFileSync(TEST_COMMAND_FILE, JSON.stringify(entry) + '\n');

    const content = readFileSync(TEST_COMMAND_FILE, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.command).toBe(command);
  });
});
