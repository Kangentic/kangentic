/**
 * Taking back the agents a host kept running while the app was closed (#913).
 *
 * A quit leaves a remote agent running, so the next launch finds its session record still `running` and
 * the agent still on the host. The startup recovery must not read that as a crash: it would mark the
 * record orphaned and resume the conversation in a second agent, in the same worktree, beside the first.
 * So before it orphans anything it asks this module, for each `running` record that names a host, one of
 * three things:
 *
 * - `rejoined`: the host holds the agent alive, and it is a session of this app again, under its own id.
 * - `pending`: the host could not be asked (the link is down, the host is unreachable). The record stays
 *   `running` and nothing is resumed or started for the task. The host's first connect asks again.
 * - `gone`: only an answer from the host says so. The agent exited, or the host lost it. The record is
 *   orphaned and resumed as after any crash.
 *
 * "Could not ask" is never "gone". Two agents in one worktree is the worst outcome here, and a slow rejoin
 * is not a failure.
 */

import * as path from 'node:path';
import { agentRegistry } from '../agent/agent-registry';
import { shellForTarget, toStoredCliTarget } from '../agent/shared/cli-target';
import { recordedPtyGrid } from '../db/recorded-pty-grid';
import { parseToolBreakdown } from '../db/repositories/session-repository';
import type { PermissionMode, Session, SessionRecord } from '../../shared/types';
import type { RemoteSessionAdoption, SessionManager } from '../pty/session-manager';
import { sessionOutputPaths } from '../transition-engine/session-paths';
import type { HelperSnapshot } from './protocol/messages';
import { hostOfRecord } from './record-host';
import { resolveRemoteLaunch } from './remote-launch';

export type RejoinOutcome = 'rejoined' | 'pending' | 'gone';

export interface RejoinDeps {
  /** The host's own list of the terminals it runs. Rejects when the host cannot be asked. */
  snapshot(hostId: string): Promise<Pick<HelperSnapshot, 'sessions'>>;
  /** Take one record's agent back. Null when the host no longer holds it. Rejects when that could not be done. */
  adopt(record: SessionRecord): Promise<Session | null>;
  log?(line: string): void;
}

/** Decide, for each running record that names a host, whether its agent is back, still to ask, or gone. */
export async function rejoinRunningRemoteSessions(
  records: readonly SessionRecord[],
  deps: RejoinDeps,
): Promise<Map<string, RejoinOutcome>> {
  const outcomes = new Map<string, RejoinOutcome>();
  const byHost = new Map<string, SessionRecord[]>();
  for (const record of records) {
    const hostId = hostOfRecord(record);
    if (!hostId) continue;
    const group = byHost.get(hostId) ?? [];
    group.push(record);
    byHost.set(hostId, group);
  }
  for (const [hostId, group] of byHost) {
    let alive: Set<string>;
    try {
      alive = new Set((await deps.snapshot(hostId)).sessions.filter((entry) => entry.alive).map((entry) => entry.sessionId));
    } catch (error) {
      deps.log?.(`[remote] could not ask ${hostId.slice(0, 8)} which agents it kept running: ${error instanceof Error ? error.message : String(error)}`);
      for (const record of group) outcomes.set(record.id, 'pending');
      continue;
    }
    for (const record of group) {
      if (!alive.has(record.id)) {
        outcomes.set(record.id, 'gone');
        continue;
      }
      try {
        outcomes.set(record.id, (await deps.adopt(record)) ? 'rejoined' : 'gone');
      } catch (error) {
        deps.log?.(`[remote] could not take back the agent of session ${record.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
        outcomes.set(record.id, 'pending');
      }
    }
  }
  return outcomes;
}

export interface RecordAdopterContext {
  sessionManager: Pick<SessionManager, 'adoptRemoteSession'>;
  projectId: string;
  /** The project's folder on this computer: for a remote project, its shell folder. */
  projectPath: string;
}

/**
 * Take back one record's agent: the session it was, under the id the host knows it by, with the files this
 * computer kept for it. The command is not rebuilt, since nothing is started, so nothing is written to the
 * host. Null when the record's agent is not one this build knows.
 */
export function createRecordAdopter(context: RecordAdopterContext): (record: SessionRecord) => Promise<Session | null> {
  return async (record) => {
    const adapter = agentRegistry.getBySessionType(record.session_type);
    if (!adapter) return null;
    const launch = await resolveRemoteLaunch({ projectPath: context.projectPath, cwd: record.cwd, adapter });
    if (!launch) return null;
    const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(path.join(context.projectPath, '.kangentic', 'sessions', record.id));
    const restoredGrid = recordedPtyGrid(record);
    const input: RemoteSessionAdoption = {
      id: record.id,
      taskId: record.task_id,
      projectId: context.projectId,
      command: '',
      cwd: record.cwd,
      startPath: 'startup_recovery',
      statusOutputPath,
      eventsOutputPath,
      agentParser: adapter,
      agentName: adapter.name,
      agentSessionId: record.agent_session_id,
      isolatedSwimlaneId: record.isolated_swimlane_id,
      permissionMode: record.permission_mode as PermissionMode | null,
      exitSequence: adapter.getExitSequence?.() ?? ['\x03'],
      shell: shellForTarget(launch.place) ?? undefined,
      cliTarget: toStoredCliTarget(launch.place),
      remote: launch.remote,
      // The same run goes on in the same record, whose counts are this run's.
      runSoFar: { toolBreakdown: parseToolBreakdown(record.tool_breakdown), compactionCount: record.compaction_count ?? 0 },
      // What the agent last reported, so its card and context bar open with a model and not a spinner.
      ...(record.model_id ? { modelSoFar: { id: record.model_id, displayName: record.model_display_name || record.model_id } } : {}),
      // Occupancy the record last saw, so the bar is not 0% until the agent next acts.
      ...(typeof record.used_percentage === 'number' && record.used_percentage > 0
        ? { occupancySoFar: record.used_percentage }
        : {}),
      ...(restoredGrid ? { restoredGrid } : {}),
    };
    return context.sessionManager.adoptRemoteSession(input);
  };
}
