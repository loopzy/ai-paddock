import { useEffect, useState } from 'react';

interface HITLRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  reason: string;
  timestamp: number;
  riskScore?: number;
  triggeredRules?: string[];
}

interface Props {
  sessionId: string;
  onDecide: (requestId: string, verdict: 'approved' | 'rejected') => void;
}

export function HITLModal({ sessionId, onDecide }: Props) {
  const [requests, setRequests] = useState<HITLRequest[]>([]);

  useEffect(() => {
    const poll = setInterval(async () => {
      const res = await fetch(`/api/sessions/${sessionId}/hitl/pending`);
      const data = await res.json();
      setRequests(data);
    }, 1000);
    return () => clearInterval(poll);
  }, [sessionId]);

  if (requests.length === 0) return null;

  const current = requests[0];
  const riskColor = (current.riskScore ?? 0) > 70 ? 'text-red-400' : (current.riskScore ?? 0) > 30 ? 'text-yellow-400' : 'text-green-400';

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-orange-600 rounded-lg p-6 max-w-2xl w-full mx-4">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-3xl" role="img" aria-label="warning">&#9888;&#65039;</span>
          <h2 className="text-xl font-bold text-orange-400">Approval Required</h2>
          {current.riskScore !== undefined && (
            <span className={`${riskColor} text-sm font-mono ml-auto`}>Risk: {current.riskScore}</span>
          )}
        </div>

        <div className="space-y-3 mb-6">
          <div>
            <span className="text-gray-500 text-sm">Tool:</span>
            <span className="ml-2 text-cyan-400 font-mono">{current.toolName}</span>
          </div>

          <div>
            <span className="text-gray-500 text-sm">Arguments:</span>
            <pre className="mt-1 bg-gray-950 p-3 rounded text-xs overflow-x-auto">
              {JSON.stringify(current.toolArgs, null, 2)}
            </pre>
          </div>

          <div>
            <span className="text-gray-500 text-sm">Reason:</span>
            <p className="mt-1 text-gray-300">{current.reason}</p>
          </div>

          {current.triggeredRules && current.triggeredRules.length > 0 && (
            <div>
              <span className="text-gray-500 text-sm">Triggered Rules:</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {current.triggeredRules.map((rule, i) => (
                  <span key={i} className="text-xs bg-red-900/50 text-red-300 px-2 py-0.5 rounded">{rule}</span>
                ))}
              </div>
            </div>
          )}

          <div className="text-xs text-gray-600">
            Requested {new Date(current.timestamp).toLocaleTimeString()}
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => onDecide(current.id, 'approved')}
            className="flex-1 px-4 py-2 bg-green-700 hover:bg-green-600 rounded font-medium"
          >
            Approve
          </button>
          <button
            onClick={() => onDecide(current.id, 'rejected')}
            className="flex-1 px-4 py-2 bg-red-700 hover:bg-red-600 rounded font-medium"
          >
            Reject
          </button>
        </div>

        {requests.length > 1 && (
          <div className="mt-3 text-center text-sm text-gray-500">
            {requests.length - 1} more request{requests.length > 2 ? 's' : ''} pending
          </div>
        )}
      </div>
    </div>
  );
}
