import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { agentShortName } from '../../../utils/agent-display-name';
import type { HandoffRecord } from '../../../../shared/types';

interface HandoffTimelineProps {
  taskId: string;
}

/**
 * Displays the cross-agent handoff chain for a task.
 * Shows: Claude -> Gemini -> Claude with timestamps.
 * Only renders if handoffs exist.
 */
export function HandoffTimeline({ taskId }: HandoffTimelineProps) {
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.handoffs.list(taskId).then((records) => {
      if (!cancelled) setHandoffs(records);
    });
    return () => { cancelled = true; };
  }, [taskId]);

  if (handoffs.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 mt-3" data-testid="handoff-timeline">
      <span className="text-xs font-medium text-fg-faint"><Trans>Handoff Chain</Trans></span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {handoffs.map((handoff, index) => (
          <div key={handoff.id} className="flex items-center gap-1.5">
            {index === 0 && (
              <HandoffBadge agent={handoff.from_agent} />
            )}
            <ArrowRight className="w-3 h-3 text-fg-faint" />
            <HandoffBadge agent={handoff.to_agent} />
          </div>
        ))}
      </div>
    </div>
  );
}

function HandoffBadge({ agent }: { agent: string }) {
  return (
    <span
      className="text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-surface-hover text-fg-muted"
      data-testid="handoff-badge"
    >
      {agentShortName(agent)}
    </span>
  );
}
