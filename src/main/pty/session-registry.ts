import type * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import type {
  AgentParser,
  Session,
  SessionAttachment,
  SessionRecord,
  SessionStatus,
  StreamOutputParser,
} from '../../shared/types';

/**
 * Internal per-session state owned by the main process. The subset
 * needed outside this module (id, pid, status, cwd, ...) is exposed
 * via `toSession()` which projects a ManagedSession into the Session
 * DTO sent over IPC.
 *
 * Fields are mutated in place by spawn/suspend/kill flows; new fields
 * added here must be initialized wherever a ManagedSession is
 * constructed (spawn failure path, placeholder registration,
 * queued placeholder, normal spawn).
 */
export interface ManagedSession {
  id: string;
  taskId: string;
  projectId: string;
  pty: pty.IPty | null;
  status: SessionStatus;
  shell: string;
  cwd: string;
  startedAt: string;
  exitCode: number | null;
  resuming: boolean;
  transient: boolean;
  /** Sequence of strings to write to PTY for graceful exit before force-killing. */
  exitSequence: string[];
  /** Agent adapter for adapter-specific behavior (readiness detection, parsing,
   *  runtime strategy, exit sequence, etc.). Typed as AgentParser for historical
   *  reasons but the actual value is always the full AgentAdapter instance. */
  agentParser?: AgentParser;
  /** Human-readable adapter name captured at spawn time (e.g. "claude",
   *  "gemini"). Used for diagnostic logs - survives minification unlike
   *  `agentParser.constructor.name`. */
  agentName?: string;
  /** Per-session telemetry parser for adapters that emit machine-readable
   *  output over the PTY (e.g. Cursor's stream-json). Built on first PTY
   *  data via `agentParser.runtime.streamOutput.createParser()`. */
  streamParser?: StreamOutputParser;
  /** Handle returned from the adapter's optional `attachSession` hook.
   *  Disposed on session end so fire-and-forget adapter work can be
   *  cancelled cleanly. Adapters drive all their own per-session
   *  orchestration through this; SessionManager never inspects the
   *  attachment. */
  adapterAttachment?: SessionAttachment;
}

/**
 * Project a live ManagedSession into the Session DTO shape sent over
 * IPC. Omits runtime-only fields (pty handle, agentParser, stream
 * parser, adapter attachment) and resolves the pid from the current
 * pty reference.
 */
export function toSession(session: ManagedSession): Session {
  return {
    id: session.id,
    taskId: session.taskId,
    projectId: session.projectId,
    pid: session.pty?.pid ?? null,
    status: session.status,
    shell: session.shell,
    cwd: session.cwd,
    startedAt: session.startedAt,
    exitCode: session.exitCode,
    resuming: session.resuming,
    transient: session.transient || undefined,
  };
}

/**
 * Whether a session represents a still-live spawn that would collide with a
 * new spawn / resume attempt for the same task.
 *
 * `running` and `queued` are live (occupy a slot, must not be duplicated).
 * `suspended`, `exited`, and missing entries are stale references that the
 * caller can safely clear before proceeding. SESSION_RESUME relies on this
 * to recover when the DB still points at a session the registry has already
 * marked suspended (e.g. internal idle-timeout suspend or an auto-spawn
 * placeholder safety-net path that didn't clear `task.session_id`).
 *
 * Note: not named `isActiveSession` because `SessionManager.activeCount`
 * already uses "active" to mean strictly running (excludes queued); broadening
 * the meaning here would clash with that established term.
 */
export function isLiveSession(session: Session | undefined): boolean {
  return !!session && (session.status === 'running' || session.status === 'queued');
}

/**
 * Decide what DB action to take when persisting a session suspend.
 * Centralizes the record-status branching used by SESSION_SUSPEND, the
 * idle-timeout listener, and any future suspend path so the rules live in
 * one place and can be unit-tested without spinning up the full IPC handler.
 *
 * - `suspend`: record has an `agent_session_id` and was running/exited - mark
 *    suspended so the next resume can use `--resume`.
 * - `exit-queued`: record was queued (never started Claude CLI) - mark exited
 *    instead of suspended to avoid a doomed `--resume` next time.
 * - `noop`: record is missing, already suspended/exited, or has no agent
 *    session id (nothing to mirror).
 */
export type SuspendDbAction = 'suspend' | 'exit-queued' | 'noop';

export function decideSuspendDbAction(record: SessionRecord | undefined): SuspendDbAction {
  if (!record) return 'noop';
  if (record.agent_session_id
      && (record.status === 'running' || record.status === 'exited')) {
    return 'suspend';
  }
  if (record.status === 'queued') return 'exit-queued';
  return 'noop';
}

/**
 * Filter a session-keyed record to only the sessions belonging to
 * `projectId`. Used by IPC handlers that need per-project usage,
 * activity, or events caches.
 */
export function filterCacheByProject<T>(
  cache: Record<string, T>,
  getProjectId: (sessionId: string) => string | undefined,
  projectId: string,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [sessionId, value] of Object.entries(cache)) {
    if (getProjectId(sessionId) === projectId) {
      result[sessionId] = value;
    }
  }
  return result;
}

/**
 * In-memory session registry. Owns the primary `Map<id,
 * ManagedSession>` and exposes both raw access (for modules that
 * iterate or mutate directly, e.g. shutdown) and higher-level domain
 * lookups (findByTaskId, counts, DTO projection).
 *
 * Kept as a separate class so spawn-flow, pty-data-handler, and other
 * extracted modules can depend on a narrow interface instead of the
 * full SessionManager surface.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, ManagedSession>();

  /** Raw Map reference. Used by shutdown helpers that need typed iteration. */
  raw(): Map<string, ManagedSession> {
    return this.sessions;
  }

  set(id: string, session: ManagedSession): void {
    this.sessions.set(id, session);
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  values(): IterableIterator<ManagedSession> {
    return this.sessions.values();
  }

  findByTaskId(taskId: string): ManagedSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.taskId === taskId) return session;
    }
    return undefined;
  }

  hasSessionForTask(taskId: string): boolean {
    return this.findByTaskId(taskId) !== undefined;
  }

  getSessionProjectId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.projectId;
  }

  getSessionTaskId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.taskId;
  }

  getSessionAgentName(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentName;
  }

  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    return session ? toSession(session) : undefined;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values(), toSession);
  }

  /** Lightweight counts without allocating mapped Session objects. */
  getSessionCounts(): { active: number; suspended: number; total: number } {
    let active = 0;
    let suspended = 0;
    let total = 0;
    for (const session of this.sessions.values()) {
      total++;
      if (session.status === 'running') active++;
      else if (session.status === 'suspended') suspended++;
    }
    return { active, suspended, total };
  }

  /**
   * Count currently-running sessions (PTY alive). Excludes queued,
   * suspended, and exited. Used by the queue to decide whether to
   * promote the next waiting session.
   */
  countRunning(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === 'running') count++;
    }
    return count;
  }

  /**
   * Register a suspended placeholder for a task that was user-paused
   * before app restart. The placeholder has no PTY but gives the
   * renderer a "Paused" state and exposes the "Resume session" button.
   */
  registerSuspendedPlaceholder(input: { taskId: string; projectId: string; cwd: string }): Session {
    const id = uuidv4();
    const session: ManagedSession = {
      id,
      taskId: input.taskId,
      projectId: input.projectId,
      pty: null,
      status: 'suspended',
      shell: '',
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    };
    this.sessions.set(id, session);
    return toSession(session);
  }
}
