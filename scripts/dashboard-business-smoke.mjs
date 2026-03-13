import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('../tmp/openclaw/node_modules/playwright-core');

const dashboardUrl = process.env.PADDOCK_DASHBOARD_URL ?? 'http://127.0.0.1:3200';
const controlPlaneUrl = process.env.PADDOCK_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3100';
const chromeExecutable =
  process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const artifactsDir = path.resolve(process.cwd(), 'artifacts', 'dashboard-business-smoke');

const command = [
  'Use only sandbox-local tools inside this VM.',
  'Create the directory /workspace/paddock_probe if it does not already exist.',
  'Create /workspace/paddock_probe/report.md with the title "# Paddock Probe" and exactly three bullet points:',
  '- sandbox active',
  '- sidecar monitored',
  '- openclaw running',
  'Create /workspace/paddock_probe/env.txt containing only the output of the command pwd.',
  'Run ls -la /workspace/paddock_probe and summarize exactly which files you created.',
  'Do not use network APIs, MCP external tools, channels, TTS, payments, or purchases.',
].join(' ');

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

function summarizeRecentEvents(events, limit = 8) {
  return events.slice(-limit).map((event) => ({
    seq: event.seq,
    type: event.type,
    phase: event.payload?.phase,
    toolName: event.payload?.toolName,
    code: event.payload?.code,
    path: event.payload?.path,
  }));
}

async function getSessionEvents(sessionId) {
  return fetchJson(`${controlPlaneUrl}/api/sessions/${sessionId}/events`);
}

async function getSessions() {
  return fetchJson(`${controlPlaneUrl}/api/sessions`);
}

async function main() {
  await mkdir(artifactsDir, { recursive: true });

  const sessionsBefore = new Set((await getSessions()).map((session) => session.id));

  const browser = await chromium.launch({
    headless: process.env.PADDOCK_HEADFUL === '1' ? false : true,
    executablePath: chromeExecutable,
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
        return events.find(
          (event) => event.type === 'amp.session.start' && event.payload.phase === 'sandbox_ready',
        );
      },
      { timeoutMs: 240000, intervalMs: 2000, label: 'sandbox readiness' },
    );

    await page.getByRole('button', { name: 'Deploy Agent' }).click();

    const readyEvent = await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) {
          throw new Error(`Agent deploy failed: ${fatal.payload.code}: ${fatal.payload.message}`);
        }
        const sessionError = events.find((event) => event.type === 'session.status' && event.payload.status === 'error');
        if (sessionError) {
          throw new Error(`Session failed during agent deploy: ${sessionError.payload.error}`);
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
    console.log(`[smoke] command submitted session=${sessionId} baselineSeq=${sendBaselineSeq}`);

    const commandActivity = await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) {
          return { status: 'fatal', events, fatal };
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
          `[smoke] waiting for command activity counts=${JSON.stringify(summarizeEvents(postSendEvents))} recent=${JSON.stringify(summarizeRecentEvents(postSendEvents))}`,
        );
        if (hasActivity) {
          return { status: 'active', events };
        }
        return null;
      },
      { timeoutMs: 420000, intervalMs: 5000, label: 'initial command activity' },
    );

    if (commandActivity.status === 'fatal') {
      throw new Error(`OpenClaw command handling failed: ${commandActivity.fatal.payload.code}`);
    }

    const postCommandEvents = await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) {
          return { status: 'fatal', events, fatal };
        }
        const probeFsChanges = events.filter((event) =>
          (event.type === 'fs.change' || event.type === 'amp.fs.change') &&
          typeof event.payload?.path === 'string' &&
          event.payload.path.startsWith('/workspace/paddock_probe/'),
        );
        const sawReport = probeFsChanges.some((event) => event.payload.path.endsWith('/report.md'));
        const sawEnv = probeFsChanges.some((event) => event.payload.path.endsWith('/env.txt'));
        const toolResults = events.filter((event) => event.type === 'amp.tool.result');
        const llmResponses = events.filter((event) => event.type === 'llm.response' || event.type === 'amp.llm.response');
        console.log(
          `[smoke] waiting for command completion sawReport=${sawReport} sawEnv=${sawEnv} toolResults=${toolResults.length} llmResponses=${llmResponses.length} recent=${JSON.stringify(summarizeRecentEvents(events))}`,
        );
        if ((sawReport && sawEnv) || toolResults.length >= 3 || llmResponses.length >= 1) {
          return { status: 'ok', events };
        }
        return null;
      },
      { timeoutMs: 180000, intervalMs: 3000, label: 'post-command completion' },
    );

    await page.getByRole('button', { name: 'Terminal' }).click();
    const terminalInput = page.getByPlaceholder('Type a command...');
    await terminalInput.fill("ls -la /workspace/paddock_probe && printf '\\n---\\n' && cat /workspace/paddock_probe/report.md && printf '\\n---\\n' && cat /workspace/paddock_probe/env.txt");
    await terminalInput.press('Enter');

    await page.waitForTimeout(3000);
    const terminalText = await page.locator('div.font-mono').innerText();
    await page.screenshot({ path: path.join(artifactsDir, 'dashboard-final.png'), fullPage: true });

    const finalEvents = await getSessionEvents(sessionId);
    const summary = {
      sessionId,
      agentReady: readyEvent.payload,
      terminalStatus: postCommandEvents.status,
      fatal: postCommandEvents.fatal?.payload ?? null,
      eventCounts: summarizeEvents(finalEvents),
      lastEvents: finalEvents.slice(-20).map((event) => ({
        type: event.type,
        payload: event.payload,
      })),
      terminalText,
    };

    await writeFile(
      path.join(artifactsDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
      'utf8',
    );

    console.log(JSON.stringify(summary, null, 2));

    if (postCommandEvents.status === 'fatal') {
      throw new Error(`OpenClaw command handling failed: ${postCommandEvents.fatal.payload.code}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
