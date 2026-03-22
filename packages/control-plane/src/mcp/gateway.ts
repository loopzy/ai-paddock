import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * MCP Gateway — exposes host-side capabilities as MCP tools.
 *
 * These tools can be called from within the VM via paddock-host-tool CLI.
 * All calls go through HITL approval if policy requires it.
 */

export interface MCPToolResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const MCP_TOOL_DEFINITIONS: MCPToolDefinition[] = [
  {
    name: 'browser.open',
    description: 'Open a URL using the host browser.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to open.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'clipboard.read',
    description: 'Read the current host clipboard contents.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'clipboard.write',
    description: 'Write text to the host clipboard.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Clipboard text to write.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'tts.speak',
    description: 'Speak text on the host using text-to-speech.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak.' },
        voice: { type: 'string', description: 'Optional host voice identifier.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'applescript.run',
    description: 'Execute AppleScript on the host.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'AppleScript source to execute.' },
      },
      required: ['script'],
    },
  },
];

export class MCPGateway {
  listTools(): MCPToolDefinition[] {
    return MCP_TOOL_DEFINITIONS.map((tool) => ({ ...tool }));
  }

  /**
   * Call a host-side MCP tool.
   */
  async callTool(toolName: string, args: string | string[] | Record<string, unknown>): Promise<MCPToolResult> {
    const [category, action] = toolName.split('.');

    switch (category) {
      case 'browser':
        return this.handleBrowser(action, args);
      case 'clipboard':
        return this.handleClipboard(action, args);
      case 'tts':
        return this.handleTTS(action, args);
      case 'applescript':
        return this.handleAppleScript(action, args);
      default:
        return {
          stderr: `Unknown tool category: ${category}`,
          exitCode: 1,
        };
    }
  }

  private async handleBrowser(action: string, args: string | string[] | Record<string, unknown>): Promise<MCPToolResult> {
    const url = typeof args === 'object' && !Array.isArray(args) ? String(args.url ?? '') : Array.isArray(args) ? args[0] : args;
    if (action === 'open') {
      try {
        await execFile('open', [url]);
        return { exitCode: 0 };
      } catch (err) {
        return {
          stderr: String(err),
          exitCode: 1,
        };
      }
    }
    return { stderr: `Unknown browser action: ${action}`, exitCode: 1 };
  }

  private async handleClipboard(action: string, args: string | string[] | Record<string, unknown>): Promise<MCPToolResult> {
    if (action === 'read') {
      try {
        const { stdout } = await execFile('pbpaste');
        return { stdout, exitCode: 0 };
      } catch (err) {
        return { stderr: String(err), exitCode: 1 };
      }
    }
    if (action === 'write') {
      const text = typeof args === 'object' && !Array.isArray(args) ? String(args.text ?? '') : Array.isArray(args) ? args[0] : args;
      try {
        await runWithStdin('pbcopy', [], text);
        return { exitCode: 0 };
      } catch (err) {
        return { stderr: String(err), exitCode: 1 };
      }
    }
    return { stderr: `Unknown clipboard action: ${action}`, exitCode: 1 };
  }

  private async handleTTS(action: string, args: string | string[] | Record<string, unknown>): Promise<MCPToolResult> {
    if (action === 'speak') {
      const text = typeof args === 'object' && !Array.isArray(args)
        ? String(args.text ?? '')
        : Array.isArray(args)
          ? args.join(' ')
          : args;
      const voice = typeof args === 'object' && !Array.isArray(args) && typeof args.voice === 'string'
        ? args.voice
        : undefined;
      try {
        const sayArgs = voice ? ['-v', voice, text] : [text];
        await execFile('say', sayArgs);
        return { exitCode: 0 };
      } catch (err) {
        return { stderr: String(err), exitCode: 1 };
      }
    }
    return { stderr: `Unknown TTS action: ${action}`, exitCode: 1 };
  }

  private async handleAppleScript(action: string, args: string | string[] | Record<string, unknown>): Promise<MCPToolResult> {
    if (action === 'run') {
      const script = typeof args === 'object' && !Array.isArray(args)
        ? String(args.script ?? '')
        : Array.isArray(args)
          ? args.join(' ')
          : args;
      try {
        const { stdout, stderr } = await execFile('osascript', ['-e', script]);
        return { stdout, stderr, exitCode: 0 };
      } catch (err) {
        return { stderr: String(err), exitCode: 1 };
      }
    }
    return { stderr: `Unknown AppleScript action: ${action}`, exitCode: 1 };
  }
}

function runWithStdin(command: string, args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || `${command} exited with code ${code ?? 'unknown'}`));
    });

    child.stdin?.end(input);
  });
}
