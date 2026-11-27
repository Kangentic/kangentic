/**
 * Main's half of the low-memory census (Sentry DESKTOP-5C, 5D, 5E, 5F, 5P).
 *
 * At the start of each low-memory spell on Windows (`onSpellStart` in
 * `host-memory.ts`), main asks the pty host for one read-only census of who
 * holds the commit charge (`process-tag/memory-census.ts`). The host answers
 * sums per group and one sum per task tag. Main classifies each tag against
 * the open projects, the way the startup sweep does (`runTerminalTaskSweep`):
 * an archived task, or one in a To Do or Done column, is terminal; any other
 * column is mid-board; a tag no open project knows is unknown (a Command
 * Terminal's and a workflow agent's own ids land there too). The tags are
 * then dropped, and only buckets leave: one event per spell
 * (`reportHostMemoryCensus`) and the `host_memory_census` scope context, so
 * the next crash carries it too. Never a pid, a name or a task id.
 *
 * Reached through a requester `register-all.ts` sets over the pty host
 * transport (`requestHostMemoryCensus`), not through the session manager.
 */

import type { CensusSum, HostMemoryCensusRequest, HostMemoryCensusResult } from '../pty/process-tag/memory-census';
import { getOpenProjectDb, openProjectDbIds } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { createChokepointReporter } from '../analytics/handled-report';

export type HostMemoryCensusRequester = (request: HostMemoryCensusRequest, timeoutMs: number) => Promise<HostMemoryCensusResult>;

let requester: HostMemoryCensusRequester | null = null;

/** Set once the pty host transport exists; null puts it back. */
export function setHostMemoryCensusRequester(next: HostMemoryCensusRequester | null): void {
  requester = next;
}

/** A census scans every same-user process, about 30 ms for 460 of them; this bounds a host that is held. */
export const HOST_MEMORY_CENSUS_TIMEOUT_MS = 20_000;

export type CensusTaskStanding = 'mid_board' | 'terminal' | 'unknown';

/** Where a tagged task stands across the open projects. */
export function classifyTaskAcrossOpenProjects(taskId: string): CensusTaskStanding {
  for (const projectId of openProjectDbIds()) {
    const database = getOpenProjectDb(projectId);
    if (!database) continue;
    const task = new TaskRepository(database).getById(taskId);
    if (!task) continue;
    if (task.archived_at) return 'terminal';
    const role = new SwimlaneRepository(database).getById(task.swimlane_id)?.role ?? null;
    return role === 'todo' || role === 'done' ? 'terminal' : 'mid_board';
  }
  return 'unknown';
}

export const CENSUS_GB_BUCKETS = ['0', '<0.5', '0.5-1', '1-2', '2-4', '4-8', '8-16', '16-32', '32+'] as const;
export const CENSUS_COUNT_BUCKETS = ['0', '1-4', '5-19', '20-99', '100+'] as const;

const BYTES_PER_GB = 1024 * 1024 * 1024;

export function bucketCensusBytes(bytes: number): (typeof CENSUS_GB_BUCKETS)[number] {
  if (bytes <= 0) return '0';
  const gigabytes = bytes / BYTES_PER_GB;
  if (gigabytes < 0.5) return '<0.5';
  if (gigabytes < 1) return '0.5-1';
  if (gigabytes < 2) return '1-2';
  if (gigabytes < 4) return '2-4';
  if (gigabytes < 8) return '4-8';
  if (gigabytes < 16) return '8-16';
  if (gigabytes < 32) return '16-32';
  return '32+';
}

export function bucketCensusCount(count: number): (typeof CENSUS_COUNT_BUCKETS)[number] {
  if (count <= 0) return '0';
  if (count < 5) return '1-4';
  if (count < 20) return '5-19';
  if (count < 100) return '20-99';
  return '100+';
}

/**
 * The census groups, in the order a report lists them. `mid_board_beside_session`
 * is a tagged process of a task whose session is live but which runs outside
 * that session's PTY tree: a second copy a resumed agent started beside the
 * first, or something the agent detached.
 */
export const CENSUS_GROUPS = [
  'kangentic',
  'live_pty',
  'mid_board_beside_session',
  'mid_board_no_session',
  'terminal_task',
  'unknown_tag',
  'other_same_user',
] as const;

export type CensusGroup = (typeof CENSUS_GROUPS)[number];

/** What a census event carries: buckets only. A type alias, so it fits a `Record<string, string>`. */
export type HostMemoryCensusTags = Record<string, string>;

/** Pure: the host's sums, the tags classified and dropped, as buckets. */
export function bucketCensus(result: HostMemoryCensusResult, classify: (taskId: string) => CensusTaskStanding): HostMemoryCensusTags {
  const sums: Record<CensusGroup, CensusSum> = {
    kangentic: result.kangentic,
    live_pty: result.livePty,
    mid_board_beside_session: { bytes: 0, count: 0 },
    mid_board_no_session: { bytes: 0, count: 0 },
    terminal_task: { bytes: 0, count: 0 },
    unknown_tag: { bytes: 0, count: 0 },
    other_same_user: result.otherSameUser,
  };
  for (const tagged of result.tagged) {
    const standing = classify(tagged.taskId);
    const group: CensusGroup = standing === 'terminal'
      ? 'terminal_task'
      : standing === 'unknown'
        ? 'unknown_tag'
        : tagged.hasLiveSession ? 'mid_board_beside_session' : 'mid_board_no_session';
    sums[group].bytes += tagged.bytes;
    sums[group].count += tagged.count;
  }
  const tags: HostMemoryCensusTags = { census: result.failed ? 'failed' : 'ok' };
  for (const group of CENSUS_GROUPS) {
    tags[`${group}_gb`] = bucketCensusBytes(sums[group].bytes);
    tags[`${group}_count`] = bucketCensusCount(sums[group].count);
  }
  tags.unmeasured_count = bucketCensusCount(result.unmeasuredCount);
  return tags;
}

export interface HostMemoryCensusDeps {
  platform: NodeJS.Platform;
  /** The registered requester, read at the spell's start. Null before the host exists. */
  requester: () => HostMemoryCensusRequester | null;
  /** Kangentic's own Electron processes (`app.getAppMetrics()`). */
  electronPids: () => number[];
  classify: (taskId: string) => CensusTaskStanding;
  report: (tags: HostMemoryCensusTags) => void;
  /** Where a census that could not be sent or answered is reported. */
  failureReporter: { report(error: unknown): void };
  timeoutMs?: number;
}

export interface HostMemoryCensus {
  /** Starts one census, unless one is already running. Resolves when it has reported. */
  onSpellStart(): Promise<void>;
}

/** One census per low-memory spell, Windows only, at most one at a time. */
export function createHostMemoryCensus(deps: HostMemoryCensusDeps): HostMemoryCensus {
  let running = false;
  return {
    async onSpellStart() {
      if (deps.platform !== 'win32' || running) return;
      const send = deps.requester();
      if (!send) return;
      running = true;
      try {
        const result = await send({ electronPids: deps.electronPids() }, deps.timeoutMs ?? HOST_MEMORY_CENSUS_TIMEOUT_MS);
        if (!result.supported) return;
        // A failed scan still reports, as `census: failed`, so a spell is never silent.
        deps.report(bucketCensus(result, deps.classify));
      } catch (error) {
        deps.failureReporter.report(error);
      } finally {
        running = false;
      }
    },
  };
}

/**
 * A census that could not be sent or answered: a host that timed out or
 * exited, or a defect here. The host's own scan failure arrives separately, as
 * its `host_memory_census` code.
 */
const hostMemoryCensusReporter = createChokepointReporter('host_memory_census');

export function reportHostMemoryCensusFailure(error: unknown): void {
  hostMemoryCensusReporter.report(error, { tags: { stage: 'census_request' } });
}

/** The live requester, for `createHostMemoryCensus`. */
export function registeredHostMemoryCensusRequester(): HostMemoryCensusRequester | null {
  return requester;
}
