import React from 'react';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';

export function StatusBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const claudeInfo = useConfigStore((s) => s.claudeInfo);
  const claudeVersionLabel = useConfigStore((s) => s.claudeVersionLabel);
  const config = useConfigStore((s) => s.config);

  const running = sessions.filter((s) => s.status === 'running').length;
  const queued = sessions.filter((s) => s.status === 'queued').length;
  const maxSessions = config.claude.maxConcurrentSessions;

  return (
    <div className="h-6 bg-zinc-900 border-t border-zinc-700 flex items-center px-3 text-xs text-zinc-500 select-none flex-shrink-0">
      <div className="flex items-center gap-4">
        <span>
          <span className={running > 0 ? 'text-green-400' : ''}>{running}/{maxSessions}</span> sessions
          {queued > 0 && <span className="text-yellow-400 ml-1">| {queued} queued</span>}
        </span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-4">
        {claudeInfo && (
          claudeInfo.found ? (
            <span className="text-zinc-500">{claudeVersionLabel}</span>
          ) : (
            <span className="text-red-400">claude not found</span>
          )
        )}
      </div>
    </div>
  );
}
