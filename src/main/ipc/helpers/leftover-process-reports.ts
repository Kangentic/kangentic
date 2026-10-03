import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { LeftoverProcess, LeftoverProcessReport } from '../../../shared/types';
import type { LeftoverProcessEntry } from '../../pty/process-tag/tagged-reap';
import { sendToRenderer } from '../send-to-renderer';

/** A report goes out once no reap is running and none has added to it for this long. */
export const REPORT_QUIET_MS = 400;
/** ...or this long after its first addition, whichever comes first. */
export const REPORT_MAX_WAIT_MS = 8000;
/** How many reported processes the Stop button can still reach. The oldest go first. */
const RETAINED_PROCESS_IDS = 500;
const FALLBACK_TASK_TITLE = 'Task';

type ReportSender = (report: LeftoverProcessReport) => void;

/** What a Stop needs about a reported process: who it is, and whose task it was. */
export interface ReportedIdentity {
  pid: number;
  startKey: string;
  taskId: string;
  /** The project the reap ran for, so a Stop can retry that task's worktree removal. */
  projectPath: string | null;
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
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private reapsInFlight = 0;

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
      this.remember(id, { pid: entry.pid, startKey: entry.startKey, taskId: entry.taskId, projectPath });
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

  /** The identity of a reported process, or null for an id this never minted (or long since dropped). */
  resolve(processId: string): ReportedIdentity | null {
    return this.identities.get(processId) ?? null;
  }

  private flush(stoppingEnabled: boolean): void {
    const report = this.pending.get(stoppingEnabled);
    if (!report) return;
    this.pending.delete(stoppingEnabled);
    if (report.quietTimer) clearTimeout(report.quietTimer);
    clearTimeout(report.maxTimer);
    try {
      report.send({ id: randomUUID(), stoppingEnabled, processes: report.processes });
    } catch (error) {
      // A timer callback: a throw here would be an uncaught exception in main.
      console.warn('[TASK-REAP] Could not send the leftover-process report (non-fatal):', error);
    }
  }

  private remember(id: string, identity: ReportedIdentity): void {
    this.identities.set(id, identity);
    while (this.identities.size > RETAINED_PROCESS_IDS) {
      const oldest = this.identities.keys().next().value;
      if (oldest === undefined) break;
      this.identities.delete(oldest);
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
