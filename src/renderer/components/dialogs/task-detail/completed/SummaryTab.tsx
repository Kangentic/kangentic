import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Clock, Settings } from 'lucide-react';
import { MarkdownRenderer } from '../../../MarkdownRenderer';
import { Tooltip } from '../../../Tooltip';
import { openKnowledgeGraphSettings } from '../../../knowledge-graph/open-knowledge-graph-settings';
import { sourceRequirements } from '../../../settings/tabs/index-sources';
import { knowledgeGraphOn, knowledgeGraphSupported } from '../../../../lib/knowledge-graph-support';
import { useConfigStore } from '../../../../stores/config-store';
import { agentJobChoice, answerSetupGap } from '../../../../../shared/answer-agent';
import { formatSpan, formatSpanCompact } from '../../../../utils/format-session';
import { formatDateTime, formatMonthDayTime, formatTimeAgo } from '../../../../lib/datetime';
import { ColumnPill, LinkButton, OPENS_CONVERSATION_DETAIL, ReportCard } from './report-parts';
import { useTaskLastMessage } from './useTaskReport';
import type {
  ConversationTabRequest,
  TaskReport,
  TaskReportKnowledge,
  TaskReportRouteColumn,
  TaskReportSummaryState,
} from '../../../../../shared/types';

/** A visit shorter than this is a pass through the column, not a stay worth a card. */
const VISIT_CARD_MIN_MS = 60_000;
/** Changed files listed before "Show all". */
const FILES_SHOWN = 8;

const STAY_ROW_CLASS = 'flex h-[30px] w-full items-center whitespace-nowrap rounded-md border px-2.5 text-xs tabular-nums';

export function SummaryTab({ report, projectId, taskId, onOpenConversation }: {
  report: TaskReport;
  projectId: string;
  taskId: string;
  /** Opens the task's conversation on a part of it; null where the host cannot show the viewer. */
  onOpenConversation: ((target: ConversationTabRequest) => void) | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <TaskSummaryCard state={report.summaryState} projectId={projectId} taskId={taskId} />
      {report.route.length > 0 && <RouteCard route={report.route} onOpenConversation={onOpenConversation} />}
      {report.knowledge && report.knowledge.commits.length > 0 && <CommitsCard knowledge={report.knowledge} />}
      {report.knowledge && report.knowledge.changedFiles.length > 0 && <FilesChangedCard knowledge={report.knowledge} />}
    </div>
  );
}

const SUMMARY_STATE_COPY: Record<Exclude<TaskReportSummaryState['kind'], 'written'>, { text: string; settings: boolean }> = {
  pending: { text: 'Summary pending', settings: false },
  off: { text: 'Task summaries are off', settings: true },
  'indexing-off': { text: 'Knowledge Graph indexing is off', settings: true },
};

/**
 * What task summaries still wait for ("Needs an agent", "Needs a model"), or
 * undefined. Read from config through the rule the Index card's Task summaries
 * line reads, so a summary that cannot be written yet never reads as pending.
 */
function useSummaryRequirement(): string | undefined {
  const knowledgeGraphConfig = useConfigStore((state) => state.config.knowledgeGraph);
  const agentList = useConfigStore((state) => state.agentList);
  return useMemo(() => {
    const choice = agentJobChoice(knowledgeGraphConfig, 'summary');
    return sourceRequirements({
      knowledgeGraphSupported: knowledgeGraphSupported(),
      semanticEnabled: knowledgeGraphOn(knowledgeGraphConfig),
      answerCapableAgents: agentList.filter((agent) => agent.found && agent.supportsAnswerFromContext).length,
      agentSetup: answerSetupGap({ agents: agentList, configured: choice.agent, configuredModel: choice.model, requireFound: true }),
      agentChosen: Boolean(choice.agent),
    }).summaries;
  }, [knowledgeGraphConfig, agentList]);
}

/**
 * The written summary, or why there is none and the agent's last message in
 * its place. The last message is read only here, so a long transcript is
 * parsed only when the view shows it.
 */
function TaskSummaryCard({ state, projectId, taskId }: { state: TaskReportSummaryState; projectId: string; taskId: string }) {
  const written = state.kind === 'written';
  const { lastMessage, loading } = useTaskLastMessage(projectId, taskId, !written);
  const requirement = useSummaryRequirement();

  if (state.kind === 'written') {
    return (
      <ReportCard title="Task summary" testId="completed-task-summary">
        <p className="max-w-[900px] whitespace-pre-wrap text-sm leading-relaxed text-fg-secondary" data-testid="completed-task-summary-text">{state.text}</p>
      </ReportCard>
    );
  }

  // Main reports pending when summaries are switched on; whether they can be
  // written yet (an agent chosen, with its model) is the renderer's read of config.
  const copy = state.kind === 'pending' && requirement
    ? { text: requirement, settings: true }
    : SUMMARY_STATE_COPY[state.kind];
  return (
    <ReportCard title="Task summary" testId="completed-task-summary">
      <div className="flex items-center gap-3 text-sm text-fg-muted" data-testid={`completed-summary-state-${state.kind}`}>
        {state.kind === 'pending' && !requirement && <Clock size={14} className="flex-shrink-0 text-fg-faint" />}
        <span>{copy.text}</span>
        {copy.settings && (
          <button
            type="button"
            onClick={openKnowledgeGraphSettings}
            className="inline-flex items-center gap-1.5 rounded border border-edge px-2 py-0.5 text-xs text-fg-secondary hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            data-testid="completed-summary-open-settings"
          >
            <Settings size={12} />
            Open Settings
          </button>
        )}
      </div>
      {(loading || lastMessage) && (
        <div className="mt-3.5" data-testid="completed-last-message">
          <div className="mb-1.5 text-xs font-semibold text-fg-muted">Last message</div>
          {lastMessage ? <ClampedMarkdown text={lastMessage.text} /> : <div className="h-4 w-2/3 animate-pulse rounded bg-surface-hover" />}
        </div>
      )}
    </ReportCard>
  );
}

/** Markdown cut to a few lines, with "Show all" when there is more. */
function ClampedMarkdown({ text }: { text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Measured again whenever the clamped box changes size: the window narrows
  // or widens, or the markdown finishes laying out after the first paint.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || expanded) return;
    const measure = () => setOverflows(body.scrollHeight > body.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <>
      <div ref={bodyRef} className={`max-w-[900px] text-sm text-fg-secondary ${expanded ? '' : 'max-h-[7.5rem] overflow-hidden'}`}>
        <MarkdownRenderer content={text} />
      </div>
      {(overflows || expanded) && (
        <div className="mt-1.5">
          <LinkButton onClick={() => setExpanded((previous) => !previous)} testId="completed-last-message-toggle">
            {expanded ? 'Show less' : 'Show all'}
          </LinkButton>
        </div>
      )}
    </>
  );
}

/**
 * Each column the task worked in, in board order, sized to its share of the
 * time. A column it came back to with two or more real stays lists each one
 * under its pill, with the full date, since the stays can be days apart.
 *
 * Where the host can show the conversation viewer, a pill opens it on that
 * column's tab, and a stay row on that tab scrolled to the stay; a window
 * already open switches its tab.
 */
function RouteCard({ route, onOpenConversation }: {
  route: TaskReportRouteColumn[];
  onOpenConversation: ((target: ConversationTabRequest) => void) | null;
}) {
  return (
    <ReportCard title="Route" testId="completed-route">
      <div className="flex items-start gap-[3px] overflow-x-auto">
        {route.map((column) => {
          const stays = column.visits.filter((visit) => visit.durationMs >= VISIT_CARD_MIN_MS);
          return (
            <div key={column.swimlaneId} className="flex flex-col gap-[3px]" style={{ flex: `${Math.max(column.totalMs, 1)} 1 0` }}>
              <ColumnPill
                column={column}
                label={formatSpanCompact(column.totalMs)}
                tip={`${column.name}: ${formatSpan(column.totalMs)}`}
                onClick={onOpenConversation ? () => onOpenConversation({ swimlaneId: column.swimlaneId }) : undefined}
              />
              {stays.length >= 2 && stays.map((visit) => {
                const stayContent = (
                  <>
                    <span className="text-fg-muted">{formatMonthDayTime(visit.startedAt)}</span>
                    <span className="ml-auto pl-3.5 font-medium text-fg-secondary">{formatSpanCompact(visit.durationMs)}</span>
                  </>
                );
                return (
                  <Tooltip
                    key={visit.startedAt}
                    label={`${formatDateTime(visit.startedAt)}: ${formatSpan(visit.durationMs)}`}
                    detail={onOpenConversation ? OPENS_CONVERSATION_DETAIL : undefined}
                  >
                    {onOpenConversation ? (
                      <button
                        type="button"
                        onClick={() => onOpenConversation({ swimlaneId: column.swimlaneId, visitStartedAt: visit.startedAt })}
                        className={`${STAY_ROW_CLASS} cursor-pointer transition-colors hover:bg-surface-hover/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
                        style={{ borderColor: column.color }}
                        data-testid="route-visit"
                      >
                        {stayContent}
                      </button>
                    ) : (
                      <div className={STAY_ROW_CLASS} style={{ borderColor: column.color }} data-testid="route-visit">
                        {stayContent}
                      </div>
                    )}
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </div>
    </ReportCard>
  );
}

function CommitsCard({ knowledge }: { knowledge: TaskReportKnowledge }) {
  const aside = knowledge.commitCount > knowledge.commits.length ? `${knowledge.commits.length} of ${knowledge.commitCount}` : undefined;
  return (
    <ReportCard title="Commits" aside={aside} testId="completed-commits">
      {knowledge.commits.map((commit) => (
        <div key={commit.sha} className="flex min-w-0 items-center gap-2 py-[3px] text-[13px] text-fg-secondary">
          <span className="flex-shrink-0 font-mono text-xs text-accent-fg">{commit.sha.slice(0, 7)}</span>
          <Tooltip label={commit.subject}>
            <span className="min-w-0 truncate">{commit.subject}</span>
          </Tooltip>
          <Tooltip label={formatDateTime(commit.committedAt)}>
            <span className="ml-auto flex-shrink-0 pl-3 text-xs text-fg-faint">{formatTimeAgo(commit.committedAt)}</span>
          </Tooltip>
        </div>
      ))}
    </ReportCard>
  );
}

function FilesChangedCard({ knowledge }: { knowledge: TaskReportKnowledge }) {
  const [showAll, setShowAll] = useState(false);
  const files = showAll ? knowledge.changedFiles : knowledge.changedFiles.slice(0, FILES_SHOWN);
  const hidden = knowledge.changedFiles.length - FILES_SHOWN;
  return (
    <ReportCard
      title="Files changed"
      aside={knowledge.changedFileCount}
      action={hidden > 0 && (
        <LinkButton onClick={() => setShowAll((previous) => !previous)} testId="completed-files-toggle">
          {showAll ? 'Show less' : 'Show all'}
        </LinkButton>
      )}
      testId="completed-files-changed"
    >
      <div className="grid grid-cols-2 gap-x-8">
        {files.map((file) => (
          <Tooltip key={file} label={file}>
            <div className="min-w-0 truncate py-[3px] font-mono text-xs text-fg-secondary" data-testid="completed-changed-file">
              {file}
            </div>
          </Tooltip>
        ))}
      </div>
    </ReportCard>
  );
}
