import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Clock, Settings } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../../i18n/translate';
import type { LocalizedText } from '../../../../../shared/i18n/text';
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
import { FILE_STATUS_CONFIG } from '../changes/file-status';
import type {
  ConversationTabRequest,
  GitTaskChangesFile,
  GitTaskChangesResult,
  TaskReport,
  TaskReportKnowledge,
  TaskReportRouteColumn,
  TaskReportSummaryState,
} from '../../../../../shared/types';

/** A visit shorter than this is a pass through the column, not a stay worth a card. */
const VISIT_CARD_MIN_MS = 60_000;
/** The Files card's box holds about this many rows, then scrolls. */
const FILES_BOX_ROWS = 8;
/** One file row's height (px), for the box's height. */
const FILE_ROW_PX = 24;

const STAY_ROW_CLASS = 'flex h-[30px] w-full items-center whitespace-nowrap rounded-md border px-2.5 text-xs tabular-nums';

export function SummaryTab({ report, projectId, taskId, taskChanges, taskChangesLoading, onOpenConversation, onOpenCommit, onOpenFile }: {
  report: TaskReport;
  projectId: string;
  taskId: string;
  /** What the task changed, from git; null while it is read, or when it could not be. */
  taskChanges: GitTaskChangesResult | null;
  taskChangesLoading: boolean;
  /** Opens the task's Conversation tab on a part of it. */
  onOpenConversation: (target: ConversationTabRequest) => void;
  /** Opens the Changes tab on one commit. */
  onOpenCommit: (commitSha: string) => void;
  /** Opens the Changes tab on one file: the whole change, or with no range its newest commit. */
  onOpenFile: (filePath: string, newestCommitSha: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <TaskSummaryCard state={report.summaryState} projectId={projectId} taskId={taskId} />
      {report.route.length > 0 && <RouteCard route={report.route} onOpenConversation={onOpenConversation} />}
      {report.knowledge && report.knowledge.commits.length > 0 && (
        <CommitsCard knowledge={report.knowledge} taskChanges={taskChanges} onOpenCommit={onOpenCommit} />
      )}
      <FilesChangedCard
        knowledge={report.knowledge}
        taskChanges={taskChanges}
        loading={taskChangesLoading}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

const SUMMARY_STATE_COPY: Record<Exclude<TaskReportSummaryState['kind'], 'written'>, { text: LocalizedText; settings: boolean }> = {
  pending: { text: msg`Summary pending`, settings: false },
  off: { text: msg`Task summaries are off`, settings: true },
  'indexing-off': { text: msg`Knowledge Graph indexing is off`, settings: true },
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
  const { t } = useLingui();
  const written = state.kind === 'written';
  const { lastMessage, loading } = useTaskLastMessage(projectId, taskId, !written);
  const requirement = useSummaryRequirement();

  if (state.kind === 'written') {
    return (
      <ReportCard title={t`Task summary`} testId="completed-task-summary">
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
    <ReportCard title={t`Task summary`} testId="completed-task-summary">
      <div className="flex items-center gap-3 text-sm text-fg-muted" data-testid={`completed-summary-state-${state.kind}`}>
        {state.kind === 'pending' && !requirement && <Clock size={14} className="flex-shrink-0 text-fg-faint" />}
        <span>{translateText(copy.text)}</span>
        {copy.settings && (
          <button
            type="button"
            onClick={openKnowledgeGraphSettings}
            className="inline-flex items-center gap-1.5 rounded border border-edge px-2 py-0.5 text-xs text-fg-secondary hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            data-testid="completed-summary-open-settings"
          >
            <Settings size={12} />
            <Trans>Open Settings</Trans>
          </button>
        )}
      </div>
      {(loading || lastMessage) && (
        <div className="mt-3.5" data-testid="completed-last-message">
          <div className="mb-1.5 text-xs font-semibold text-fg-muted"><Trans>Last message</Trans></div>
          {lastMessage ? <ClampedMarkdown text={lastMessage.text} /> : <div className="h-4 w-2/3 animate-pulse rounded bg-surface-hover" />}
        </div>
      )}
    </ReportCard>
  );
}

/** Markdown cut to a few lines, with "Show all" when there is more. */
function ClampedMarkdown({ text }: { text: string }) {
  const { t } = useLingui();
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
            {expanded ? t`Show less` : t`Show all`}
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
 * A pill opens the Conversation tab on that column's tab, and a stay row on
 * that tab scrolled to the stay.
 */
function RouteCard({ route, onOpenConversation }: {
  route: TaskReportRouteColumn[];
  onOpenConversation: (target: ConversationTabRequest) => void;
}) {
  const { t } = useLingui();
  return (
    <ReportCard title={t({ message: 'Route', context: 'completed task card' })} testId="completed-route">
      <div className="flex items-start gap-[3px] overflow-x-auto">
        {route.map((column) => {
          const stays = column.visits.filter((visit) => visit.durationMs >= VISIT_CARD_MIN_MS);
          return (
            <div key={column.swimlaneId} className="flex flex-col gap-[3px]" style={{ flex: `${Math.max(column.totalMs, 1)} 1 0` }}>
              <ColumnPill
                column={column}
                label={formatSpanCompact(column.totalMs)}
                tip={`${column.name}: ${formatSpan(column.totalMs)}`}
                onClick={() => onOpenConversation({ swimlaneId: column.swimlaneId })}
              />
              {stays.length >= 2 && stays.map((visit) => (
                <Tooltip
                  key={visit.startedAt}
                  label={`${formatDateTime(visit.startedAt)}: ${formatSpan(visit.durationMs)}`}
                  detail={translateText(OPENS_CONVERSATION_DETAIL)}
                >
                  <button
                    type="button"
                    onClick={() => onOpenConversation({ swimlaneId: column.swimlaneId, visitStartedAt: visit.startedAt })}
                    className={`${STAY_ROW_CLASS} cursor-pointer transition-colors hover:bg-surface-hover/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
                    style={{ borderColor: column.color }}
                    data-testid="route-visit"
                  >
                    <span className="text-fg-muted">{formatMonthDayTime(visit.startedAt)}</span>
                    <span className="ml-auto pl-3.5 font-medium text-fg-secondary">{formatSpanCompact(visit.durationMs)}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          );
        })}
      </div>
    </ReportCard>
  );
}

/**
 * The task's linked commits. A row whose commit is in the clone opens the
 * Changes tab on it; one the clone lacks (or before git answers) stays text.
 */
function CommitsCard({ knowledge, taskChanges, onOpenCommit }: {
  knowledge: TaskReportKnowledge;
  taskChanges: GitTaskChangesResult | null;
  onOpenCommit: (commitSha: string) => void;
}) {
  const { t } = useLingui();
  const shownCount = knowledge.commits.length;
  const totalCount = knowledge.commitCount;
  const aside = totalCount > shownCount ? t`${shownCount} of ${totalCount}` : undefined;
  const openable = new Set((taskChanges?.commits ?? []).map((commit) => commit.hash));
  return (
    <ReportCard title={t`Commits`} aside={aside} testId="completed-commits">
      {knowledge.commits.map((commit) => {
        const shortSha = commit.sha.slice(0, 7);
        const content = (
          <>
            <span className="flex-shrink-0 font-mono text-xs text-accent-fg">{shortSha}</span>
            <span className="min-w-0 truncate">{commit.subject}</span>
            <span className="ml-auto flex-shrink-0 pl-3 text-xs text-fg-faint">{formatTimeAgo(commit.committedAt)}</span>
          </>
        );
        if (!openable.has(commit.sha)) {
          return (
            <Tooltip key={commit.sha} label={commit.subject} detail={formatDateTime(commit.committedAt)}>
              <div className="flex min-w-0 items-center gap-2 py-[3px] text-[13px] text-fg-secondary" data-testid="completed-commit-row">
                {content}
              </div>
            </Tooltip>
          );
        }
        // The same tip as a row that cannot open: the subject the row cuts short
        // and the exact time. A click on a commit row opening it needs no words.
        return (
          <Tooltip key={commit.sha} label={commit.subject} detail={formatDateTime(commit.committedAt)}>
            <button
              type="button"
              onClick={() => onOpenCommit(commit.sha)}
              className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-[13px] text-fg-secondary transition-colors hover:bg-surface-hover/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              data-testid="completed-commit-row"
            >
              {content}
            </button>
          </Tooltip>
        );
      })}
    </ReportCard>
  );
}

/**
 * The files the task changed, read from git: each with its status and lines,
 * biggest change first, two columns in a box about eight rows tall that
 * scrolls. A row opens the Changes tab on that file. Only when git has no
 * files to give (the commits are not in this clone, or the read failed) does
 * it fall back to the index's list of files the agent's tools wrote, as text.
 * With neither there is no card, so while git is read it holds its place only
 * when the index already names files, and a task that changed nothing never
 * flashes an empty card.
 */
function FilesChangedCard({ knowledge, taskChanges, loading, onOpenFile }: {
  knowledge: TaskReportKnowledge | null;
  taskChanges: GitTaskChangesResult | null;
  loading: boolean;
  onOpenFile: (filePath: string, newestCommitSha: string | null) => void;
}) {
  const { t } = useLingui();
  const gitFiles = taskChanges?.files ?? [];
  const indexFiles = knowledge?.changedFiles ?? [];
  const boxStyle = { maxHeight: FILES_BOX_ROWS * FILE_ROW_PX };

  if (gitFiles.length === 0 && indexFiles.length === 0) return null;

  if (loading) {
    return (
      <ReportCard title={t`Files changed`} testId="completed-files-changed">
        <div className="grid grid-cols-2 gap-x-8 gap-y-2" data-testid="completed-files-loading">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-4 animate-pulse rounded bg-surface-hover" />
          ))}
        </div>
      </ReportCard>
    );
  }

  if (gitFiles.length === 0) {
    return (
      <ReportCard title={t`Files changed`} aside={knowledge?.changedFileCount} testId="completed-files-changed">
        <div className="grid grid-cols-2 gap-x-8 overflow-y-auto" style={boxStyle}>
          {indexFiles.map((file) => (
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

  const hasRange = Boolean(taskChanges?.range);
  return (
    <ReportCard title={t`Files changed`} aside={gitFiles.length} testId="completed-files-changed">
      {/* The box, not each row, takes the negative margin: rows pad their hover
          back in, so their text lines up with the title, and nothing reaches
          past the scrolling box to raise a sideways scrollbar. */}
      <div className="-mx-1.5 grid grid-cols-2 gap-x-5 overflow-y-auto overflow-x-hidden" style={boxStyle} data-testid="completed-files-box">
        {gitFiles.map((file) => (
          <FileRow key={file.path} file={file} onOpen={() => onOpenFile(file.path, hasRange ? null : (file.newestCommitSha ?? null))} />
        ))}
      </div>
    </ReportCard>
  );
}

function FileRow({ file, onOpen }: { file: GitTaskChangesFile; onOpen: () => void }) {
  const { t } = useLingui();
  const status = FILE_STATUS_CONFIG[file.status];
  const StatusIcon = status.icon;
  const oldPath = file.oldPath;
  const newPath = file.path;
  // The whole path the row cuts short, and a rename's old path, which shows
  // nowhere else.
  return (
    <Tooltip label={oldPath ? t`${oldPath} to ${newPath}` : file.path}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-surface-hover/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        style={{ height: FILE_ROW_PX }}
        data-testid="completed-changed-file"
      >
        <StatusIcon size={12} className={`flex-shrink-0 ${status.colorClass}`} aria-label={translateText(status.label)} />
        <span className="min-w-0 truncate font-mono text-xs text-fg-secondary">{file.path}</span>
        <span className="ml-auto flex flex-shrink-0 gap-1 pl-3 text-[11px] tabular-nums">
          {file.binary ? (
            <span className="text-fg-faint">{t`binary`}</span>
          ) : (
            <>
              <span className="text-green-400">+{file.insertions}</span>
              <span className="text-red-400">-{file.deletions}</span>
            </>
          )}
        </span>
      </button>
    </Tooltip>
  );
}
