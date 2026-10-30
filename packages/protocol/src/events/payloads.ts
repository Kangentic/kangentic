/**
 * Wire-level mirrors of the desktop-app shapes that flow to a phone inside
 * feed events and read-* responses, plus the runtime guards a phone runs
 * before trusting any field. Phase 2 of the protocol: the envelope
 * (messages.ts) and event skeleton (event.ts) were final in Phase 1; these
 * types pin down the payload CONTENTS that were deferred as JsonValue.
 *
 * These are deliberate structural MIRRORS, not imports: this package is a
 * dependency-light leaf shared by desktop and phone, so it cannot import
 * the desktop app's internal types (src/shared/types.ts). The desktop's
 * wire-mappers (src/main/mobile-bridge/handlers/wire-mappers.ts) are the
 * one place each mirror meets its source shape, so a drift shows up there
 * as a compile error instead of a silent phone-side parse failure.
 *
 * Guard philosophy: validate the discriminants and required scalars a
 * consumer dispatches on, pass unrecognized extra fields through untouched
 * (lenient forward compatibility - an older phone must tolerate fields a
 * newer desktop adds), and throw on a malformed required field so the
 * caller can drop the payload cleanly.
 */
import type { JsonValue } from '../wire/messages';
import { isRecord } from '../wire/json-value';

// === Transcript ===

/** Mirrors the desktop's TranscriptBlock. `tool_use.input` is JSON-sanitized by the desktop mapper before it reaches the wire. */
export type TranscriptBlockWire =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue };

/** Mirrors the desktop's per-turn TranscriptTurnUsage token counts. */
export interface TranscriptTurnUsageWire {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type TranscriptSystemSubtypeWire = 'compaction' | 'command' | 'command_output' | 'session_boundary';

/** Mirrors the desktop's TranscriptEntry union - the parsed conversation the phone's transcript-terminal renders. */
export type TranscriptEntryWire =
  | { kind: 'user'; uuid: string; ts: number; text: string }
  | {
      kind: 'assistant';
      uuid: string;
      ts: number;
      model?: string;
      agentName?: string;
      usage?: TranscriptTurnUsageWire;
      blocks: TranscriptBlockWire[];
    }
  | { kind: 'tool_result'; uuid: string; ts: number; toolUseId: string; content: string; isError?: boolean }
  | { kind: 'system'; uuid: string; ts: number; subtype: TranscriptSystemSubtypeWire; text: string };

/** One transcript entry at its absolute position in the full transcript at the delta's revision. */
export interface TranscriptUpsertWire {
  index: number;
  entry: TranscriptEntryWire;
}

/**
 * Protocol v2 transcript payload: incremental, never the whole transcript.
 *
 * - 'delta' carries only the entries that changed or appeared since the
 *   last delta the desktop sent on this subscription, as absolute-indexed
 *   upserts in ascending order. A large delta is split across several
 *   events (same revision) so every frame stays well under the transport
 *   caps and the first chunk renders without waiting for the rest. The
 *   phone applies upserts inside or adjacent to its loaded window and
 *   re-requests a window when it detects a gap.
 * - 'reset' tells the phone its local state is unreconstructable from
 *   deltas (entries removed or reordered, or a degraded transcript source
 *   whose uuids are unstable) - drop local entries and re-request a
 *   window via the read-stream 'transcript-window' action.
 *
 * `revision` is the desktop's monotonically increasing whole-transcript
 * version; `totalEntries` is the full transcript length at that revision,
 * which is how the phone knows history extends above its window.
 */
export type TranscriptEventPayload =
  | { mode: 'delta'; revision: number; totalEntries: number; upserts: TranscriptUpsertWire[] }
  | { mode: 'reset'; revision: number; totalEntries: number };

// === Terminal ===

/**
 * PTY grid dimensions, shared by the read-stream snapshot (`ptyDimensions`),
 * the `terminal-resize` event, and the interactive-terminal `resize` action.
 * The bytes on the terminal stream are laid out for exactly this grid; a
 * renderer that uses any other geometry misplaces every cursor-addressed
 * frame the fullscreen TUI draws.
 */
export interface TerminalDimensionsWire {
  cols: number;
  rows: number;
}

// === Activity ===

/** Mirrors the desktop's ActivityState. 'permission' means the agent paused for user approval (incl. AskUserQuestion / ExitPlanMode pauses). */
export type ActivityStateWire = 'thinking' | 'idle' | 'permission';

/**
 * What a `permission` wait is for, when the agent reported it: `question`
 * when it asked the user something, `approval` when it wants a tool allowed
 * or a plan approved. Mirrors the desktop's PermissionWaitKind. Append only:
 * every reader drops a kind it does not know rather than rejecting what
 * carries it, so a kind a newer desktop adds reads as an unknown wait.
 */
export const PERMISSION_WAIT_KINDS = ['question', 'approval'] as const;

export type PermissionWaitKindWire = (typeof PERMISSION_WAIT_KINDS)[number];

export function isPermissionWaitKindWire(value: unknown): value is PermissionWaitKindWire {
  return typeof value === 'string' && (PERMISSION_WAIT_KINDS as readonly string[]).includes(value);
}

/**
 * Mirrors the desktop's ActivityReason discriminated union. `since` (epoch ms
 * the session first needed the user) is optional, additive-field style like
 * `toolCallCount`/`effort` above: an older phone parsing a payload with the
 * field missing still validates, and a desktop that has not yet learned a
 * `since` for a phantom-state edge case can omit it.
 *
 * `waitKind` on `permission` (protocol 0.26.0) says what the wait is for.
 * Absent means the agent did not say, or an older desktop. An older phone
 * ignores it.
 */
export type ActivityReasonWire =
  | { kind: 'idle'; since?: number }
  | { kind: 'permission'; since?: number; waitKind?: PermissionWaitKindWire }
  | { kind: 'tool'; pendingCount: number; currentTool: string | null }
  | { kind: 'subagent'; depth: number }
  | { kind: 'background-shell'; count: number; ids: string[] }
  | { kind: 'turn-active' };

/**
 * Phone-needed subset of the desktop's SessionUsage. The desktop mapper
 * explicitly picks these fields; renderer-only extras (transcriptPath,
 * rateLimits, sessionId echo) never reach the wire.
 */
export interface SessionUsageWire {
  contextWindow: {
    usedPercentage: number;
    usedTokens: number;
    cacheTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    contextWindowSize: number;
  };
  cost: {
    totalCostUsd: number;
    totalDurationMs: number;
  };
  /**
   * Completed tool calls across every run of the session. A resume (an app
   * restart, a pause and resume) is a new run, and the desktop adds the
   * session's earlier runs to the live count. Optional: an older desktop
   * omits it.
   */
  toolCallCount?: number;
  model: {
    id: string;
    displayName: string;
    effort?: string;
  };
}

/**
 * Phone-needed subset of the desktop's SessionSummary: what a task COST over
 * its whole life, as opposed to SessionUsageWire's live snapshot of one
 * running agent.
 *
 * Every figure is a lifetime aggregate across every session record of the
 * task, which is what makes it meaningful for a completed one: a task worked
 * across five `--resume` legs has five session rows, and reporting only the
 * final leg would under-report everything. The desktop's getSummaryForTask
 * owns those aggregation rules - they are not re-derived here. Cost, duration
 * and tokens are each conversation's cumulative reading, so they count once per
 * session lineage and add across lineages; tool calls and lines SUM; files
 * changed takes the MAX.
 *
 * `sessionId` is the transcript ANCHOR, not a live session: it resolves
 * through the desktop's session records, which outlive the agent, so it reads
 * a finished task's conversation with nothing running. An archived task's
 * `session_id` on the board is null by then, so this is the only handle to it.
 */
export interface SessionSummaryWire {
  sessionId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  modelDisplayName: string;
  durationMs: number;
  toolCallCount: number;
  compactionCount: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  /** ISO 8601. The task's creation, which is where its timeline starts. */
  taskCreatedAt: string;
  /** ISO 8601. Earliest session start across every leg. */
  startedAt: string;
  /** ISO 8601, or null while a leg is still open. Latest exit or suspend. */
  exitedAt: string | null;
  exitCode: number | null;
}

/**
 * Loose mirror of the desktop's SessionEvent telemetry entry. `type` is
 * deliberately a plain string, not the desktop's EventType enum, so a new
 * desktop event type does not break an older phone's parser.
 */
export interface SessionEventWire {
  ts: number;
  type: string;
  tool?: string;
  toolId?: string;
  detail?: string;
}

// === Board ===

/**
 * The system column roles, mirroring the desktop's `SWIMLANE_ROLES` /
 * `SwimlaneRole` (`src/shared/types.ts`). This package cannot import that
 * file (see the module doc), so the two lists are a deliberate mirror, kept
 * in sync by `tests/unit/protocol/board-column-role-parity.test.ts` on the
 * desktop side rather than by a shared import.
 */
export const BOARD_COLUMN_ROLES = ['todo', 'done'] as const;

export type BoardColumnRoleWire = (typeof BOARD_COLUMN_ROLES)[number];

// Pinned to `BoardColumnRoleWire` rather than compared as bare literals, so a
// typo or a rename inside these predicates is a compile error here instead of
// a predicate that silently returns false for every column. The parity test
// keeps the role list itself matching the desktop's.
const TODO_ROLE: BoardColumnRoleWire = 'todo';
const DONE_ROLE: BoardColumnRoleWire = 'done';

/** True for a column whose role is the system 'todo' role. Prefer this at a call site over a literal `=== 'todo'`, which the `(string & {})` widening leaves unchecked. */
export function isTodoRole(role: string | null | undefined): boolean {
  return role === TODO_ROLE;
}

/** True for a column whose role is the system 'done' role. Prefer this at a call site over a literal `=== 'done'`, which the `(string & {})` widening leaves unchecked. */
export function isDoneRole(role: string | null | undefined): boolean {
  return role === DONE_ROLE;
}

/** Phone-needed subset of the desktop's Swimlane row (snake_case preserved so the desktop mapper is a mechanical pick). */
export interface BoardColumnWire {
  id: string;
  name: string;
  description: string | null;
  /**
   * `'todo'` / `'done'` are the system roles; anything else (including a
   * future role this package predates) is a custom or not-yet-known column,
   * which is exactly what the `(string & {})` escape hatch preserves - the
   * literal union alone would reject a value a newer desktop legitimately
   * sends. That widening does NOT make a typo'd comparison a compile error
   * (a string literal is assignable to `string & {}`), so call sites should
   * use `isTodoRole` / `isDoneRole` rather than `=== 'todo'` / `=== 'done'`.
   */
  role: BoardColumnRoleWire | (string & {}) | null;
  position: number;
  color: string;
  icon: string | null;
  is_archived: boolean;
  is_ghost: boolean;
  /**
   * Whether moving a task into this column spawns a successor agent
   * session, derived desktop-side from the column's `auto_spawn` flag and
   * role. This is INTENT, not a guarantee:
   *
   * - `false` - this column does not intend to spawn. Reliable enough to act
   *   on ONLY when the column's own `role` is 'todo' or 'done': those two
   *   produce a full reset or an archive, and a Board Profile cannot change a
   *   column's role, so a client MAY skip a session-swap transition entirely
   *   for them. `role` rides this same object, so
   *   `isTodoRole(column.role) || isDoneRole(column.role)` is how a client
   *   recognizes that case. A `false` that came from `auto_spawn: false` on
   *   any other column is intent only, exactly like `true`: a Board Profile
   *   can set `autoSpawn: true` for one task on that column, and the move
   *   then does spawn.
   * - `true` - this column intends to spawn, but a handful of desktop-side
   *   conditions can suspend the old session without a successor actually
   *   landing (a board profile disabling auto_spawn for this task, a failed
   *   worktree checkout that reverts the move, a shutdown or a newer move
   *   racing this one). A client MUST NOT treat `true` as a promise; keep
   *   whatever timeout already bounds a session-swap wait and let `true`
   *   only skip a redundant one.
   * - `null` / absent - a desktop that predates this field. A client falls
   *   back to its pre-existing behavior, the same way an absent
   *   `pr_merge_readiness` reads as "never judged".
   *
   * Declared OPTIONAL (`?`) so a hand-built `BoardColumnWire` literal does
   * not have to list it. `parseBoardColumnWire` populates the key from every
   * real wire response regardless, so the optionality costs nothing at
   * runtime.
   *
   * Ordering precondition this field depends on: the phone must learn a
   * MOVE's destination column before the old session's `session-ended`
   * arrives, or it cannot resolve `spawns_session` against the right column.
   * That holds today because `handleTaskMove` emits its board-changed event
   * at the commit point rather than at settle time. See the comment above
   * `emitBoardChanged()` in `src/main/ipc/handlers/task-move.ts`, and
   * `docs/integrations/mobile-bridge/scope.md`.
   */
  spawns_session?: boolean | null;
}

/** Phone-needed subset of the desktop's Task row. A non-null `session_id` is the live-session signal the phone's triage view keys on. */
export interface BoardTaskWire {
  id: string;
  display_id: number;
  title: string;
  description: string;
  swimlane_id: string;
  position: number;
  agent: string | null;
  session_id: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  /**
   * Normalized merge readiness of the linked PR: `ready` / `blocked` /
   * `conflicting` / `queued` / `running` / `unknown`, or null when never
   * judged. `queued` and `running` mean a blocking check is still in flight.
   * Absent from desktops that predate it, which the parser reads as null; a
   * value a client does not know should render as plain open.
   *
   * Declared OPTIONAL (`?`) so a hand-built `BoardTaskWire` literal does not
   * have to list it. `parseBoardTaskWire` populates the key from every real
   * wire response regardless, so the optionality costs nothing at runtime.
   */
  pr_merge_readiness?: string | null;
  base_branch: string | null;
  labels: string[];
  priority: number;
  attachment_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * The task's in-flight spawn-progress label, the text of the desktop card's
   * preparing footer: "Creating worktree...", "Fetching latest...",
   * "Waiting (2 ahead)", "Switching model...", "Starting agent...", a git-queue
   * wait with its elapsed time, and any staleness note the desktop appends
   * ("Starting agent... (base 3 behind)"). The desktop announces every change
   * with a `task-updated` board event, coalesced to at most about one a
   * second per task.
   *
   * Untrusted display text, the same terms as `session-ended`'s
   * `spawnProgressLabel`: never parse it or switch on it, and fall back to
   * generic copy. It can carry text the desktop did not write: a column
   * automation's name, in `Running "<name>"...`, from a config a team may
   * share. From 0.16.0 the desktop strips escape sequences, control characters,
   * invisible format characters (bidi controls, the zero-width space, the soft
   * hyphen, the byte order mark) and tag characters outside the England,
   * Scotland and Wales flag emoji, turns line breaks and tabs into spaces, and
   * caps it at
   * 120 characters ending in "...", but a client still caps it for its own
   * layout.
   *
   * Precedence, matching the desktop card: a label overrides a `suspended`
   * session status (a respawn is in flight behind a session that was just
   * suspended for it), and never a `running` or `queued` one. A client that
   * reads the read-stream feed's `status: 'suspended'` during a model or
   * effort switch shows this label, not "Paused".
   *
   * A spawn path that dies without clearing its label leaves it in place for
   * up to the desktop's 120s spawn-progress TTL, and the TTL expiry sends no
   * board event, so a stale label can outlive its spawn until the next
   * snapshot. Null or absent means no spawn is in flight, or a desktop that
   * predates the field (pre-0.16.0). Under `view: 'sessions'` a task with a
   * label is kept even while its `session_id` is null, so a first start and
   * a respawn's gap stay visible.
   *
   * Declared OPTIONAL (`?`) like `pr_merge_readiness`; `parseBoardTaskWire`
   * populates the key from every real wire response.
   */
  spawn_progress?: string | null;
  /**
   * True when the task's session is paused and the desktop's own task view
   * would offer Resume for it: the task is not in To Do or Done and not
   * archived. It is the desktop's promise that `start-session` for this task
   * resumes the paused session exactly as its Resume button does: the same
   * conversation, the column's model, effort and permission, a "Resuming
   * session..." label, and NO enter automations or column message. Gate a
   * phone's Resume control on THIS field.
   *
   * On the board row because the phone always holds the board: a desktop
   * pause clears the task's `session_id`, so a phone keeps no read-stream on
   * a paused session (the stream's `resumable` covers only an open session
   * screen through the suspend itself). A pause, a resume, a column move and
   * an archive each reach the phone as a `task-updated` board event, after
   * which the next snapshot carries the new value. Under `view: 'sessions'` a
   * resumable task is kept even though its `session_id` is null, so an agent
   * feed can draw it as Paused with a Resume control.
   *
   * Explicit on purpose, never inferred from another field: a pre-0.16.0
   * desktop answers `start-session` by STARTING the column, which re-runs its
   * enter automations and resends its message (a paused task in Code Review
   * would get `/code-review` again). Null or absent means such a desktop; a
   * client offers no Resume then. While `spawn_progress` is non-null a spawn
   * is already in flight and the desktop card shows that label instead of a
   * Resume control; a client applies the same precedence. `start-session`
   * re-checks the column and refuses a To Do, Done or archived task with the
   * desktop's Resume copy, so a value overtaken by a move is safe to act on.
   * A paused task that offers no Resume reads false here. From 0.17.0 `paused`
   * tells it apart from a task with no paused session.
   *
   * Declared OPTIONAL (`?`) like `spawns_session`; `parseBoardTaskWire`
   * populates the key from every real wire response.
   */
  resumable?: boolean | null;
  /**
   * True when the task has a paused session (a `suspended` session that is not
   * a Command Terminal) and no live one. No column or archive gate applies. It
   * is the fact the desktop card's "Paused" footer reads, so a paused task in
   * Done or on the archived page reads true here while `resumable` reads
   * false. The desktop draws an archived task as a compact card with no
   * footer, so a client that matches the desktop card draws "Paused" only
   * when `archived_at` is null. A move from another column into Done
   * archives the task in the same step, so only a task that sits in Done
   * unarchived gets the full card and its footer. A move into To Do removes
   * the task's session rows, so a task there normally reads false. Gate
   * Resume on `resumable` only; `resumable: true` always comes with
   * `paused: true`.
   *
   * A desktop pause clears the task's `session_id`, so find a paused session
   * from this field, not from `session_id`, and name it by
   * `paused_session_id` (from 0.27.0). A respawn queued behind the
   * desktop's concurrency limit leaves the task holding a paused session and a
   * queued one; that task reads false, as the desktop card shows the queued
   * session. While `spawn_progress` is non-null the desktop card shows that
   * label instead of "Paused"; a client applies the same precedence.
   *
   * Under `view: 'sessions'` a paused task that offers no Resume stays out of
   * the snapshot, because an agent feed has nothing to act on for it. Null or
   * absent means a desktop that predates the field (pre-0.17.0); a client
   * then reads a paused task from `resumable` alone, as before.
   *
   * Declared OPTIONAL (`?`) like `resumable`; `parseBoardTaskWire` populates
   * the key from every real wire response.
   */
  paused?: boolean | null;
  /**
   * The id of the task's paused session while `paused` is true, and null
   * otherwise. It is the id to name in `send-user-message` for a paused task:
   * the desktop holds that message for the task's next agent and answers
   * `delivered: true`. Data only; nothing on the desktop displays it.
   *
   * It is the desktop's live id for the paused session, which a restart
   * replaces: the desktop re-registers each paused session under a new id
   * that no earlier snapshot, `session_id` or session list carries. That
   * change reaches the phone as a `task-updated` board event, after which the
   * next snapshot carries the new id. Read it from the latest snapshot rather
   * than keeping one, and treat an `unknown-session` answer as a sign to
   * re-read the board.
   *
   * `session_id` keeps its meaning and stays null while the task is paused. A
   * resume never reuses this id: the resumed agent arrives as a new session in
   * `session_id`, and this field turns null. The id follows `paused` exactly,
   * so a paused task in Done or on the archived page carries one too. The
   * desktop refuses a hold for such a task with the `unknown-session` code it
   * sent there before 0.26.0 and the hold's reason as the error text, and a
   * re-read of the board does not change that answer.
   *
   * Null or absent also means a desktop that predates the field (pre-0.27.0).
   * On such a desktop a phone can still name a paused session's id it already
   * knows, from a session screen that was open through the pause.
   *
   * Declared OPTIONAL (`?`) like `paused`; `parseBoardTaskWire` populates the
   * key from every real wire response.
   */
  paused_session_id?: string | null;
  /**
   * True when the task has a live session (`running` or `queued`) and is not
   * in To Do. It is the desktop's promise that `pause-session` for this task
   * pauses that session exactly as its Pause button does: the conversation is
   * kept for a later Resume, and the pause sticks, so a column with auto-spawn
   * on does not start the task again by itself. Gate a phone's Pause control on
   * THIS field.
   *
   * Done and archived do not clear it, matching the desktop, whose Pause stays
   * available there because it is the only in-window stop for a live agent. A
   * move into Done suspends the task's session in the same step, so a task
   * there normally has no live session and reads false. It reads true only
   * when that suspend failed and left the agent running.
   *
   * Never true while `paused` is true: a paused task has no live session. While
   * `spawn_progress` is non-null and no session is live, the desktop card still
   * shows a Pause control, but its click only cancels an in-flight resume or
   * start, which `pause-session` does not promise. This field reads false
   * then, and the verb refuses a task with no live session.
   *
   * A pause, a session's start and its end each reach the phone as a
   * `task-updated` board event, after which the next snapshot carries the new
   * value. Null or absent means a desktop that predates the field
   * (pre-0.18.0), and a client offers no Pause then: a 0.15.0 to 0.17.0
   * desktop refuses `pause-session` with the `unsupported-verb` code, and an
   * older one does not answer it at all.
   *
   * Declared OPTIONAL (`?`) like `paused`; `parseBoardTaskWire` populates the
   * key from every real wire response.
   */
  pausable?: boolean | null;
  /**
   * True when column automations are off for this task: no On task enter, On
   * agent turn end or On task exit row runs for it in any column, and a move
   * types no column message. Column settings, a hand's moves and the task's own
   * first command are untouched. It is the fact the desktop card's "Automations
   * paused" strip reads, and the desktop menu's Pause or Resume automations
   * row flips it.
   *
   * There is no verb for it. A phone flips it with the `board-tool-write`
   * `update_task` call, whose param is camelCase: `automationsDisabled: true`
   * or `false`, never `automations_disabled`. On a workflow task it also holds
   * the task out of its workflow (no judging, moving or starting) while the
   * rest runs. A desktop that predates `workflow.automations_pausable`
   * (pre-0.25.0) refuses `true` for a workflow task, so offer the control on
   * one only while that field is true.
   *
   * The desktop clears it by itself only when the task joins a workflow. A move
   * out of Done or a restore from the archive keeps it. Every change, by any
   * hand, reaches the phone as a `task-updated` board event, after which the
   * next snapshot carries the new value.
   *
   * Null or absent means a desktop that predates the field (pre-0.22.0). A
   * client offers no control then, since it cannot read the switch's state.
   *
   * Declared OPTIONAL (`?`) like `pausable`; `parseBoardTaskWire` populates the
   * key from every real wire response.
   */
  automations_disabled?: boolean | null;
  /**
   * The workflow the task belongs to (a set of linked tasks that runs through
   * its boards by itself), or null for an ordinary task. Absent from desktops
   * that predate workflows, which the parser reads as null, as it does a value
   * it cannot read. Declared OPTIONAL for the reason `pr_merge_readiness` is.
   */
  workflow?: BoardTaskWorkflowWire | null;
}

/**
 * A board task's workflow, as its card draws it: the strip (name, color), what
 * the task waits for, and whether a hand may move it. `lock_reason` is the
 * desktop's own sentence, so a phone that refuses a move says what the desktop
 * would; the desktop refuses a locked move on its own anyway.
 */
export interface BoardTaskWorkflowWire {
  id: string;
  title: string;
  /** The workflow's home project, which may not be the board's. */
  project_id: string;
  /** `running`, `paused`, `draft` or `done`; a value a client does not know reads as running. */
  state: string;
  /** Which of six categorical colors (1 to 6) the desktop paints its icon in. */
  color_slot: number;
  /** The columns the task visits, by id, in board order. */
  route: string[];
  /** The tasks it waits for that are not done, named as the card's footer names them ("#413"). */
  waiting_for: string[];
  /**
   * While the card is locked (its workflow runs, its automations are not
   * paused, and it is not waiting in a human gate), the desktop's sentence for
   * a refused move; null otherwise,
   * which is when the desktop draws no lock. An unlocked card still never
   * moves into To Do, and while `gate_target_id` is set it moves only there.
   */
  lock_reason: string | null;
  /**
   * While the workflow runs and the card waits in a column no agent judges
   * (a human gate): the one column a hand may move it to, the next on its
   * route. Moving it there is how the person reports the step done. Null otherwise.
   */
  gate_target_id: string | null;
  /**
   * True on a desktop that honours the task's automations switch
   * (`BoardTaskWire.automations_disabled`) on a workflow task: `update_task`
   * accepts `automationsDisabled` for it, and while the switch is on the
   * workflow neither judges, moves nor starts the task, and a hand may move its
   * card anywhere but To Do (`lock_reason` reads null). Offer the switch on a
   * workflow task only when this is true.
   *
   * Null or absent means a desktop that predates the field (pre-0.25.0), which
   * refuses `automationsDisabled: true` for a workflow task: hide the control.
   *
   * Declared OPTIONAL (`?`) like `BoardTaskWire.pausable`;
   * `parseBoardTaskWorkflowWire` populates the key from every real wire response.
   */
  automations_pausable?: boolean | null;
}

/**
 * One live Command Terminal of a project (protocol 0.20.0): an agent the
 * desktop runs at the project root with no task, started from the desktop's
 * Ctrl+Shift+P layer or by a phone's `command-terminal` start. It is listed
 * beside a project's tasks in a read-board snapshot (`commandTerminals`), and
 * the Agents feed draws it with a "Command Terminal" pill.
 *
 * - `slot` is the terminal's durable number in its project, 1 to 4. It never
 *   renumbers while siblings start and stop.
 * - `name` is what to show: the terminal's own name once it has one, else
 *   "Command Terminal N". `named` is true once it has its own name (the
 *   desktop derives one from the first prompt), which is when the phone's
 *   session header adds its pill.
 * - `activity` is the raw state and reason, the same shape `read-stream`
 *   reports, so the phone formats the line ("Running Bash", "Awaiting
 *   permission") with the formatter it already uses for a task's agent. Both
 *   are null until the desktop's activity engine has classified the session.
 */
export interface CommandTerminalWire {
  sessionId: string;
  projectId: string;
  slot: number;
  name: string;
  named: boolean;
  activity: { state: ActivityStateWire | null; reason: ActivityReasonWire | null };
}

/** Phone-needed subset of the desktop's BacklogTask row. */
export interface BacklogItemWire {
  id: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
  position: number;
  item_type: string | null;
  external_url: string | null;
  attachment_count: number;
  created_at: string;
  updated_at: string;
}

// === Diff ===

/** Mirrors the desktop's GitDiffStatus. */
export type DiffFileStatusWire = 'A' | 'M' | 'D' | 'R' | 'C' | 'U';

/** Exact mirror of the desktop's GitDiffFileEntry. */
export interface DiffFileWire {
  path: string;
  status: DiffFileStatusWire;
  insertions: number;
  deletions: number;
  oldPath?: string;
  binary: boolean;
}

/** Exact mirror of the desktop's GitDiffFilesResult - the read-diff file-list response. */
export interface DiffFileListWire {
  files: DiffFileWire[];
  totalInsertions: number;
  totalDeletions: number;
}

/** Exact mirror of the desktop's GitFileContentResult - the read-diff single-file response. */
export interface DiffFileContentWire {
  original: string;
  modified: string;
  language: string;
}

// === Guards (the phone's trust boundary for desktop-originated payloads) ===

export const DIFF_FILE_STATUSES: readonly string[] = ['A', 'M', 'D', 'R', 'C', 'U'];
const TRANSCRIPT_SYSTEM_SUBTYPES: readonly string[] = ['compaction', 'command', 'command_output', 'session_boundary'];

export function requireString(record: Record<string, unknown>, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${context} is missing a string "${field}"`);
  return value;
}

export function requireNumber(record: Record<string, unknown>, field: string, context: string): number {
  const value = record[field];
  if (typeof value !== 'number') throw new Error(`${context} is missing a number "${field}"`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, field: string, context: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') throw new Error(`${context} is missing a boolean "${field}"`);
  return value;
}

function isTranscriptBlockWire(value: unknown): value is TranscriptBlockWire {
  if (!isRecord(value)) return false;
  if (value.type === 'text' || value.type === 'thinking') return typeof value.text === 'string';
  if (value.type === 'tool_use') return typeof value.id === 'string' && typeof value.name === 'string' && 'input' in value;
  return false;
}

function isTranscriptEntryWire(value: unknown): value is TranscriptEntryWire {
  if (!isRecord(value)) return false;
  if (typeof value.uuid !== 'string' || typeof value.ts !== 'number') return false;
  switch (value.kind) {
    case 'user':
      return typeof value.text === 'string';
    case 'assistant':
      return Array.isArray(value.blocks) && value.blocks.every(isTranscriptBlockWire);
    case 'tool_result':
      return typeof value.toolUseId === 'string' && typeof value.content === 'string';
    case 'system':
      return typeof value.subtype === 'string' && TRANSCRIPT_SYSTEM_SUBTYPES.includes(value.subtype) && typeof value.text === 'string';
    default:
      return false;
  }
}

/** Narrows a transcript entry array (windowed-history pages). Throws on a malformed entry so the caller can drop the payload. */
export function parseTranscriptEntriesWire(payload: JsonValue): TranscriptEntryWire[] {
  if (!Array.isArray(payload)) throw new Error('transcript payload must be an array of entries');
  return payload.map((entry, index) => {
    if (!isTranscriptEntryWire(entry)) throw new Error(`transcript payload entry ${index} is malformed`);
    return entry;
  });
}

/** Narrows a transcript event's delta/reset payload. Throws on a malformed required field so the caller can drop the push. */
export function parseTranscriptEventPayload(payload: JsonValue): TranscriptEventPayload {
  if (!isRecord(payload)) throw new Error('transcript payload must be an object');
  const revision = requireNumber(payload, 'revision', 'transcript payload');
  const totalEntries = requireNumber(payload, 'totalEntries', 'transcript payload');
  if (!Number.isInteger(revision) || revision < 0) throw new Error('transcript payload has an invalid "revision"');
  if (!Number.isInteger(totalEntries) || totalEntries < 0) throw new Error('transcript payload has an invalid "totalEntries"');

  if (payload.mode === 'reset') return { mode: 'reset', revision, totalEntries };
  if (payload.mode !== 'delta') throw new Error('transcript payload has an invalid "mode"');
  if (!Array.isArray(payload.upserts)) throw new Error('transcript delta is missing "upserts"');
  const upserts = payload.upserts.map((upsert, position): TranscriptUpsertWire => {
    if (!isRecord(upsert) || typeof upsert.index !== 'number' || !Number.isInteger(upsert.index) || upsert.index < 0) {
      throw new Error(`transcript delta upsert ${position} has an invalid "index"`);
    }
    if (!isTranscriptEntryWire(upsert.entry)) throw new Error(`transcript delta upsert ${position} has a malformed "entry"`);
    return { index: upsert.index, entry: upsert.entry };
  });
  return { mode: 'delta', revision, totalEntries, upserts };
}

/**
 * Narrows a PTY dimensions payload. Bounds are sanity caps, not policy:
 * the desktop's own resize clamp (cols >= 2, rows >= 1) is the floor, and
 * 1000 on each axis rejects garbage without constraining any real device.
 */
export function parseTerminalDimensionsWire(payload: JsonValue): TerminalDimensionsWire {
  if (!isRecord(payload)) throw new Error('terminal dimensions must be an object');
  const cols = requireNumber(payload, 'cols', 'terminal dimensions');
  const rows = requireNumber(payload, 'rows', 'terminal dimensions');
  if (!Number.isInteger(cols) || cols < 2 || cols > 1000) throw new Error('terminal dimensions have an invalid "cols"');
  if (!Number.isInteger(rows) || rows < 1 || rows > 1000) throw new Error('terminal dimensions have an invalid "rows"');
  return { cols, rows };
}

/** True for a well-formed ActivityStateWire value. */
export function isActivityStateWire(value: unknown): value is ActivityStateWire {
  return value === 'thinking' || value === 'idle' || value === 'permission';
}

/**
 * True for a well-formed ActivityReasonWire value. A `waitKind` this version
 * does not know fails it; read a reason from the wire with
 * `parseActivityReasonWire`, which drops such a kind first.
 */
export function isActivityReasonWire(value: unknown): value is ActivityReasonWire {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'idle':
      return value.since === undefined || typeof value.since === 'number';
    case 'permission':
      return (value.since === undefined || typeof value.since === 'number')
        && (value.waitKind === undefined || isPermissionWaitKindWire(value.waitKind));
    case 'turn-active':
      return true;
    case 'tool':
      return typeof value.pendingCount === 'number' && (value.currentTool === null || typeof value.currentTool === 'string');
    case 'subagent':
      return typeof value.depth === 'number';
    case 'background-shell':
      return typeof value.count === 'number' && Array.isArray(value.ids) && value.ids.every((id) => typeof id === 'string');
    default:
      return false;
  }
}

/**
 * Reads an activity reason off the wire: the value when it is a well-formed
 * ActivityReasonWire, else null. A `permission` reason's `waitKind` that this
 * version does not know (from a newer desktop) is dropped, not rejected, so
 * the reason reads as a wait of unknown kind and the event that carries it
 * still parses.
 */
export function parseActivityReasonWire(value: unknown): ActivityReasonWire | null {
  if (isRecord(value) && value.kind === 'permission' && value.waitKind !== undefined && !isPermissionWaitKindWire(value.waitKind)) {
    const { waitKind: _unknownWaitKind, ...withoutWaitKind } = value;
    return isActivityReasonWire(withoutWaitKind) ? withoutWaitKind : null;
  }
  return isActivityReasonWire(value) ? value : null;
}

/** Narrows a usage payload to the SessionUsageWire subset. Throws on a malformed required field. */
export function parseSessionUsageWire(payload: JsonValue): SessionUsageWire {
  if (!isRecord(payload)) throw new Error('usage payload must be an object');
  const contextWindow = payload.contextWindow;
  if (!isRecord(contextWindow)) throw new Error('usage payload is missing "contextWindow"');
  const cost = payload.cost;
  if (!isRecord(cost)) throw new Error('usage payload is missing "cost"');
  const model = payload.model;
  if (!isRecord(model)) throw new Error('usage payload is missing "model"');
  return {
    contextWindow: {
      usedPercentage: requireNumber(contextWindow, 'usedPercentage', 'usage contextWindow'),
      usedTokens: requireNumber(contextWindow, 'usedTokens', 'usage contextWindow'),
      cacheTokens: requireNumber(contextWindow, 'cacheTokens', 'usage contextWindow'),
      totalInputTokens: requireNumber(contextWindow, 'totalInputTokens', 'usage contextWindow'),
      totalOutputTokens: requireNumber(contextWindow, 'totalOutputTokens', 'usage contextWindow'),
      contextWindowSize: requireNumber(contextWindow, 'contextWindowSize', 'usage contextWindow'),
    },
    cost: {
      totalCostUsd: requireNumber(cost, 'totalCostUsd', 'usage cost'),
      totalDurationMs: requireNumber(cost, 'totalDurationMs', 'usage cost'),
    },
    ...(typeof payload.toolCallCount === 'number' ? { toolCallCount: payload.toolCallCount } : {}),
    model: {
      id: requireString(model, 'id', 'usage model'),
      displayName: requireString(model, 'displayName', 'usage model'),
      ...(typeof model.effort === 'string' ? { effort: model.effort } : {}),
    },
  };
}

/**
 * Narrows a session-summary payload to SessionSummaryWire. Throws on a
 * malformed required field.
 *
 * The numeric metrics are required rather than optional because the desktop
 * COALESCEs each to 0 before it sends them, so "no data" arrives as a real
 * zero. Making them optional here would invite a phone to render an em-dash
 * where the honest answer is 0.
 */
export function parseSessionSummaryWire(payload: JsonValue): SessionSummaryWire {
  if (!isRecord(payload)) throw new Error('session summary payload must be an object');
  return {
    sessionId: requireString(payload, 'sessionId', 'session summary'),
    totalCostUsd: requireNumber(payload, 'totalCostUsd', 'session summary'),
    totalInputTokens: requireNumber(payload, 'totalInputTokens', 'session summary'),
    totalOutputTokens: requireNumber(payload, 'totalOutputTokens', 'session summary'),
    modelDisplayName: requireString(payload, 'modelDisplayName', 'session summary'),
    durationMs: requireNumber(payload, 'durationMs', 'session summary'),
    toolCallCount: requireNumber(payload, 'toolCallCount', 'session summary'),
    compactionCount: requireNumber(payload, 'compactionCount', 'session summary'),
    linesAdded: requireNumber(payload, 'linesAdded', 'session summary'),
    linesRemoved: requireNumber(payload, 'linesRemoved', 'session summary'),
    filesChanged: requireNumber(payload, 'filesChanged', 'session summary'),
    taskCreatedAt: requireString(payload, 'taskCreatedAt', 'session summary'),
    startedAt: requireString(payload, 'startedAt', 'session summary'),
    exitedAt: typeof payload.exitedAt === 'string' ? payload.exitedAt : null,
    exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
  };
}

/** Narrows a session-event payload to SessionEventWire. Throws on a malformed required field. */
export function parseSessionEventWire(payload: JsonValue): SessionEventWire {
  if (!isRecord(payload)) throw new Error('session event payload must be an object');
  return {
    ts: requireNumber(payload, 'ts', 'session event'),
    type: requireString(payload, 'type', 'session event'),
    ...(typeof payload.tool === 'string' ? { tool: payload.tool } : {}),
    ...(typeof payload.toolId === 'string' ? { toolId: payload.toolId } : {}),
    ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
  };
}

function parseStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${context} is not a string array`);
  }
  return value;
}

export function nullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' ? value : null;
}

export function nullableNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' ? value : null;
}

function nullableBoolean(record: Record<string, unknown>, field: string): boolean | null {
  const value = record[field];
  return typeof value === 'boolean' ? value : null;
}

/** Narrows one board-column row. Throws on a malformed required field. */
export function parseBoardColumnWire(value: JsonValue): BoardColumnWire {
  if (!isRecord(value)) throw new Error('board column must be an object');
  return {
    id: requireString(value, 'id', 'board column'),
    name: requireString(value, 'name', 'board column'),
    description: nullableString(value, 'description'),
    // An unrecognized role passes through rather than throwing: it is a
    // custom column (or a future system role this package predates), not a
    // malformed payload. See the BoardColumnRoleWire doc comment.
    role: nullableString(value, 'role'),
    position: requireNumber(value, 'position', 'board column'),
    color: requireString(value, 'color', 'board column'),
    icon: nullableString(value, 'icon'),
    is_archived: requireBoolean(value, 'is_archived', 'board column'),
    is_ghost: requireBoolean(value, 'is_ghost', 'board column'),
    spawns_session: nullableBoolean(value, 'spawns_session'),
  };
}

/** Narrows one board-task row. Throws on a malformed required field. */
export function parseBoardTaskWire(value: JsonValue): BoardTaskWire {
  if (!isRecord(value)) throw new Error('board task must be an object');
  return {
    id: requireString(value, 'id', 'board task'),
    display_id: requireNumber(value, 'display_id', 'board task'),
    title: requireString(value, 'title', 'board task'),
    description: typeof value.description === 'string' ? value.description : '',
    swimlane_id: requireString(value, 'swimlane_id', 'board task'),
    position: requireNumber(value, 'position', 'board task'),
    agent: nullableString(value, 'agent'),
    session_id: nullableString(value, 'session_id'),
    worktree_path: nullableString(value, 'worktree_path'),
    branch_name: nullableString(value, 'branch_name'),
    pr_number: nullableNumber(value, 'pr_number'),
    pr_url: nullableString(value, 'pr_url'),
    pr_state: nullableString(value, 'pr_state'),
    pr_merge_readiness: nullableString(value, 'pr_merge_readiness'),
    base_branch: nullableString(value, 'base_branch'),
    labels: Array.isArray(value.labels) ? parseStringArray(value.labels, 'board task labels') : [],
    priority: typeof value.priority === 'number' ? value.priority : 0,
    attachment_count: typeof value.attachment_count === 'number' ? value.attachment_count : 0,
    archived_at: nullableString(value, 'archived_at'),
    created_at: requireString(value, 'created_at', 'board task'),
    updated_at: requireString(value, 'updated_at', 'board task'),
    spawn_progress: nullableString(value, 'spawn_progress'),
    resumable: nullableBoolean(value, 'resumable'),
    paused: nullableBoolean(value, 'paused'),
    paused_session_id: nullableString(value, 'paused_session_id'),
    pausable: nullableBoolean(value, 'pausable'),
    automations_disabled: nullableBoolean(value, 'automations_disabled'),
    workflow: parseBoardTaskWorkflowWire(value.workflow),
  };
}

/**
 * A board task's workflow, or null when absent or unreadable. Lenient on
 * purpose: a malformed workflow costs the card its strip, never the board.
 */
export function parseBoardTaskWorkflowWire(value: JsonValue | undefined): BoardTaskWorkflowWire | null {
  if (value === undefined || !isRecord(value)) return null;
  const strings = (field: JsonValue | undefined): string[] =>
    Array.isArray(field) ? field.filter((entry): entry is string => typeof entry === 'string') : [];
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.project_id !== 'string') return null;
  return {
    id: value.id,
    title: value.title,
    project_id: value.project_id,
    state: typeof value.state === 'string' ? value.state : 'running',
    color_slot: typeof value.color_slot === 'number' ? value.color_slot : 1,
    route: strings(value.route),
    waiting_for: strings(value.waiting_for),
    lock_reason: typeof value.lock_reason === 'string' ? value.lock_reason : null,
    gate_target_id: typeof value.gate_target_id === 'string' ? value.gate_target_id : null,
    automations_pausable: typeof value.automations_pausable === 'boolean' ? value.automations_pausable : null,
  };
}

/**
 * Narrows one Command Terminal row. Throws on a malformed required field. An
 * unrecognized activity state or reason reads as null rather than throwing, so
 * a reason kind a newer desktop adds costs the line, not the whole snapshot.
 */
export function parseCommandTerminalWire(value: JsonValue): CommandTerminalWire {
  if (!isRecord(value)) throw new Error('command terminal must be an object');
  const activity = isRecord(value.activity) ? value.activity : {};
  return {
    sessionId: requireString(value, 'sessionId', 'command terminal'),
    projectId: requireString(value, 'projectId', 'command terminal'),
    slot: requireNumber(value, 'slot', 'command terminal'),
    name: requireString(value, 'name', 'command terminal'),
    named: requireBoolean(value, 'named', 'command terminal'),
    activity: {
      state: isActivityStateWire(activity.state) ? activity.state : null,
      reason: parseActivityReasonWire(activity.reason),
    },
  };
}

/** Narrows one backlog-item row. Throws on a malformed required field. */
export function parseBacklogItemWire(value: JsonValue): BacklogItemWire {
  if (!isRecord(value)) throw new Error('backlog item must be an object');
  return {
    id: requireString(value, 'id', 'backlog item'),
    title: requireString(value, 'title', 'backlog item'),
    description: typeof value.description === 'string' ? value.description : '',
    priority: typeof value.priority === 'number' ? value.priority : 0,
    labels: Array.isArray(value.labels) ? parseStringArray(value.labels, 'backlog item labels') : [],
    position: requireNumber(value, 'position', 'backlog item'),
    item_type: nullableString(value, 'item_type'),
    external_url: nullableString(value, 'external_url'),
    attachment_count: typeof value.attachment_count === 'number' ? value.attachment_count : 0,
    created_at: requireString(value, 'created_at', 'backlog item'),
    updated_at: requireString(value, 'updated_at', 'backlog item'),
  };
}

/** Narrows a read-diff file-list payload. Throws on a malformed required field. */
export function parseDiffFileListWire(payload: JsonValue): DiffFileListWire {
  if (!isRecord(payload)) throw new Error('diff file list must be an object');
  if (!Array.isArray(payload.files)) throw new Error('diff file list is missing "files"');
  const files = payload.files.map((file, index) => {
    if (!isRecord(file)) throw new Error(`diff file entry ${index} must be an object`);
    const status = requireString(file, 'status', `diff file entry ${index}`);
    if (!DIFF_FILE_STATUSES.includes(status)) throw new Error(`diff file entry ${index} has an invalid "status"`);
    return {
      path: requireString(file, 'path', `diff file entry ${index}`),
      status: status as DiffFileStatusWire,
      insertions: requireNumber(file, 'insertions', `diff file entry ${index}`),
      deletions: requireNumber(file, 'deletions', `diff file entry ${index}`),
      ...(typeof file.oldPath === 'string' ? { oldPath: file.oldPath } : {}),
      binary: requireBoolean(file, 'binary', `diff file entry ${index}`),
    };
  });
  return {
    files,
    totalInsertions: requireNumber(payload, 'totalInsertions', 'diff file list'),
    totalDeletions: requireNumber(payload, 'totalDeletions', 'diff file list'),
  };
}

/** Narrows a read-diff single-file payload. Throws on a malformed required field. */
export function parseDiffFileContentWire(payload: JsonValue): DiffFileContentWire {
  if (!isRecord(payload)) throw new Error('diff file content must be an object');
  return {
    original: requireString(payload, 'original', 'diff file content'),
    modified: requireString(payload, 'modified', 'diff file content'),
    language: requireString(payload, 'language', 'diff file content'),
  };
}
