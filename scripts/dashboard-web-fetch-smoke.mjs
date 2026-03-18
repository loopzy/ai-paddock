import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('../tmp/openclaw/node_modules/playwright-core');

const dashboardUrl = process.env.PADDOCK_DASHBOARD_URL ?? 'http://127.0.0.1:3200';
const controlPlaneUrl = process.env.PADDOCK_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3100';
const sandboxType = process.env.PADDOCK_SANDBOX_TYPE ?? 'simple-box';
const chromeExecutable =
  process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const artifactsDir = path.resolve(process.cwd(), 'artifacts', `dashboard-web-fetch-smoke-${sandboxType}`);

const command = [
  'Use the web_fetch tool exactly once to fetch https://example.com.',
  'Do not use the browser tool.',
  'Do not use exec, curl, wget, python HTTP clients, MCP external tools, channels, TTS, payments, or purchases.',
  'After the fetch succeeds, summarize the page title and mention the final domain.',
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

async function getSessions() {
  return fetchJson(`${controlPlaneUrl}/api/sessions`);
}

async function getSessionEvents(sessionId) {
  return fetchJson(`${controlPlaneUrl}/api/sessions/${sessionId}/events`);
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
    toolName: event.payload?.toolName,
    code: event.payload?.code,
    phase: event.payload?.phase,
  }));
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
        if (error) throw new Error(`Sandbox startup failed: ${error.payload.error}`);
        return events.find((event) => event.type === 'amp.session.start' && event.payload.phase === 'sandbox_ready');
      },
      { timeoutMs: 240000, intervalMs: 2000, label: 'sandbox readiness' },
    );

    await page.getByRole('button', { name: 'Deploy Agent' }).click();

    await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) throw new Error(`Agent deploy failed: ${fatal.payload.code}: ${fatal.payload.message}`);
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
    console.log(`[web-fetch-smoke] command submitted session=${sessionId} baselineSeq=${sendBaselineSeq}`);

    const finalEvents = await waitFor(
      async () => {
        const events = await getSessionEvents(sessionId);
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) throw new Error(`OpenClaw command failed: ${fatal.payload.code}: ${fatal.payload.message}`);
        const agentError = events.find((event) => event.type === 'amp.agent.error');
        if (agentError) throw new Error(`OpenClaw reported recoverable error: ${agentError.payload.code}: ${agentError.payload.message}`);
        const hitlRequest = events.find((event) => event.type === 'hitl.request');
        if (hitlRequest) throw new Error(`Unexpected HITL request for ${hitlRequest.payload?.toolName ?? 'unknown'}`);

        const postSendEvents = events.filter((event) => event.seq > sendBaselineSeq);
        const webFetchIntent = postSendEvents.find(
          (event) => event.type === 'amp.tool.intent' && event.payload?.toolName === 'web_fetch',
        );
        const webFetchResult = postSendEvents.find(
          (event) => event.type === 'amp.tool.result' && event.payload?.toolName === 'web_fetch',
        );
        const browserIntent = postSendEvents.find(
          (event) => event.type === 'amp.tool.intent' && event.payload?.toolName === 'browser',
        );
        const execIntent = postSendEvents.find(
          (event) => event.type === 'amp.tool.intent' && event.payload?.toolName === 'exec',
        );
        if (browserIntent) throw new Error('web_fetch smoke unexpectedly used browser');
        if (execIntent) throw new Error('web_fetch smoke unexpectedly used exec');
        if (webFetchResult?.payload?.result?.status === 'error') {
          throw new Error(`web_fetch returned error status: ${webFetchResult.payload.result.error ?? 'unknown error'}`);
        }
        if (webFetchResult?.payload?.result?.error) {
          throw new Error(`web_fetch returned error payload: ${webFetchResult.payload.result.error}`);
        }

        const llmResponses = postSendEvents.filter((event) => event.type === 'llm.response');
        console.log(
          `[web-fetch-smoke] waiting counts=${JSON.stringify(summarizeEvents(postSendEvents))} recent=${JSON.stringify(summarizeRecentEvents(postSendEvents))}`,
        );

        if (webFetchIntent && webFetchResult && llmResponses.length >= 1) {
          return events;
        }
        return null;
      },
      { timeoutMs: 300000, intervalMs: 5000, label: 'web_fetch execution' },
    );

    await page.screenshot({ path: path.join(artifactsDir, 'dashboard-final.png'), fullPage: true });

    const summary = {
      sessionId,
      sandboxType,
      command,
      eventCounts: summarizeEvents(finalEvents),
      webFetchResult: finalEvents.find(
        (event) => event.type === 'amp.tool.result' && event.payload?.toolName === 'web_fetch',
      )?.payload,
      lastEvents: finalEvents.slice(-25).map((event) => ({
        type: event.type,
        payload: event.payload,
      })),
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
