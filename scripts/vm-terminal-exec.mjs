const [, , sessionId, ...commandParts] = process.argv;

if (!sessionId || commandParts.length === 0) {
  console.error("usage: node scripts/vm-terminal-exec.mjs <sessionId> <command...>");
  process.exit(1);
}

const wsBase = process.env.PADDOCK_CONTROL_PLANE_WS ?? "ws://127.0.0.1:3100";
const command = commandParts.join(" ");
const timeoutMs = Number(process.env.PADDOCK_VM_TERMINAL_TIMEOUT_MS ?? 30000);
const ws = new WebSocket(`${wsBase}/ws/sessions/${sessionId}/terminal`);

const timeout = setTimeout(() => {
  console.error(`timed out after ${timeoutMs}ms`);
  process.exit(2);
}, timeoutMs);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "exec", command }));
});

ws.addEventListener("message", (event) => {
  clearTimeout(timeout);
  console.log(event.data.toString());
  ws.close();
});

ws.addEventListener("error", (event) => {
  clearTimeout(timeout);
  const error = "message" in event && event.message ? String(event.message) : String(event);
  console.error(error);
  process.exit(1);
});
