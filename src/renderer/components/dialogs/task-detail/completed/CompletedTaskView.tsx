import { useState } from 'react';
import type { ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { Tabs, tabIds } from '../../../Tabs';
import type { TabItem } from '../../../Tabs';
import { openTaskConversation } from '../open-task-conversation';
import { HoverTip } from '../../../HoverTip';
import { CompletedHeaderStrip } from './CompletedHeaderStrip';
import { SummaryTab } from './SummaryTab';
import { UsageTab } from './UsageTab';
import { useTaskReport } from './useTaskReport';
import type { Task } from '../../../../../shared/types';

type CompletedTab = 'summary' | 'usage' | 'description';

const TABS: ReadonlyArray<TabItem<CompletedTab>> = [
  { id: 'summary', label: 'Summary' },
  { id: 'usage', label: 'Usage' },
  { id: 'description', label: 'Description' },
];

const ID_PREFIX = 'completed-task';

/**
 * A completed task's window body: a strip of what the task took, then three
 * tabs. Summary reads what was done (the written summary, the route through the
 * board, its commits and files), Usage reads what it cost (each run, the models
 * and their tokens, the background calls), and Description is the task as it
 * was written. Everything but the description comes from one
 * `sessions.getTaskReport` read.
 */
export function CompletedTaskView({
  task,
  projectId,
  description,
}: {
  task: Task;
  /** The task's own project, which can differ from the open board's. */
  projectId: string;
  /** The description body, or null when the task has none. */
  description: ReactNode | null;
}) {
  const [selectedTab, setSelectedTab] = useState<CompletedTab>('summary');
  const { report, loading } = useTaskReport(projectId, task.id);
  const panelIds = tabIds(ID_PREFIX, selectedTab);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="completed-task-view">
      {report && <CompletedHeaderStrip task={task} report={report} />}
      <Tabs
        tabs={TABS}
        selectedId={selectedTab}
        onSelect={setSelectedTab}
        ariaLabel="Completed task"
        idPrefix={ID_PREFIX}
        testId="completed-task-tabs"
        trailing={(
          <HoverTip label="View the full conversation transcript">
            <button
              type="button"
              onClick={() => { void openTaskConversation(task.id, projectId); }}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-secondary hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              data-testid="completed-view-conversation"
            >
              <MessageSquare size={14} />
              View conversation
            </button>
          </HoverTip>
        )}
      />
      <div
        role="tabpanel"
        id={panelIds.panelId}
        aria-labelledby={panelIds.tabId}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
        data-testid={`completed-panel-${selectedTab}`}
      >
        {selectedTab === 'description' && (
          description
            ? <div className="space-y-3">{description}</div>
            : <div className="py-8 text-center text-sm text-fg-disabled">No description</div>
        )}
        {selectedTab !== 'description' && loading && <ReportSkeleton />}
        {selectedTab !== 'description' && !loading && !report && (
          <div className="py-8 text-center text-sm text-fg-disabled">Could not read this task&apos;s record</div>
        )}
        {selectedTab === 'summary' && report && <SummaryTab report={report} projectId={projectId} taskId={task.id} />}
        {selectedTab === 'usage' && report && <UsageTab report={report} />}
      </div>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="completed-report-loading">
      {[0, 1].map((index) => (
        <div key={index} className="h-24 animate-pulse rounded-[10px] border border-edge bg-surface-hover/30" />
      ))}
    </div>
  );
}
