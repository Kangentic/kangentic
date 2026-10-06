import { Check, Cpu, LoaderCircle, Square } from 'lucide-react';
import type { LeftoverProcess, LeftoverProcessReport } from '../../../shared/types';
import { BaseDialog } from './BaseDialog';
import { CountBadge } from '../CountBadge';
import { useLeftoverProcessesStore } from '../../stores/leftover-processes-store';
import { useConfigStore } from '../../stores/config-store';
import { useNow } from '../../hooks/useNow';
import { formatDateTime } from '../../lib/datetime';
import {
  groupByTask,
  reportAgeOf,
  reportTitleOf,
  rowDetailOf,
  rowStateOf,
  sectionsOf,
  splitProcessLabel,
  type LeftoverRowState,
} from '../../lib/leftover-processes';

/**
 * The list a leftover-process toast's Review link opens: what a task left
 * running when it ended, Still running first (the rows a user can act on),
 * then Stopped. Each row keeps one button slot in one place: Stop, Stopping,
 * Stopped, Ended, or Stop again after a failure, and a row never moves between
 * sections while the list is open.
 */
export function LeftoverProcessesDialog() {
  const report = useLeftoverProcessesStore((state) => (state.openReportId ? state.reports[state.openReportId] ?? null : null));
  const closeReport = useLeftoverProcessesStore((state) => state.closeReport);
  if (!report) return null;
  return <LeftoverProcessesDialogBody report={report} onClose={closeReport} />;
}

function openBehaviorSettings(onClose: () => void): void {
  onClose();
  const store = useConfigStore.getState();
  store.setLastSettingsTab('behavior');
  store.setSettingsOpen(true);
}

/** How often the header's age re-reads the clock; it shows whole minutes. */
const AGE_TICK_MS = 30_000;

function LeftoverProcessesDialogBody({ report, onClose }: { report: LeftoverProcessReport; onClose: () => void }) {
  const { stillRunning, stopped } = sectionsOf(report);
  const spansTasks = new Set(report.processes.map((entry) => entry.taskId)).size > 1;
  const now = useNow(AGE_TICK_MS);
  const age = reportAgeOf(report, now);
  return (
    <BaseDialog
      onClose={onClose}
      title={reportTitleOf(report)}
      subtitle={age ? <span title={formatDateTime(report.reportedAt)} data-testid="leftover-processes-age">{age}</span> : undefined}
      icon={<Cpu size={16} className="text-accent-fg" />}
      className="w-[560px] max-w-[calc(100vw-2rem)]"
      bodyClassName="max-h-[60vh] overflow-y-auto"
      testId="leftover-processes-dialog"
      trapFocus
      footer={
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            data-testid="leftover-processes-close"
            className="px-6 py-1.5 min-w-[96px] text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
          >
            Close
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {!report.stoppingEnabled && (
          <p className="text-sm text-fg-muted" data-testid="leftover-processes-stopping-off">
            Stopping leftover processes is off, so these kept running.{' '}
            <button
              type="button"
              onClick={() => openBehaviorSettings(onClose)}
              className="text-accent-fg underline underline-offset-2 hover:opacity-80"
            >
              Change in Settings
            </button>
          </p>
        )}
        <LeftoverSection label="Still running" processes={stillRunning} spansTasks={spansTasks} testId="leftover-processes-running" />
        <LeftoverSection label="Stopped" processes={stopped} spansTasks={spansTasks} testId="leftover-processes-stopped" />
      </div>
    </BaseDialog>
  );
}

function LeftoverSection({
  label, processes, spansTasks, testId,
}: { label: string; processes: LeftoverProcess[]; spansTasks: boolean; testId: string }) {
  if (processes.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId} aria-label={label}>
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-xs font-medium text-fg-muted">{label}</span>
        <CountBadge count={processes.length} variant="accent" size="sm" />
      </div>
      {spansTasks
        ? groupByTask(processes).map((group) => (
          <div key={group.taskId} className="flex flex-col gap-1.5">
            <div className="text-xs font-medium text-fg-secondary mt-1">{group.taskTitle}</div>
            {group.processes.map((entry) => <LeftoverRow key={entry.id} entry={entry} />)}
          </div>
        ))
        : processes.map((entry) => <LeftoverRow key={entry.id} entry={entry} />)}
    </section>
  );
}

function LeftoverRow({ entry }: { entry: LeftoverProcess }) {
  const stopState = useLeftoverProcessesStore((state) => state.stopStates[entry.id]);
  const stopProcess = useLeftoverProcessesStore((state) => state.stopProcess);
  const state = rowStateOf(entry, stopState);
  const detail = rowDetailOf(entry, state);
  const { program, script } = splitProcessLabel(entry.label);
  return (
    <div
      className="flex items-center gap-3 rounded-md bg-surface-hover/40 px-3 py-2"
      data-testid="leftover-process-row"
      data-state={state}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-fg">
          {program}
          {script ? <span className="text-fg-muted"> ({script})</span> : null}
        </div>
        <div className={`truncate text-xs ${detail.failure ? 'text-red-400' : 'text-fg-tertiary'}`}>{detail.text}</div>
      </div>
      <span className="w-[76px] flex-shrink-0 text-right font-mono text-[11px] text-fg-faint tabular-nums select-text">
        PID {entry.pid}
      </span>
      <RowAction state={state} label={entry.label} onStop={() => { void stopProcess(entry.id); }} />
    </div>
  );
}

const ACTION_BASE_CLASS = 'flex h-7 w-[92px] flex-shrink-0 items-center justify-center gap-1.5 rounded border text-xs transition-colors';

function RowAction({ state, label, onStop }: { state: LeftoverRowState; label: string; onStop: () => void }) {
  if (state === 'running' || state === 'failed') {
    return (
      <button
        type="button"
        onClick={onStop}
        aria-label={`Stop ${label}`}
        data-testid="leftover-process-stop"
        className={`${ACTION_BASE_CLASS} border-red-500/40 text-red-400 hover:bg-red-500/10`}
      >
        <Square size={12} strokeWidth={2.5} aria-hidden="true" />
        Stop
      </button>
    );
  }
  const content = state === 'stopping'
    ? <><LoaderCircle size={12} strokeWidth={2.5} className="animate-spin" aria-hidden="true" />Stopping</>
    : state === 'stopped'
      ? <><Check size={12} strokeWidth={2.5} aria-hidden="true" />Stopped</>
      : <>Ended</>;
  return (
    <button
      type="button"
      disabled
      data-testid="leftover-process-stop"
      className={`${ACTION_BASE_CLASS} border-edge ${state === 'stopping' ? 'text-fg-muted' : 'text-fg-faint'}`}
    >
      {content}
    </button>
  );
}
