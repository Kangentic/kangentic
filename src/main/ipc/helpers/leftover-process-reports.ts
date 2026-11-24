import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { LeftoverProcess, LeftoverProcessReport } from '../../../shared/types';
import type { LeftoverProcessEntry } from '../../pty/process-tag/tagged-reap';
import { sendToRenderer } from '../send-to-renderer';
import { isLeftInWorktree } from './reap-verdict';

/** A report goes out once no reap is running and none has added to it for this long. */
export const REPORT_QUIET_MS = 400;
/** ...or this long after its first addition, whichever comes first. */
export const REPORT_MAX_WAIT_MS = 8000;
/** How many reported processes the Stop button can still reach, and how many unreported ones are remembered. The oldest go first. */
export const RETAINED_PROCESS_IDS = 500;
const FALLBACK_TASK_TITLE = 'Task';

type ReportSender = (report: LeftoverProcessReport) => void;

/** What a Stop needs about a reported process: who it is, whose task it was, and what the reap did with it. */
export interface ReportedIdentity {
  pid: number;
  startKey: string;
  taskId: string;
  /** The project the reap ran for, so a Stop can retry that task's worktree removal. */
  projectPath: string | null;
  /** Whether it worked in the task's worktree, where it holds the folder on Windows (`leftInWorktree`). */
  place: LeftoverProcessEntry['place'];
  /** What the reap did with it. A later Stop does not change this: ask by identity whether it still runs. */
  outcome: LeftoverProcessEntry['outcome'];
}

interface PendingReport {
  processes: LeftoverProcess[];
  send: ReportSender;
  quietTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout>;
}

export interface LeftoverProcessReportsOptions {
  quietMs?: number;
  maxWaitMs?: number;
}

function identityOf(entry: LeftoverProcessEntry, projectPath: string | null): ReportedIdentity {
  return { pid: entry.pid, startKey: entry.startKey, taskId: entry.taskId, projectPath, place: entry.place, outcome: entry.outcome };
}

/** One process, however many reaps named it. */
function processKeyOf(identity: Pick<ReportedIdentity, 'pid' | 'startKey'>): string {
  return `${identity.pid}:${identity.startKey}`;
}

/** Keep `identity` under `key`, dropping the oldest past `RETAINED_PROCESS_IDS`. */
function retainNewest(identities: Map<string, ReportedIdentity>, key: string, identity: ReportedIdentity): void {
  identities.set(key, identity);
  while (identities.size > RETAINED_PROCESS_IDS) {
    const oldest = identities.keys().next().value;
    if (oldest === undefined) break;
    identities.delete(oldest);
  }
}

/**
 * Turns reap results into the reports the renderer toasts, one per burst: a
 * bulk delete or a project delete reaps task by task, and the user gets one
 * toast for all of it rather than one per task. A burst ends once no reap is
 * running (`beginReap`) and `REPORT_QUIET_MS` has passed with no new result, or
 * `REPORT_MAX_WAIT_MS` after it began. Quiet alone is not enough: the pty host
 * runs a request that arrives during a reap in the NEXT batch, after the first
 * one's one-second grace, so two tasks reset together came back a second apart
 * and made two toasts (measured in a preview).
 *
 * It also holds the identity of every process it reported, under an id minted
 * here, so the list's Stop button names a reported process and never a raw pid.
 * A pid the renderer makes up resolves to nothing.
 */
export class LeftoverProcessReports {
  private readonly pending = new Map<boolean, PendingReport>();
  private readonly identities = new Map<string, ReportedIdentity>();
  /** What a startup sweep left, apart from `identities` so it never takes a slot a Stop button needs. */
  private readonly unreportedLeft = new Map<string, ReportedIdentity>();
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private reapsInFlight = 0;
  private reportListener: ((report: LeftoverProcessReport) => void) | null = null;

  constructor(options: LeftoverProcessReportsOptions = {}) {
    this.quietMs = options.quietMs ?? REPORT_QUIET_MS;
    this.maxWaitMs = options.maxWaitMs ?? REPORT_MAX_WAIT_MS;
  }

  /**
   * Mark a reap as running, so a burst does not end under it. Returns the
   * release, which is idempotent; call it after the reap's result was added.
   */
  beginReap(): () => void {
    this.reapsInFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reapsInFlight -= 1;
      if (this.reapsInFlight === 0) {
        for (const stoppingEnabled of [...this.pending.keys()]) this.armQuietTimer(stoppingEnabled);
      }
    };
  }

  /** Queue one reap's result. Nothing is sent for a reap that reported nothing. */
  add(
    send: ReportSender,
    entries: readonly LeftoverProcessEntry[],
    taskTitles: ReadonlyMap<string, string>,
    stoppingEnabled: boolean,
    projectPath: string | null = null,
  ): void {
    if (entries.length === 0) return;
    const processes = entries.map((entry): LeftoverProcess => {
      const id = randomUUID();
      retainNewest(this.identities, id, identityOf(entry, projectPath));
      return {
        id,
        taskId: entry.taskId,
        taskTitle: taskTitles.get(entry.taskId) ?? FALLBACK_TASK_TITLE,
        pid: entry.pid,
        label: entry.label,
        outcome: entry.outcome,
        reason: entry.reason,
        place: entry.place,
      };
    });
    let report = this.pending.get(stoppingEnabled);
    if (!report) {
      const maxTimer = setTimeout(() => this.flush(stoppingEnabled), this.maxWaitMs);
      maxTimer.unref?.();
      report = { processes: [], send, quietTimer: null, maxTimer };
      this.pending.set(stoppingEnabled, report);
    }
    report.processes.push(...processes);
    report.send = send;
    this.armQuietTimer(stoppingEnabled);
  }

  /**
   * Remember what a reap left in a worktree without reporting it: what a startup
   * sweep kept, which the user was told of when its task ended. It gets no id, so
   * no Stop can name it; only `leftInWorktree` reads it.
   */
  rememberLeft(entries: readonly LeftoverProcessEntry[], projectPath: string): void {
    for (const entry of entries) {
      if (!isLeftInWorktree(entry)) continue;
      retainNewest(this.unreportedLeft, processKeyOf(entry), identityOf(entry, projectPath));
    }
  }

  /** (Re)start a report's quiet window. It sends only if no reap is running when it ends; the last release re-arms it. */
  private armQuietTimer(stoppingEnabled: boolean): void {
    const report = this.pending.get(stoppingEnabled);
    if (!report) return;
    if (report.quietTimer) clearTimeout(report.quietTimer);
    report.quietTimer = setTimeout(() => {
      if (this.reapsInFlight === 0) this.flush(stoppingEnabled);
    }, this.quietMs);
    report.quietTimer.unref?.();
  }

  /** Hear every report as it goes out (the analytics count). Replaces any earlier listener. */
  setReportListener(listener: ((report: LeftoverProcessReport) => void) | null): void {
    this.reportListener = listener;
  }

  /** The identity of a reported process, or null for an id this never minted (or long since dropped). */
  resolve(processId: string): ReportedIdentity | null {
    return this.identities.get(processId) ?? null;
  }

  /**
   * Every process reported, or remembered (`rememberLeft`), as left working inside
   * this task's worktree, once each: two reports can name one process. It may have
   * ended since, which only `checkReportedProcesses` can say. Empty for a task
   * nothing was reported or remembered of.
   */
  leftInWorktree(projectPath: string, taskId: string): Array<Pick<ReportedIdentity, 'pid' | 'startKey'>> {
    const left = new Map<string, Pick<ReportedIdentity, 'pid' | 'startKey'>>();
    for (const identity of [...this.identities.values(), ...this.unreportedLeft.values()]) {
      if (identity.taskId !== taskId || identity.projectPath !== projectPath || !isLeftInWorktree(identity)) continue;
      left.set(processKeyOf(identity), { pid: identity.pid, startKey: identity.startKey });
    }
    return [...left.values()];
  }

  private flush(stoppingEnabled: boolean): void {
    const report = this.pending.get(stoppingEnabled);
    if (!report) return;
    this.pending.delete(stoppingEnabled);
    if (report.quietTimer) clearTimeout(report.quietTimer);
    clearTimeout(report.maxTimer);
    const outgoing: LeftoverProcessReport = { id: randomUUID(), stoppingEnabled, processes: report.processes, reportedAt: new Date().toISOString() };
    try {
      report.send(outgoing);
    } catch (error) {
      // A timer callback: a throw here would be an uncaught exception in main.
      console.warn('[TASK-REAP] Could not send the leftover-process report (non-fatal):', error);
    }
    try {
      this.reportListener?.(outgoing);
    } catch {
      // A listener is telemetry; it never breaks the report.
    }
  }
}

/** The app's one collector: the reap paths add to it and the Stop handler resolves through it. */
export const leftoverProcessReports = new LeftoverProcessReports();

/** Queue a reap's result for the main window's toast. */
export function publishLeftoverProcesses(
  mainWindow: BrowserWindow,
  entries: readonly LeftoverProcessEntry[],
  taskTitles: ReadonlyMap<string, string>,
  stoppingEnabled: boolean,
  projectPath: string | null,
): void {
  leftoverProcessReports.add(
    (report) => sendToRenderer(mainWindow, IPC.LEFTOVER_PROCESSES_REPORT, report),
    entries,
    taskTitles,
    stoppingEnabled,
    projectPath,
  );
}
