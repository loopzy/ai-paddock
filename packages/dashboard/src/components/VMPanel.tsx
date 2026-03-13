import { useState, useEffect } from 'react';
import { WebTerminal } from './WebTerminal.js';

type SandboxType = 'simple-box' | 'computer-box' | 'cua';

interface PaddockEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * VMPanel — renders either a desktop iframe (computer-box) or web terminal (simple-box).
 * Tab switching is handled by the parent App component.
 */
export function VMPanel({ sessionId, sandboxType, events }: { sessionId: string; sandboxType: SandboxType; events: PaddockEvent[] }) {
  const [guiPorts, setGuiPorts] = useState<{ httpPort: number; httpsPort: number } | null>(null);

  const sandboxReady = events.some(e => e.type === 'amp.session.start' && e.payload.phase === 'sandbox_ready');

  useEffect(() => {
    if (sandboxType !== 'computer-box' || !sandboxReady) return;
    fetch(`/api/sessions/${sessionId}/gui-ports`)
      .then(r => r.json())
      .then(data => setGuiPorts(data.guiPorts))
      .catch(console.error);
  }, [sessionId, sandboxType, sandboxReady]);

  if (sandboxType === 'computer-box') {
    if (!guiPorts) {
      return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Loading desktop...</div>;
    }
    return (
      <div className="flex-1">
        <iframe
          src={`http://localhost:${guiPorts.httpPort}`}
          className="w-full h-full border-0"
          title="VM Desktop"
        />
      </div>
    );
  }

  return <WebTerminal sessionId={sessionId} />;
}

export { type SandboxType };
