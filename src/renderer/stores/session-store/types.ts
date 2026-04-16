import type {
  Session,
  SessionUsage,
  ActivityState,
  SessionEvent,
  SpawnSessionInput,
} from '../../../shared/types';
import type { TaskChangesPanelSlice } from './task-changes-panel-slice';
import type { UsagePeriodSlice } from './usage-period-slice';
import type { TransientSessionSlice } from './transient-session-slice';

/**
 * The "core" session store state: every key that lives on the main
 * session-store.ts file (sessions, usage/activity/events, CRUD
 * methods, sync, UI hints, derived getters).
 *
 * The three extracted slices (transient-session, task-changes-panel,
 * usage-period) are composed on top via intersection in SessionStore
 * below. This split is imperfect: transient-session-slice reaches
 * into core's per-session dictionaries to scrub them on session kill.
 * The core shape must stay in sync with what transient-session-slice
 * references.
 */
export interface CoreSessionSlice {
  sessions: Session[];
  /** Derived O(1) lookup: taskId -> Session. Rebuilt whenever `sessions` changes. */
  _sessionByTaskId: Map<string, Session>;
  activeSessionId: string | null;
  detailTaskId: string | null;
  dialogSessionId: string | null;
  sessionUsage: Record<string, SessionUsage>;
  /** Tracks sessions whose PTY has activated the alternate screen buffer (TUI ready). */
  sessionFirstOutput: Record<string, boolean>;
  sessionActivity: Record<string, ActivityState>;
  sessionEvents: Record<string, SessionEvent[]>;
  seenIdleSessions: Record<string, boolean>;
  /** Command label to show in the terminal overlay (e.g. "/code-review") keyed by task ID. */
  pendingCommandLabel: Record<string, string>;
  /** Spawn progress label from main process (e.g. "Fetching latest...") keyed by task ID. */
  spawnProgress: Record<string, string>;
  _pendingOpenTaskId: string | null;
  /** One-shot flag set by notification click for transient (Command Terminal) sessions. */
  _pendingOpenCommandTerminal: boolean;
  setPendingOpenCommandTerminal: (value: boolean) => void;

  syncSessions: () => Promise<boolean>;
  setPendingOpenTaskId: (id: string | null) => void;
  setDetailTaskId: (id: string | null) => void;
  spawnSession: (input: SpawnSessionInput) => Promise<Session>;
  killSession: (id: string) => Promise<void>;
  resetSession: (taskId: string) => Promise<void>;
  suspendSession: (taskId: string) => Promise<void>;
  resumeSession: (taskId: string, resumePrompt?: string) => Promise<Session>;
  setActiveSession: (id: string | null) => void;
  setDialogSessionId: (id: string | null) => void;
  upsertSession: (session: Session) => void;
  updateSessionStatus: (id: string, updates: Partial<Session>) => void;
  updateUsage: (sessionId: string, data: SessionUsage) => void;
  markFirstOutput: (sessionId: string) => void;
  updateActivity: (sessionId: string, state: ActivityState) => void;
  addEvent: (sessionId: string, event: SessionEvent) => void;
  batchUpdateUsage: (entries: Map<string, SessionUsage>) => void;
  batchAddEvents: (entries: Array<{ sessionId: string; event: SessionEvent }>) => void;
  clearEvents: (sessionId: string) => void;
  setPendingCommandLabel: (taskId: string, label: string) => void;
  clearPendingCommandLabel: (taskId: string) => void;
  setSpawnProgress: (taskId: string, label: string | null) => void;
  markIdleSessionsSeen: (projectId: string) => void;
  markSingleIdleSessionSeen: (sessionId: string) => void;

  getRunningCount: () => number;
  getQueuedCount: () => number;
  getQueuePosition: (sessionId: string) => { position: number; total: number } | null;
}

export type SessionStore = CoreSessionSlice & TaskChangesPanelSlice & UsagePeriodSlice & TransientSessionSlice;
