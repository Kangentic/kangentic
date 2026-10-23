import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Tabs, tabIds } from '../../../Tabs';
import type { TabItem } from '../../../Tabs';
import { useSessionStore } from '../../../../stores/session-store';
import type { CompletedTab, CompletedViewRequest } from '../../../../stores/session-store/task-changes-panel-slice';
import { CompletedHeaderStrip } from './CompletedHeaderStrip';
import { CompletedChangesTab, completedChangesEntityId } from './CompletedChangesTab';
import { CompletedConversationTab } from './CompletedConversationTab';
import { SummaryTab } from './SummaryTab';
import { UsageTab } from './UsageTab';
import { useTaskChanges, useTaskReport } from './useTaskReport';
import type { ConversationTabRequest, Task } from '../../../../../shared/types';

const TABS: ReadonlyArray<TabItem<CompletedTab>> = [
  { id: 'summary', label: 'Summary' },
  { id: 'changes', label: 'Changes' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'usage', label: 'Usage' },
  { id: 'description', label: 'Description' },
];

const ID_PREFIX = 'completed-task';

/** Tabs that fill the view edge to edge with their own scrolling, rather than a padded page. */
const FULL_BLEED_TABS: ReadonlySet<CompletedTab> = new Set(['changes', 'conversation']);

/**
 * A completed task's window body: a strip of what the task took, then five
 * tabs. Summary reads what was done (the written summary, the route through the
 * board, its commits and files), Changes is the Changes panel over the task's
 * commits, Conversation is the conversation viewer's body, Usage reads what it
 * cost, and Description is the task as it was written.
 *
 * The report is one `sessions.getTaskReport` read; what the task changed is one
 * `git:taskChanges` read, shared by the strip, the Summary's commit and file
 * rows and the Changes tab.
 *
 * Opened on a tab from outside through the session store's one-shot
 * `completedViewRequest` (the archived card's Show changes and View
 * conversation); applied during render and cleared after, so it never fights
 * the user's own tab choice.
 */
export function CompletedTaskView({
  task,
  projectId,
  description,
  isFocused = false,
}: {
  task: Task;
  /** The task's own project, which can differ from the open board's. */
  projectId: string;
  /** The description body, or null when the task has none. */
  description: ReactNode | null;
  /** Whether this window is the focused one: gates the Changes and Conversation keyboard. */
  isFocused?: boolean;
}) {
  const request = useSessionStore((state) => (state.completedViewRequest?.taskId === task.id ? state.completedViewRequest : null));
  const clearCompletedViewRequest = useSessionStore((state) => state.clearCompletedViewRequest);
  const setChangesSelectedCommit = useSessionStore((state) => state.setChangesSelectedCommit);
  const setChangesSelectedFile = useSessionStore((state) => state.setChangesSelectedFile);

  const [selectedTab, setSelectedTab] = useState<CompletedTab>(request?.tab ?? 'summary');
  // Held in state and replaced per click, so the conversation body applies
  // each Route card pick (it compares the request by reference).
  const [conversationTabRequest, setConversationTabRequest] = useState<ConversationTabRequest | null>(request?.conversationTab ?? null);
  const [appliedRequest, setAppliedRequest] = useState<CompletedViewRequest | null>(request);
  if (request && request !== appliedRequest) {
    setAppliedRequest(request);
    setSelectedTab(request.tab);
    if (request.conversationTab) setConversationTabRequest({ ...request.conversationTab });
  }
  useEffect(() => {
    if (request) clearCompletedViewRequest(task.id);
  }, [request, clearCompletedViewRequest, task.id]);

  const { report, loading } = useTaskReport(projectId, task.id);
  const taskChanges = useTaskChanges(projectId, task.id);
  const panelIds = tabIds(ID_PREFIX, selectedTab);

  const entityId = completedChangesEntityId(task.id);
  const openCommitInChanges = useCallback((commitSha: string) => {
    setChangesSelectedCommit(entityId, commitSha);
    setSelectedTab('changes');
  }, [entityId, setChangesSelectedCommit]);
  // A file opens on the task's whole change when it has one, else in the
  // newest commit that touched it.
  const openFileInChanges = useCallback((filePath: string, newestCommitSha: string | null) => {
    setChangesSelectedCommit(entityId, newestCommitSha);
    setChangesSelectedFile(entityId, filePath);
    setSelectedTab('changes');
  }, [entityId, setChangesSelectedCommit, setChangesSelectedFile]);
  const openConversation = useCallback((target: ConversationTabRequest) => {
    setConversationTabRequest({ ...target });
    setSelectedTab('conversation');
  }, []);

  const fullBleed = FULL_BLEED_TABS.has(selectedTab);
  const gitTotals = taskChanges.changes?.range ? taskChanges.changes.totals : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="completed-task-view">
      {report && <CompletedHeaderStrip task={task} report={report} gitTotals={gitTotals} />}
      <Tabs
        tabs={TABS}
        selectedId={selectedTab}
        onSelect={setSelectedTab}
        ariaLabel="Completed task"
        idPrefix={ID_PREFIX}
        testId="completed-task-tabs"
      />
      <div
        role="tabpanel"
        id={panelIds.panelId}
        aria-labelledby={panelIds.tabId}
        className={fullBleed ? 'flex min-h-0 flex-1 flex-col' : 'min-h-0 flex-1 overflow-y-auto px-6 py-5'}
        data-testid={`completed-panel-${selectedTab}`}
      >
        {selectedTab === 'description' && (
          description
            ? <div className="space-y-3">{description}</div>
            : <div className="py-8 text-center text-sm text-fg-disabled">No description</div>
        )}
        {selectedTab === 'changes' && (
          <CompletedChangesTab
            task={task}
            projectId={projectId}
            isFocused={isFocused}
            changes={taskChanges.changes}
            loading={taskChanges.loading}
            error={taskChanges.error}
            onRetry={taskChanges.retry}
          />
        )}
        {selectedTab === 'conversation' && (
          <CompletedConversationTab
            taskId={task.id}
            projectId={projectId}
            isFocused={isFocused}
            tabRequest={conversationTabRequest}
          />
        )}
        {(selectedTab === 'summary' || selectedTab === 'usage') && loading && <ReportSkeleton />}
        {(selectedTab === 'summary' || selectedTab === 'usage') && !loading && !report && (
          <div className="py-8 text-center text-sm text-fg-disabled">Could not read this task&apos;s record</div>
        )}
        {selectedTab === 'summary' && report && (
          <SummaryTab
            report={report}
            projectId={projectId}
            taskId={task.id}
            taskChanges={taskChanges.changes}
            taskChangesLoading={taskChanges.loading}
            onOpenConversation={openConversation}
            onOpenCommit={openCommitInChanges}
            onOpenFile={openFileInChanges}
          />
        )}
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
