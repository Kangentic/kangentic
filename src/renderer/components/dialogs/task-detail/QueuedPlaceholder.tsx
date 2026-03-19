import { Clock, ChevronRight } from 'lucide-react';
import { useConfigStore } from '../../../stores/config-store';
import { useSessionStore } from '../../../stores/session-store';
import { Pill } from '../../Pill';

export function QueuedPlaceholder({ sessionId }: { sessionId: string | null }) {
  const maxConcurrent = useConfigStore((s) => s.config.claude.maxConcurrentSessions);
  const runningCount = useSessionStore((s) => s.getRunningCount());
  // Split into primitive selectors -- avoids new object refs triggering re-renders
  const queuePosition = useSessionStore((s) => {
    if (!sessionId) return 0;
    const pos = s.getQueuePosition(sessionId);
    return pos ? pos.position : 0;
  });
  const queueTotal = useSessionStore((s) => {
    if (!sessionId) return 0;
    const pos = s.getQueuePosition(sessionId);
    return pos ? pos.total : 0;
  });

  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);

  return (
    <div className="flex-1 flex flex-col bg-surface/50">
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <Clock size={32} className="text-fg-faint animate-pulse" />
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-base text-fg-muted font-medium">Waiting in queue</span>
          {queuePosition > 0 && (
            <span className="text-sm text-fg-faint">
              Position {queuePosition} of {queueTotal}
            </span>
          )}
          <span className="text-xs text-fg-disabled mt-1">
            Starts automatically when a slot opens up
          </span>
        </div>
      </div>
      <div className="px-4 py-2.5 border-t border-edge">
        <Pill onClick={() => setSettingsOpen(true)} className="text-fg-faint bg-surface-hover/50 hover:bg-surface-hover hover:text-fg-tertiary transition-colors">
          {runningCount} / {maxConcurrent} agent slots in use
          <ChevronRight size={12} />
        </Pill>
      </div>
    </div>
  );
}
