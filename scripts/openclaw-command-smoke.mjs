const controlPlaneUrl = process.env.PADDOCK_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3100';
const sandboxType = process.env.PADDOCK_SANDBOX_TYPE ?? 'simple-box';
const command = process.env.PADDOCK_SMOKE_COMMAND ?? '整点好康的';
const commandTimeoutMs = Number(process.env.PADDOCK_SMOKE_COMMAND_TIMEOUT_MS ?? 180000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getSessionEvents(sessionId) {
  return fetchJson(`${controlPlaneUrl}/api/sessions/${sessionId}/events`);
}

async function waitFor(sessionId, label, predicate, timeoutMs, intervalMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const events = await getSessionEvents(sessionId);
    const result = predicate(events);
    if (result) {
      return { events, result };
    }
    await sleep(intervalMs);
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

function summarizeRecentEvents(events, limit = 12) {
  return events.slice(-limit).map((event) => ({
    seq: event.seq,
    type: event.type,
    payload: event.payload,
  }));
}

async function createSession() {
  return fetchJson(`${controlPlaneUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentType: 'openclaw', sandboxType }),
  });
}

async function deployAgent(sessionId) {
  return fetchJson(`${controlPlaneUrl}/api/sessions/${sessionId}/deploy-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentType: 'openclaw' }),
  });
}

async function stopSession(sessionId) {
  try {
    await fetchJson(`${controlPlaneUrl}/api/sessions/${sessionId}/stop`, { method: 'POST' });
  } catch {
    // ignore cleanup failures
  }
  try {
    await fetchJson(`${controlPlaneUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
  } catch {
    // ignore cleanup failures
  }
}

async function sendCommand(sessionId, value) {
  const ws = new WebSocket(`ws://127.0.0.1:3100/ws/sessions/${sessionId}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.send(JSON.stringify({ type: 'user.command', command: value }));
  ws.close();
}

async function main() {
  const session = await createSession();
  console.log(JSON.stringify({ phase: 'session-created', sessionId: session.id, sandboxType }, null, 2));

  try {
    await waitFor(
      session.id,
      'sandbox_ready',
      (events) =>
        events.find((event) => event.type === 'amp.session.start' && event.payload?.phase === 'sandbox_ready') ||
        events.find((event) => event.type === 'session.status' && event.payload?.status === 'error'),
      240000,
    );
    console.log(JSON.stringify({ phase: 'sandbox-ready' }, null, 2));

    await deployAgent(session.id);

    const ready = await waitFor(
      session.id,
      'agent_ready',
      (events) =>
        events.find((event) => event.type === 'amp.agent.ready') ||
        events.find((event) => event.type === 'amp.agent.fatal') ||
        events.find((event) => event.type === 'session.status' && event.payload?.status === 'error'),
      300000,
    );
    console.log(JSON.stringify({ phase: 'agent-ready', event: ready.result }, null, 2));

    await sendCommand(session.id, command);
    console.log(JSON.stringify({ phase: 'command-sent', command }, null, 2));

    const completion = await waitFor(
      session.id,
      'command completion',
      (events) => {
        const fatal = events.find((event) => event.type === 'amp.agent.fatal');
        if (fatal) return { kind: 'fatal', event: fatal };

        const recoverableError = events.find((event) => event.type === 'amp.agent.error');
        if (recoverableError) return { kind: 'agent_error', event: recoverableError };

        const agentMessage = [...events].reverse().find((event) => event.type === 'amp.agent.message');
        if (agentMessage) return { kind: 'message', event: agentMessage };

        const llmResponses = events.filter((event) => event.type === 'llm.response' || event.type === 'amp.llm.response');
        const commandAccepted = events.some(
          (event) => event.type === 'amp.command.status' && event.payload?.status === 'accepted',
        );
        const lastLlmResponse = llmResponses.at(-1)?.payload;
        if (
          commandAccepted &&
          llmResponses.length >= 2 &&
          !agentMessage &&
          (lastLlmResponse?.responseText === '' || lastLlmResponse?.responsePreview === '')
        ) {
          return {
            kind: 'suspect_stall',
            recent: summarizeRecentEvents(events),
          };
        }

        return null;
      },
      commandTimeoutMs,
      3000,
    );

    console.log(
      JSON.stringify(
        {
          phase: 'done',
          completion: completion.result,
          counts: summarizeEvents(completion.events),
          tail: summarizeRecentEvents(completion.events, 20),
        },
        null,
        2,
      ),
    );

    if (completion.result.kind !== 'message') {
      process.exitCode = 1;
    }
  } finally {
    await stopSession(session.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
