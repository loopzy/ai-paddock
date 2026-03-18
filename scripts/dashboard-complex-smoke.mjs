import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('../tmp/openclaw/node_modules/playwright-core');
const execFile = promisify(execFileCallback);

const dashboardUrl = process.env.PADDOCK_DASHBOARD_URL ?? 'http://127.0.0.1:3200';
const controlPlaneUrl = process.env.PADDOCK_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3100';
const sandboxType = process.env.PADDOCK_SANDBOX_TYPE ?? 'simple-box';
const chromeExecutable =
  process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const artifactsDir = path.resolve(process.cwd(), 'artifacts', `dashboard-complex-smoke-${sandboxType}`);
const workspaceDir = '/workspace/paddock_complex';
const localReportUrl = 'http://127.0.0.1:8765/report.html';

const command = [
  'Use only sandbox-local tools inside this VM.',
  'Read /workspace/AGENTS.md and /workspace/TOOLS.md before acting.',
  'Work strictly one tool call at a time. Wait for each tool result before issuing the next tool call.',
  `Create the directory ${workspaceDir} if it does not already exist.`,
  `Write ${workspaceDir}/notes.md with the title "# Complex Smoke" followed by exactly three bullet points summarizing the sandbox instructions, and then a section "## Local Tools" listing exactly five sandbox-local tools by name.`,
  `Write ${workspaceDir}/data.csv with the header "name,value" and exactly three rows: alpha,3 beta,7 gamma,11.`,
  `Write ${workspaceDir}/build_report.py using only the Python standard library. The script must use absolute paths under ${workspaceDir}, must read ${workspaceDir}/data.csv, must write ${workspaceDir}/summary.json with JSON keys "total" and "average", and must write ${workspaceDir}/report.html with an HTML table that includes the exact lowercase text "total 21" and "average 7". Do not use Flask, Jinja2, pip, npm, or any third-party package.`,
  `Run python3 ${workspaceDir}/build_report.py.`,
  `Start a local static HTTP server on 127.0.0.1:8765 for ${workspaceDir} using python3 -m http.server and the process tool.`,
  'Capture the exact process sessionId returned by the background http.server command and later pass that exact sessionId to the process tool when stopping the server.',
  `After the server is running, use only the browser tool to open ${localReportUrl} and verify that the page contains both "total 21" and "average 7". Never use exec or process to run curl, wget, python HTTP clients, or any other HTTP fetcher for this verification. If a browser action fails, retry with the browser tool instead of using shell/network tools.`,
  'Do not use curl, gateway tools, external network tools, or package installers for this verification.',
  'After verification, stop the local HTTP server.',
  `Finally summarize exactly which files you created under ${workspaceDir} and whether browser verification succeeded.`,
  'Do not use network APIs, MCP external tools, channels, TTS, payments, or purchases.',
].join(' ');

const expectedPaths = [
  `${workspaceDir}/notes.md`,
  `${workspaceDir}/data.csv`,
  `${workspaceDir}/build_report.py`,
  `${workspaceDir}/summary.json`,
  `${workspaceDir}/report.html`,
];
const completionQuietPeriodMs = Number(process.env.PADDOCK_COMPLEX_SMOKE_QUIET_MS ?? 10000);

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitFor(predicate, options) {
  const { timeoutMs, intervalMs, label } = options;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function summarizeEvents(events) {
  const counts = new Map();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function summarizeRecentEvents(events, limit = 10) {
  return events.slice(-limit).map((event) => ({
    seq: event.seq,
    type: event.type,
    phase: event.payload?.phase,
    toolName: event.payload?.toolName,
    code: event.payload?.code,
    path: event.payload?.path,
  }));
}

function findDisallowedVerificationCommands(events) {
  return events
    .filter((event) => event.type === 'amp.tool.intent' && event.payload?.toolName === 'exec')
    .map((event) => ({
      seq: event.seq,
      command: typeof event.payload?.toolInput?.command === 'string' ? event.payload.toolInput.command : '',
    }))
    .filter(({ command }) => /(^|[^a-z0-9_])(curl|wget)([^a-z0-9_]|$)/i.test(command));
}

const ALLOWED_LOCAL_TOOLS = new Set(['read', 'write', 'edit', 'list', 'apply_patch', 'exec', 'process', 'browser', 'image']);

function findDisallowedToolIntents(events) {
  return events
    .filter((event) => event.type === 'amp.tool.intent')
    .map((event) => ({
      seq: event.seq,
      toolName: typeof event.payload?.toolName === 'string' ? event.payload.toolName : '',
    }))
    .filter(({ toolName }) => toolName && !ALLOWED_LOCAL_TOOLS.has(toolName));
}

function summarizeAgentErrors(events) {
  return events
    .filter((event) => event.type === 'amp.agent.error')
    .map((event) => ({
      seq: event.seq,
      code: event.payload?.code,
      message: event.payload?.message,
      category: event.payload?.category,
      recoverable: event.payload?.recoverable,
    }));
}

function extractToolError(event) {
  const resultPayload = event?.payload?.result;
  if (typeof resultPayload?.error === 'string' && resultPayload.error) {
    return resultPayload.error;
  }

  const nested = resultPayload?.result;
  const details = nested?.details;
  if (typeof details?.error === 'string' && details.error) {
    return details.error;
  }
  if (typeof details?.status === 'string' && details.status.toLowerCase() === 'error') {
    return typeof details?.error === 'string' && details.error ? details.error : 'tool returned status=error';
  }

  const content = Array.isArray(nested?.content) ? nested.content : [];
  for (const entry of content) {
    if (typeof entry?.text !== 'string') continue;
    const text = entry.text.trim();
    if (!(text.startsWith('{') && text.endsWith('}'))) continue;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === 'string' && parsed.error) return parsed.error;
      if (typeof parsed?.status === 'string' && parsed.status.toLowerCase() === 'error') {
        return typeof parsed?.error === 'string' && parsed.error ? parsed.error : 'tool returned status=error';
      }
    } catch {
      // ignore non-JSON tool text payloads
    }
  }

  return null;
}

async function getSessionEvents(sessionId) {
  return fetchJson(`${controlPlaneUrl}/api/sessions/${sessionId}/events`);
}

async function getSessions() {
  return fetchJson(`${controlPlaneUrl}/api/sessions`);
}

async function runVmCommand(sessionId, command) {
  const { stdout } = await execFile(process.execPath, ['scripts/vm-terminal-exec.mjs', sessionId, command], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 16,
  });
  const parsed = JSON.parse(stdout);
  return String(parsed.stdout ?? '');
}

function collectCreatedPaths(events) {
  const paths = new Set();

  for (const event of events) {
    const path = typeof event.payload?.path === 'string' ? event.payload.path : null;
    if (!path || !path.startsWith(`${workspaceDir}/`)) continue;

    if (event.type === 'fs.change' || event.type === 'amp.fs.change') {
      paths.add(path);
      continue;
    }

    if (
      event.type === 'amp.tool.result' &&
      (event.payload?.toolName === 'write' || event.payload?.toolName === 'edit' || event.payload?.toolName === 'apply_patch')
    ) {
      paths.add(path);
    }
  }

  return Array.from(paths).sort();
}

async function main() {
  await mkdir(artifactsDir, { recursive: true });

  const sessionsBefore = new Set((await getSessions()).map((session) => session.id));
  const browser = await chromium.launch({
    headless: process.env.PADDOCK_HEADFUL === '1' ? false : true,
    executablePath: chromeExecutable,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  let lastObservedCompletionSeq = 0;
  let completionQuietSince = 0;

  try {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('combobox', { name: 'Select sandbox type' }).selectOption(sandboxType);
    await page.getByRole('button', { name: 'Create Sandbox' }).click();

    const session = await waitFor(
      async () => {
        const sessions = await getSessions();
        return sessions.find((candidate) => !sessionsBefore.has(candidate.id)) ?? null;
      },
      { timeoutMs: 120000, intervalMs: 1000, label: 'new session creation' },
    );
    const sessionId = session.id;

    await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const error = events.find((event) => event.type === 'session.status' && event.payload.status === 'error');
        if (error) {
          throw new Error(`Sandbox startup failed: ${error.payload.error}`);
        }
        return events.find((event) => event.type === 'amp.session.start' && event.payload.phase === 'sandbox_ready');
      },
      { timeoutMs: 240000, intervalMs: 2000, label: 'sandbox readiness' },
    );

    await page.getByRole('button', { name: 'Deploy Agent' }).click();

    await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) {
          throw new Error(`Agent deploy failed: ${fatal.payload.code}: ${fatal.payload.message}`);
        }
        return events.find((event) => event.type === 'amp.agent.ready') ?? null;
      },
      { timeoutMs: 300000, intervalMs: 2000, label: 'OpenClaw readiness' },
    );

    const textbox = page.getByRole('textbox');
    await waitFor(
      async () => (await textbox.isEnabled()) ? true : null,
      { timeoutMs: 30000, intervalMs: 500, label: 'command input enablement' },
    );

    await textbox.fill(command);
    await page.getByRole('button', { name: 'Send' }).click();

    const eventsAtSend = await getSessionEvents(sessionId);
    const sendBaselineSeq = eventsAtSend.at(-1)?.seq ?? 0;
    console.log(`[complex-smoke] command submitted session=${sessionId} baselineSeq=${sendBaselineSeq}`);

    await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) {
          throw new Error(`OpenClaw command failed: ${fatal.payload.code}: ${fatal.payload.message}`);
        }
        const recoverableError = events.find((event) => event.type === 'amp.agent.error');
        if (recoverableError) {
          throw new Error(`OpenClaw reported recoverable error: ${recoverableError.payload.code}: ${recoverableError.payload.message}`);
        }
        const disallowedCommands = findDisallowedVerificationCommands(events);
        if (disallowedCommands.length > 0) {
          throw new Error(`OpenClaw used disallowed verification command: ${disallowedCommands[0].command}`);
        }
        const disallowedToolIntents = findDisallowedToolIntents(events);
        if (disallowedToolIntents.length > 0) {
          throw new Error(`OpenClaw used disallowed tool: ${disallowedToolIntents[0].toolName}`);
        }
        const hitlRequest = events.find((event) => event.type === 'hitl.request');
        if (hitlRequest) {
          throw new Error(`OpenClaw requested HITL approval for tool: ${hitlRequest.payload?.toolName ?? 'unknown'}`);
        }
        const postSendEvents = events.filter((event) => event.seq > sendBaselineSeq);
        const hasActivity = postSendEvents.some((event) =>
          event.type === 'llm.request' ||
          event.type === 'amp.tool.intent' ||
          event.type === 'amp.gate.verdict' ||
          event.type === 'amp.tool.result' ||
          event.type === 'llm.response' ||
          event.type === 'amp.llm.response',
        );
        console.log(
          `[complex-smoke] waiting for activity counts=${JSON.stringify(summarizeEvents(postSendEvents))} recent=${JSON.stringify(summarizeRecentEvents(postSendEvents))}`,
        );
        return hasActivity ? events : null;
      },
      { timeoutMs: 420000, intervalMs: 5000, label: 'initial complex command activity' },
    );

    const finalEvents = await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const latestSeq = events.at(-1)?.seq ?? 0;
        if (latestSeq !== lastObservedCompletionSeq) {
          lastObservedCompletionSeq = latestSeq;
          completionQuietSince = Date.now();
        }
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) {
          throw new Error(`OpenClaw command failed: ${fatal.payload.code}: ${fatal.payload.message}`);
        }
        const recoverableError = events.find((event) => event.type === 'amp.agent.error');
        if (recoverableError) {
          throw new Error(`OpenClaw reported recoverable error: ${recoverableError.payload.code}: ${recoverableError.payload.message}`);
        }
        const disallowedCommands = findDisallowedVerificationCommands(events);
        if (disallowedCommands.length > 0) {
          throw new Error(`OpenClaw used disallowed verification command: ${disallowedCommands[0].command}`);
        }
        const disallowedToolIntents = findDisallowedToolIntents(events);
        if (disallowedToolIntents.length > 0) {
          throw new Error(`OpenClaw used disallowed tool: ${disallowedToolIntents[0].toolName}`);
        }
        const hitlRequest = events.find((event) => event.type === 'hitl.request');
        if (hitlRequest) {
          throw new Error(`OpenClaw requested HITL approval for tool: ${hitlRequest.payload?.toolName ?? 'unknown'}`);
        }

        const createdPaths = collectCreatedPaths(events);
        const createdPathSet = new Set(createdPaths);
        const missingPaths = expectedPaths.filter((filePath) => !createdPathSet.has(filePath));
        const extraCreatedPaths = createdPaths.filter((filePath) => !expectedPaths.includes(filePath));
        const browserResults = events.filter(
          (event) => event.type === 'amp.tool.result' && event.payload?.toolName === 'browser',
        );
        const browserErrors = browserResults
          .map((event) => ({ seq: event.seq, error: extractToolError(event) }))
          .filter((entry) => typeof entry.error === 'string' && entry.error.length > 0);
        const browserSuccesses = browserResults.filter(
          (event) => !extractToolError(event),
        );
        const llmResponses = events.filter((event) => event.type === 'llm.response' || event.type === 'amp.llm.response');
        const serverProcesses = missingPaths.length === 0 && browserSuccesses.length >= 1
          ? await runVmCommand(sessionId, `pgrep -af 'http.server 8765' || true`)
          : '';
        const serverStopped = !serverProcesses.includes('python3 -m http.server 8765');
        const quietMs = completionQuietSince > 0 ? Date.now() - completionQuietSince : 0;
        console.log(
          `[complex-smoke] waiting for completion missingPaths=${JSON.stringify(missingPaths)} extraCreatedPaths=${JSON.stringify(extraCreatedPaths)} browserResults=${browserResults.length} browserSuccesses=${browserSuccesses.length} browserErrors=${JSON.stringify(browserErrors)} llmResponses=${llmResponses.length} serverStopped=${serverStopped} quietMs=${quietMs} recent=${JSON.stringify(summarizeRecentEvents(events))}`,
        );
        if (
          missingPaths.length === 0 &&
          extraCreatedPaths.length === 0 &&
          browserSuccesses.length >= 1 &&
          llmResponses.length >= 1 &&
          serverStopped &&
          quietMs >= completionQuietPeriodMs
        ) {
          return events;
        }
        return null;
      },
      { timeoutMs: 300000, intervalMs: 5000, label: 'complex command completion' },
    );

    const vmInspection = await runVmCommand(
      sessionId,
      [
        `ls -la ${workspaceDir}`,
        `printf '\\n---SUMMARY---\\n' && cat ${workspaceDir}/summary.json`,
        `printf '\\n---NOTES---\\n' && cat ${workspaceDir}/notes.md`,
        `printf '\\n---SERVER---\\n' && (pgrep -af 'http.server 8765' || true)`,
      ].join(' && '),
    );
    const serverSection = vmInspection.split('---SERVER---').at(-1) ?? '';
    if (serverSection.includes('python3 -m http.server 8765')) {
      throw new Error('HTTP server is still running after agent completion');
    }
    const createdPaths = collectCreatedPaths(finalEvents);
    const browserResults = finalEvents.filter(
      (event) => event.type === 'amp.tool.result' && event.payload?.toolName === 'browser',
    );
    const browserErrors = browserResults
      .map((event) => ({ seq: event.seq, error: extractToolError(event) }))
      .filter((entry) => typeof entry.error === 'string' && entry.error.length > 0);
    const browserSuccesses = browserResults.filter(
      (event) => !extractToolError(event),
    );
    const llmResponses = finalEvents.filter((event) => event.type === 'llm.response' || event.type === 'amp.llm.response');
    const disallowedCommands = findDisallowedVerificationCommands(finalEvents);
    const disallowedToolIntents = findDisallowedToolIntents(finalEvents);
    const agentErrors = summarizeAgentErrors(finalEvents);
    const extraCreatedPaths = createdPaths.filter((filePath) => !expectedPaths.includes(filePath));
    await page.screenshot({ path: path.join(artifactsDir, 'dashboard-final.png'), fullPage: true });

    const summary = {
      sessionId,
      sandboxType,
      command,
      expectedPaths,
      createdPaths,
      browserResults: browserResults.length,
      browserSuccesses: browserSuccesses.length,
      browserTransientErrors: browserErrors,
      llmResponses: llmResponses.length,
      agentErrors,
      disallowedCommands,
      disallowedToolIntents,
      extraCreatedPaths,
      serverStopped: true,
      eventCounts: summarizeEvents(finalEvents),
      lastEvents: finalEvents.slice(-25).map((event) => ({
        type: event.type,
        payload: event.payload,
      })),
      vmInspection,
    };

    await writeFile(path.join(artifactsDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
