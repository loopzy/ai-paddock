import { useState, useRef, useEffect, useCallback } from 'react';

interface TerminalLine {
  type: 'input' | 'stdout' | 'stderr';
  text: string;
}

export function WebTerminal({ sessionId }: { sessionId: string }) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/sessions/${sessionId}/terminal`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as { type: string; stdout: string; stderr: string; exitCode: number };
      if (msg.stdout) setLines(prev => [...prev, { type: 'stdout', text: msg.stdout }]);
      if (msg.stderr) setLines(prev => [...prev, { type: 'stderr', text: msg.stderr }]);
    };
    wsRef.current = ws;
    return () => ws.close();
  }, [sessionId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines.length]);

  const exec = useCallback(() => {
    if (!input.trim() || !wsRef.current) return;
    setLines(prev => [...prev, { type: 'input', text: `$ ${input}` }]);
    wsRef.current.send(JSON.stringify({ type: 'exec', command: input }));
    setInput('');
  }, [input]);

  return (
    <div className="flex-1 flex flex-col bg-black font-mono text-xs">
      <div className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {lines.map((line, i) => (
          <div key={i} className={line.type === 'stderr' ? 'text-red-400' : line.type === 'input' ? 'text-cyan-400' : 'text-gray-300'}>
            {line.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex border-t border-gray-800">
        <span className="px-2 py-2 text-cyan-600">$</span>
        <input
          className="flex-1 bg-transparent py-2 text-gray-200 focus:outline-none"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && exec()}
          placeholder="Type a command..."
        />
      </div>
    </div>
  );
}
