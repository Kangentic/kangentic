import type { PopOutDescriptor, PopOutKind, PopOutParamsByKind } from './pop-out';
import type {
  Announcement,
  AnnouncementArchiveEntry,
  AnnouncementsChangedPayload,
} from './announcements';

// === Database Models ===

export interface ProjectGroup {
  id: string;
  name: string;
  position: number;
  is_collapsed: boolean;
}

export interface ProjectGroupCreateInput {
  name: string;
}

/**
 * A dev-server port reserved by one task, held in the GLOBAL database because
 * ports are a shared resource across every project in the instance.
 *
 * A reservation is advisory, and a promise rather than a fact: whether a port
 * is actually usable is answered by a bind probe (`describeDevPorts`), never by
 * this row. That split is deliberate - it is what lets a stale reservation
 * self-correct instead of permanently burning a port, and it is the only way to
 * see a dev server the user started outside Kangentic on a port nothing here
 * ever handed out.
 */
export interface DevPortLease {
  port: number;
  projectId: string;
  taskId: string;
  allocatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  github_url: string | null;
  default_agent: string;
  /** Project-level default model, applied below the column override and above the CLI default. Null means no project preference. */
  default_model: string | null;
  /** Project-level default effort/reasoning level. Null means no project preference. */
  default_effort: string | null;
  group_id: string | null;
  position: number;
  last_opened: string;
  created_at: string;
}

/**
 * Adapter-declared affordance shown by ContextBar when the agent CLI
 * exposes no live-telemetry channel (no statusFile / sessionHistory /
 * streamOutput pipeline can be wired). Omit entirely for agents whose
 * `runtime` populates SessionUsage normally - that is the common case.
 *
 * The label and tooltip live with the adapter so agent-specific copy
 * stays inside `src/main/agent/adapters/<agent>/`. The renderer treats
 * this as a generic "telemetry unavailable" signal and never branches
 * on agent name.
 */
export interface AgentLiveTelemetryUnsupported {
  /** Pill text shown in place of the loading spinner. */
  unavailableLabel: string;
  /** Tooltip title shown on the pill (multi-line allowed). */
  unavailableTitle: string;
}

/**
 * Adapter-discovered capabilities surfaced to the renderer. All fields are
 * derived from the live CLI (e.g. parsing `--help`) or runtime probes; nothing
 * is hardcoded in Kangentic. Adapters that cannot discover a capability simply
 * leave the field undefined and the corresponding UI control is not rendered.
 */
export interface AgentCapabilities {
  /** Effort/reasoning levels accepted by the CLI's `--effort` (or equivalent) flag. */
  effortLevels?: string[];
  /**
   * True when the CLI accepts a model override flag (e.g. Claude `--model <alias>`).
   * Set independently of `models`: when true and `models` has entries, the
   * renderer shows a dropdown; when true and `models` is empty/undefined, the
   * renderer falls back to a free-form text input.
   */
  supportsModelOverride?: boolean;
  /**
   * Model identifiers the user can pick from. Discovered from the same sources
   * the agent's own picker uses (e.g. Claude reads `availableModels` from the
   * user/project settings hierarchy). Absent when the user has not curated a
   * list - the renderer falls back to a free-form text input in that case.
   */
  models?: string[];
  /**
   * Friendly display name per entry in `models` (e.g. `claude-opus-4-8` ->
   * "Opus 4.8"), computed by the adapter so no agent-naming knowledge lives in
   * shared or renderer code. An id absent from this map (or when the map
   * itself is absent) falls back to showing its raw id.
   */
  modelDisplayNames?: Record<string, string>;
}

export interface AgentDetectionInfo {
  name: string;
  displayName: string;
  found: boolean;
  path: string | null;
  version: string | null;
  /** True = logged in, false = installed but not authenticated, null/undefined = N/A or not probed. */
  authenticated?: boolean | null;
  permissions: AgentPermissionEntry[];
  defaultPermission: PermissionMode;
  /** Set by adapters that have no live-telemetry channel - drives the ContextBar fallback pill. */
  liveTelemetryUnsupported?: AgentLiveTelemetryUnsupported;
  /** True if the adapter streams account-wide rate-limit windows; gates the ContextBar
   *  rate-limit pill so any session of this agent shows the shared global snapshot. */
  reportsRateLimits?: boolean;
  /** Template for the text injected when a clipboard/dropped image is captured to a temp PNG
   *  (e.g. "Read this image: {path} "), so the agent reliably reads it as an image instead of
   *  treating a bare file path as inert text. Undefined = inject the bare quoted path. */
  pastedImageReferenceTemplate?: string;
  /** True if the adapter exposes a one-shot summarize capability (used by auto-name task title). */
  supportsSummarize?: boolean;
  /** Discovered at detection time; absent for adapters that do not implement discovery. */
  capabilities?: AgentCapabilities;
  /** Present when the adapter can attach to a user-run server instead of spawning locally.
   *  Absent = this agent has no remote-execution capability; the Agent settings tab never
   *  renders remote rows for it. */
  remoteExecution?: AgentRemoteExecutionInfo;
  /** Optional boolean startup toggles this agent CLI exposes (e.g. Codex's "Disable ChatGPT
   *  Apps"). Absent/empty = this agent declares none; the Agent settings tab renders nothing. */
  launchOptions?: readonly AgentLaunchOptionInfo[];
}

/**
 * Renderer-facing description of a single adapter-declared launch-option toggle
 * (`AgentAdapter.launchOptions`). Declares shape and copy only - never a value - so the Agent
 * settings tab can render a toggle for any agent without branching on agent name
 * (agent-adapters-boundary.md). The adapter interprets `id` into whatever CLI flag it needs;
 * nothing outside the adapter knows the mapping.
 */
export interface AgentLaunchOptionInfo {
  /** Stable id, used as the config key under `agent.launchOptions[agentName]`. Never renamed. */
  id: string;
  label: string;
  description: string;
  /** Value used when the user has not set one. */
  default: boolean;
}

/**
 * Renderer-facing description of an adapter's remote-execution capability
 * (`AgentAdapter.remoteExecution`, mirrored here by `agent-list.ts`). Declares
 * shape only - never a value - so the Agent settings tab can render the
 * right fields without branching on agent name.
 */
export interface AgentRemoteExecutionInfo {
  /** Placeholder text for the Server URL field (e.g. "http://10.0.0.5:4096"). */
  urlPlaceholder: string;
  authKind: 'basic' | 'bearerEnv' | 'none';
  /** Whether the server working directory is supplied per-invocation (OpenCode's
   *  `--dir`) or fixed when the server itself starts (Qwen's `--workspace`). A
   *  'server-bound' agent can serve only one directory per running server. */
  workingDirectoryScope: 'per-invocation' | 'server-bound';
  /** Optional adapter-authored caveat shown under the remote fields (e.g. which
   *  Kangentic features are unavailable in remote mode). Renderer just renders
   *  whatever string is present - never branches on agent name to decide the
   *  copy (agent-adapters-boundary.md). Mirrors `AgentLiveTelemetryUnsupported`'s
   *  adapter-declared-copy shape. */
  remoteModeCaveat?: string;
}

/** Credentials for reaching an agent's remote execution server. Shape is a
 *  discriminated union because different agents authenticate differently
 *  (OpenCode: HTTP basic; Codex: a bearer token supplied via an env var NAME,
 *  never the value itself, so the secret never leaves the user's own shell). */
export type AgentExecutionServerAuth =
  | { kind: 'none' }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'bearerEnv'; envVarName: string };

/** Global, agent-keyed server identity - "where does this agent's remote server
 *  live and how do I authenticate to it". Machine-scoped: not project-overridable,
 *  mirrors `agent.cliPaths`. */
export interface AgentExecutionServer {
  url: string | null;
  auth: AgentExecutionServerAuth;
}

/** Per-project, agent-keyed usage of that server - "does THIS project run this
 *  agent locally or remotely, and if remote, in which server-side directory". */
export interface AgentProjectExecution {
  mode: 'local' | 'remote';
  /** Path on the server. Ignored/unused for a 'server-bound' agent's workingDirectoryScope. */
  workingDirectory: string | null;
}

/** The flattened value threaded through a spawn once a project resolves to
 *  remote mode for an agent - global server identity + this project's directory. */
export interface ResolvedExecutionTarget {
  url: string;
  auth: AgentExecutionServerAuth;
  workingDirectory: string | null;
}

/** Result of probing a remote execution server for reachability. */
export type RemoteServerStatus =
  | {
      reachable: true;
      version: string | null;
      /** Whole milliseconds from request start to response headers. Optional
       *  rather than nullable like `version` because only probes that actually
       *  time their request report it: the relay probe does, the agent
       *  execution-server probe does not, and making it required would force a
       *  value out of every adapter's `probeServer`. */
      latencyMs?: number;
    }
  | { reachable: false; reason: string };

export interface AgentSummarizeInput {
  /** Free-form text to summarize into a short task title. */
  prompt: string;
  /** Optional: a specific agent name. Defaults to the active project's default agent. */
  agentName?: string;
}

export type AgentSummarizeResult =
  | { ok: true; title: string }
  | { ok: false; reason: string };

export type ProjectSearchEntryKind = 'file' | 'directory';

export interface ProjectSearchEntry {
  path: string;
  kind: ProjectSearchEntryKind;
  parentPath?: string;
}

export interface ProjectSearchEntriesInput {
  cwd: string;
  query: string;
  limit: number;
}

export interface ProjectSearchEntriesResult {
  entries: ProjectSearchEntry[];
  truncated: boolean;
}

/**
 * How `relocate` treats the project folder.
 * - `repoint` (default): the folder was already moved/renamed outside
 *   Kangentic; just re-point the project at it (validates it exists).
 * - `move`: Kangentic moves the folder to `newPath` itself (one-step move),
 *   then relocates. The destination must NOT already exist.
 */
export type ProjectRelocateMode = 'repoint' | 'move';

export interface ProjectRelocateOptions {
  mode?: ProjectRelocateMode;
}

/**
 * Non-fatal conditions a relocation can finish with. `source-delete-failed`
 * means a cross-volume move copied to the new location and relocated cleanly,
 * but the original folder could not be fully removed afterward (it remains on
 * disk).
 */
export type ProjectRelocateWarning = 'source-delete-failed';

export interface ProjectRelocateResult {
  project: Project;
  warnings: ProjectRelocateWarning[];
}

/**
 * Progress pushed to the renderer while a one-step move is in flight.
 * `moving` = an atomic rename is in flight (indeterminate). `copying` = a
 * cross-volume copy is running (determinate via copiedEntries/totalEntries).
 */
export interface ProjectMoveProgress {
  projectId: string;
  phase: 'moving' | 'copying';
  copiedEntries: number;
  totalEntries: number;
}

/** Normalized, platform-agnostic pull-request state. */
export type PRState = 'open' | 'draft' | 'merged' | 'closed';

/**
 * Outcome of an on-demand PR resolve. `linked`/`unchanged` mean a PR is associated;
 * `not-found`/`no-anchor` mean none was found; `resolver-unavailable` means the
 * provider CLI is missing/unauthenticated; `transient-error` means the check
 * failed temporarily (network/5xx/timeout) and the existing link was preserved.
 */
export type PRLinkStatus = 'linked' | 'unchanged' | 'not-found' | 'no-anchor' | 'resolver-unavailable' | 'transient-error';

/**
 * How a task gets its agent settings. Exactly one mode is live at a time, and
 * the choice is explicit rather than derived from "are any pins set" - those
 * are two different behaviours even when every field reads as inherited:
 *
 *   - `'column_settings'` - the task follows each column it moves through, for
 *     its whole life. `profile_id` selects WHICH set of column settings applies
 *     (null = the board as configured, non-null = that Board Profile's ladder).
 *   - `'agent_override'` - agent / model / effort / permission are pinned for
 *     the task. Fields left on inherit are still resolved dynamically until the
 *     task's first ever spawn, which locks all four
 *     (`lockAdvancedOverridesOnFirstSpawn`).
 *
 * Named for the two radio labels the New Task / Edit dialog shows, so the stored
 * value and the control the user clicked read the same. Deriving the mode from
 * the pins used to lose "Agent Override with everything inherited" on every save.
 */
export type TaskRunMode = 'column_settings' | 'agent_override';

export interface Task {
  id: string;
  display_id: number;
  title: string;
  description: string;
  swimlane_id: string;
  position: number;
  agent: string | null;
  session_id: string | null;
  worktree_path: string | null;
  /**
   * The directory NAME (not path) of this task's worktree, chosen exactly once
   * and never changed. New tasks get `String(display_id)`; tasks that predate
   * that scheme keep their legacy `<slug>-<taskId8>` name, so nothing on disk is
   * ever renamed or relocated.
   *
   * This exists because a Done move nulls `worktree_path`, which makes the move
   * back out a fresh creation. Without a durable record, a pre-existing task
   * would be recreated under the new scheme at a different path, orphaning its
   * agent transcript (keyed by a slug of the cwd) and its browser cookie jar
   * (keyed by a hash of the path). See `WorktreeManager.createWorktree`.
   *
   * Invariant: whenever `worktree_path` is non-null,
   * `path.basename(worktree_path) === worktree_folder`.
   */
  worktree_folder: string | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_url: string | null;
  /** Normalized PR state from the authoritative branch->PR resolver. null when no PR is linked or it was linked before state tracking. */
  pr_state: PRState | null;
  /** Last-captured worktree HEAD commit SHA. Immutable anchor for resolving the PR after the worktree is reclaimed (Done) or the branch is renamed. null until captured. */
  head_sha: string | null;
  /** External origin, carried through when this task was promoted from an imported backlog item. Lets import dedup stay aware of promoted (and archived) tasks. null for tasks created directly. */
  external_id: string | null;
  external_source: string | null;
  external_url: string | null;
  base_branch: string | null;
  use_worktree: number | null;
  labels: string[];
  priority: number;
  /** Per-task model override set via the ContextBar popover or locked at first spawn (see `lockAdvancedOverridesOnFirstSpawn`). Takes precedence over the swimlane's `model_override`; null inherits the swimlane (or agent default). */
  model_override: string | null;
  /** Per-task effort override set via the ContextBar popover or locked at first spawn (see `lockAdvancedOverridesOnFirstSpawn`). Takes precedence over the swimlane's `effort_override`; null inherits the swimlane (or agent default). */
  effort_override: string | null;
  /** Per-task agent override set at task creation. When non-null, wins over the swimlane's `agent_override` and the project default for the task's entire lifetime - column moves cannot change the agent. Set via the New Task dialog's Advanced section or locked at first spawn (`lockAdvancedOverridesOnFirstSpawn`); the ContextBar popover does not edit this. */
  agent_override: string | null;
  /** Per-task permission mode override. Takes precedence over the swimlane's `permission_mode` and the project's default permission mode, same as `model_override`/`effort_override` - EXCEPT when the destination swimlane forces `permission_mode: 'plan'`, which always wins regardless of this field: plan mode is a genuine safety guarantee (never let a task's Auto-Classifier/Accept-Edits pin bypass a deliberate read-only phase), not just an ordinary column default like every other permission mode. Null inherits. Set via the New Task dialog's Advanced section / the task-detail edit form, or locked at first spawn alongside agent/model/effort (`lockAdvancedOverridesOnFirstSpawn`) so a task with ANY Advanced override runs under the permission the dialog displayed, not the destination column's. */
  permission_mode: PermissionMode | null;
  /** Per-task initial command, injected once the agent spawns for this task. MCP-only (set via `kangentic_create_task`'s `autoCommand` param); not surfaced in the UI. Takes precedence over the profile's and then the swimlane's `auto_command` for this task only; null inherits. Deliberately NOT part of the profile/direct-override exclusivity set (it is an MCP escape hatch, not an Advanced pin), so a task may carry both this and `profile_id`. */
  auto_command: string | null;
  /**
   * The Board Profile (`kangentic.json` `profiles`) whose per-column strategy
   * deltas this task follows as it moves across the board. Null = the synthetic
   * "Default" profile, i.e. the columns' own base settings.
   *
   * MUTUALLY EXCLUSIVE with the four Advanced pins (`agent_override`,
   * `model_override`, `effort_override`, `permission_mode`), enforced in
   * `TaskRepository`: a task either pins one set of values for its whole life OR
   * rides a per-column ladder, never both. Setting this therefore also forces
   * `run_mode` to `'column_settings'` and clears all four pins, in the same
   * write (`applyProfileExclusivity`). That exclusivity is load-bearing - a
   * profile task never reaches `lockAdvancedOverridesOnFirstSpawn`, which is
   * what stops the first-spawn lock from freezing the ladder at column 1.
   *
   * An id naming no known profile degrades to Default rather than throwing: the
   * profiles live in a checked-in file while this column lives in the local DB,
   * so a teammate deleting a profile must never wedge an in-flight task.
   */
  profile_id: string | null;
  /**
   * Which of the two run modes the user chose (see `TaskRunMode`). Persisted
   * rather than derived, because "Agent Override with all four fields left on
   * inherit" and "Column Settings" store an identical set of nulls, yet mean
   * opposite things: the first locks all four at first spawn, the second never
   * locks. Mutually exclusive with `profile_id` in the same sense the pins are -
   * `'agent_override'` clears it, and setting it forces `'column_settings'`.
   */
  run_mode: TaskRunMode;
  attachment_count: number;
  /**
   * Outcome of this task's most recent auto_command injection - the durable
   * half of the two sinks in `auto-command-outcome.ts` (the other being the
   * transient `task:autoCommandResult` notice). All four stay null until a
   * first injection runs.
   *
   * Declared here because `SELECT t.*` already returns these columns on every
   * task read, so omitting them made `Task` describe a narrower shape than it
   * actually carries over IPC - present at runtime, unreachable to a typed
   * consumer.
   */
  auto_command_state: AutoCommandState | null;
  /** The command text that was attempted, joined with ' | ' when a burst carried several. */
  auto_command_text: string | null;
  /** User-facing failure prose, set only when `auto_command_state` is 'failed'. */
  auto_command_error: string | null;
  /** When that outcome was recorded (UTC ISO 8601). */
  auto_command_at: string | null;
  /** Serialized `TaskDetailViewState` (JSON) persisting the task-detail dialog's layout across restarts. null until the user changes the layout once. */
  detail_view_state: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Per-task detail-dialog layout, persisted as a JSON blob in
 * `tasks.detail_view_state` and hydrated back into the session store on task
 * load so reopening a task restores its layout across app restarts. Every
 * field is optional: an absent field falls back to its in-memory default.
 * Mirrors the per-task-keyed fields of `task-changes-panel-slice.ts`.
 *
 * Dialog "maximized" is intentionally NOT here: the task-detail window's
 * maximize is window-manager state (`toggleMaximizeWindow`) already persisted in
 * `AppConfig.workspaceByProject`, and the session-store `maximizedTasks` set
 * only ever holds the create-dialog sentinels, never a real task id.
 */
export interface TaskDetailViewState {
  /** Terminal / right-panel split ratio (0.25-0.75). */
  dividerRatio?: number;
  /** Changes side panel open. */
  changesOpen?: boolean;
  /** Browser side panel open. */
  browserOpen?: boolean;
  /** Changes panel split-vs-expanded mode. */
  changesViewMode?: 'split' | 'expanded';
  /** Selected diff file path in the Changes panel. */
  changesSelectedFile?: string;
  /** Reviewed (viewed) diff file paths. */
  changesViewedFiles?: string[];
  /** Live diff scope (working / staged / branch). */
  changesScope?: GitDiffScope;
  /** Manually-set file-tree width (px) in the Changes panel. */
  changesFileTreeWidth?: number;
  /** Selected commit OID in the Changes panel's history browser. Absent means "Uncommitted changes" (the default). */
  changesSelectedCommit?: string;
  /** Manually-set commit-history region height (px) in the Changes panel's vertical split. */
  changesHistoryHeight?: number;
}

export interface TaskAttachment {
  id: string;
  task_id: string;
  filename: string;
  file_path: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
}

export interface BacklogAttachment {
  id: string;
  backlog_task_id: string;
  filename: string;
  file_path: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
}

export type SwimlaneRole = 'todo' | 'done';

/**
 * Which session track a task runs on when it enters a column.
 * - 'main' (default): the task's main conversation (Anthropic's "main agent"),
 *   resumed as the task moves between normal columns.
 * - 'isolated': this column's own separate, independently-resumable session,
 *   keyed by the swimlane id (an "isolated context"). It does NOT inherit the
 *   main conversation, which suits work that should stay independent of it (for
 *   example, a code review). Leaving an isolated column resumes the main session.
 *
 * Modeled as an enum (not a boolean) so future tracks can be added without a
 * schema migration. Only 'main' and 'isolated' are implemented today.
 */
export type SessionTarget = 'main' | 'isolated';

/**
 * What a column does with its target session track on entry.
 * - 'create_or_resume' (default): resume the track's session if one exists for
 *   this (task, target), else spawn a fresh one.
 * - 'always_spawn_new': always spawn a fresh session on entry, retiring the
 *   prior session for that (task, target). This is the independent-pass-each-time
 *   behavior (the reviewer archetype). Fresh applies on column entry only; an
 *   app restart / pause-resume of an in-progress session still resumes it.
 */
export type SessionSpawnStrategy = 'create_or_resume' | 'always_spawn_new';

export interface Swimlane {
  id: string;
  name: string;
  /** Free-form description of the column's purpose. Shown as a header tooltip and shared with the team via kangentic.json. Null when unset. */
  description: string | null;
  role: SwimlaneRole | null;
  position: number;
  color: string;
  icon: string | null;
  is_archived: boolean;
  is_ghost: boolean;
  permission_mode: PermissionMode | null;
  auto_spawn: boolean;
  auto_command: string | null;
  /** When this column's auto_command fires (see AutoCommandMode). Defaults to 'immediate'. */
  auto_command_mode: AutoCommandMode;
  plan_exit_target_id: string | null;
  agent_override: string | null;
  /** Free-form model identifier (e.g. "opus", "sonnet", "claude-opus-4-7"). Adapter-specific; null inherits the agent default. */
  model_override: string | null;
  /** Adapter-specific effort/reasoning level (e.g. Claude's "low" | "medium" | "high" | "xhigh" | "max"). Null inherits the agent default. */
  effort_override: string | null;
  handoff_context: boolean;
  /** Which session track a task runs on in this column (see SessionTarget). Defaults to 'main'. */
  session_target: SessionTarget;
  /** What to do with that track on entry (see SessionSpawnStrategy). Defaults to 'create_or_resume'. */
  session_spawn_strategy: SessionSpawnStrategy;
  created_at: string;
}

/**
 * When a column's `auto_command` is delivered to the agent.
 *
 * - `immediate` (default) inject as soon as the task lands in the column,
 *   interrupting the agent's current turn if there is one. The interruption is
 *   reported to the user rather than being silent.
 * - `deferred` hold until the agent's current turn genuinely finishes, then
 *   inject. "Finished" is the two-signal turn-completion predicate (idle AND a
 *   quiet PTY), not a timer and not a bare idle check - see
 *   `src/main/transition-engine/turn-completion.ts` for why a bare idle is not
 *   safe here.
 */
export type AutoCommandMode = 'immediate' | 'deferred';

/**
 * Terminal state of one auto_command delivery.
 *
 * `unconfirmed` is NOT a failure, and the distinction is load-bearing: only
 * Claude currently implements `getSubmissionVerifier('command-injection')`, so
 * on every other agent a delivery can only ever land here. Treating it as a
 * failure would make the field meaningless off Claude and would turn a normal
 * delivery into an error notice for most users.
 *
 * `escalated` means keystrokes could not be confirmed, so the session was
 * restarted and the command handed to the CLI as its prompt argument. Delivery
 * is guaranteed by the spawn, so it is not a failure - but no verifier saw it
 * land, so it is deliberately not `confirmed` either.
 */
export type AutoCommandState = 'confirmed' | 'unconfirmed' | 'escalated' | 'failed' | 'cancelled';

/** Payload of the `task:autoCommandResult` push event. */
export interface AutoCommandResultNotice {
  taskId: string;
  taskTitle: string;
  projectId?: string;
  state: AutoCommandState;
  /** The command text that was attempted. */
  command: string;
  /** Set when `state` is 'failed'; already user-facing prose. */
  reason?: string;
  /** Unsent text that was cleared off the prompt to make room, if any. */
  discardedDraft?: string;
  /** True when delivery interrupted a turn the agent was in the middle of. */
  interruptedTurn: boolean;
  /** True when delivery only succeeded by restarting the session. */
  escalated: boolean;
}

export type ActionType =
  | 'create_worktree'
  | 'spawn_agent'
  | 'send_command'
  | 'create_pr'
  | 'run_script'
  | 'cleanup_worktree'
  | 'kill_session'
  | 'webhook';

export interface Action {
  id: string;
  name: string;
  type: ActionType;
  config_json: string;
  created_at: string;
}

export interface ActionConfig {
  // create_worktree
  baseBranch?: string;
  copyFiles?: string[];

  // spawn_agent
  agent?: string;
  promptTemplate?: string;
  nonInteractive?: boolean;

  // send_command
  command?: string;

  // run_script
  script?: string;
  workingDir?: 'worktree' | 'project';

  // webhook
  url?: string;
  method?: 'GET' | 'POST' | 'PUT';
  body?: string;
  headers?: Record<string, string>;
}

export interface SwimlaneTransition {
  id: string;
  from_swimlane_id: string;
  to_swimlane_id: string;
  action_id: string;
  execution_order: number;
}

// === Session Management ===

export type SessionStatus = 'running' | 'queued' | 'exited' | 'suspended';

/**
 * Who reshaped the PTY. 'spawn' is the grid the PTY spawned at; the rest
 * mirror SessionManager.resize's origin parameter ('desktop' is any
 * renderer-driven fit, 'mobile' a paired phone's grid request, 'park' the
 * resting-grid park for unwatched sessions).
 */
export type PtyResizeOrigin = 'desktop' | 'mobile' | 'park' | 'spawn';

export interface Session {
  id: string;
  taskId: string;
  projectId: string;
  pid: number | null;
  status: SessionStatus;
  shell: string;
  cwd: string;
  startedAt: string;
  exitCode: number | null;
  /** True when this session was spawned as a resume of a previous session. */
  resuming: boolean;
  /** True for ephemeral command terminal sessions (no task association, no DB persistence). */
  transient?: boolean;
  /**
   * Parallel-session discriminator for the terminal badge. Null/undefined (main
   * session, or legacy/transient sessions) shows as "Main"; a swimlane id (the
   * column this session is isolated to) shows as "Isolated". See
   * SessionRecord.isolated_swimlane_id.
   */
  isolatedSwimlaneId?: string | null;
  /**
   * Agent-reported session ID (the value passed to `--resume`). Known at spawn
   * for caller-owned-ID adapters (Claude, Kimi, Qwen); set by the capture
   * pipeline once the agent emits it over the PTY or via hooks (OpenCode,
   * Codex, Gemini, Droid). Null until captured. Mirrors the persisted
   * SessionRecord.agent_session_id for the live session.
   */
  agentSessionId: string | null;
}

// === Session Persistence (DB) ===

export type SessionRecordStatus = 'running' | 'queued' | 'suspended' | 'exited' | 'orphaned';

export type SuspendedBy = 'user' | 'system';

export interface SessionRecord {
  id: string;
  task_id: string;
  session_type: string;
  /**
   * Parallel-session discriminator. NULL means this session is part of the task's
   * main session. A swimlane id means it is the separate, context-isolated session
   * that belongs to that 'isolated'-strategy column, letting one task hold
   * multiple independently-resumable sessions.
   */
  isolated_swimlane_id: string | null;
  agent_session_id: string | null;
  command: string;
  cwd: string;
  permission_mode: string | null;
  prompt: string | null;
  status: SessionRecordStatus;
  exit_code: number | null;
  started_at: string;
  suspended_at: string | null;
  exited_at: string | null;
  suspended_by: SuspendedBy | null;
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  model_id: string | null;
  model_display_name: string | null;
  /**
   * Model the session was actually spawned, resumed, or live-switched with (the
   * `--model` flag value; null = agent default / no flag). Ground truth for the
   * column-transition injection delta in `prepareInjectionPlan`: a move only
   * injects `/model` when this differs from the destination's effective model,
   * so a drifted column config never ghost-injects. Distinct from `model_id`,
   * which is the agent-reported model captured at exit via metrics.
   */
  applied_model: string | null;
  /**
   * Effort/reasoning level the session was actually spawned, resumed, or
   * live-switched with (the `--effort` flag value; null = agent default).
   * Sibling of `applied_model` for the effort field of the injection delta.
   */
  applied_effort: string | null;
  total_duration_ms: number | null;
  tool_call_count: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  files_changed: number | null;
  /** JSON-encoded `PerToolStat[]`. NULL for sessions captured before this column existed. */
  tool_breakdown: string | null;
  /** Context compactions during this record's CLI run (PreCompact hooks). Per-run; lifetime = SUM across the task's records. Defaults to 0. */
  compaction_count: number;
}

/**
 * Per-tool aggregate captured at session exit/suspend. Sourced from the
 * incremental tracker in UsageAccumulator so the totals are not truncated by
 * the bounded event-cache window. Cost/token fields are optional - they
 * are only populated if a future adapter starts emitting per-tool cost
 * on its ToolEnd event payload (see `SessionEvent.costUsd` etc.). The
 * renderer hides the corresponding columns when no row has the field set.
 */
export interface PerToolStat {
  toolName: string;
  callCount: number;
  /** Sum of (ToolEnd.ts - matching ToolStart.ts) over completed pairs. */
  totalDurationMs: number;
  /** Count of `interrupted` events (PostToolUseFailure). Subset of pairs that did not finish cleanly. */
  interruptedCount: number;
  /** Optional - reserved for adapters that emit per-tool cost. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Record of a cross-agent context handoff. */
export interface HandoffRecord {
  id: string;
  task_id: string;
  from_session_id: string | null;
  to_session_id: string | null;
  from_agent: string;
  to_agent: string;
  trigger: string;
  /** Absolute path to the source agent's native session history file, or null if unavailable. */
  session_history_path: string | null;
  created_at: string;
}

/**
 * Outcome of one `kangentic_send_session_message` ATTEMPT. Declared here rather
 * than beside the coordinator so the row type and the code that writes it share
 * one definition, with the dependency running shared -> main (never the
 * reverse). `delivered` and `queued` produced a turn; `refused` and `failed`
 * record an attempt only.
 */
export type SentSessionMessageStatus = 'delivered' | 'queued' | 'refused' | 'failed';

/**
 * One message sent into a session via `kangentic_send_session_message`, by
 * another agent or by a human steering it directly.
 *
 * The delivered text carries no in-band marker, so this row is the ONLY record
 * that a given turn arrived through the tool rather than being typed at the
 * keyboard. `message` is stored as the caller supplied it, which matches the
 * transcript turn it produced for ordinary prose - the paste path normalizes CR
 * to LF and strips C0 control characters, so a message containing those differs
 * from the delivered text by exactly that normalization.
 *
 * The caller fields are null when a human sent it with no Kangentic session of
 * their own, and are plain ids (not foreign keys) because a cross-project send
 * originates in a different project's database.
 */
export interface SentSessionMessage {
  id: string;
  /** The session that RECEIVED the message. */
  session_id: string;
  caller_session_id: string | null;
  caller_task_id: string | null;
  caller_project_id: string | null;
  message: string;
  /**
   * The attempt's outcome, not just its successes:
   * `delivered` (sent straight through), `queued` (held for the next idle
   * transition), `refused` (a guard rejected it - no turn produced), or
   * `failed` (delivery threw; whether a turn was produced is unknown).
   *
   * Reconstructing "which turns arrived this way" means filtering to
   * `delivered` / `queued`. The other two record an attempt, not a turn.
   */
  status: SentSessionMessageStatus;
  /** Refusal or failure detail. Null for a successful delivery. */
  error: string | null;
  created_at: string;
}

export interface SessionSummary {
  sessionId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  modelDisplayName: string;
  durationMs: number;
  toolCallCount: number;
  /** Lifetime context compactions across the task's sessions (SUM of per-run counts). */
  compactionCount: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  taskCreatedAt: string;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  /** Per-tool breakdown for the latest captured session record. Empty when missing. */
  toolBreakdown: PerToolStat[];
}

// === Session Activity (Claude Code Hooks) ===

/**
 * Top-level activity state.
 *
 * `'permission'` is a distinct state from `'idle'`: the agent has paused
 * waiting for user approval (a `PermissionRequest` hook fired). UI and
 * notifications differentiate this from a clean Stop because the user
 * needs to act, not just acknowledge.
 *
 * The renderer should treat `'permission'` like `'idle'` for spinner
 * purposes (no animated spinner) but render a distinct affordance
 * (lock icon, dot, etc.).
 */
export type ActivityState = 'thinking' | 'idle' | 'permission';

/**
 * Why the activity engine reports its current state. Discriminated
 * union exposed alongside `ActivityState` so the UI can render
 * context-aware affordances - different icons per `kind`, live counts,
 * tooltip text naming the current tool.
 *
 * Priority ladder (single source of truth in the engine's
 * `deriveActivityAndReason`):
 *   permission > tool > subagent > background-shell > turn-active > idle
 *
 * Kinds where the predicate is `'thinking'`: tool, subagent,
 * background-shell, turn-active. Others map to `'permission'` or
 * `'idle'`.
 *
 * `since` on the `idle`/`permission` variants is the epoch ms the session
 * FIRST needed the user (`SessionEngineState.needsUserSince`) - spans both
 * variants, so a `thinking -> permission -> idle` run reports the original
 * park time rather than resetting when permission resolves into idle. Lets
 * the UI render elapsed wait time next to the mail affordance.
 */
export type ActivityReason =
  | { kind: 'idle'; since: number }
  | { kind: 'permission'; since: number }
  | {
      kind: 'tool';
      pendingCount: number;
      /** Most recent ToolStart's tool name; null between tool calls. */
      currentTool: string | null;
    }
  | { kind: 'subagent'; depth: number }
  | {
      kind: 'background-shell';
      count: number;
      /** Identity-aware shell ids when extracted from hooks; empty for anonymous shells. */
      ids: readonly string[];
    }
  | { kind: 'turn-active' };

/**
 * Rich activity-engine state snapshot for the debug overlay
 * (Developer tab toggle). Surfaces internal counters + ring buffer of
 * recent transitions for diagnosing stuck-thinking / missed-idle bugs.
 *
 * IPC payload only - production renderer code uses `ActivityState` +
 * `ActivityReason`. Subscribed via `getActivityStats(sessionId)`.
 *
 * Keep the scalar fields in sync with the parallel `ActivityStatsSnapshot`
 * in `src/main/activity-engine/engine/shapes.ts` (the engine-internal copy).
 * `tests/unit/activity-stats-snapshot-parity.test.ts` fails if the two copies'
 * top-level fields drift (typecheck alone does not catch a one-sided field add).
 */
export interface ActivityStatsSnapshot {
  sessionId: string;
  activity: ActivityState;
  reason: ActivityReason;
  pendingToolCount: number;
  subagentDepth: number;
  backgroundShellIds: readonly string[];
  anonymousBackgroundShellCount: number;
  /** Named bg shells that opted out of holding the session active by carrying
   *  `NO_ACTIVITY_HOLD_FLAG` in their launching command (today: `/preview`'s
   *  watcher). Tracked for liveness by the process-tree watcher, but excluded
   *  from the predicate's background-shell term. */
  exemptBackgroundShellIds: readonly string[];
  turnActive: boolean;
  permissionPending: boolean;
  /** The tool_use_id awaiting a permission decision when `permissionPending` is true, else null. */
  permissionAwaitedToolId: string | null;
  msSinceLastSignal: number | null;
  /** Wall-clock ms of the most recent thinking-signal. Lets the
   *  debug-overlay timeline render the active watchdog deadline as
   *  `lastSignalAt + thresholdMs`. Null when no signal yet. */
  lastSignalAt: number | null;
  /** Wall-clock ms of the most recent PTY output chunk. The
   *  stuck-pending-tools watchdog uses the fresher of this and
   *  `lastSignalAt` so a streaming foreground tool is not force-idled.
   *  Null when no chunk yet. */
  lastPtyOutputAt: number | null;
  /** ms since the most recent PTY output chunk, or null when no chunk yet. */
  msSincePtyOutput: number | null;
  pendingIdleArmed: boolean;
  /** Wall-clock ms since the session first needed the user (idle or
   *  permission), or null while thinking. See `ActivityReason`'s `since`. */
  needsUserSince: number | null;
  /**
   * True between an `idle_hint` ("waiting for your input") notification and the
   * next genuine turn-initiating event. While set, the stuck-subagent and
   * stuck-pending-tools watchdogs use a SHORT grace instead of the 5-min cap, so
   * a counter left stuck by an aborted/errored turn is reclaimed fast. Surfaced
   * so the debug overlay can explain a fast watchdog fire. False in the common
   * case.
   */
  idleHintPending: boolean;
  /**
   * True while the session is held `thinking` through a live `turn_retrying`
   * retry (a transient StopFailure error the agent is auto-retrying mid-turn).
   * While set, the stale-thinking watchdog narrows its anchor to `lastSignalAt`
   * alone so parked-TUI retry repaints do not defer the 180s net. Surfaced so
   * the debug overlay can explain a narrowed retry hold, the retry-side analog
   * of `idleHintPending`. False in the common case.
   */
  retryFailurePending: boolean;
  recentTransitions: ReadonlyArray<{
    ts: number;
    from: ActivityState;
    /** Same as `from` for non-transition events that mutated counters
     *  without changing activity. */
    to: ActivityState;
    reasonKind: ActivityReason['kind'];
    /** Free-form trigger label - see TransitionTrigger in activity-engine.ts. */
    trigger: string;
    /** Plain-text summary of which counters/flags changed during this
     *  step (e.g. "tools +1", "bg -1, turn no"). Undefined when no
     *  observable counter shifted. */
    counterDelta?: string;
  }>;
  /**
   * Monotonic per-session tally of recovery / compensation events.
   * Increments on each watchdog fire or force-* call; never decrements.
   * Used by the debug overlay's counter strip to flag silent
   * compensations that don't visibly flip the activity pill. In a
   * clean session, all eight fields read 0.
   */
  compensationCounters: {
    /** `timer:stale-thinking` watchdog fires (turnActive held alone). */
    staleThinking: number;
    /** `timer:bg-shell-hatch` fires (orphan bg shell, watcher missed). */
    bgShellHatch: number;
    /** `timer:stuck-pending-tools` fires (Ctrl+C dropped PostToolUse). */
    stuckPendingTools: number;
    /** Heartbeat-recovery / PTY-tracker forced thinking transitions. */
    forceThinking: number;
    /** PTY-silence / shutdown forced idle transitions. */
    forceIdle: number;
    /** Unmatchable `background_shell_end` made a no-op (spurious end leaked). */
    unmatchedBgShellEnd: number;
    /** Empty-string `subagent_stop` (spurious inner-loop Stop) ignored, not counted. */
    ignoredInnerSubagentStop: number;
    /** `timer:stuck-subagent` fired (a named SubagentStop was dropped, depth reclaimed). */
    stuckSubagent: number;
  };
  /**
   * Bucketed PTY-chunk arrivals over the last ~120 seconds (100ms
   * buckets). Lets the debug-overlay timeline render streaming
   * intensity without piping raw chunk timestamps over IPC. Empty in
   * production builds where the recorder is dead-code-eliminated.
   */
  recentPtyChunks: ReadonlyArray<{
    /** Bucket lower bound in wall-clock ms (floor to 100ms). */
    tsBucket: number;
    /** Number of chunks observed during this bucket. */
    count: number;
  }>;
}

// === Typesafe Enums for Hook Events, Event Types, and Tool Names ===

/** SessionEvent.type values (final values written to JSONL by event-bridge). */
export const EventType = {
  Prompt: 'prompt',
  ToolStart: 'tool_start',
  ToolEnd: 'tool_end',
  Idle: 'idle',
  Interrupted: 'interrupted',
  /**
   * The turn ended because of a Claude Code service / API error (rate limit,
   * overload, server error, ...) rather than a normal completion. Sourced from
   * Claude Code's `StopFailure` hook, which fires INSTEAD of the regular `Stop`
   * on an aborted turn (see the claude adapter's hook-manager). Treated like
   * `Interrupted` by the engine - a hard turn-end that resets the in-flight
   * counters and commits idle immediately - so a lost subagent/tool stop in the
   * aborted turn cannot leave the session falsely "thinking" until a watchdog.
   * Kept DISTINCT from `Interrupted` (user Esc) so the activity log reads
   * "service error", with the error type carried in `detail` (e.g. "rate_limit").
   *
   * Reserved for a TERMINAL abort. A TRANSIENT, auto-retried error (529
   * overloaded / server_error / rate_limit) is classified at the source into
   * `TurnRetrying` instead - see that entry.
   */
  TurnFailed: 'turn_failed',
  /**
   * Claude Code fired `StopFailure` for a TRANSIENT, auto-retried API error
   * (overloaded / server_error / rate_limit / api_error) rather than a final
   * abort. Classified at the source by the Claude adapter's hook directive
   * (the Claude-specific error-string vocabulary lives there, not in the
   * engine - mirrors the `IdleHint` precedent), with the error type carried in
   * `detail`. Unlike `TurnFailed`, this does NOT force an immediate idle: while
   * the turn is genuinely live (no preceding `idle_hint`, `turnActive` still
   * set) the engine keeps the session `thinking` through the retry backoff and
   * defers the idle decision to the 180s stale-thinking watchdog, so a task
   * mid-retry no longer shows a false "needs you" idle. If the turn had already
   * wound down (an `idle_hint` preceded it) or already ended, it is treated
   * exactly like `TurnFailed` (immediate idle).
   */
  TurnRetrying: 'turn_retrying',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Notification: 'notification',
  /**
   * The agent signaled (out of band) that it is waiting for user input - e.g.
   * a Claude "Claude is waiting for your input" notification, classified at the
   * source by the adapter's hook directive (NOT by string-matching in the
   * engine). Unlike `Notification` (always log-only), the activity engine treats
   * `idle_hint` as turn-ending ONLY when nothing else is keeping the session
   * thinking (no pending tools, no subagents, no background shells, no pending
   * permission). Otherwise it is log-only. This lets a finished turn whose
   * `Stop`/`Idle` hook was dropped settle to idle through the normal stability
   * window instead of waiting out the 180s stale-thinking watchdog.
   */
  IdleHint: 'idle_hint',
  Compact: 'compact',
  TeammateIdle: 'teammate_idle',
  TaskCompleted: 'task_completed',
  ConfigChange: 'config_change',
  WorktreeCreate: 'worktree_create',
  WorktreeRemove: 'worktree_remove',
  /**
   * A Bash tool with `run_in_background: true` was launched. Emitted by
   * the event-bridge when PreToolUse sees tool_input.run_in_background.
   * Used by the activity state machine to keep the session as 'thinking'
   * even after a subsequent Stop, because the detached child outlives
   * the PostToolUse (which fires as soon as Claude returns the handle).
   * See `tests/e2e/background-shell-idle.spec.ts` for the full repro.
   */
  BackgroundShellStart: 'background_shell_start',
  /**
   * A KillBash tool call was invoked. The agent explicitly killed a
   * backgrounded shell; decrements the active-background-shells counter.
   * Natural completion of a background shell is NOT tracked (Claude Code
   * does not fire a hook for it), so the counter can over-estimate, but
   * that errs on the safe side (keep thinking while any shell *might* be
   * active).
   */
  BackgroundShellEnd: 'background_shell_end',
  /**
   * Fired by Qwen Code / Gemini CLI before each LLM API call within an
   * agent turn. Used for per-call visibility in the Activity tab; does
   * not change activity state (the agent is already 'thinking' from the
   * containing BeforeAgent).
   */
  ModelStart: 'model_start',
  /** Fired after each LLM API call returns. Log-only counterpart to ModelStart. */
  ModelEnd: 'model_end',
  /** Fired when the agent is choosing which tool to invoke next. Log-only. */
  ToolSelectionStart: 'tool_selection_start',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];


/** Agent tool names we detect/react to. */
export const AgentTool = {
  Bash: 'Bash',
  ExitPlanMode: 'ExitPlanMode',
} as const;
export type AgentTool = (typeof AgentTool)[keyof typeof AgentTool];

/**
 * Declarative mapping from EventType → ActivityState.
 * `null` means the event does not change the activity state (log-only).
 * `Record<EventType, ...>` ensures a compile error if a new EventType is
 * added without a mapping.
 */
export const EventTypeActivity: Record<EventType, ActivityState | null> = {
  // → thinking (agent actively working)
  [EventType.ToolStart]: 'thinking',
  [EventType.Prompt]: 'thinking',
  [EventType.SubagentStart]: 'thinking',
  [EventType.Compact]: 'thinking',
  [EventType.WorktreeCreate]: 'thinking',
  [EventType.BackgroundShellStart]: 'thinking',
  // → idle (agent waiting)
  [EventType.Idle]: 'idle',
  [EventType.Interrupted]: 'idle',
  [EventType.TurnFailed]: 'idle',
  // → null (no state change, log-only)
  [EventType.Notification]: null,
  // idle_hint is conditional: the engine ends the turn only when no other
  // signal is holding it thinking, otherwise it is log-only. There is no
  // single static activity for it, so it maps to null here.
  [EventType.IdleHint]: null,
  // turn_retrying is conditional, like idle_hint: the engine keeps the session
  // thinking for a live retry, or idles immediately if the turn had already
  // wound down. No single static activity, so it maps to null here (this map
  // is vestigial at runtime - see activity-engine.ts's isTurnInitiatingEvent).
  [EventType.TurnRetrying]: null,
  [EventType.SubagentStop]: null,
  [EventType.ToolEnd]: null,
  [EventType.SessionStart]: null,
  [EventType.SessionEnd]: null,
  [EventType.TeammateIdle]: null,
  [EventType.TaskCompleted]: null,
  [EventType.ConfigChange]: null,
  [EventType.WorktreeRemove]: null,
  [EventType.BackgroundShellEnd]: null,
  [EventType.ModelStart]: null,
  [EventType.ModelEnd]: null,
  [EventType.ToolSelectionStart]: null,
};

// === Session Events (Claude Code Hooks → Activity Log) ===

/**
 * Recognized reasons why a session went idle. The `detail` field on a
 * SessionEvent is polymorphic across event types (tool_start uses it for
 * file paths, subagent_start uses it for the subagent name), but for
 * `idle` events the value is one of these documented reasons. Compare
 * `event.detail` against these constants rather than string literals.
 */
export const IdleReason = {
  /** PermissionRequest hook fired - agent is blocked on user approval. */
  Permission: 'permission',
  /** Synthetic: the stale-thinking detector forced a transition. */
  Timeout: 'timeout',
  /** Synthetic: the PTY tracker matched a known prompt pattern. */
  Prompt: 'prompt',
  /** Synthetic: the PTY tracker's silence timer expired. */
  Silence: 'silence',
  /**
   * Synthetic: the bg-shell watcher detected a background shell's
   * process exited naturally (no KillBash, no BashOutput status).
   * Used as the `detail` of a synthetic `background_shell_end` event
   * emitted by `BgShellWatcher`.
   */
  NaturalExit: 'natural-exit',
} as const;
export type IdleReason = typeof IdleReason[keyof typeof IdleReason];

/**
 * Recognized reasons for a synthetic `prompt` event emitted by the PTY
 * activity tracker. Real Prompt events (from UserPromptSubmit hooks)
 * carry no detail; synthetic ones carry this marker so the renderer can
 * distinguish hook-driven prompts from PTY-inferred resumption.
 */
export const PromptReason = {
  PtyActivity: 'pty-activity',
} as const;
export type PromptReason = typeof PromptReason[keyof typeof PromptReason];

export interface SessionEvent {
  ts: number;
  type: EventType;
  tool?: string;    // for tool_start/tool_end/interrupted
  /**
   * Optional correlation id for tool events. When present, the
   * activity engine matches `tool_end` to its `tool_start` by id
   * instead of falling back to LIFO-by-name. This eliminates the
   * stale-currentTool drift when concurrent tools end out-of-order
   * and removes the duplicate-name ambiguity.
   *
   * Source: Claude Code's hook payload includes `tool_use_id` at the
   * top level on PreToolUse and PostToolUse. Other adapters that
   * surface a stable per-call identifier should populate this too.
   * Adapters without correlation IDs simply leave it undefined; the
   * engine falls back to name-matching automatically.
   */
  toolId?: string;
  /**
   * Polymorphic context for the event:
   * - For `tool_start`/`tool_end`: tool-specific info (file path, command)
   * - For `idle`: an `IdleReason` constant
   * - For `prompt`: a `PromptReason` constant (synthetic PTY path only)
   * - For `subagent_start`/`subagent_stop`: subagent type
   * - For `notification`: notification text
   * - For `idle_hint`: the source notification text that was classified as a
   *   waiting-for-input hint (e.g. "Claude is waiting for your input")
   */
  detail?: string;
  /**
   * Optional per-tool telemetry on `tool_end` events. Populated only when an
   * adapter exposes per-tool cost or tokens (none today). Reserved as the
   * extension point so future adapters can emit richer breakdowns without
   * any agent-name branching at the render layer.
   */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

// === Per-Adapter Submission Verification (TerminalSubmit: submitContent + submitKeystrokes) ===

/**
 * Unified submission verification for both paste-and-submit and command-injection contexts.
 * Each adapter implements `getSubmissionVerifier(contextType)` returning a verifier
 * callback or null when the context is not supported (caller uses fallback).
 *
 * Semantics: a verifier is a strong signal that *complements* (does not replace)
 * the engine's activity/data fallbacks. Paste-engine races the verifier against
 * the activity event listener and the post-`\r` data path; the first wins. A
 * verifier returning false therefore does not block the wait - the fallbacks
 * remain active for the rest of the window.
 */

/** Discriminated union for verification context. */
export type SubmissionContext =
  | { type: 'paste' }
  | {
      type: 'command-injection';
      text: string;
      agentSessionId?: string;
      cwd?: string;
      /**
       * Wall-clock timestamp (ms since epoch) of the most recent Enter write
       * that this verifier should match against. Bounds the JSONL scan window
       * so old entries are not mistakenly treated as confirmation.
       *
       * `TerminalSubmit.submitKeystrokes` advances this on each retry-Enter;
       * the verifier uses it to discard transcript entries older than
       * `sentAt - tolerance`.
       */
      sentAt?: number;
      /**
       * How strongly this command's delivery may be confirmed.
       *
       * - `command-match` the adapter emitted this itself (`/effort xhigh`),
       *   so the transcript must show a discrete invocation with exactly
       *   these args. Rejecting a combined-args entry is the point: that is
       *   how a swallowed Enter is detected.
       * - `submitted` a user-supplied auto_command. It may be plain prose or
       *   an unregistered `/foo`, so it cannot be required to parse as a
       *   registered slash command - only that EXACTLY this text became a
       *   user turn. Strictly weaker, therefore always available.
       *
       * Defaults to `command-match` when absent, preserving the behavior of
       * callers written before per-command modes existed.
       */
      mode?: 'command-match' | 'submitted';
    };

/** Context type for `getSubmissionVerifier()` parameter. */
export type SubmissionContextType = 'paste' | 'command-injection';

/**
 * Verifier callback that confirms a submission was processed.
 * - Paste context: confirms the pasted prompt was accepted by the agent.
 * - Command-injection context: confirms the injected command was parsed as written.
 */
export type SubmissionVerifier = (context: SubmissionContext) => Promise<boolean>;

// === Session Usage (Claude Code Status Line) ===

export interface RateLimitWindow {
  /** Stable adapter-defined key, e.g. 'five-hour', 'seven-day'. Used as React key. */
  id: string;
  /** Human-readable label, e.g. '5h session', '7d weekly'. Used in tooltips and aria-label. */
  label: string;
  /** Renderer maps this to a Lucide icon. Kept as a small enum so the renderer stays in charge of visual vocabulary. */
  iconKind: 'session' | 'period';
  /** 0-100, clamped by the adapter. */
  usedPercentage: number;
  /** Unix epoch seconds. */
  resetsAt: number;
  /**
   * Total window length in seconds, when the provider's window has a fixed
   * duration. With resetsAt this yields the window start
   * (resetsAt - windowDurationSeconds), which drives the renderer's
   * elapsed-time marker. Optional: an adapter whose window has no fixed length
   * omits it, and the renderer simply draws no time marker for that window.
   */
  windowDurationSeconds?: number;
}

export interface SessionUsage {
  contextWindow: {
    usedPercentage: number;
    usedTokens: number;           // total input tokens in context (excludes output)
    cacheTokens: number;          // cache_read + cache_creation
    totalInputTokens: number;
    totalOutputTokens: number;
    contextWindowSize: number;
  };
  cost: {
    totalCostUsd: number;
    totalDurationMs: number;
  };
  /**
   * Cumulative count of completed tool calls for the session. Stamped onto the
   * usage payload by the orchestrator just before it is pushed to the renderer:
   * the authoritative count lives in the main-process accumulator and survives
   * the bounded event cache, so the renderer cannot derive it from
   * `sessionEvents`. Optional because older main builds and non-stamping code
   * paths may omit it; read it with `?? 0`.
   */
  toolCallCount?: number;
  model: {
    id: string;
    displayName: string;
    /**
     * Effort level the agent reports it is RUNNING AT, from its live telemetry
     * (Claude's status.json `effort.level`). Claude Code documents this as the
     * level "after any silent downgrade for the selected model", so it is the
     * running value, not the requested one.
     *
     * Absent for older Claude Code versions, for non-Claude adapters, and - the
     * case that matters - for any model with no effort levels at all. Claude
     * Code gates the field on a per-model capability check, so the key is simply
     * omitted for an unsupported model. The exclusion is per model, not per
     * generation or family: `claude-haiku-4-5` and `claude-sonnet-4-5` have no
     * effort while `claude-opus-4-8` does. Never mirror that list here; read the
     * telemetry. Pair with `reportedByAgent` to tell "this model has no effort
     * level" apart from "no telemetry has arrived yet".
     */
    effort?: string;
    /**
     * True when this model block came from a live agent telemetry snapshot. Set
     * by the adapter that parsed the snapshot and never inferred downstream.
     *
     * Needed because `displayName` alone does not imply telemetry: a spawn seeds
     * it from the `--model` flag so a never-yet-reported session still shows its
     * model (`session-spawn-flow.ts`). Without this flag the renderer cannot
     * tell a configured value from a confirmed one, and presents both with the
     * same visual weight.
     */
    reportedByAgent?: boolean;
  };
  /** Agent-reported session ID (from status.json). Used for stale ID recovery. */
  sessionId?: string;
  /**
   * Absolute path to the agent's own cumulative transcript (Claude's session
   * JSONL, surfaced from status.json `transcript_path`). The authoritative
   * source for lifetime token totals, since the statusLine `context_window`
   * counts above are a current-context snapshot, not cumulative. Absent for
   * agents / CLI versions that do not report it.
   */
  transcriptPath?: string;
  /**
   * Optional plan/usage windows reported by the agent (e.g. Claude's 5h session and 7d weekly).
   * Adapters declare each window self-describingly so the renderer can map without knowing
   * provider-specific bucket names. Adapters that don't report rate limits leave this undefined.
   */
  rateLimits?: RateLimitWindow[];
}

/**
 * Cumulative lifetime token usage for a session, parsed from the agent's own
 * transcript. Unlike the `SessionUsage.contextWindow` snapshot (current context
 * occupancy), these strictly increase across a session's turns and across
 * `--resume` restarts, so they are the authoritative source for the per-task
 * lifetime rollup. Produced by `AgentAdapter.transcriptUsage`.
 */
export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Cumulative tool-call count + per-tool breakdown parsed from an agent's own
 * transcript. Backfills the live UsageAccumulator count for sessions whose
 * ToolStart/ToolEnd hook events never reached it (e.g. a suspended/parked
 * session), which otherwise reports 0 despite real cost/tokens. Produced by
 * `AgentAdapter.transcriptToolCounts`. `toolBreakdown` entries are
 * callCount-only (`totalDurationMs`/`interruptedCount` are 0 - the transcript
 * has no ToolStart/ToolEnd pairing to derive them from).
 */
export interface TranscriptToolCounts {
  toolCallCount: number;
  toolBreakdown: PerToolStat[];
}

// === Usage Time Period Stats ===

export type UsageTimePeriod = 'live' | 'today' | 'week' | 'month' | 'all';

// === Usage Dashboard Stats ===

/** Which projects a dashboard-stats query aggregates over. */
export type UsageStatsScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'all' };

export type UsageStatsScopeKind = UsageStatsScope['kind'];

/**
 * Drill-down to a single local day (clicking a day in a dashboard chart).
 * Transient view state - never persisted; the whole payload re-scopes to
 * [local midnight of dayStartMs, next local midnight), with hour/half-hour
 * bucket granularity like the Today range.
 */
export interface UsageDayDrill {
  /** Any epoch ms within the target local day (normalized server-side). */
  dayStartMs: number;
}

/**
 * User-defined bounded window (the "Custom" range picker; month granularity
 * in v1). Overrides the quick period's window like a drill does, at adaptive
 * day/week bucket granularity. Transient view state - never persisted;
 * cleared by picking a quick period, preserved across scope/project cycling.
 */
export interface UsageCustomWindow {
  /** Inclusive local start (epoch ms; first-of-month local midnight in v1). */
  sinceMs: number;
  /** Exclusive local end (epoch ms; first of the month AFTER the To month). */
  untilMs: number;
}

/**
 * KPI totals for the usage dashboard.
 *
 * Two data sources with DIFFERENT token semantics that never reconcile:
 * the cost/token/session/tool/line fields come from `usage_history`
 * (per-finalized-session context-window SNAPSHOT tokens, the same numbers the
 * old status-bar strip showed), while the cache-token and burn-rate fields are
 * derived from `conversation_turn_usage` (true per-turn tokens). The UI must
 * never present the two as the same measurement.
 */
export interface UsageKpis {
  totalCostUsd: number;
  /** True when at least one session in range reported a non-zero cost. False
   *  means no agent reported cost at all (e.g. subscription plans), which is
   *  distinct from "$0 spent". */
  costKnown: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Convenience: input + output. */
  totalTokens: number;
  sessionCount: number;
  toolCallCount: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  compactionCount: number;
  totalDurationMs: number;
  /** Turn-derived totals (conversation_turn_usage; true per-turn tokens). */
  turnInputTokens: number;
  turnOutputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Tokens per hour over the effective window (turn-derived); null when no turn data. */
  burnRateTokensPerHour: number | null;
  /** Dollars per hour via proportional allocation of each session's reported
   *  cost across its turns by token share. API-equivalent and approximate;
   *  null when no cost or no turn data is available. */
  burnRateUsdPerHour: number | null;
}

/** One bucket of the turn-derived token trend (source: conversation_turn_usage). */
export interface TokenSeriesPoint {
  /** Local-boundary-aligned bucket start, epoch ms. */
  bucketStartMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Session cost allocated to this bucket proportionally by token share (approximate). */
  allocatedCostUsd: number;
  turnCount: number;
}

/** Per-model slice of one cost-series bucket (for the stacked daily bars).
 *  Model ids are normalized base ids, matching `ModelUsageBreakdown.modelId`
 *  so the stack and the donut agree on identity. */
export interface CostSeriesModelSlice {
  modelId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** One local-day (or local-week for 'all') bucket of the session-derived cost trend
 *  (source: usage_history, bucketed by session_started_at). */
export interface CostSeriesPoint {
  bucketStartMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
  /** Per-model splits of this bucket (sums equal the bucket totals). */
  byModel: CostSeriesModelSlice[];
}

/** Per-model rollup over the selected range (source: usage_history). */
export interface ModelUsageBreakdown {
  /** Normalized model id; null when the agent reported none. */
  modelId: string | null;
  modelDisplayName: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionCount: number;
}

/** Per-agent rollup over the selected range (source: usage_history.agent). */
export interface AgentUsageBreakdown {
  /** Agent name as recorded on the session; null for rows predating the agent column. */
  agent: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionCount: number;
}

/** Per-effort rollup over the selected range (source: usage_history.effort,
 *  the session's last-applied `--effort` value). */
export interface EffortUsageBreakdown {
  /** Applied effort level; null means agent default (no flag) - a real
   *  bucket, rendered as "(default)", not missing data. */
  effort: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionCount: number;
}

/** Per-project sub-totals for the app-wide rollup's comparison table. All
 *  fields fold out of the rows already read for the range (zero extra
 *  queries); ratios (cost share, blended $/Mtok, avg session) are derived
 *  client-side from these. */
export interface ProjectUsageSummary {
  projectId: string;
  projectName: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionCount: number;
  toolCallCount: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  totalDurationMs: number;
  /** Most recent session start in range (epoch ms); null when no sessions. */
  lastActiveMs: number | null;
  /** Dominant agent by tokens in range; null when none recorded. */
  topAgent: string | null;
}

/**
 * One in-flight (running/queued) session, snapshotted from the live
 * `SessionManager` for the usage-dashboard's server-side live overlay. Churn
 * fields are intentionally absent: git stats are captured at finalization,
 * not live. Merged into the ledger by `sessionRecordId` (the same id a
 * finalized session lands under in `usage_history.session_record_id`), so a
 * session already snapshotted into the ledger by the periodic metrics timer
 * is replaced by its live row rather than double-counted.
 */
export interface LiveSessionRow {
  sessionRecordId: string;
  projectId: string;
  /** ISO session start time. */
  startedAtIso: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  totalDurationMs: number | null;
  toolCallCount: number;
  modelId: string | null;
  modelDisplayName: string | null;
  agent: string | null;
  effort: string | null;
}

/**
 * Composite payload for the usage dashboard and the `kangentic_get_usage_stats`
 * MCP tool. Series are DENSE (exactly one point per bucket, zero-filled) and
 * bounded (~400 points; the service widens buckets for long ranges), so the
 * renderer never gap-fills. For period 'live' the window is the trailing
 * 120 minutes in 5-minute buckets and `costSeries` is empty.
 */
export interface UsageDashboardStats {
  scope: UsageStatsScope;
  period: UsageTimePeriod;
  /** Inclusive x-domain start of the token series. */
  rangeStartMs: number;
  /** Exclusive x-domain end ("now" for open-ended periods). */
  rangeEndMs: number;
  /** Uniform token-series bucket width. */
  bucketSizeMs: number;
  /** Uniform cost-series bucket width (local day, or local week for 'all'). */
  costBucketSizeMs: number;
  generatedAtMs: number;
  kpis: UsageKpis;
  /** KPI totals of the immediately-preceding window (yesterday / last week /
   *  last month / prior 2h; the prior day for a drill), powering the hero
   *  tiles' "vs previous period" deltas. Null for All Time (no previous). */
  previousKpis: UsageKpis | null;
  tokenSeries: TokenSeriesPoint[];
  costSeries: CostSeriesPoint[];
  byModel: ModelUsageBreakdown[];
  byAgent: AgentUsageBreakdown[];
  byEffort: EffortUsageBreakdown[];
  /** Present only for scope.kind === 'all'. */
  perProject?: ProjectUsageSummary[];
  /** Projects whose DB was missing or unreadable and were skipped (app-wide scope). */
  skippedProjects?: Array<{ projectId: string; projectName: string }>;
}

// === Session Display State (discriminated union for UI) ===

export type SessionDisplayState =
  | { kind: 'none' }
  | { kind: 'preparing'; label: string }
  | { kind: 'initializing'; label: string }
  | { kind: 'queued' }
  | { kind: 'running'; activity: ActivityState; usage: SessionUsage | null }
  | { kind: 'suspended' }
  | { kind: 'exited'; exitCode: number };

// === Bottom Panel Constants ===

/** Sentinel value for the Activity tab in the bottom panel. */
export const ACTIVITY_TAB = '__all__';

// === Git Diff Types ===

export type GitDiffStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'U';

export interface GitDiffFileEntry {
  path: string;
  status: GitDiffStatus;
  insertions: number;
  deletions: number;
  oldPath?: string;
  binary: boolean;
}

export interface GitPendingChangesInput {
  /** Path to check - worktree path or project path */
  checkPath: string;
  /**
   * Whether the move that follows will force-delete the branch (git autoCleanup).
   * Only-local commits are at risk of loss only when the branch is deleted; with
   * the branch kept they stay reachable on its ref and must not warn. Defaults to
   * true (conservative) when omitted.
   */
  autoCleanup?: boolean;
  /** Linked PR number, used to detect a squash-merge that patch-id cannot see. */
  prNumber?: number | null;
  /** Last-known linked PR state; a stored 'merged' avoids a fresh `gh` lookup. */
  prState?: PRState | null;
}

export interface GitPendingChangesResult {
  hasPendingChanges: boolean;
  uncommittedFileCount: number;
  /**
   * Commits that exist only on this local branch and nowhere recoverable (not
   * pushed, not merged by content, not in a merged PR), AND that the pending
   * move would actually destroy by force-deleting the branch. Zero when the
   * branch will be kept, since the commits then survive on its ref. Despite the
   * legacy name, this is "at-risk local-only commits," not merely "unpushed."
   */
  unpushedCommitCount: number;
  /**
   * The worktree's live HEAD branch, or null on a detached HEAD or probe
   * failure. Agents rename branches inside the worktree, so this is preferred
   * over the stored `task.branch_name` when naming the branch in the UI.
   */
  currentBranch: string | null;
}

/**
 * Lightweight, local-only branch context for the Changes panel header. Distinct
 * from the expensive {@link GitPendingChangesInput} probe (which fetches all
 * remotes and does a `gh` PR lookup); this stays cheap so it can run on every
 * panel open, fs.watch fire, and manual refresh.
 */
export interface GitBranchSummaryInput {
  worktreePath?: string;
  projectPath: string;
  baseBranch: string;
  /**
   * When true, the HANDLER refreshes remote-tracking refs first (via the
   * throttled, 5s-budget, never-rejecting fetchAllRemotesIfStale) so `behind`
   * reflects the actual remote rather than the last time anyone fetched.
   * getBranchSummary itself stays fetch-free; the Changes panel opts in from
   * its mount effect only, and fs.watch refires never pass it.
   */
  refreshRemote?: boolean;
}

/** Tip commit of the worktree's HEAD, for the header's last-commit line. */
export interface GitLastCommit {
  /** Abbreviated commit hash (`git log --format=%h`). */
  hash: string;
  /** Commit subject (first line of the message). */
  subject: string;
  /** Committer date as a strict ISO 8601 string; the renderer formats it. */
  timestamp: string;
}

export interface GitBranchSummaryResult {
  /** Live HEAD branch, or null on a detached HEAD or probe failure. */
  currentBranch: string | null;
  /** Commits reachable from HEAD but not the base branch (this branch's work). */
  ahead: number;
  /** Commits reachable from the base branch but not HEAD (this branch is behind). */
  behind: number;
  /** The HEAD tip commit, or null on an unborn branch / probe failure. */
  lastCommit: GitLastCommit | null;
}

/**
 * Input for the commit-graph reader that powers the task-detail Graph pane.
 * Local-only and cheap (no fetch / `gh` lookup), mirroring {@link
 * GitBranchSummaryInput}: it runs on every pane open and fs.watch fire.
 */
export interface GitCommitGraphInput {
  worktreePath?: string;
  projectPath: string;
  baseBranch: string;
  /** Hard cap on commits returned (defaults to 200). Older history is truncated. */
  maxCommits?: number;
  /** Base-branch ancestors below the merge-base to include for context (defaults to 5). */
  baseContextCount?: number;
}

/** One commit node in the graph, with the parent links that form the DAG edges. */
export interface GitCommitGraphCommit {
  /** Full 40-char commit hash (`git log --format=%H`). */
  hash: string;
  /** Abbreviated commit hash (`%h`). */
  shortHash: string;
  /** Full parent hashes (`%P`); empty for a root commit, 2+ for a merge. */
  parents: string[];
  /** Author name (`%an`). */
  authorName: string;
  /** Author date as a strict ISO 8601 string (`%aI`); the renderer formats it. */
  authorTimestamp: string;
  /** Commit subject, first line only (`%s`). */
  subject: string;
}

/**
 * Commit-graph result: topologically-ordered commits (newest first) plus the
 * resolved anchor SHAs the renderer uses to mark the tip, base ref, and fork
 * point. Fails SAFE: any git error yields an all-empty/null result so the pane
 * simply shows an empty state rather than surfacing an error.
 */
export interface GitCommitGraphResult {
  commits: GitCommitGraphCommit[];
  /** HEAD commit (full hash), or null on probe failure / unborn branch. */
  tipHash: string | null;
  /** Resolved base ref commit (origin/<base> or <base>), or null if unresolved. */
  baseHash: string | null;
  /** merge-base(base, HEAD) - the fork point, or null if unresolved. */
  mergeBaseHash: string | null;
  /** Live HEAD branch, or null on a detached HEAD. */
  currentBranch: string | null;
  /** True when history exceeded `maxCommits` and the tail was dropped. */
  truncated: boolean;
}

/**
 * Which set of changes the Changes panel diffs:
 * - `working`: uncommitted working-tree edits (`git diff`, working vs index) -
 *   the small active subset you are editing right now.
 * - `staged`: changes added to the index (`git diff --staged`, index vs HEAD).
 * - `branch`: everything this branch accumulated vs its base (working tree vs the
 *   merge-base of base..HEAD) - the full PR. The original review behavior; the
 *   live default the panel opens with is the global `diffDefaultScope` setting.
 */
export type GitDiffScope = 'working' | 'staged' | 'branch';

export interface GitDiffFilesInput {
  worktreePath?: string;
  projectPath: string;
  baseBranch: string;
  /** Defaults to 'branch' (the full branch-vs-base diff) when omitted. */
  scope?: GitDiffScope;
  /**
   * When set, diff this single commit (`<commitOid>^..<commitOid>`) instead of
   * `scope` - the history browser's commit-detail selection. Overrides `scope`.
   */
  commitOid?: string;
}

export interface GitDiffFilesResult {
  files: GitDiffFileEntry[];
  totalInsertions: number;
  totalDeletions: number;
}

export interface GitFileContentInput {
  worktreePath?: string;
  projectPath: string;
  baseBranch: string;
  filePath: string;
  status: GitDiffStatus;
  oldPath?: string;
  /** Must match the scope the file list was fetched with. Defaults to 'branch'. */
  scope?: GitDiffScope;
  /** Must match the `commitOid` the file list was fetched with, if any. */
  commitOid?: string;
}

export interface GitFileContentResult {
  original: string;
  modified: string;
  language: string;
}

/**
 * Input for the per-file history reader (commits touching a single file, via
 * `git log --follow`). Local-only and fail-safe, mirroring {@link GitCommitGraphInput}.
 */
export interface GitFileHistoryInput {
  worktreePath?: string;
  projectPath: string;
  filePath: string;
  /** Hard cap on commits returned (defaults to 100). */
  maxCommits?: number;
}

/** One commit touching a file, newest first. */
export interface GitFileHistoryCommit {
  hash: string;
  shortHash: string;
  authorName: string;
  authorTimestamp: string;
  subject: string;
}

export interface GitFileHistoryResult {
  commits: GitFileHistoryCommit[];
}

/** Input for the per-line blame reader (`git blame --line-porcelain`). */
export interface GitBlameInput {
  worktreePath?: string;
  projectPath: string;
  filePath: string;
}

/** Blame info for one line (1-indexed) of a file's current content. */
export interface GitBlameLine {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  /** Author date as a strict ISO 8601 string; empty for an uncommitted line. */
  date: string;
}

export interface GitBlameResult {
  lines: GitBlameLine[];
}

// === Configuration ===

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'auto';

export interface AgentPermissionEntry {
  mode: PermissionMode;
  label: string;
}

/** Default agent identifier - matches the DB schema default for new projects. */
export const DEFAULT_AGENT = 'claude';

/** Default permission mode - used as fallback when agent list hasn't loaded or agent not found. */
export const DEFAULT_PERMISSION: PermissionMode = 'acceptEdits';

/** Default permission modes - used as fallback when agent list hasn't loaded yet. */
export const DEFAULT_PERMISSIONS: AgentPermissionEntry[] = [
  { mode: 'plan', label: 'Plan (Read-Only)' },
  { mode: 'dontAsk', label: "Don't Ask (Deny Unless Allowed)" },
  { mode: 'default', label: 'Default (Allowlist)' },
  { mode: 'acceptEdits', label: 'Accept Edits' },
  { mode: 'auto', label: 'Auto (Classifier)' },
  { mode: 'bypassPermissions', label: 'Bypass (Unsafe)' },
];

/** Get label for a mode from a permissions list. */
export function getPermissionLabel(permissions: AgentPermissionEntry[], mode: PermissionMode): string {
  return permissions.find((entry) => entry.mode === mode)?.label ?? mode;
}

/** Resolve the default permission mode for an agent from the detection list. */
export function getAgentDefaultPermission(agentList: AgentDetectionInfo[], agentName: string): PermissionMode {
  return agentList.find((agent) => agent.name === agentName)?.defaultPermission ?? DEFAULT_PERMISSION;
}

/**
 * Resolve permission mode when switching agents.
 * Preserves the current mode if the new agent supports it; otherwise falls back
 * to the new agent's recommended default.
 */
export function resolvePermissionForAgent(agentList: AgentDetectionInfo[], agentName: string, currentMode: PermissionMode): PermissionMode {
  const agentInfo = agentList.find((agent) => agent.name === agentName);
  if (!agentInfo) return DEFAULT_PERMISSION;
  if (agentInfo.permissions.some((entry) => entry.mode === currentMode)) return currentMode;
  return agentInfo.defaultPermission;
}

export type ThemeMode = 'dark' | 'light'
  | 'moon' | 'forest' | 'ocean' | 'ember'
  | 'sand' | 'mint' | 'sky' | 'peach';

/** Background colors for BrowserWindow (prevents flash on launch). */
export const THEME_BACKGROUNDS: Record<ThemeMode, string> = {
  dark: '#18181b', light: '#f5f5f4',
  moon: '#1a1d2e', forest: '#1a2318', ocean: '#0f1923', ember: '#1f1a17',
  sand: '#f5f0e8', mint: '#eef5f0', sky: '#edf3f8', peach: '#f8f0ec',
};

/** Per-theme foreground color (mirrors index.css's `--kng-fg-secondary`,
 *  renderer-only need so not read live from CSS). Used by the Terminal settings
 *  tab's Colors section to offer "match my current app theme" as a terminal color preset:
 *  the terminal's foreground/cursor default (#e4e4e7) is byte-identical to
 *  the dark theme's value here, since that is literally where it came from
 *  before the terminal had its own fixed color scheme. */
export const THEME_FOREGROUNDS: Record<ThemeMode, string> = {
  dark: '#e4e4e7', light: '#292524',
  moon: '#c6c8d0', forest: '#c6cac4', ocean: '#c0c6ce', ember: '#ccc8c4',
  sand: '#3d3228', mint: '#1e3028', sky: '#1a2a3a', peach: '#3a2520',
};

/** UI metadata for the settings dropdown. */
export const NAMED_THEMES: { id: ThemeMode; label: string; base: 'dark' | 'light' }[] = [
  { id: 'moon', label: 'Moon', base: 'dark' },
  { id: 'forest', label: 'Forest', base: 'dark' },
  { id: 'ocean', label: 'Ocean', base: 'dark' },
  { id: 'ember', label: 'Ember', base: 'dark' },
  { id: 'sand', label: 'Sand', base: 'light' },
  { id: 'mint', label: 'Mint', base: 'light' },
  { id: 'sky', label: 'Sky', base: 'light' },
  { id: 'peach', label: 'Peach', base: 'light' },
];

/** Custom terminal color overrides, editable in the Terminal settings tab's
 *  Colors section. Any
 *  slot left unset falls back to the built-in default (see
 *  TERMINAL_DEFAULT_COLORS in useTerminal.ts, renderer-only since only xterm
 *  rendering needs the concrete hex values). Deliberately just these three:
 *  the 16-color ANSI palette (used by shell tools like `git diff`/`ls
 *  --color`) is a fixed built-in scheme, not exposed for per-color editing -
 *  most users want to set their overall look, not tune individual ANSI
 *  slots. `cursorAccent` and `selectionBackground` are also NOT here:
 *  cursorAccent always tracks whatever `background` resolves to (so the
 *  glyph under a block cursor stays legible), and selectionBackground is a
 *  fixed app accent, not a terminal color a user would pick independently.
 *  A dictionary-style field (CONFIG_DICTIONARY_PATHS in config-manager.ts):
 *  saved wholesale so resetting a slot (deleting its key) actually takes
 *  effect. Global-only. */
export interface TerminalColorOverrides {
  background?: string;
  foreground?: string;
  cursor?: string;
}

/** Recursively makes all properties optional. Arrays are kept whole (not element-partial). */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[] ? U[] : T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export interface NotificationConfig {
  desktop: {
    onAgentIdle: boolean;
    onAgentCrash: boolean;
    onPlanComplete: boolean;
    /** A task spawn has been preparing (worktree/git) longer than the stall threshold. */
    onSpawnStalled: boolean;
  };
  toasts: {
    onAgentIdle: boolean;
    onAgentCrash: boolean;
    onPlanComplete: boolean;
    /** A task spawn has been preparing (worktree/git) longer than the stall threshold. */
    onSpawnStalled: boolean;
    durationSeconds: number;
    maxCount: number;
  };
  cooldownSeconds: number;
}

/** Click-outside (light-dismiss) policy for modeless task-detail windows. `off`
 *  disables it; `single` closes a lone window in any state (the peek case), and so
 *  does nothing at all once a second window is open; `focused` closes the focused
 *  window in any state, whether one or five are open (the default); `all` closes
 *  every window. */
export type WindowLightDismiss = 'off' | 'single' | 'focused' | 'all';

// === Dictation (voice-to-text) ===

/** Concrete transcription engine ids. `stub` is the no-ML test engine. */
export type DictationEngineId = 'stub' | 'sherpa-onnx' | 'whisper-cpp' | 'remote-openai' | 'hybrid' | 'chunked-offline';

/** User-facing engine selection. `auto` tiers by detected hardware; the rest
 *  force a specific engine for latency-vs-accuracy comparison. `remote` maps
 *  to the `remote-openai` engine. */
export type DictationEngineMode = 'auto' | 'sherpa-onnx' | 'whisper-cpp' | 'hybrid' | 'remote';

/** Coarse hardware tier driving the auto engine/model choice. */
export type DictationEngineTier = 'remote' | 'streaming-tiny' | 'accurate-base';

/** Static description of an engine, surfaced to the settings panel. */
export interface DictationEngineInfo {
  id: DictationEngineId;
  displayName: string;
  /** Emits revising partials live (transducer) vs. a single final pass. */
  streaming: boolean;
  /** Produces punctuation + casing natively (whisper / remote). */
  punctuation: boolean;
  /** SPDX-ish license string for the engine code (not the model weights). */
  license: string;
  requiresModelDownload: boolean;
}

/** Best-effort detected hardware used for engine/model auto-selection. */
export interface DictationHardwareProfile {
  /** CPU brand string, e.g. "AMD Ryzen 9 9950X3D 16-Core Processor". */
  cpuModel: string;
  /** Logical processors (threads). */
  cpuCores: number;
  totalRamGb: number;
  hasAvx2: boolean;
  /** Acceleration backend our engines can use. `none` = CPU only (which still
   *  covers a present-but-unaccelerated adapter like AMD/Intel in v1);
   *  `unknown` = detection failed. The human-readable adapter is in
   *  `gpuDescription`. */
  gpu: 'none' | 'cuda' | 'metal' | 'unknown';
  /** Human-readable detected GPU vendor for display (e.g. "NVIDIA (CUDA)"). */
  gpuDescription?: string;
  platform: NodeJS.Platform;
  arch: string;
}

/** Remote OpenAI-compatible `/v1/audio/transcriptions` backend config. All
 *  fields are optional because the user fills them in incrementally in
 *  settings; the remote engine validates that `url` is present before use. */
export interface DictationRemoteEndpoint {
  url?: string;
  apiKey?: string;
  model?: string;
}

/** Payload for `dictation.start` (renderer passes the current global config). */
export interface DictationStartOptions {
  engineMode: DictationEngineMode;
  /** The FINAL (accurate) model id, or null/undefined for the tier default
   *  (Parakeet on the accurate tier), or `'none'` for no post-processing pass. */
  modelId?: string | null;
  /** The LIVE (preview) model id: null/undefined = the streaming Zipformer default,
   *  an offline model id = chunked live, `'none'` = no live preview. */
  liveModelId?: string | null;
  punctuation: boolean;
  language: string;
}

/** Result of `dictation.start`. */
export interface DictationStartResult {
  dictationSessionId: string;
  engineId: DictationEngineId;
  modelId: string | null;
  needsDownload: boolean;
}

/** A user-selectable transcription model (for the settings model dropdown). */
export interface DictationModelOption {
  id: string;
  displayName: string;
  sizeMb: number;
  engineKind: 'online-transducer' | 'offline-whisper' | 'offline-nemo-transducer' | 'offline-moonshine';
  /** Spoken languages this model can transcribe (Whisper / BCP-47 codes). The
   *  Language dropdown shows the intersection of the selected models' sets. */
  languages: string[];
}

/** Hardware + engine snapshot for the settings panel (`dictation.getInfo`). */
export interface DictationInfo {
  hardware: DictationHardwareProfile;
  tier: DictationEngineTier;
  selectedEngineId: DictationEngineId;
  engines: DictationEngineInfo[];
  installedModels: string[];
  /** The model the selected engine will load, or null (remote/no model). */
  selectedModelId: string | null;
  /** Approximate download size of the selected model in MB, or null. */
  selectedModelSizeMb: number | null;
  /** Selectable offline models (accuracy/size trade-off) - kept as the union for
   *  any general consumer; the two-stage dropdowns use the lists below. */
  availableModels: DictationModelOption[];
  /** Live-preview model choices: the streaming Zipformer (native, instant) plus
   *  the offline models small enough to chunk (Parakeet, Whisper tiny/base). */
  liveModels: DictationModelOption[];
  /** Final/accurate model choices: every offline model (Parakeet + Whisper ladder). */
  finalModels: DictationModelOption[];
  /** The resolved live + final model ids for the current selection. */
  selectedLiveModelId: string | null;
  selectedFinalModelId: string | null;
}

/** Progress event for an in-flight model download. */
export interface DictationModelProgress {
  modelId: string;
  status: 'downloading' | 'verifying' | 'done' | 'error';
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}

/** One streamed PCM frame (16 kHz mono Int16, carried as a transferable
 *  ArrayBuffer). `seq` lets the service detect dropped frames. */
export interface DictationAudioChunk {
  dictationSessionId: string;
  seq: number;
  pcm: ArrayBuffer;
}

/** Microphone permission outcome. `unavailable` covers an OS-level denial or
 *  a platform with no mic. */
export type DictationMicPermission = 'granted' | 'denied' | 'unavailable';

/** The five onboarding checklist steps, in the order they are presented. Lives here rather
 *  than beside the hook so the config store can reference it without importing a renderer
 *  hook that imports the config store back. */
export type OnboardingStepKey =
  | 'defaultsChosen'
  | 'boardShaped'
  | 'taskCreated'
  | 'draggedToAutoSpawnLane'
  | 'taskDetailOpened';

/**
 * Snapshot of the settings the onboarding checklist watches, taken on first checklist
 * OPEN (WelcomeChecklistDialog's mount effect is the only writer). Steps 1 and 2 tick when
 * live state DIFFERS from this, so a user who opens Settings or Board manager and closes it
 * again gets no checkmark - only a real change earns one.
 *
 * Note the four "defaults" a user picks do not live together: `default_agent` /
 * `default_model` / `default_effort` are columns on the project row, while
 * `permissionMode` is global config (`agent.permissionMode`). This snapshot flattens
 * both so the comparison has a single shape.
 */
export interface OnboardingBaseline {
  /** Project row `default_agent`. Always populated, so it needs a baseline to be meaningful. */
  defaultAgent: string;
  /** Project row `default_model`. Null means no project preference was set. */
  defaultModel: string | null;
  /** Project row `default_effort`. Null means no project preference was set. */
  defaultEffort: string | null;
  /** Effective `agent.permissionMode` at capture time. Always populated. */
  permissionMode: PermissionMode;
  /** Stable string encoding of the board's shape - see buildSwimlaneSignature. Not a hash: it
   *  is the lane fields joined with separators, compared only for equality. Deliberately excludes
   *  `position` (it is rewritten by any reorder, including one the user undoes). */
  swimlaneSignature: string;
}

// ============================================================================
// Agent Monitor - the cross-project aggregate view.
//
// Machine-global by nature: it spans every registered project, so nothing here
// is project-scoped. The rows are assembled in the main process
// (src/main/monitor/monitor-aggregator.ts) by joining the process-global session
// registry + activity/event caches against each owning project's DB.
// ============================================================================

/**
 * The attention bucket a row falls into. Derived ONLY via `requiresUserInteraction()`
 * / `isActive()` from `src/shared/activity-state.ts` - never by comparing an
 * `ActivityState` to a literal (enforced by
 * `tests/unit/activity-state-classification.test.ts`).
 */
export type MonitorStateBucket = 'needs-you' | 'working' | 'idle' | 'finished';

/**
 * How the monitor arranges its rows. `cards` reflows by container width.
 *
 * All three name a FORM, not a density - `list` was briefly "compact", which
 * described how tight it was rather than what it is, and read oddly beside two
 * options that name shapes.
 */
export type MonitorLayout = 'cards' | 'table' | 'list';
/**
 * How rows are sectioned. Always one or the other - there is no "ungrouped"
 * choice, because a segmented control sitting with nothing selected reads as
 * broken, and neither section scheme is expensive enough to want off.
 *
 * ('flat' still exists as an INTERNAL grouping mode for the table layout, which
 * cannot interleave section headers into a <table>; it is simply not a value the
 * user can select or that is ever persisted.)
 */
export type MonitorGroupBy = 'state' | 'project';
/**
 * Row order WITHIN a section. Just the two time directions.
 *
 * Attention-first ordering is not a sort option because it is structural: rows
 * are always grouped, and the Status grouping emits Idle before Active before
 * Paused. An "Idle first" sort on top of that ordered idle rows within the Idle
 * section, which is no ordering at all. (Sorting BY project was dropped for the
 * same reason - it duplicated grouping by project.)
 */
export type MonitorSort = 'longest-running' | 'recently-started';

/** One live or recently-finished agent session, resolved across projects. */
/**
 * The subset of `SessionEvent` a monitor row carries.
 *
 * The row is re-sent on every snapshot push, and the renderer reads only the detail
 * line, so the correlation ids and per-tool telemetry on the full event were pure
 * payload. Kept as a named shape rather than a bare string so the "doing now" line
 * can be formatted by event kind without widening the row again.
 */
export interface MonitorLastEvent {
  type: EventType;
  /** The rendered "doing now" line. See `SessionEvent.detail` for what it holds. */
  detail: string | null;
}

export interface MonitorSessionRow {
  sessionId: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  /**
   * The last few meaningful rendered lines of this session's terminal.
   *
   * This REPLACED the task-description excerpt the card used to show. A
   * description is the same text every time you look at it and says nothing about
   * what the agent is doing now, which is the one question this screen exists to
   * answer; it also left a Command Terminal's card blank, since a terminal has no
   * task. The peek is live, varies per session, and is the same for both kinds of
   * row. `monitor.getTaskDetail` still serves the full description on demand for
   * the detail view.
   *
   * Seeded here so a snapshot is self-consistent (and so an idle session that
   * never emits still has one), then patched in place between snapshots by the
   * MONITOR_PEEK push. Extraction rule: `src/main/pty/buffer/output-peek.ts`.
   */
  outputPeek: string[];
  /** The task's #N ticket number; null when the task row could not be resolved. */
  displayId: number | null;
  /** Swimlane (column) name the task currently sits in. Empty for a Command
   *  Terminal, which is not on the board at all. */
  columnName: string;
  /**
   * Branch a Command Terminal is working on. Null for a task agent.
   *
   * The card's eyebrow is a breadcrumb answering "where is this session
   * working". For a task that is its column; a terminal has none, which left the
   * slot blank and the title sitting under a gap. The branch is the honest
   * analogue: it is a location rather than a label, and it is what the Command
   * Terminal's own window header shows via its branch picker.
   *
   * Deliberately NOT populated for task agents even though a worktree-backed task
   * has a branch too. Its column is the more useful breadcrumb there, and the
   * eyebrow only has room for one.
   */
  commandTerminalBranch: string | null;
  labels: string[];
  prUrl: string | null;
  prNumber: number | null;
  prState: PRState | null;
  /** Adapter name captured at spawn (e.g. "claude"). Null for a pre-adapter session. */
  agentName: string | null;
  /** The agent-reported live model when available, else the model the session was
   *  spawned/resumed/switched with. Null = agent default with no live report yet. */
  modelDisplayName: string | null;
  /** Reasoning effort the session was actually spawned/resumed/switched with
   *  (`applied_effort`). Null = the agent's own default, or an agent with no
   *  effort concept. */
  effort: string | null;
  /** Permission mode the session was spawned under. Null for agents that manage
   *  autonomy in their own TUI rather than via a spawn flag. */
  permissionMode: string | null;
  startedAt: string;
  /** UTC ISO exit time from the owning project's `sessions` row; null while live. */
  exitedAt: string | null;
  status: SessionStatus;
  activity: ActivityState | null;
  activityReason: ActivityReason | null;
  /** Last telemetry event, rendered as the row's "doing now" line. */
  lastEvent: MonitorLastEvent | null;
  /** Context-window usage 0-100, or null when the window size is unknown. */
  contextPercent: number | null;
  isolated: boolean;
  /**
   * A Command Terminal (transient) session rather than a task agent.
   *
   * The monitor is the ONLY surface that can show these: they have no board card
   * because they have no task, and the Command Terminal layer only shows the
   * project you currently have open. Their `taskId` is a synthetic key, so they
   * carry no title / ticket / column / labels.
   */
  isCommandTerminal: boolean;
}

export interface MonitorSnapshot {
  rows: MonitorSessionRow[];
  /** UTC ISO stamp of when main assembled this snapshot. */
  generatedAt: string;
}

/**
 * Everything the task-detail surface needs about the PROJECT a task belongs to,
 * for a host that is not that project's board.
 *
 * Mirrors `TaskDetailHostValue`'s data half (the renderer adds the mutation
 * callbacks). On the board these values come from the board / config / project
 * stores; the Agent Monitor fetches this instead, because those stores hold the
 * open project and its rows can belong to any of them.
 */
/**
 * Where main decided a task detail should open. Mirrors `DetailDestination` in
 * src/main/task-detail/detail-owner-registry.ts, which owns the rules.
 */
/** Which surface hosts a task detail. Both can live in the main window. */
export type TaskDetailHost = 'board' | 'monitor';

export interface TaskDetailOwner {
  webContentsId: number;
  host: TaskDetailHost;
}

export type TaskDetailDestination =
  /** The requester already holds it; its window was focused, nothing remounts. */
  | { kind: 'focused-existing'; owner: TaskDetailOwner }
  /** The requester mounts it; `closedElsewhere` names the surface that gave it up. */
  | { kind: 'open-here'; owner: TaskDetailOwner; closedElsewhere: TaskDetailOwner | null };

/**
 * A task detail open in a DIFFERENT renderer than the one receiving it.
 *
 * Carries no `webContentsId` on purpose: main has already filtered the list per
 * recipient, so every entry means "not mine". Handing the renderer ids would only
 * let a caller re-derive the comparison and get the direction backwards.
 */
export interface TaskDetailRemoteOwner {
  projectId: string;
  taskId: string;
}

export interface TaskDetailBundle {
  task: Task;
  projectId: string;
  projectName: string;
  projectPath: string;
  defaultAgent: string | null;
  swimlanes: Swimlane[];
  shortcuts: (ShortcutConfig & { source: 'team' | 'local' })[];
  config: {
    labelColors: Record<string, string>;
    defaultBaseBranch: string;
    worktreesEnabled: boolean;
    browserEnabled: boolean;
  };
}

/**
 * The user's persisted monitor view. Stored as one blob on the global AppConfig and
 * shared by the in-app overlay and the detached pop-out, so "their preferred view"
 * is a single preference rather than one per host.
 */
export interface MonitorView {
  layout: MonitorLayout;
  groupBy: MonitorGroupBy;
  sort: MonitorSort;
  /**
   * Show only sessions with a live agent - the Idle and Active buckets - hiding
   * Paused and Recently finished.
   *
   * Named `liveOnly`, not `hideIdle`: it never hid the Idle bucket (those are
   * agents waiting on YOU, the last thing to hide), and "inactive" collided with
   * the Active/Idle vocabulary the rest of the view speaks.
   */
  liveOnly: boolean;
  /** Empty = every project. */
  projectFilter: string[];
  /** Empty = every state. */
  stateFilter: MonitorStateBucket[];
  textFilter: string;
}

export interface AppConfig {
  theme: ThemeMode;
  sidebarVisible: boolean;
  boardLayout: 'horizontal' | 'vertical';
  cardDensity: 'compact' | 'default' | 'comfortable';
  columnWidth: 'narrow' | 'default' | 'wide';
  showTaskNumbers: boolean; // show each task's #N (display_id) on its board card
  terminalPanelVisible: boolean;
  animationsEnabled: boolean;
  statusBarVisible: boolean;
  diffViewMode: 'split' | 'inline'; // split = side-by-side, inline = unified
  diffDefaultScope: GitDiffScope; // default scope a freshly opened Changes panel uses
  diffIgnoreWhitespace: boolean; // hide whitespace-only changes in the diff
  diffCollapseUnchanged: boolean; // fold away large unchanged regions, showing only changed hunks
  diffFileSort: 'name' | 'status' | 'size'; // Changes panel file ordering
  diffFlatList: boolean; // Changes panel file list: flat full-path list vs nested directory tree

  /** Persisted Agent Monitor view. Global-only: the monitor spans every project, so a
   *  per-project override would be meaningless. Written debounced on every change (not
   *  on close) so the view survives a quit or crash, not just an orderly close. */
  monitor: MonitorView;

  terminal: {
    shell: string | null; // null = auto-detect. Global-only: applies across every project.
    fontFamily: string; // global-only: applies across every project
    fontSize: number; // global-only: applies across every project
    showPreview: boolean;
    panelHeight: number; // persisted terminal panel height in px
    panelCollapsed: boolean; // persisted collapsed state
    cursorStyle: 'block' | 'underline' | 'bar'; // global-only: applies across every project
    colors: TerminalColorOverrides; // global-only: applies across every project
    backspaceSendsCtrlH: boolean; // send Ctrl+H (0x08) instead of DEL (0x7f) on plain Backspace; opt-in, default false, all platforms
  };

  agent: {
    permissionMode: PermissionMode;
    cliPaths: Record<string, string | null>; // keyed by agent name, null = auto-detect
    maxConcurrentSessions: number;
    queueOverflow: 'queue' | 'reject';
    idleTimeoutMinutes: number; // 0 = disabled
    autoResumeSessionsOnRestart: boolean; // when false, sessions stay paused after restart and require a manual Resume click
    /** Global, agent-keyed remote-server identity (url + auth). Machine-scoped, mirrors cliPaths. */
    executionServers: Record<string, AgentExecutionServer>;
    /** Per-project, agent-keyed local/remote choice + server working directory. Project-overridable. */
    execution: Record<string, AgentProjectExecution>;
    /** Global, agent-keyed boolean launch-option toggles (agent name -> option id -> enabled).
     *  Machine-scoped, mirrors cliPaths - not project-overridable. An absent entry falls back
     *  to the adapter's declared `AgentLaunchOptionInfo.default`. */
    launchOptions: Record<string, Record<string, boolean>>;
  };

  sidebar: {
    width: number;
  };

  git: {
    worktreesEnabled: boolean;
    autoCleanup: boolean;
    defaultBaseBranch: string;
    copyFiles: string[];
    initScript: string | null;
    /** Symlink the root node_modules into each worktree so agents skip a fresh install. Disable to let initScript own the worktree's deps. */
    linkNodeModules: boolean;
    /** Minutes between background PR-state refresh sweeps for the open project. null = off (on-open sweep only). */
    prRefreshIntervalMinutes: number | null;
  };

  mcpServer: {
    enabled: boolean;
    /** Interface the in-process MCP HTTP server listens on. Default '127.0.0.1' (loopback only). */
    bindAddress: string;
    /**
     * Extra host allowlisted alongside `bindAddress` for the MCP server's DNS-rebinding
     * protection, so an external client naming it in its `Host` header is not rejected.
     * Kangentic never advertises or pushes this value anywhere: to point an external
     * client at the server the user substitutes it by hand for the `127.0.0.1` in
     * `.kangentic/mcp-config.json`. Unset means loopback only.
     */
    callbackHost?: string;
  };

  contextBar: {
    showShell: boolean;
    showVersion: boolean;
    /** Ticking wall-clock elapsed time since the session started. */
    showElapsed: boolean;
    // `showModel` / `showEffort` removed: those pills double as the
    // model/effort picker triggers. Hiding them via toggle would silently
    // disable a feature, not just minimize chrome. The other toggles below
    // are pure cosmetic noise filters and keep their toggles.
    showCost: boolean;
    /** Cumulative count of completed tool calls (live). */
    showToolCalls: boolean;
    /** Agent active time reported by the CLI (usage.cost.totalDurationMs). */
    showAgentActive: boolean;
    showTokens: boolean;
    showContextFraction: boolean;
    showProgressBar: boolean;
    showRateLimits: boolean;
  };

  notifications: NotificationConfig;

  backlog: {
    priorities: Array<{ label: string; color: string }>;
    labelColors: Record<string, string>;
  };

  // Embedded browser pane defaults. Project-overridable so each
  // project remembers its own dev-server URL and so security-conscious
  // projects can disable the pane entirely.
  browser?: {
    /** Show the Browser pill in the task detail header. Default true. */
    enabled?: boolean;
    /** Project default URL when a task has no per-task override. */
    defaultUrl?: string;
  };

  /**
   * Developer / debug toggles. Global-only - the debug overlay is a
   * per-machine dev affordance, not something that varies per project.
   * Lives below the shared-settings separator in the Developer tab.
   */
  developer?: {
    /**
     * Show the activity-engine debug overlay (floating panel showing
     * live counters, current reason, recent transitions). Useful for
     * diagnosing "stuck thinking" or "missed idle" reports.
     * Default false. Always rendered in product builds.
     */
    activityDebugOverlay?: boolean;
    /**
     * Persist info/debug-level renderer + main console logs to
     * `<projectRoot>/.kangentic/logs/<date>.log`. errors/warnings are
     * always captured regardless of this toggle. Default false.
     * Always rendered in product builds.
     */
    persistConsoleLogs?: boolean;
    /**
     * Record every IPC handler invocation to
     * `<projectRoot>/.kangentic/logs/ipc-<date>.jsonl`. Includes channel,
     * args (with redaction for known-sensitive channels), result,
     * duration. Useful for "why didn't this action work?" debugging
     * but generates non-trivial disk I/O. Default false. Always
     * rendered in product builds.
     */
    recordIpcTraffic?: boolean;
    /**
     * Bind a localhost-only HTTP inspection bridge for the dev-only
     * `kangentic_devtools_*` MCP tools to connect to. Master switch for
     * the inspection bridge, lockfile writing, and the dev-only MCP
     * tools that hit it. Only meaningful in dev builds; the toggle
     * key persists across builds for type compatibility but the UI
     * affordance is gated on `__KANGENTIC_DEV__`. Default false.
     */
    previewInspectionServer?: boolean;
    /**
     * Stricter gate for the inspection bridge: enables `eval`,
     * `inject_session_event`, and the `pty-input.bytes` form. Allows
     * arbitrary-code surfaces. Off by default; only meaningful when
     * `previewInspectionServer` is also on. Dev-only.
     */
    previewEvalEnabled?: boolean;
  };

  /**
   * Agent browser automation. GLOBAL (per-machine) policy for whether and how
   * an agent may drive the embedded Browser pane via the kangentic_browser_*
   * MCP tools. Distinct from `browser` above (the per-project pane settings):
   * this is a cross-project security policy and lives below the settings
   * separator in its own "Agent Browser" tab.
   */
  browserAutomation?: {
    /** Master switch. When false the kangentic_browser_* tools are disabled. Default true. */
    enabled?: boolean;
    /** Allow click / type / keypress / drag. When false the agent is observe-only. Default true. */
    allowInteraction?: boolean;
    /** Allow navigating the pane to other URLs. Default true. */
    allowNavigation?: boolean;
    /** Allow arbitrary-JS eval in the loaded page's origin. Default false. */
    allowEval?: boolean;
    /** Restrict navigation to localhost / private hosts only. Default false (any http(s)). */
    restrictNavigationToLocalhost?: boolean;
  };

  /**
   * Dev-server port leases. Held in the GLOBAL database by necessity, not by
   * policy: ports are a shared resource, so a per-project range could not see
   * that another project already holds 4200. That scopes the ledger to one
   * Kangentic INSTANCE rather than the machine, since `configDir` honours
   * KANGENTIC_DATA_DIR - a bind probe, not the ledger, is what keeps two
   * instances from colliding.
   *
   * Nothing is leased up front: a task holds ports only once its agent asked
   * via kangentic_reserve_dev_ports, and {{port}} exposes the lowest of them.
   * Kangentic never starts or supervises a dev server.
   */
  devServer?: {
    /** First port considered when leasing. Default 7300, chosen to miss every
     *  common framework default (3000, 4200, 4321, 5000, 5173, 8000, 8080). */
    portRangeStart?: number;
    /** Last port considered when leasing (inclusive). Default 7499. */
    portRangeEnd?: number;
  };

  /**
   * Conversation memory: local index over agent conversation transcripts for
   * search and recall. GLOBAL/shared scope (below the settings separator, in
   * the Memory tab). Works offline with no API key.
   */
  memory?: {
    /** Index agent conversation transcripts locally for search/recall.
     *  Default true. Off: no indexing, no conversation search results, and the
     *  embed worker never runs. */
    indexingEnabled?: boolean;
    /** Semantic (embedding) layer on top of lexical search. Default false;
     *  turning it on triggers the one-time local model download. */
    semanticEnabled?: boolean;
    /** Selected embedding model id (see src/shared/embedding-models.ts). Default
     *  'bge-base'. Switching re-embeds the index in the background. */
    embeddingModel?: string;
    /** Which hardware the embedding model runs on. 'auto' (default) prefers a GPU
     *  execution provider (DirectML on Windows, WebGPU elsewhere) and falls back to
     *  CPU if it fails to initialize; 'gpu' forces the same GPU-first chain; 'cpu'
     *  forces the universal CPU path. Offloading to an idle GPU keeps the CPU free
     *  for the agents when many run at once. */
    acceleration?: MemoryAcceleration;
  };

  /**
   * Voice-to-text dictation. GLOBAL/shared scope (hardware/user level, not
   * per-project): lives below the settings separator in the Dictation tab.
   * The push-to-talk binding is NOT here; it lives in `hotkeyOverrides` keyed
   * by the `dictation.pushToTalk` keybinding-registry id.
   */
  dictation?: {
    /** Master toggle: enable push-to-talk dictation. Default false. */
    enabled?: boolean;
    /** Engine selection. `auto` tiers by detected hardware. Default `auto`. */
    engineMode?: DictationEngineMode;
    /** The FINAL (accurate) model: a model id, null/absent = the tier default
     *  (Parakeet), or `'none'` = no post-processing pass (keep the live text). */
    modelId?: string | null;
    /** The LIVE (preview) model: null/absent = the streaming Zipformer, an offline
     *  model id = chunked live, `'none'` = no live preview. */
    liveModelId?: string | null;
    /** Quality preset. `fast`/`balanced`/`accurate` set AND lock the live +
     *  refinement models; `custom` unlocks the two dropdowns for manual choice.
     *  Absent = derive from the model selection (back-compat). UI-only; the engine
     *  reads the resolved model ids, not this. */
    mode?: 'fast' | 'balanced' | 'accurate' | 'custom';
    /** Add punctuation + capitalization to committed text. Default true (OFF = faster path). */
    punctuation?: boolean;
    /** BCP-47 language. v1 ships English only. Default `en`. */
    language?: string;
    /** Press Enter automatically once the transcription is inserted, submitting it to
     *  the agent. Default true; set false to leave the text in the input for you to
     *  review and send yourself. */
    autoSubmit?: boolean;
    /** Trailing-capture buffer: keep the mic open this many ms after the user releases
     *  push-to-talk, so the tail of the last word (still being spoken as they release)
     *  is captured instead of clipped. Snaps to 50ms steps in the UI (0-500). 0 = stop
     *  immediately. Default 250. */
    releaseBufferMs?: number;
    /** Which live UI surface to show while dictating (experiment switcher).
     *  `popup` = floating panel; `docked` = bar by the terminal input; `live` =
     *  type directly into the resolved target as you speak. Default `popup`,
     *  though `live` is what actually ships (see `useDictation`). */
    experience?: 'popup' | 'docked' | 'live';
    /** Remote backend (used when engineMode = `remote`). */
    remote?: DictationRemoteEndpoint;
  };

  /**
   * Mobile companion app bridge. GLOBAL/shared scope (below the settings
   * separator, in the Mobile Devices tab): the identity, roster, and relay
   * connection represent this desktop installation, not any one project.
   */
  mobileBridge?: {
    /** Master switch. When false, no relay connection is held and pairing is unavailable. Default false. */
    enabled?: boolean;
    /**
     * 'hosted' dials the Kangentic-hosted relay; 'local' dials a relay
     * running on 127.0.0.1 (dev builds only - see src/shared/relay.ts's
     * LOCAL_DEV_RELAY_URL); 'custom' uses relayUrl. Default 'hosted'.
     */
    relayMode?: 'hosted' | 'local' | 'custom';
    /** The relay address to dial. Only consulted when relayMode === 'custom'; resolve through src/shared/relay.ts's resolveRelayUrl rather than reading this directly. */
    relayUrl?: string;
  };

  hasCompletedFirstRun: boolean;
  /** The version whose release-notes modal has already been auto-shown, so it does
   *  not reopen on every relaunch. Empty string until the first update lands. */
  lastSeenReleaseNotesVersion: string;
  /** The version whose post-update "What's New" dialog has already been shown.
   *
   *  Deliberately NOT `lastSeenReleaseNotesVersion`, which records the PENDING
   *  version when the pre-restart modal is dismissed. A user who clicks "Later"
   *  and then quits normally has the update installed by
   *  `autoUpdater.autoInstallOnAppQuit`, and would relaunch with the new version
   *  already marked seen and the notes never read - exactly the case the
   *  post-update surface exists to cover.
   *
   *  Seeded to the running version on a fresh install (src/main/index.ts) so a
   *  first-time user is not shown notes for software they have never run, and so
   *  it does not collide with the onboarding walkthrough on that same boot.
   *  Empty string on an existing install that has not yet upgraded past the
   *  release this key was added in. */
  lastWhatsNewShownVersion: string;
  /** Ids of in-app announcements the user has dismissed from the banner
   *  (src/shared/announcements.ts). Auto-set on dismissal, not shown in the
   *  settings UI. Pruned on write to ids still present in the active feed so
   *  the array stays bounded (computeDismissedIdsAfterDismiss). Optional
   *  because configs written before this key existed lack it until their next
   *  save; readers guard with `?? []`. */
  dismissedAnnouncementIds?: string[];
  /** Project ids whose onboarding checklist the user has dismissed. Global (per-machine)
   *  memory keyed by project id, like `lastActiveTaskByProject`. `undefined` means the
   *  one-time upgrade backfill (App.tsx, on first hydration) has not run yet; `[]` means
   *  it has run and nothing is dismissed. The backfill seeds every project the user already
   *  had open so existing users never see the checklist on projects they already use.
   *
   *  EMPTINESS is the load-bearing signal, not membership: the checklist auto-opens only
   *  while this list is empty. The walkthrough teaches the app rather than a repo, so it is
   *  install-scoped - a newly added project has a brand-new id and would otherwise replay
   *  the whole thing on an established install. The list becomes non-empty by exactly three
   *  routes, all of which mean "not a first run": the backfill finding at least one existing
   *  project, a real dismissal (WelcomeChecklistDialog), or all five steps completed
   *  (AppLayout). Membership itself is now only a record of which projects were retired.
   *
   *  Distinct from the legacy `hasCompletedFirstRun`, which means first TASK creation - that
   *  is step 3 of the walkthrough, so it would retire onboarding mid-flow. */
  onboardedProjectIds?: string[];
  /** Per-project snapshot of the settings the onboarding checklist watches, captured on first
   *  checklist OPEN. `WelcomeChecklistDialog`'s mount effect is the only writer, and AppLayout
   *  mounts that dialog only while `onboardingChecklistOpen`, so adding a project does NOT
   *  capture one by itself. While `onboardedProjectIds` is still empty, arriving at a project
   *  earns one auto-open per session (AppLayout keys that latch by project id precisely so the
   *  first-run window can span several), so a second project added during that window does get
   *  a baseline. Once the list is non-empty the install-scoped gate is closed for good, and a
   *  project added later has no baseline until the Developer tab's dev-only trigger opens the
   *  checklist there.
   *  Steps 1 and 2 tick by comparing live state against this, so opening a settings screen and
   *  closing it again ticks nothing - only a real change does. Both are guarded on
   *  `baseline !== undefined`, so a baseline-less project reports them un-ticked rather than
   *  spuriously complete. Keyed by project id; listed in CONFIG_DICTIONARY_PATHS so
   *  per-project removal is not swallowed by the deep merge. */
  onboardingBaseline?: Record<string, OnboardingBaseline>;
  skipDeleteConfirm: boolean;
  skipBoardConfigConfirm: boolean;
  autoFocusIdleSession: boolean;
  /** Click-outside dismiss policy for modeless task-detail windows. Default `focused`. */
  windowLightDismiss: WindowLightDismiss;
  /** One-shot marker for the `single` -> `focused` default flip on `windowLightDismiss`.
   *
   *  `ConfigManager.save()` writes the WHOLE merged blob, so every install that ran
   *  while `single` was the default has it persisted as a literal key. A default change
   *  alone therefore reaches fresh installs only: an upgrading user keeps `single`
   *  forever, and `single` resolves to no target once a second window is open, so
   *  click-outside close silently does nothing there with no visible cause.
   *
   *  A persisted `single` cannot be told apart from a deliberate choice - both serialize
   *  identically - so the migration in `ConfigManager.load()` accepts overriding a real
   *  `single` choice made before this shipped. This marker is what bounds that to exactly
   *  one rewrite: a user who re-picks `single` afterwards keeps it.
   *
   *  The marker is persisted on every launch that can safely write, INCLUDING a fresh
   *  install, so the block stops re-evaluating. The one exception is a config file that
   *  exists but will not parse: writing there would replace it with bare defaults, so
   *  the rewrite is deferred to a launch that can read the file.
   *
   *  Retirable (with its migration block) once no supported install can still predate
   *  the release that introduced it - at which point every config on disk already
   *  carries `true`. Until then it stays, like `hasCompletedFirstRun` below. */
  hasMigratedWindowLightDismissDefault: boolean;
  /** Task IDs that have already been offered an auto-rename suggestion. Persisted so a
   *  dismissed suggestion does not reappear on the next app launch. Drained on task
   *  delete (TASK_DELETE / TASK_BULK_DELETE handlers in `task-crud.ts`) so the array
   *  size stays bounded by the live task count. */
  autoNameAskedTaskIds: string[];
  /** Maximum auto-name CLI calls per rolling 60-minute window. Caps cost on burst
   *  task creation. 0 disables the limit. Default: 60. */
  autoNameRateLimitPerHour: number;
  restoreWindowPosition: boolean;
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  windowMaximized: boolean;
  /** Persisted bounds + last target display for each detached pop-out surface, keyed by
   *  PopOutKind (not per-task), so a surface reopens on the monitor it was last placed on. */
  popOutBounds: Record<string, {
    bounds: { x: number; y: number; width: number; height: number };
    displayId: number;
    maximized: boolean;
  }>;
  /** @deprecated The status-bar usage strip was replaced by the usage dashboard.
   *  Read once as a seed fallback for `usageStatsPeriod`; never written anymore. */
  statusBarPeriod: UsageTimePeriod;
  /** Persisted time range for the usage stats dashboard. One global value shared
   *  across all projects (survives project switches and restarts). */
  usageStatsPeriod: UsageTimePeriod;
  /** Persisted scope for the usage stats dashboard: the current project or the
   *  app-wide all-projects rollup. Remembers the last user selection. */
  usageStatsScope: UsageStatsScopeKind;
  /** Per-project memory of the last user-selected task tab in the terminal panel.
   *  Keyed by project ID, value is the task ID. Restored on project switch. */
  lastActiveTaskByProject: Record<string, string>;
  /** Per-project in-app window-manager layout: the open task-detail windows + their
   *  tiling, so the full arrangement survives a project switch and an app restart.
   *  Keyed by project ID. Global (per-machine) state, written merge-safely via
   *  `config.set` and restored AFTER sessions resolve. See
   *  src/renderer/window-manager/persistence/. */
  workspaceByProject: Record<string, SerializedWorkspace>;
  /** GLOBAL in-app layout for the Command Terminal window layer: the open command
   *  terminal window(s) + their tiling, shared across ALL projects (one blob, not
   *  keyed by project) so the arrangement is consistent everywhere. The sessions
   *  themselves stay per-project and ephemeral; only the geometry/arrangement
   *  persists. Anchored by slot id (the on-disk `taskId` field carries the slot).
   *  Null until a layout is first saved. See
   *  src/renderer/components/command-bar/ + window-manager/persistence/. */
  commandTerminalWorkspace: SerializedWorkspace | null;
  /** GLOBAL in-app layout for the Agent Monitor's task-detail window layer: which
   *  details are open over the monitor and how they are arranged. One blob, not
   *  keyed by project, because the monitor is cross-project by design (its windows
   *  are anchored by `projectId:taskId`).
   *
   *  Unlike the other two layers this one has to cross a RENDERER boundary: the
   *  monitor can be hosted in the main window or in its own pop-out, and each has
   *  its own copy of the module-singleton window store, so the blob is the only
   *  thing that can carry an open detail between them. Nothing is mounted while
   *  the monitor is closed - the layout is restored on next open.
   *
   *  Null until a layout is first saved. See src/renderer/components/monitor/. */
  monitorWorkspace: SerializedWorkspace | null;
  /** Persisted union of every model ID we've ever seen for each agent: the
   *  result of the static/JSONL `discoverCapabilities()` walk, plus any model
   *  that has appeared on a live session's usage stream (Claude reports model
   *  IDs like `claude-opus-4-7` on `usage.model.id`), plus any value the user
   *  has typed/picked in an override. Keyed by agent name. Acts as the cache
   *  for the model dropdowns so they don't depend on re-walking JSONL every
   *  launch and they "discover" new models the user invokes in real time. */
  discoveredModelsByAgent: Record<string, string[]>;
  /** Empirically-observed context-window size (in tokens) per model, learned
   *  from a live session's `status.json` (`context_window.context_window_size`,
   *  the account-accurate window Claude reports). Keyed by agent name, then by
   *  BASE model id (the `[1m]`/dated suffix stripped, since the window is a
   *  model+account constant). The window is NOT derivable from a model id alone
   *  (a plain `claude-opus-4-8` runs 1M on a 1M-entitled account, 200K
   *  elsewhere), so it is discovered from telemetry rather than hardcoded; the
   *  model dropdowns render a context-size badge only for a model whose window
   *  has actually been observed. Last-observation-wins so an entitlement change
   *  re-baselines. */
  discoveredContextWindowsByAgent: Record<string, Record<string, number>>;
  /** User keybinding overrides: registry action id -> canonical combo string
   *  (e.g. 'Mod+Shift+K'). Absent/empty means use the registry default. Global
   *  only (per-machine), like `developer.*`. See `src/shared/keybindings.ts`. */
  hotkeyOverrides: Record<string, string>;
}

/** The resolved dictation config block (never undefined at the field level). */
export type DictationConfig = NonNullable<AppConfig['dictation']>;

/** A persisted in-app window-manager layout (one entry per project in
 *  `AppConfig.workspaceByProject`). taskId-anchored and fractional, so it survives
 *  session respawns and viewport resizes. The `taskId` field is the durable
 *  anchor: a board taskId for a `task-detail` window, a Kangentic session id for
 *  a `conversation` window. */
export interface SerializedWorkspace {
  /** Schema version of this persisted layout. Stamped on save and checked on
   *  restore so an older / unknown-shaped blob is ignored rather than mis-applied. */
  version: number;
  windows: Array<{
    taskId: string;
    /** The window's content kind. Optional for back-compat with pre-existing
     *  blobs (all of which were 'task-detail' windows on the board layer, or
     *  'command-terminal' windows on the command layer): a restored window with
     *  no stamped kind defaults to the restoring layer's own kind. */
    kind?: 'task-detail' | 'command-terminal' | 'conversation';
    title: string;
    geometry: { x: number; y: number; w: number; h: number };
    restoreGeometry: { x: number; y: number; w: number; h: number } | null;
    state: 'floating' | 'tiled' | 'snapped' | 'maximized';
  }>;
  /** N-ary tile tree with leaves anchored by taskId. Null when nothing is tiled. */
  tileTree: SerializedTileNode | null;
  tileTreeRect: { x: number; y: number; w: number; h: number };
  focusedTaskId: string | null;
}

export type SerializedTileNode =
  | { kind: 'leaf'; taskId: string }
  | {
      kind: 'split';
      direction: 'horizontal' | 'vertical';
      children: SerializedTileNode[];
      sizes: number[];
    };

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
  sidebarVisible: true,
  boardLayout: 'horizontal',
  cardDensity: 'default',
  columnWidth: 'default',
  showTaskNumbers: true,
  terminalPanelVisible: true,
  animationsEnabled: true,
  statusBarVisible: true,
  diffViewMode: 'split',
  diffDefaultScope: 'working',
  diffIgnoreWhitespace: false,
  diffCollapseUnchanged: false,
  diffFileSort: 'name',
  diffFlatList: false,
  monitor: {
    layout: 'cards',
    // Grouped by PROJECT out of the box. This view exists because agents are
    // spread across projects, so "whose agents are these" is the question a user
    // arrives with, and project sections answer it before they touch a control.
    // Grouping by state is the deliberate second choice, for when the question is
    // "what needs me" instead.
    //
    // Either way the sections are LABELLED, which is what makes a card moving
    // between them legible. Suppressing that movement was tried first and made
    // the ordering dishonest (a working agent could sit above one that needed
    // you); positions are still held stable for anything short of a section
    // change. Note that attention-first ordering is a property of STATE grouping
    // (BUCKET_ORDER), so it applies once the user picks Status.
    groupBy: 'project',
    sort: 'longest-running',
    liveOnly: false,
    projectFilter: [],
    stateFilter: [],
    textFilter: '',
  },
  terminal: {
    shell: null,
    fontFamily: 'Menlo, Consolas, "Courier New", monospace',
    fontSize: 14,
    showPreview: false,
    panelHeight: 250,
    panelCollapsed: false,
    cursorStyle: 'block',
    colors: {},
    backspaceSendsCtrlH: false,
  },
  agent: {
    permissionMode: 'acceptEdits',
    cliPaths: {},
    maxConcurrentSessions: 8,
    queueOverflow: 'queue',
    idleTimeoutMinutes: 0,
    autoResumeSessionsOnRestart: true,
    executionServers: {},
    execution: {},
    launchOptions: {},
  },
  sidebar: {
    width: 400,
  },
  git: {
    worktreesEnabled: true,
    autoCleanup: true,
    defaultBaseBranch: 'main',
    copyFiles: [],
    initScript: null,
    linkNodeModules: true,
    prRefreshIntervalMinutes: 5,
  },
  mcpServer: {
    enabled: true,
    bindAddress: '127.0.0.1',
  },
  contextBar: {
    showShell: true,
    showVersion: true,
    showElapsed: true,
    showCost: true,
    showToolCalls: true,
    // Agent active-time overlaps conceptually with elapsed time, so it is
    // opt-in by default to keep the bar lean (one row in the common case).
    showAgentActive: false,
    showTokens: true,
    showContextFraction: true,
    showProgressBar: true,
    showRateLimits: true,
  },
  notifications: {
    desktop: {
      onAgentIdle: true,
      onAgentCrash: true,
      onPlanComplete: true,
      onSpawnStalled: true,
    },
    toasts: {
      onAgentIdle: true,
      onAgentCrash: true,
      onPlanComplete: true,
      onSpawnStalled: true,
      durationSeconds: 4,
      maxCount: 5,
    },
    cooldownSeconds: 10,
  },
  backlog: {
    priorities: [
      { label: 'None', color: '#6b7280' },
      { label: 'Low', color: '#3b82f6' },
      { label: 'Medium', color: '#eab308' },
      { label: 'High', color: '#f97316' },
      { label: 'Urgent', color: '#ef4444' },
    ],
    labelColors: {},
  },
  browser: {
    enabled: true,
  },
  hasCompletedFirstRun: false,
  lastSeenReleaseNotesVersion: '',
  lastWhatsNewShownVersion: '',
  dismissedAnnouncementIds: [],
  skipDeleteConfirm: false,
  skipBoardConfigConfirm: false,
  autoFocusIdleSession: false,
  windowLightDismiss: 'focused',
  hasMigratedWindowLightDismissDefault: false,
  autoNameAskedTaskIds: [],
  autoNameRateLimitPerHour: 60,
  restoreWindowPosition: true,
  windowBounds: null,
  windowMaximized: false,
  popOutBounds: {},
  statusBarPeriod: 'live',
  usageStatsPeriod: 'live',
  usageStatsScope: 'project',
  lastActiveTaskByProject: {},
  workspaceByProject: {},
  commandTerminalWorkspace: null,
  monitorWorkspace: null,
  discoveredModelsByAgent: {},
  discoveredContextWindowsByAgent: {},
  hotkeyOverrides: {},
  memory: {
    indexingEnabled: true,
    semanticEnabled: false,
    embeddingModel: 'bge-base',
    acceleration: 'auto',
  },
  dictation: {
    enabled: false,
    engineMode: 'auto',
    modelId: null,
    punctuation: true,
    language: 'en',
    autoSubmit: true,
    releaseBufferMs: 250,
    experience: 'popup',
  },
  mobileBridge: {
    // relayMode is deliberately ABSENT, not 'hosted'. ConfigManager.load()
    // deep-merges this default with the parsed config file key-by-key
    // (mobileBridge is not a CONFIG_DICTIONARY_PATHS entry, so it is not
    // replaced wholesale), which means any value set here fills in over a
    // config written before relayMode existed. Seeding 'hosted' therefore
    // defeated resolveRelayUrl's "relayMode missing but relayUrl set =>
    // custom" compat inference (src/shared/relay.ts) for exactly the users it
    // was written for: a self-hoster upgrading from the pre-relayMode schema
    // would silently be switched onto the Kangentic-hosted relay. Leaving it
    // undefined lets that inference run. An explicit user choice still
    // persists a concrete mode, and a fresh config with no relayUrl resolves
    // to hosted anyway.
    enabled: false,
    relayUrl: '',
  },
};

// === Agent Commands ===

export interface AgentCommand {
  name: string;         // "code-review"
  displayName: string;  // "/code-review"
  description: string;  // from frontmatter, or empty
  argumentHint: string; // from frontmatter, or empty (e.g. "[all|audit|write]")
  source: 'command' | 'skill';
}

// === Updater ===

export interface UpdateDownloadedInfo {
  version: string;
  /** Markdown release notes for this version, normalized to a flat string. Empty if none. */
  releaseNotes: string;
}

// === Backlog ===

export type BacklogPriority = 0 | 1 | 2 | 3 | 4;
// 0=none, 1=low, 2=medium, 3=high, 4=urgent

export const BACKLOG_PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

export const DEFAULT_PRIORITY_CONFIG: Array<{ label: string; color: string }> = [
  { label: 'None', color: '#6b7280' },
  { label: 'Low', color: '#3b82f6' },
  { label: 'Medium', color: '#eab308' },
  { label: 'High', color: '#f97316' },
  { label: 'Urgent', color: '#ef4444' },
];

export interface BacklogTask {
  id: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
  position: number;
  assignee: string | null;
  due_date: string | null;
  item_type: string | null;
  external_id: string | null;
  external_source: string | null;
  external_url: string | null;
  sync_status: string | null;
  external_metadata: Record<string, unknown> | null;
  attachment_count: number;
  created_at: string;
  updated_at: string;
}

export interface BacklogTaskCreateInput {
  title: string;
  description?: string;
  priority?: number;
  labels?: string[];
  pendingAttachments?: Array<{ filename: string; data: string; media_type: string }>;
  assignee?: string;
  dueDate?: string;
  itemType?: string;
  externalId?: string;
  externalSource?: string;
  externalUrl?: string;
  syncStatus?: string;
  externalMetadata?: Record<string, unknown>;
}

export interface BacklogTaskUpdateInput {
  id: string;
  title?: string;
  description?: string;
  priority?: number;
  labels?: string[];
  pendingAttachments?: Array<{ filename: string; data: string; media_type: string }>;
}

export interface BacklogPromoteInput {
  backlogTaskIds: string[];
  targetSwimlaneId: string;
}

export interface BacklogDemoteInput {
  taskId: string;
  priority?: number;
  labels?: string[];
}

// === External Import Types ===

/**
 * Discriminator for board integration providers. Existing values keep
 * snake_case for DB back-compat; new stub providers use plain lowercase.
 * Do not "normalize" casing across providers - existing DB rows rely on
 * the snake_case spellings.
 */
export type ExternalSource =
  | 'github_issues'
  | 'github_projects'
  | 'azure_devops'
  | 'asana'
  | 'jira'
  | 'linear'
  | 'trello';

export interface ImportSource {
  id: string;
  source: ExternalSource;
  label: string;
  repository: string;
  url: string;
  createdAt: string;
}

export interface ExternalIssue {
  externalId: string;
  externalSource: ExternalSource;
  externalUrl: string;
  title: string;
  body: string;
  labels: string[];
  assignee: string | null;
  state: string;
  workItemType?: string;
  createdAt: string;
  updatedAt: string;
  alreadyImported: boolean;
  attachmentCount: number;
  fileAttachments?: Array<FileAttachmentRef>;
}

/**
 * Reference to an attachment to download. `url` is the time-of-fetch URL
 * (good for the immediate download path). `externalRef` is an opaque,
 * adapter-specific identifier the adapter can use to re-resolve a fresh URL
 * at download time -- needed for providers like Asana whose `download_url`
 * expires within ~2 minutes of being returned by the API.
 */
export interface FileAttachmentRef {
  url: string;
  filename: string;
  sizeBytes: number;
  externalRef?: string;
}

export interface ImportFetchInput {
  source: ExternalSource;
  repository: string;
  page: number;
  perPage: number;
  searchQuery?: string;
  state?: 'open' | 'closed' | 'all';
}

export interface ImportFetchResult {
  issues: ExternalIssue[];
  totalCount: number;
  hasNextPage: boolean;
}

export interface ImportExecuteInput {
  source: ExternalSource;
  repository: string;
  issues: Array<{
    externalId: string;
    externalUrl: string;
    title: string;
    body: string;
    labels: string[];
    assignee: string | null;
    fileAttachments?: Array<FileAttachmentRef>;
  }>;
}

export interface ImportExecuteResult {
  imported: number;
  skippedDuplicates: number;
  skippedAttachments: number;
  items: BacklogTask[];
}

export interface AsanaAuthStatus {
  /** True when a Personal Access Token is saved and validated. */
  connected: boolean;
  email?: string;
  message?: string;
}

export interface AsanaSetPatInput {
  token: string;
}

export interface AsanaSetPatResult {
  ok: boolean;
  email?: string;
  error?: string;
}

export interface ImportCheckCliResult {
  available: boolean;
  authenticated: boolean;
  error?: string;
}

// === Mobile Bridge ===
// This repo's types.ts is deliberately import-free (a dependency-free leaf
// module), so these mirror @kangentic/protocol's CapabilityVerb/roster
// shapes as plain, self-contained types rather than importing them -- keep
// MOBILE_CAPABILITY_VERBS in sync with packages/protocol/src/capabilities/verbs.ts
// (CAPABILITY_VERBS) by hand; there is no shell/file/arbitrary-command verb
// in the protocol, by design.
export const MOBILE_CAPABILITY_VERBS = [
  'read-stream',
  'read-board',
  'read-diff',
  'send-user-message',
  'move-task',
  'answer-permission-prompt',
  'interactive-terminal',
  'board-tool-read',
  'board-tool-write',
  'register-push',
] as const;
export type MobileCapabilityVerb = (typeof MOBILE_CAPABILITY_VERBS)[number];

export interface MobileBridgeStatus {
  enabled: boolean;
  /** False when Electron safeStorage can't genuinely encrypt (e.g. the Linux basic_text backend) -- the bridge refuses to create/use an identity in that state. */
  secureStorageAvailable: boolean;
  /** Hex-encoded static public key, for display/verification. Never the private key. */
  identityFingerprint: string | null;
  relayUrl: string;
  pairedDeviceCount: number;
  pairingInProgress: boolean;
  /**
   * Aggregate transport state across every paired device's live relay
   * connection: 'connected' if any is connected, else 'connecting' if any
   * is connecting, else 'reconnecting' if any is reconnecting, else
   * 'closed' if any is closed, else 'idle' when there are no sessions.
   * Excludes the ephemeral pairing transport, which has its own error
   * surface via the pairingEnded event. So a paired device whose relay is
   * unreachable does not render as healthy.
   */
  relayState: MobileBridgeTransportState;
}

/** Mirrors @kangentic/protocol's TransportState - re-declared here (not re-exported) so src/shared/types.ts stays free of a protocol-package runtime dependency; only the string union shape needs to match. */
export type MobileBridgeTransportState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * What one paired device's row reports. Every transport state plus 'offline':
 * the relay slot is up but no phone is attached to it (no live Noise KK
 * session), which the transport alone cannot express - it reads 'connected'
 * whenever the relay is reachable, phone powered off or not.
 *
 * 'offline' is a presence conclusion, NOT a transport state, so it is
 * deliberately absent from the @kangentic/protocol mirror above; that union
 * must keep matching the package exactly.
 */
export type MobileDeviceConnectionState = MobileBridgeTransportState | 'offline';

export interface MobileStartPairingResult {
  /** The `kangentic-pair://...` URI to render as a QR code. */
  qrUri: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface MobilePairedDevice {
  deviceId: string;
  displayName: string;
  capabilities: MobileCapabilityVerb[];
  /** ISO 8601. */
  pairedAt: string;
  /** Live, not persisted - this device's own connection state (transport refined by whether the phone is actually attached), not the panel-wide aggregate. */
  connectionState: MobileDeviceConnectionState;
}

export interface MobilePairingSasPayload {
  /** 6-digit short authentication string for the user to compare against the phone's screen. No emoji: the digits alone already carry the full transcript-hash comparison. */
  digits: string;
  /** Hex-encoded, for display only -- the roster entry itself is signed and persisted main-side. */
  phoneStaticPublicKeyHex: string;
}

/** Fired once the phone's sealed confirm frame opens and the device is auto-enrolled - see @kangentic/protocol's pairing/confirm.ts for what that frame does and does not prove. */
export interface MobilePairingConfirmedPayload {
  deviceId: string;
  /** The phone-supplied device name from the pairing handshake, not user-entered - renaming afterward is a separate action (mobile:renameDevice). */
  displayName: string;
}

export interface MobilePairingEndedPayload {
  reason: string;
  /** 'cancelled' is a deliberate user action (Cancel, or the panel closing mid-ceremony) - already obvious from the UI transition back to idle, so the desktop does not surface its reason as a message. Only 'failed' (mismatch, timeout, handshake error) is shown. */
  kind: 'cancelled' | 'failed';
}

// === IPC API Types ===

export interface TaskCreateInput {
  title: string;
  description: string;
  swimlane_id: string;
  labels?: string[];
  priority?: number;
  baseBranch?: string;
  useWorktree?: boolean | null;
  customBranchName?: string;
  model_override?: string | null;
  effort_override?: string | null;
  agent_override?: string | null;
  permission_mode?: PermissionMode | null;
  /** MCP-only initial command, injected once the agent spawns for this task. Not surfaced in the New Task dialog. */
  auto_command?: string | null;
  /** Board Profile to ride (see `Task.profile_id`). Setting this clears the four Advanced pins; they are mutually exclusive. */
  profile_id?: string | null;
  /** Which run mode the task was authored in (see `Task.run_mode`). Omitted defaults to `'column_settings'`, except that pinning any of the four Advanced fields implies `'agent_override'`. */
  run_mode?: TaskRunMode;
  /** External origin carried through when promoting an imported backlog item, so import dedup survives promotion. */
  externalId?: string;
  externalSource?: string;
  externalUrl?: string;
  pendingAttachments?: Array<{
    filename: string;
    data: string; // base64
    media_type: string;
  }>;
  /** Preserve an original creation timestamp (UTC ISO 8601) instead of stamping "now". Used when relocating a task to a different project's board. */
  createdAt?: string;
}

export interface TaskUpdateInput {
  id: string;
  title?: string;
  description?: string;
  swimlane_id?: string;
  position?: number;
  agent?: string | null;
  session_id?: string | null;
  worktree_path?: string | null;
  branch_name?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  pr_state?: PRState | null;
  head_sha?: string | null;
  base_branch?: string | null;
  use_worktree?: number | null;
  labels?: string[];
  priority?: number;
  model_override?: string | null;
  effort_override?: string | null;
  agent_override?: string | null;
  permission_mode?: PermissionMode | null;
  /** Board Profile to ride (see `Task.profile_id`). Setting this clears the four Advanced pins, and setting any of those four clears this. */
  profile_id?: string | null;
  /** Which run mode the task runs in (see `Task.run_mode`). `'agent_override'` clears `profile_id`; `'column_settings'` clears the four pins. Omitted leaves the stored mode alone, unless a pin or profile in the same write implies one. */
  run_mode?: TaskRunMode;
}

/** Result of `IPC.TASK_RESOLVE_PR` - the on-demand branch->PR resolver. */
export interface TaskResolvePrResult {
  /** The task after resolution (latest pr_url/pr_number/pr_state), or null if not found. */
  task: Task | null;
  /** True when the task now has a linked PR (whether or not it changed this call). */
  linked: boolean;
  /** Why the resolve ended this way - lets the UI/MCP show an accurate message. */
  reason: PRLinkStatus;
  /** Detail for `resolver-unavailable` (e.g. "gh CLI not found - run gh auth login"). */
  message?: string;
}

/**
 * Input for `IPC.TASK_SET_RUNTIME_OVERRIDE`. Either field can be omitted to
 * leave it unchanged; pass `null` to explicitly clear the override (so the
 * task falls back to its swimlane's `model_override`/`effort_override` and
 * ultimately to the agent default).
 */
export interface TaskSetRuntimeOverrideInput {
  taskId: string;
  model?: string | null;
  effort?: string | null;
}

/**
 * Result of `IPC.TASK_SET_RUNTIME_OVERRIDE`. `mode` describes how the change
 * was applied: `live` = slash-command injected into the running PTY,
 * `restart` = session suspended and respawned with `--resume`, `persisted` =
 * task has no live session so the override is saved for next spawn.
 */
export type TaskSetRuntimeOverrideResult =
  | { ok: true; mode: 'live' | 'restart' | 'persisted' }
  | { ok: false; reason: string };

/**
 * Input for `IPC.SESSION_INJECT_SETTINGS`. The session-keyed counterpart to
 * `TaskSetRuntimeOverrideInput`, used for transient (command-terminal)
 * sessions that have no task row and no DB persistence. The change is injected
 * live into the running PTY only; there is nothing to persist. `currentModel`/
 * `currentEffort` are the live values so the handler can compute whether each
 * field actually changed before asking the adapter for a slash sequence.
 */
export interface SessionInjectSettingsInput {
  sessionId: string;
  agent: string;
  model?: string | null;
  effort?: string | null;
  currentModel?: string | null;
  currentEffort?: string | null;
}

/**
 * Result of `IPC.SESSION_INJECT_SETTINGS`. `injected` is false when the
 * adapter produced no slash sequence for the requested change (e.g. a no-op
 * delta or an agent with no live-switch slash command).
 */
export type SessionInjectSettingsResult =
  | { ok: true; injected: boolean }
  | { ok: false; reason: string };

export interface TaskSwitchBranchInput {
  taskId: string;
  newBaseBranch: string;
  enableWorktree?: boolean;
}

export interface TaskUpdateFromBaseInput {
  taskId: string;
}

/**
 * Outcome of the explicit "Update from base" task action: fetch the task's
 * effective base, then fast-forward the task's worktree from `origin/<base>`.
 * This action is the only thing that MOVES a reused worktree - spawn-time
 * freshening deliberately never fast-forwards an existing tree, it only
 * surfaces drift. `cannot-ff` is a normal outcome, not an error: a branch
 * carrying its own commits legitimately stays where it is.
 */
export type TaskUpdateFromBaseResult =
  | { status: 'updated'; baseBranch: string; commitCount: number }
  | { status: 'already-up-to-date'; baseBranch: string }
  | { status: 'cannot-ff'; baseBranch: string; ahead: number; behind: number }
  | { status: 'dirty-tree'; baseBranch: string }
  | { status: 'fetch-failed'; baseBranch: string; reason: string }
  | { status: 'no-remote'; baseBranch: string };

export interface TaskMoveInput {
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
}

export interface TaskUnarchiveInput {
  id: string;
  targetSwimlaneId: string;
}

/**
 * Result of `tasks.listArchivedPreview(limit)`: the newest `limit` archived
 * tasks plus the authoritative total archived count. The board hydrates from
 * this small payload instead of the full archive (which can be many MB); the
 * full list loads lazily only when the Completed dialog opens.
 */
export interface ArchivedTasksPreview {
  totalCount: number;
  tasks: Task[];
}

export interface TaskBulkDeleteFailure {
  id: string;
  error: string;
}

export interface TaskBulkDeleteResult {
  deleted: number;
  failures: TaskBulkDeleteFailure[];
}

export interface TaskBulkDeleteProgress {
  completed: number;
  total: number;
  failures: TaskBulkDeleteFailure[];
}

export interface SwimlaneCreateInput {
  name: string;
  description?: string | null;
  color?: string;
  icon?: string | null;
  is_archived?: boolean;
  permission_mode?: PermissionMode | null;
  auto_spawn?: boolean;
  auto_command?: string | null;
  auto_command_mode?: AutoCommandMode;
  plan_exit_target_id?: string | null;
  agent_override?: string | null;
  model_override?: string | null;
  effort_override?: string | null;
  handoff_context?: boolean;
  session_target?: SessionTarget;
  session_spawn_strategy?: SessionSpawnStrategy;
}

export interface SwimlaneUpdateInput {
  id: string;
  name?: string;
  description?: string | null;
  color?: string;
  icon?: string | null;
  position?: number;
  is_archived?: boolean;
  is_ghost?: boolean;
  permission_mode?: PermissionMode | null;
  auto_spawn?: boolean;
  auto_command?: string | null;
  auto_command_mode?: AutoCommandMode;
  plan_exit_target_id?: string | null;
  agent_override?: string | null;
  model_override?: string | null;
  effort_override?: string | null;
  handoff_context?: boolean;
  session_target?: SessionTarget;
  session_spawn_strategy?: SessionSpawnStrategy;
}

export interface ActionCreateInput {
  name: string;
  type: ActionType;
  config_json: string;
}

export interface ActionUpdateInput {
  id: string;
  name?: string;
  type?: ActionType;
  config_json?: string;
}

export interface ProjectCreateInput {
  name: string;
  path: string;
  github_url?: string;
  default_agent?: string;
  default_model?: string | null;
  default_effort?: string | null;
}

/** Optional overrides for project creation at open-by-path time (the Add project dialog). */
export interface ProjectOpenByPathOverrides {
  name?: string;
  defaultAgent?: string;
}

/** Optional native folder-picker dialog customization (dialog.selectFolder). */
export interface SelectFolderOptions {
  title?: string;
  buttonLabel?: string;
  /** macOS only; ignored on Windows/Linux. */
  message?: string;
  defaultPath?: string;
}

/**
 * Read-only probe of a candidate project folder, returned by
 * `projects.probePath`. Drives the Add project dialog's git verdict and
 * already-registered branch before any project is actually created.
 */
export interface ProjectPathProbe {
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  isInsideWorktree: boolean;
  /** Current branch name, or null when not a git repo or HEAD is unreadable. */
  currentBranch: string | null;
  /** The folder's basename, offered as the dialog's default project name. */
  suggestedName: string;
  /** id of an already-registered project at this exact path, or null. */
  alreadyRegisteredProjectId: string | null;
}

/**
 * Outcome of `projects.ensureGit`.
 *
 * `ok` is false only for a genuine failure (git missing, permission denied). A folder
 * that was already covered by a repo - its own or a parent's - is `ok: true` with
 * `created: false`, so the caller can stay silent instead of reporting a non-problem.
 */
export interface ProjectEnsureGitResult {
  ok: boolean;
  /** True only when `git init` actually ran. */
  created: boolean;
  error: string | null;
}

/** Minimal parsing interface for agent-specific runtime behavior. */
export interface AgentParser {
  /**
   * Detect whether the agent has produced its first meaningful output.
   * Called on each PTY data flush. Return true to emit the 'first-output'
   * event that lifts the shimmer overlay in the renderer.
   */
  detectFirstOutput(data: string): boolean;
  /**
   * Optional: extract the configured model from a spawned command so the board
   * card can show a friendly model name immediately, before the agent reports
   * its own via status.json / stream telemetry. Returns `{ id, displayName }`
   * (e.g. `claude-opus-4-8` -> "Opus 4.8"), or null when no explicit model is
   * encoded. The agent's live telemetry overrides the seeded value, so a later
   * `/model` change stays accurate. See `AgentAdapter.configuredModelFromCommand`.
   */
  configuredModelFromCommand?(command: string): { id: string; displayName: string } | null;
  /** How this agent exposes runtime state (activity detection + session ID capture). */
  runtime: AdapterRuntimeStrategy;
  /**
   * Remove monitoring hooks injected by this adapter from the project's
   * settings file. Called on session exit and suspend to prevent hook
   * accumulation across sessions. Gemini and Codex write hooks to a
   * shared project-level file (no per-session settings flag), so each
   * session must clean up its own hooks when done. `taskId` identifies
   * which spawn is releasing so adapters can reference-count per task
   * and stay idempotent on double-releases (suspend + onExit).
   */
  removeHooks(directory: string, taskId?: string): void;
  /**
   * Optional per-session lifecycle hook. When present, session manager
   * calls it once per spawn and disposes the returned attachment on
   * session end. All adapter-specific orchestration that can't be
   * expressed declaratively through `runtime` lives here. See
   * `AgentAdapter.attachSession` for full contract.
   */
  attachSession?(context: SessionContext): SessionAttachment | void;
}

/**
 * Declares how an agent's activity (thinking vs idle) is detected.
 *
 * - `hooks` - Activity events arrive via event-bridge hooks (JSONL).
 *   Used by Claude Code. No PTY-based fallback.
 *
 * - `pty` - Activity is inferred from PTY output patterns. Primary
 *   mechanism for agents without hooks (Aider) or with broken hooks (Codex).
 *   Optional `detectIdle` provides instant idle detection via prompt regex;
 *   otherwise falls back to a silence timer.
 *
 * - `hooks_and_pty` - Hooks are the primary mechanism, but PTY-based
 *   detection acts as a fallback if hooks fail to fire. Once hooks deliver
 *   a thinking event, PTY detection is automatically suppressed.
 *   Used by Gemini (hook format verified, but runtime issues possible).
 */
export type ActivityDetectionStrategy =
  | { readonly kind: 'hooks' }
  | { readonly kind: 'pty'; detectIdle?(data: string): boolean }
  | { readonly kind: 'hooks_and_pty'; detectIdle?(data: string): boolean };

/**
 * Factory functions for constructing ActivityDetectionStrategy values.
 * Prefer these over inline object literals at adapter sites - they give
 * autocompleted, descriptive call-sites and enforce the correct shape
 * per variant (e.g. `hooks()` can't accidentally get a `detectIdle`).
 */
export const ActivityDetection = {
  /** Hooks are the sole source of activity truth (Claude Code). */
  hooks: (): ActivityDetectionStrategy => ({ kind: 'hooks' }),
  /** PTY-only detection. Optional detectIdle for instant prompt-regex idle. */
  pty: (detectIdle?: (data: string) => boolean): ActivityDetectionStrategy =>
    ({ kind: 'pty', detectIdle }),
  /** Hooks primary with PTY fallback if hooks fail to fire. */
  hooksAndPty: (detectIdle?: (data: string) => boolean): ActivityDetectionStrategy =>
    ({ kind: 'hooks_and_pty', detectIdle }),
} as const;

/**
 * Declares how an agent exposes runtime state to Kangentic.
 * One location per adapter for activity detection + session ID capture,
 * so everything about how we interact with a given CLI at runtime
 * lives in a single scannable block.
 */
export interface AdapterRuntimeStrategy {
  /** How thinking vs idle is detected (hooks, PTY patterns, or both). */
  readonly activity: ActivityDetectionStrategy;

  /**
   * How the agent's real CLI session ID is captured for resume support.
   * Omit entirely for agents that don't support resume (e.g. Aider) or
   * that use caller-owned IDs via --session-id (e.g. Claude Code).
   */
  readonly sessionId?: {
    /** Parse session ID from hook stdin JSON. Fires once on session_start
     *  when the agent's hooks deliver metadata (Gemini, Codex via env var). */
    fromHook?(hookContext: string): string | null;
    /** Parse session ID from raw PTY output. Scanned on every data chunk,
     *  plus one final scrollback scan when suspend() runs. Used for agents
     *  that print their session ID in terminal output (Codex startup header,
     *  Gemini shutdown summary). */
    fromOutput?(data: string): string | null;
    /**
     * Locate the agent's session ID by scanning the filesystem for a
     * freshly-created session file. Used for agents that don't print
     * the ID in PTY output and whose hooks are unavailable (Codex 0.118
     * doesn't fire `.codex/hooks.json`, but does write a rollout JSONL
     * at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
     * on every spawn - the UUID is in the filename). The implementation
     * polls the expected directory for a file created after
     * `spawnedAt` and returns the extracted UUID, or null if no match
     * is found within the polling budget.
     */
    fromFilesystem?(options: {
      spawnedAt: Date;
      cwd: string;
    }): Promise<string | null>;
  };

  /**
   * How the agent's native session history file is located and parsed
   * for real-time telemetry (model, context window, token counts,
   * message events). Used by agents that persist conversation state
   * to a local file we can tail: Codex writes JSONL to
   * ~/.codex/sessions/..., Gemini writes JSON to ~/.gemini/tmp/...
   * Claude declares it too, but as a BACKGROUND-SESSION FALLBACK: its
   * authoritative telemetry is the hook-driven `statusFile` pipeline,
   * and the transcript reader is detached on the first status.json
   * parse (via StatusFileReaderCallbacks.onFirstStatus). Omit entirely
   * for agents with no such file (Aider has no equivalent).
   */
  readonly sessionHistory?: {
    /**
     * Given the agent-reported session ID (captured by the PTY
     * scraper via runtime.sessionId.fromOutput, or caller-owned at
     * spawn for callerOwnedSessionId adapters), locate the session
     * history file on disk. Returns an absolute path, or null if the
     * file cannot be found within the adapter's polling budget or if
     * the platform can't be supported (e.g. WSL from Windows).
     *
     * Implementations compute the expected path from cwd + agent
     * session id and poll for it to appear. The budget is
     * adapter-chosen: Codex/Gemini use ~5 s (they locate after
     * capturing the id from a running CLI), while Claude uses ~60 s
     * (its attach fires at spawn, before the CLI has booted and
     * persisted its first prompt entry). `locate` MUST confirm the
     * file exists before returning it - SessionHistoryReader treats
     * ENOENT on the initial read as "file disappeared" and detaches.
     */
    locate(options: {
      agentSessionId: string;
      cwd: string;
    }): Promise<string | null>;

    /**
     * Parse session history content into telemetry. For append-only
     * JSONL files (Codex) this receives newly-appended bytes; caller
     * tracks the byte cursor. For whole-file-rewrite JSON files
     * (Gemini) this receives the full file content.
     */
    parse(content: string, mode: 'full' | 'append'): SessionHistoryParseResult;

    /**
     * True for whole-file-rewrite agents (Gemini rewrites session.json
     * on every message). False for append-only JSONL (Codex appends).
     * Tells the watcher whether to track a byte cursor or always
     * re-read the whole file.
     */
    readonly isFullRewrite: boolean;
  };

  /**
   * How the agent's hook-based status/events files are parsed for
   * real-time telemetry. Used by agents that emit telemetry through
   * Kangentic-injected hooks (event-bridge.js + status-bridge.js)
   * which write to per-session `status.json` and `events.jsonl` files
   * under `.kangentic/sessions/<sessionId>/`. Today only Claude Code
   * uses this pipeline; other agents rely on `sessionHistory` instead.
   *
   * Per-session file paths are caller-supplied (set on the spawn
   * options) since they are runtime values, not static adapter
   * metadata. The hook only owns the parse logic.
   */
  readonly statusFile?: {
    /**
     * Decode the rewritten contents of `status.json` into a
     * `SessionUsage` snapshot (model, context window, token counts,
     * cost). Returns null when the content is partial, malformed, or
     * does not yet contain a complete usage block.
     */
    parseStatus(raw: string): SessionUsage | null;

    /**
     * Decode a single appended line from `events.jsonl` into a
     * `SessionEvent`. Returns null for blank lines, comments, or
     * unrecognized event shapes.
     */
    parseEvent(line: string): SessionEvent | null;

    /**
     * True when the status file is fully rewritten on each update.
     * The events file is always append-only and tracked by a
     * separate byte cursor regardless of this flag.
     */
    readonly isFullRewrite: boolean;
  };

  /**
   * How the agent surfaces telemetry through its own PTY stdout (no
   * external file, no hook). Used by agents that emit machine-readable
   * NDJSON to the terminal (Cursor's `--output-format stream-json`).
   * Each spawn gets its own parser instance so per-session rolling
   * buffers can survive across PTY chunk boundaries.
   */
  readonly streamOutput?: {
    /** Build a fresh parser bound to a single session. */
    createParser(): StreamOutputParser;
  };

  /**
   * How the agent exposes a NAMED background shell's on-disk output for
   * liveness detection. The bg-shell process-tree watcher stats this file
   * each poll cycle: growth (size or mtime advancing) is positive evidence
   * that the shell is still alive, which keeps a genuinely-running shell
   * from being reclaimed at the 5-min named-shell cap when no OS PID could
   * be captured (the false-idle path in Incident B, where a backgrounded
   * E2E run is alive but the count heuristic is permanently desynced by
   * app-under-test churn).
   *
   * Claude Code writes each backgrounded Bash's stdout/stderr to a temp
   * file; other agents may have no such file. Omit entirely for those.
   */
  readonly backgroundShells?: {
    /**
     * Locate the on-disk output file for a named background shell, or
     * null when it cannot be found (no such file, agent uses a different
     * layout, or the path could not be resolved). The watcher treats null
     * as "unsupported" and falls back to the count heuristic and caps.
     */
    resolveOutputFile(options: { cwd: string; shellId: string }): string | null;

    /**
     * Report which of `shellIds` have a TERMINAL background-shell
     * notification in the agent's durable session transcript - definitive
     * proof the shell completed. A shell whose termination is never hooked
     * (Claude delivers it as a `queued_command` attachment, which never
     * fires `UserPromptSubmit`) is still recorded in the transcript, so this
     * is the reliable drain path for a NAMED shell whose OS PID was never
     * captured and whose output file stays quiescent without a process-tree
     * deficit ever confirming exit (task #386). Matching against the
     * caller's own tracked `shellIds` means an unrelated notification (e.g.
     * a subagent/Task completion, whose id is never a tracked shell) can
     * never match.
     *
     * Implementations read only NEW transcript bytes since the previous
     * call (an internal per-transcript cursor) so repeated polling stays
     * cheap. Must not throw: return [] when the transcript is missing,
     * unreadable, or nothing terminal appeared. Omit entirely for agents
     * whose transcript carries no such signal.
     */
    reportTerminatedShells?(options: {
      cwd: string;
      agentSessionId: string;
      shellIds: string[];
    }): string[];
  };
}

/**
 * Narrow, generic surface the session manager hands to an adapter's
 * `attachSession` hook. Everything an adapter needs to push telemetry
 * into the runtime without knowing anything about SessionTelemetry,
 * IPC, or the session map - so adapter-specific orchestration can
 * live inside the adapter module, not inside session-manager.ts.
 *
 * Keep this interface minimal - expand only when a new adapter has
 * a concrete need.
 */
export interface SessionContext {
  /** Stable internal session ID for diagnostic logging. */
  readonly sessionId: string;

  /**
   * Merge a partial SessionUsage patch into the session's
   * SessionTelemetry usage cache. Safe to call from async callbacks - a no-op
   * once the session has been torn down. Used by adapters that
   * resolve telemetry out-of-band (secondary CLI queries, HTTP
   * probes, etc.) and want to seed ContextBar before the PTY
   * produces parseable output.
   */
  applyUsage(usage: Partial<SessionUsage>): void;
}

/**
 * Handle returned from `AgentAdapter.attachSession` that lets the
 * session manager cancel pending adapter work when the session ends.
 * Adapters using fire-and-forget promises can implement this as a
 * flag flip; adapters subscribing to timers, watchers, or streams
 * should clear those here.
 */
export interface SessionAttachment {
  dispose(): void;
}

/**
 * Per-session PTY telemetry parser produced by
 * AdapterRuntimeStrategy.streamOutput.createParser(). Owns whatever
 * carry-over state the adapter needs (e.g. trailing partial JSON line)
 * across PTY chunks within one spawn.
 */
export interface StreamOutputParser {
  /**
   * Parse a PTY data chunk for usage and/or events. Returns null when
   * the chunk yielded no recognizable telemetry (the common case for
   * non-init lines), so callers can short-circuit without allocating.
   */
  parseTelemetry(data: string): {
    usage?: Partial<SessionUsage>;
    events?: SessionEvent[];
  } | null;
}

/**
 * Typesafe enum for the explicit activity transition hint returned by
 * session history parsers. Parsers emit these when a history entry
 * maps directly to a state change (Codex `task_started` → Thinking,
 * `task_complete` → Idle) rather than relying on the event stream
 * alone. Mirrors the `ActivityState` string union but scoped to the
 * transitions a history parser can observe.
 */
export const Activity = {
  Thinking: 'thinking',
  Idle: 'idle',
} as const;
export type Activity = typeof Activity[keyof typeof Activity];

/**
 * Parsed telemetry extracted from an agent's native session history
 * file by AdapterRuntimeStrategy.sessionHistory.parse(). All fields
 * are optional so parsers can return partial results (e.g. a token
 * update with no model change yields `usage` populated and
 * `events: []`).
 */
export interface SessionHistoryParseResult {
  /** Updated usage snapshot. Null if this parse pass didn't touch
   *  model or tokens. Callers merge with the existing usageCache entry. */
  usage: SessionUsage | null;
  /** New events to push into the session event log. Empty array if none. */
  events: SessionEvent[];
  /** Explicit activity transition hint. Null if events[] already
   *  imply the transition via the state machine. */
  activity: Activity | null;
}

/**
 * Per-turn token usage for one assistant turn, captured from the agent's native
 * transcript (Claude records `message.usage` on each assistant message). Kept as
 * the raw component counts, not a single sum, so downstream cost analysis can
 * weight fresh input vs. the much cheaper cache reads. Deduped by the agent's
 * message id at parse time, so a turn split across multiple JSONL lines is
 * counted once. Undefined when the agent/turn reported no usage. This is the
 * full-fidelity per-turn data that session-level `sessions.total_*_tokens`
 * aggregates - persisted here so burn-rate / cost analysis can tap it from the
 * conversation itself, not only the session summary.
 */
export interface TranscriptTurnUsage {
  /** Fresh (non-cached) input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache this turn (billed at the write rate). */
  cacheCreationInputTokens: number;
  /** Tokens served from the prompt cache this turn (billed at the cheap read rate). */
  cacheReadInputTokens: number;
}

/**
 * A durably-stored per-turn usage row from the per-project `conversation_turn_usage`
 * ledger. Unlike the in-transcript `TranscriptTurnUsage` (re-derived on every parse
 * and gone the moment the agent prunes its native JSONL), these rows are written to
 * the database at index time and persist independently of the source file, so
 * cost / burn-rate analysis can read a task's or a project's full token history long
 * after the transcript is deleted. Keyed by the turn's own uuid: a `--resume` replays
 * its parent's turns verbatim under the same uuid, so a replayed turn maps back onto
 * the same row (token totals never double-count a shared turn).
 */
export interface ConversationTurnUsageRecord {
  turnUuid: string;
  agentSessionId: string | null;
  sessionId: string | null;
  taskId: string | null;
  model: string | null;
  /** Epoch ms of the turn, or null when the agent reported no timestamp. */
  ts: number | null;
  usage: TranscriptTurnUsage;
  /** When this row was last written (UTC ISO 8601). */
  recordedAt: string;
}

/**
 * One entry in a parsed agent transcript. Distinct from `SessionEvent`
 * (telemetry only) - this preserves the actual conversation content for
 * display in the Transcript tab.
 */
export type TranscriptEntry =
  | { kind: 'user'; uuid: string; ts: number; text: string }
  // agentName is set only when this entry was stitched into a cross-session
  // task-level view (resolveTaskTranscript) whose sessions used different
  // agents - the role badge prefers it over the response's single top-level
  // agentName, which only describes the latest session. Absent for an
  // ordinary single-session transcript.
  //
  // usage carries this turn's per-turn token counts when the agent reported
  // them (see TranscriptTurnUsage). It is not shown in the viewer today; it is
  // captured so consumption/burn-rate analysis can read it straight off the
  // conversation. Absent when the agent/turn reported no usage.
  | { kind: 'assistant'; uuid: string; ts: number; model?: string; agentName?: string; usage?: TranscriptTurnUsage; blocks: TranscriptBlock[] }
  | { kind: 'tool_result'; uuid: string; ts: number; toolUseId: string; content: string; isError?: boolean }
  // Non-conversation events surfaced explicitly instead of being rendered as
  // misleading "## User" turns: conversation-compaction boundaries/summaries,
  // slash-command invocations and their local stdout, and (session_boundary)
  // the seam between two sessions stitched into one task-level view.
  | { kind: 'system'; uuid: string; ts: number; subtype: TranscriptSystemSubtype; text: string };

/**
 * The `kind: 'system'` entry variants.
 *
 * Named rather than inlined because this union had been hand-copied into four
 * other places (the renderer's SystemRow, the markdown formatter, the
 * normalized event stream, and the mobile wire mapper), so adding a member
 * meant finding all of them by chasing type errors. The protocol package's
 * `TranscriptSystemSubtypeWire` is deliberately NOT one of them: it stays at
 * the four wire-visible members, and `truncated` is mapped onto
 * `session_boundary` before it crosses. `truncated` marks a transcript too large
 * to parse whole: only its most recent `MAX_PARSE_SOURCE_BYTES` were read, and
 * its `text` names how much was left out. Like `session_boundary`, its text is
 * a ready-to-display sentence rather than raw payload behind a canned label.
 */
export type TranscriptSystemSubtype =
  | 'compaction'
  | 'command'
  | 'command_output'
  | 'session_boundary'
  | 'truncated';

export type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface SpawnSessionInput {
  /** Caller-provided session ID. When omitted, spawn() generates one via uuidv4(). */
  id?: string;
  taskId: string;
  projectId: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  statusOutputPath?: string; // path for the status bridge JSON file
  eventsOutputPath?: string; // path for the event bridge JSONL file (activity log)
  /** True when this session is resuming a previous Claude conversation. */
  resuming?: boolean;
  /** True for ephemeral command terminal sessions. */
  transient?: boolean;
  /** For a transient session, the renderer's durable Command Terminal window slot
   *  (`slot-1`, ...). Recorded so the Agent Monitor names the terminal exactly as
   *  its own window title bar does. See src/shared/command-terminal-name.ts. */
  commandTerminalSlot?: string | null;
  /** For a transient session, the branch it was actually spawned on (the RESOLVED
   *  branch, after any checkout fallback). Recorded so the monitor can tell you
   *  where a terminal is working, the way a task row names its column. */
  commandTerminalBranch?: string | null;
  /** Agent-specific parser for status/event output. Falls back to ClaudeStatusParser if omitted. */
  agentParser?: AgentParser;
  /** Human-readable agent name for diagnostic logs (e.g. "claude", "gemini").
   *  Survives production minification unlike `agentParser.constructor.name`. */
  agentName?: string;
  /** Sequence of strings to write to PTY before killing for graceful exit (e.g. ['\x03', '/exit\r']). */
  exitSequence?: string[];
  /**
   * Caller-owned agent session UUID. Set when the adapter declares
   * `supportsCallerSessionId = true` and the spawn pipeline pre-generates
   * a UUID before invoking the CLI (e.g. Claude `--session-id`, Qwen
   * `--session-id`, Kimi `--session`). Lets the spawn flow trigger
   * `notifyAgentSessionId` immediately so `sessionHistoryReader.attach`
   * fires without waiting for capture pathways to round-trip. Null/undefined
   * for adapters that auto-generate IDs (Codex, Gemini, Droid).
   */
  agentSessionId?: string | null;
  /**
   * The swimlane this PTY's session is isolated to (null = the task's main
   * session). Carried onto the live Session so the terminal can badge Main vs
   * Isolated. Defaults to null when omitted.
   */
  isolatedSwimlaneId?: string | null;
  /**
   * Caller-known PTY grid to spawn at, when available (e.g. a Command
   * Terminal branch respawn reusing the still-mounted xterm's current size).
   * Falls back to `takePendingResize` (a resize that beat the spawn), then to
   * DEFAULT_PTY_COLS/ROWS - see session-spawn-flow.ts.
   */
  cols?: number;
  rows?: number;
}

export interface SpawnTransientSessionInput {
  projectId: string;
  /** The window's durable slot id (`slot-1`, `slot-2`, ...). Slots are allocated by
   *  the renderer's Command Terminal layer, so main cannot derive this; it is sent
   *  purely so the Agent Monitor can name the terminal the same way its window
   *  does. Optional so an older caller still spawns, just unnumbered. */
  slot?: string;
  /** Branch to checkout before spawning. If omitted, uses the project's default base branch. */
  branch?: string;
  /** See `SpawnSessionInput.cols`/`rows` - the same seed-the-real-grid escape hatch. */
  cols?: number;
  rows?: number;
}

export interface NotificationInput {
  title: string;
  body: string;
  projectId: string;
  taskId: string;
}

// === Board Configuration (kangentic.json) ===

export interface BoardColumnConfig {
  id?: string; // opaque DB UUID for reconciliation identity
  name: string;
  /** Free-form description of the column's purpose. Shared with the team. */
  description?: string | null;
  role?: SwimlaneRole;
  icon?: string;
  color?: string;
  autoSpawn?: boolean;
  permissionMode?: PermissionMode | null;
  planExitTarget?: string; // name of target column
  archived?: boolean;
  autoCommand?: string | null;
  /** When the auto-command fires (see AutoCommandMode). Omitted means 'immediate'. */
  autoCommandMode?: AutoCommandMode;
  agentOverride?: string | null;
  /** Adapter-specific model identifier passed at spawn time (e.g. Claude `--model`). Null inherits the agent default. */
  modelOverride?: string | null;
  /** Adapter-specific effort/reasoning level passed at spawn time (e.g. Claude `--effort`). Null inherits the agent default. */
  effortOverride?: string | null;
  handoffContext?: boolean;
  /** Which session track this column runs a task on (see SessionTarget). Omitted = 'main'. */
  sessionTarget?: SessionTarget;
  /** What to do with that track on entry (see SessionSpawnStrategy). Omitted = 'create_or_resume'. */
  sessionSpawnStrategy?: SessionSpawnStrategy;
}

export interface BoardActionConfig {
  id?: string; // opaque DB UUID for reconciliation identity
  name: string;
  type: ActionType;
  config: ActionConfig;
}

export interface BoardTransitionConfig {
  from: string; // column name or '*'
  to: string; // column name
  actions: string[]; // action names
}

export type ShortcutDisplay = 'header' | 'menu' | 'both';

export interface ShortcutConfig {
  id?: string;           // UUID for merge identity (assigned on write-back)
  label: string;         // "Open in VS Code"
  icon?: string;         // Lucide icon key: 'code', 'git-branch', etc. Default: 'zap'
  command: string;       // "code \"{{cwd}}\"" -- template with variables
  display?: ShortcutDisplay; // where the shortcut appears (default: 'both')
}

/**
 * One column's strategy delta inside a Board Profile.
 *
 * SPARSE BY DESIGN, with three states per field - consumers MUST branch on key
 * PRESENCE (`'modelOverride' in entry`), never `entry.modelOverride ?? lane.x`:
 *
 *   key absent         -> inherit the column's own base value
 *   key present, null  -> clear to the agent default (no CLI flag), even when
 *                         the base column pins one
 *   key present, value -> use that value
 *
 * The middle state is why `??` is wrong: a profile must be able to say "Executing
 * runs the agent's default model" against a base column that pins Opus. Sparse
 * (rather than a full copy of every field) means adding a column, or editing a
 * base column, does not silently rot every profile.
 *
 * `JSON.stringify` drops `undefined` and keeps `null`, so a writer that emits
 * `undefined` for inherit and `null` for clear serializes correctly for free.
 */
export interface BoardProfileEntry {
  agentOverride?: string | null;
  modelOverride?: string | null;
  effortOverride?: string | null;
  permissionMode?: PermissionMode | null;
  autoCommand?: string | null;
  autoCommandMode?: AutoCommandMode;
  autoSpawn?: boolean;
  handoffContext?: boolean;
  sessionTarget?: SessionTarget;
  sessionSpawnStrategy?: SessionSpawnStrategy;
  /**
   * Name of the target column (NOT a uuid), matching `BoardColumnConfig.planExitTarget`.
   * This one field keeps the by-name convention it already round-trips under; it is
   * resolved to a swimlane id at read time.
   */
  planExitTarget?: string;
}

/**
 * A named alternate ladder of per-column STRATEGY settings, so a task can ride
 * different horsepower per column (e.g. Planning in Opus xhigh, Executing in
 * Opus high, Merge in Sonnet high) without changing the shared board for
 * everyone else.
 *
 * Column IDENTITY (which columns exist, their name, order, role, color, icon) is
 * singular across profiles - only strategy is profile-scoped.
 *
 * Lives only in `kangentic.json` / `kangentic.local.json`, following the
 * `ShortcutConfig` pattern: no DB table and no migration, with team/local scoping
 * for free. A task's ASSIGNMENT to a profile is separate per-machine state
 * (`tasks.profile_id`).
 *
 * `id` is a stable uuid and is what `tasks.profile_id` stores; `name` is display
 * only, so a teammate renaming a profile never detaches in-flight tasks. Entries
 * are keyed by swimlane uuid for the same reason - a column RENAME is far more
 * common than a uuid regeneration, and name-keying would silently detach every
 * entry on a rename with no error.
 */
export interface BoardProfile {
  /** UUID, assigned on write-back (mirrors `ShortcutConfig.id`). */
  id: string;
  /** Unique display name. */
  name: string;
  description?: string;
  /** Per-column deltas, keyed by swimlane uuid. A column with no entry inherits its base config verbatim. */
  columns: Record<string, BoardProfileEntry>;
}

export interface BoardConfig {
  version: number;
  columns: BoardColumnConfig[];
  actions: BoardActionConfig[];
  transitions: BoardTransitionConfig[];
  shortcuts?: ShortcutConfig[];
  /**
   * Named alternate strategy ladders (see BoardProfile). Absent / empty means
   * every task runs the columns' own settings, i.e. the synthetic "Default"
   * profile, which is deliberately NOT stored here.
   *
   * Like `shortcuts`, this key has no DB representation, so `buildBoardConfigFromDb`
   * must carry it across from the existing team config or a column edit destroys it.
   */
  profiles?: BoardProfile[];
  defaultBaseBranch?: string;
  _modifiedBy?: string;
}

// === Preload API (exposed to renderer via contextBridge) ===

/** Summary of a dev test-harness git-change seed (see DEV_SEED_GIT_CHANGES). */
export interface DevSeedGitChangesResult {
  /** Number of repos (active worktrees + project) that were seeded. */
  repos: number;
  /** The seed directory created in each repo (e.g. 'seed-3'). */
  dir: string;
  /** Commits in the seed chain ahead of base, per repo (a rich commit-history browser fixture, not one giant commit). */
  commits: number;
  /** Distinct fixture files committed ahead of base across the whole chain, per repo. */
  committed: number;
  /** Files staged in the index (M/A/D/R), per repo. */
  staged: number;
  /** Files changed in the working tree only (M/D/U), per repo. */
  working: number;
}

/** Summary of a dev test-harness embedding-backlog seed (see DEV_SEED_EMBEDDING_BACKLOG). */
export interface DevSeedEmbeddingBacklogResult {
  /** Number of synthetic pending chunks inserted. */
  seeded: number;
  /** The synthetic document id the chunks were written under (e.g. 'dev-seed-embedding-backlog-3'). */
  docId: string;
}

/** Summary of a dev test-harness usage-data seed (see DEV_SEED_USAGE_DATA). */
export interface DevSeedUsageDataResult {
  /** Synthetic finalized sessions written to usage_history (across all projects). */
  sessions: number;
  /** Synthetic turns written to conversation_turn_usage (across all projects). */
  turns: number;
  /** Days of history covered. */
  days: number;
  /** Registered projects seeded (descending volume per project). */
  projects: number;
}

/** Summary of a dev test-harness large-conversation seed (see DEV_SEED_LARGE_CONVERSATION). */
export interface DevSeedLargeConversationResult {
  /** The throwaway task's Kangentic session record id. */
  sessionId: string;
  /** The throwaway task's id. */
  taskId: string;
  /** Turns written by this click. */
  turnsAdded: number;
  /** Running total of turns written to the transcript file across every click for this seed. */
  totalTurns: number;
  /** The Claude session JSONL file the turns were written to. */
  filePath: string;
}

/** A mouse back/forward press inside a Browser pane's guest page, forwarded from
 *  main. See `ElectronAPI['browser']['onGuestMouseButton']`. */
export interface GuestMouseButtonEvent {
  webContentsId: number;
  button: 'back' | 'forward';
  phase: 'down' | 'up';
  /** `Date.now()` in the MAIN process, when the button actually moved. */
  at: number;
}

/**
 * Where a renderer error came from, sent alongside the message on
 * `ElectronAPI['analytics']['trackRendererError']`.
 *
 * The message alone is not locatable: `Cannot read properties of undefined
 * (reading 'split')` told us nothing about which surface threw it, because all
 * three reporters (both error boundaries and the bare unhandled-rejection
 * listener) sent a message and nothing else.
 */
export interface RendererErrorContext {
  /** Which reporter caught it. The most useful field by far: it says whether a
   *  component stack exists at all, since only the boundaries have one. */
  boundary: 'root' | 'panel' | 'unhandled_rejection';
  /** `PanelErrorBoundary`'s static `label` prop ("Changes", "Monitor"). */
  panel?: string;
  /** React's `info.componentStack`. Main reduces it to component names before
   *  sending; the raw value never leaves the process. */
  componentStack?: string;
}

export interface ElectronAPI {
  // Dev-only (preview): present only when __KANGENTIC_DEV__ (build-excluded in prod).
  dev?: {
    /** Create + return a synthetic ephemeral project for the preview. */
    createEphemeralProject: () => Promise<Project>;
    /**
     * Seed a realistic all-scopes/all-statuses git changeset into each given
     * ephemeral preview repo (active task worktrees + the project) so the Changes
     * tab has something to review. Silently skips any path outside the
     * preview-projects root.
     */
    seedGitChanges: (targetPaths: string[]) => Promise<DevSeedGitChangesResult>;
    /**
     * Seed `count` synthetic pending chunks (embedded_model = NULL) into the
     * current project's conversation-memory index via the real chunk-write
     * path, then flag the project dirty - the fast path to a realistic
     * embedding backlog (thousands of pending chunks) for exercising the
     * central embedding engine's drain loop under sustained real-worker load,
     * without needing that many real agent turns to produce it.
     */
    seedEmbeddingBacklog: (count: number) => Promise<DevSeedEmbeddingBacklogResult>;
    /**
     * Seed (or, on a re-click for the same project, append to) a throwaway
     * task + session backed by a real synthetic Claude session JSONL
     * transcript file, `count` turns long - the fast path to a huge realistic
     * transcript for exercising the Conversation viewer's
     * scrolling/search/performance, without running a real agent for hours.
     */
    seedLargeConversation: (count: number) => Promise<DevSeedLargeConversationResult>;
    /**
     * Seed `days` of realistic synthetic usage (sessions across several
     * agents/models plus per-turn time series, newest inside the trailing
     * live window) into EVERY registered project's usage ledgers via the real
     * capture repositories, at descending volume per project - the fast path
     * to rich usage-dashboard charts (including a meaningful This Project vs
     * All Projects difference) in a /preview session. Each click appends a
     * fresh batch.
     */
    seedUsageData: (days: number) => Promise<DevSeedUsageDataResult>;
    /** True only in dev-preview (`/preview`, `--ephemeral`); false in the regular dogfood. */
    isEphemeralPreview: boolean;
    /**
     * The original task's label for a `/preview` window - `#<display_id> - <title>` - so
     * the title bar can identify which task the "Project 1" / "Project 2" clones belong
     * to. Main reuses the same string as the OS window title, so the taskbar thumbnail
     * and the in-app pill always agree. Null outside preview, or when main could not
     * resolve it from the parent project DB.
     */
    previewTaskTitle: string | null;
  };
  // Projects
  projects: {
    list: () => Promise<Project[]>;
    create: (input: ProjectCreateInput) => Promise<Project>;
    delete: (id: string) => Promise<void>;
    open: (id: string) => Promise<void>;
    getCurrent: () => Promise<Project | null>;
    openByPath: (path: string, overrides?: ProjectOpenByPathOverrides) => Promise<Project>;
    probePath: (path: string) => Promise<ProjectPathProbe>;
    /** Make sure a picked folder is covered by git, initialising a repo when it is not.
     *  A folder already inside a repo is a no-op success, not an error. */
    ensureGit: (path: string) => Promise<ProjectEnsureGitResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    rename: (id: string, name: string) => Promise<Project>;
    setDefaultAgent: (id: string, agentName: string) => Promise<Project>;
    setDefaultModel: (id: string, model: string | null) => Promise<Project>;
    setDefaultEffort: (id: string, effort: string | null) => Promise<Project>;
    reorder: (ids: string[]) => Promise<void>;
    setGroup: (projectId: string, groupId: string | null) => Promise<void>;
    relocate: (id: string, newPath: string, options?: ProjectRelocateOptions) => Promise<ProjectRelocateResult>;
    onMoveProgress: (callback: (progress: ProjectMoveProgress) => void) => () => void;
    onAutoOpened: (callback: (project: Project) => void) => () => void;
    onPathMissing: (callback: (project: Project) => void) => () => void;
  };

  // Project Groups
  projectGroups: {
    list: () => Promise<ProjectGroup[]>;
    create: (input: ProjectGroupCreateInput) => Promise<ProjectGroup>;
    update: (id: string, name: string) => Promise<ProjectGroup>;
    delete: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
    setCollapsed: (id: string, collapsed: boolean) => Promise<void>;
  };

  // Tasks
  tasks: {
    list: (swimlaneId?: string) => Promise<Task[]>;
    // Mutation methods take an optional trailing `projectId` the renderer
    // stamps at interaction time so the mutation always targets the project it
    // was issued for, even if the user switches projects before the handler
    // runs. The handler prefers it over the ambient current project. See
    // .claude/rules/project-scoped-ipc.md.
    create: (input: TaskCreateInput, projectId?: string | null) => Promise<Task>;
    update: (input: TaskUpdateInput, projectId?: string | null) => Promise<Task>;
    delete: (id: string, projectId?: string | null) => Promise<void>;
    move: (input: TaskMoveInput, projectId?: string | null) => Promise<void>;
    /**
     * Cancel an in-flight spawn for a task (e.g. while it is parked in the
     * git queue or fetching). Aborts the move's AbortController; the existing
     * AbortError path clears spawn progress and rolls the move back.
     */
    cancelSpawn: (taskId: string) => Promise<void>;
    listArchived: () => Promise<Task[]>;
    /**
     * The newest `limit` archived tasks plus the total archived count. Cheap
     * hydration payload for the Done column's count + inline preview; the full
     * archive loads lazily via `listArchived` when the Completed dialog opens.
     */
    listArchivedPreview: (limit: number) => Promise<ArchivedTasksPreview>;
    unarchive: (input: TaskUnarchiveInput, projectId?: string | null) => Promise<Task>;
    bulkDelete: (ids: string[], projectId?: string | null) => Promise<TaskBulkDeleteResult>;
    bulkUnarchive: (ids: string[], targetSwimlaneId: string, projectId?: string | null) => Promise<void>;
    switchBranch: (input: TaskSwitchBranchInput, projectId?: string | null) => Promise<Task>;
    /**
     * One-click "Update from base": fetch the task's effective base and
     * fast-forward its worktree from origin/<base>. Refuses while a session is
     * running; every non-throw outcome is a TaskUpdateFromBaseResult status.
     */
    updateFromBase: (input: TaskUpdateFromBaseInput, projectId?: string | null) => Promise<TaskUpdateFromBaseResult>;
    setRuntimeOverride: (input: TaskSetRuntimeOverrideInput, projectId?: string | null) => Promise<TaskSetRuntimeOverrideResult>;
    /** On-demand authoritative branch->PR resolve + link for a task (works without a live session). */
    resolvePr: (taskId: string, projectId?: string | null) => Promise<TaskResolvePrResult>;
    /** Persist the task-detail dialog's layout blob (debounced from the renderer) so it restores across restarts. Pass null to clear. */
    setDetailViewState: (taskId: string, state: TaskDetailViewState | null, projectId?: string | null) => Promise<void>;
    onAutoMoved: (callback: (taskId: string, targetSwimlaneId: string, taskTitle: string, projectId?: string) => void) => () => void;
    /**
     * A task was created, promoted, unarchived or MCP-auto-spawned successfully,
     * but its agent could not start. Those four paths deliberately do not fail
     * the whole operation, so without this the task simply sits there looking
     * identical to a healthy one. `message` is already user-facing. A task MOVE
     * does not use this channel: it rejects the in-flight invoke instead, which
     * the renderer already toasts.
     */
    onSpawnBlocked: (callback: (taskId: string, taskTitle: string, message: string, projectId?: string) => void) => () => void;
    /**
     * Non-blocking spawn warning: the agent STARTED, but its base branch could
     * not be freshened (a network or credential fetch failure), so it may be
     * running from a stale base. `message` is already user-facing; unlike
     * onSpawnBlocked the renderer adds no copy of its own, because "did not
     * start its agent" would be a lie here. Cooldown-guarded in main so a bulk
     * unarchive while offline produces one toast per project, not one per task.
     */
    onSpawnWarning: (callback: (taskId: string, message: string, projectId?: string) => void) => () => void;
    /**
     * A column's auto_command finished delivering, and the result is worth
     * telling the user about.
     *
     * Only fires for outcomes a user should act on: a `failed` delivery, or a
     * successful one that had to discard typed text or interrupt a live turn.
     * A plain `confirmed` delivery is silent, and so is `unconfirmed` - most
     * agents expose no transcript verifier at all, so every delivery on them
     * lands there and toasting it would be constant noise that means nothing.
     */
    onAutoCommandResult: (callback: (result: AutoCommandResultNotice) => void) => () => void;
    onCreatedByAgent: (callback: (taskId: string, taskTitle: string, columnName: string, projectId?: string) => void) => () => void;
    onUpdatedByAgent: (callback: (taskId: string, taskTitle: string, projectId?: string) => void) => () => void;
    onDeletedByAgent: (callback: (taskId: string, taskTitle: string, projectId?: string) => void) => () => void;
    onSessionResync: (callback: (projectId?: string) => void) => () => void;
    /**
     * A task's PR link or PR state was reconciled by the app rather than by an
     * agent: the periodic refresh sweep, the session-idle auto-link, the
     * link-time re-resolve that follows a link write, or the task-detail
     * "Link / refresh PR" control.
     *
     * Deliberately quiet, like `onSessionResync`. The board still has to reload
     * (the card's PR chip is stale), but announcing it as "Task updated by
     * agent" is wrong twice over: no agent updated anything, and the sweep can
     * fire it for several tasks at once. An agent's OWN `update_task` /
     * `link_pr` tool call still goes out on `onUpdatedByAgent` and still toasts.
     */
    onPrLinkChanged: (callback: (projectId?: string) => void) => () => void;
    /**
     * A task was moved from the paired mobile app.
     *
     * Deliberately quiet, like `onPrLinkChanged` and `onSessionResync`. The
     * board must reload (the card is rendering in the column it just left), but
     * it is not agent news: `onUpdatedByAgent` would toast `Task updated by
     * agent`, and no agent was involved in a card the user dragged on their own
     * phone. The move is already confirmed on the device that made it, and the
     * card visibly relocating is the feedback here.
     *
     * A third provenance, not a reuse of the other two: those mean "the app
     * reconciled something itself", and this one means "you did this, elsewhere".
     * Keeping it distinct also keeps the dev IPC log honest about where a move
     * came from.
     */
    onMovedByMobile: (callback: (projectId?: string) => void) => () => void;
    onSpawnProgress: (callback: (taskId: string, label: string | null) => void) => () => void;
    /**
     * Queryable snapshot of in-flight spawn-progress labels (keyed by taskId).
     * syncSessions reconciles its spawnProgress map against this so an HMR
     * reload during the "Starting agent..." window cannot strand a card.
     */
    getSpawnProgress: () => Promise<Record<string, string>>;
    onBulkDeleteProgress: (callback: (progress: TaskBulkDeleteProgress) => void) => () => void;
  };

  // Attachments
  attachments: {
    list: (taskId: string) => Promise<TaskAttachment[]>;
    add: (input: { task_id: string; filename: string; data: string; media_type: string }) => Promise<TaskAttachment>;
    remove: (id: string) => Promise<void>;
    getDataUrl: (id: string) => Promise<string>;
    open: (id: string) => Promise<string>;
  };

  // Swimlanes
  swimlanes: {
    list: () => Promise<Swimlane[]>;
    create: (input: SwimlaneCreateInput) => Promise<Swimlane>;
    update: (input: SwimlaneUpdateInput) => Promise<Swimlane>;
    delete: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
    onUpdatedByAgent: (callback: (swimlaneId: string, swimlaneName: string, projectId?: string) => void) => () => void;
  };

  // Actions
  actions: {
    list: () => Promise<Action[]>;
    create: (input: ActionCreateInput) => Promise<Action>;
    update: (input: ActionUpdateInput) => Promise<Action>;
    delete: (id: string) => Promise<void>;
  };

  // Transitions
  transitions: {
    list: () => Promise<SwimlaneTransition[]>;
    set: (fromId: string, toId: string, actionIds: string[]) => Promise<void>;
    getForTransition: (fromId: string, toId: string) => Promise<SwimlaneTransition[]>;
  };

  // Sessions (PTY)
  sessions: {
    // spawn/suspend/resume/reset/reconcile take an optional trailing
    // `projectId` the renderer stamps at interaction time (same rationale as
    // the task mutations above). kill/write/resize/list operate by session id
    // and stay project-agnostic. See .claude/rules/project-scoped-ipc.md.
    spawn: (input: SpawnSessionInput, projectId?: string | null) => Promise<Session>;
    kill: (sessionId: string) => Promise<void>;
    suspend: (taskId: string, projectId?: string | null) => Promise<void>;
    resume: (taskId: string, resumePrompt?: string, projectId?: string | null) => Promise<Session>;
    /**
     * Targeted "is this task's session alive right now?" probe. Returns
     * the live registry Session if main has one for this task, or null
     * if the task has no live PTY. Side effect: clears stale
     * `task.session_id` pointers on the DB row when the registry has no
     * matching entry. Used by the task detail dialog to self-heal a
     * renderer cache that has drifted to `suspended` while the PTY is
     * actually running (HMR listener gap, optimistic suspend, etc.).
     */
    reconcile: (taskId: string, projectId?: string | null) => Promise<Session | null>;
    reset: (taskId: string, projectId?: string | null) => Promise<void>;
    write: (sessionId: string, data: string) => Promise<void>;
    /**
     * `colsChanged` is intentionally unused by the renderer (main orders the
     * geometry change ahead of any scrollback sample on its own - see the
     * parallel-IPC note in useTerminal's mount path). `refused` is set only
     * when main deliberately held the grid against this resize (the mobile
     * sub-floor guard) and is consumed only by the echo re-assert, which uses
     * it to stop healing attempts immediately instead of retrying to its cap.
     */
    resize: (sessionId: string, cols: number, rows: number) => Promise<{ colsChanged: boolean; refused?: true }>;
    list: () => Promise<Session[]>;
    getScrollback: (sessionId: string) => Promise<string>;
    /**
     * Unscoped map of sessionId -> true for sessions that have emitted first
     * output. Lets syncSessions rebuild `sessionFirstOutput` after an HMR
     * reload so a running session is not flashed back to its boot state.
     */
    getFirstOutput: () => Promise<Record<string, boolean>>;
    getUsage: (projectId?: string) => Promise<Record<string, SessionUsage>>;
    onData: (callback: (sessionId: string, data: string, projectId?: string) => void) => () => void;
    /**
     * Acknowledge that the renderer has consumed `bytes` of a session's output
     * (written to xterm or dropped during scrollback replay). Drives per-session
     * output backpressure: main pauses a session's PTY when too many emitted
     * bytes are unacknowledged and resumes it as the renderer drains. One-way
     * (fire-and-forget send), keyed by sessionId only - not project-scoped.
     */
    ackData: (sessionId: string, bytes: number) => void;
    /**
     * The PTY's dimensions actually changed, from any origin: a renderer fit,
     * a phone's grid request, the resting-grid park, or the spawn itself.
     * Exists because xterm re-sends dimensions only when its OWN size changes,
     * so a PTY reshaped under a mounted xterm otherwise diverges with no
     * recovery path. The mounted owner compares the echoed dims to its own and
     * re-asserts its fit when they disagree. Broadcast to every window (echoes
     * only fire on real dim changes); filtered by sessionId in the listener.
     * Deliberately the one sessions push without a projectId parameter:
     * session ids are globally-unique UUIDs, so the sessionId filter alone is
     * unambiguous across projects.
     */
    onPtyResized: (callback: (sessionId: string, cols: number, rows: number, origin: PtyResizeOrigin) => void) => () => void;
    onFirstOutput: (callback: (sessionId: string, projectId?: string) => void) => () => void;
    onExit: (callback: (sessionId: string, exitCode: number, projectId?: string, intentional?: boolean) => void) => () => void;
    onStatus: (callback: (sessionId: string, session: Session, projectId?: string) => void) => () => void;
    onUsage: (callback: (sessionId: string, data: SessionUsage, projectId?: string) => void) => () => void;
    getActivity: (projectId?: string) => Promise<Record<string, ActivityState>>;
    onActivity: (callback: (sessionId: string, state: ActivityState, reason: ActivityReason, projectId?: string, taskId?: string) => void) => () => void;
    getActivityReason: (sessionId: string) => Promise<ActivityReason | null>;
    getActivityReasons: (projectId?: string) => Promise<Record<string, ActivityReason>>;
    getActivityStats: (sessionId: string) => Promise<ActivityStatsSnapshot | null>;
    getEvents: (sessionId: string) => Promise<SessionEvent[]>;
    getEventsCache: (projectId?: string) => Promise<Record<string, SessionEvent[]>>;
    onEvent: (callback: (sessionId: string, event: SessionEvent, projectId?: string) => void) => () => void;
    onIdleTimeout: (callback: (sessionId: string, taskId: string, timeoutMinutes: number, projectId?: string) => void) => () => void;
    getSummary: (taskId: string) => Promise<SessionSummary | null>;
    listSummaries: () => Promise<Record<string, SessionSummary>>;
    /** Live per-tool breakdown for an active session (from the in-memory accumulator, not the DB). */
    getToolBreakdown: (sessionId: string) => Promise<PerToolStat[]>;
    spawnTransient: (input: SpawnTransientSessionInput) => Promise<{ session: Session; branch: string; checkoutError?: string }>;
    killTransient: (sessionId: string) => Promise<void>;
    setFocused: (sessionIds: string[]) => Promise<void>;
    /**
     * Which sessions this renderer has an xterm MOUNTED for - a superset of
     * the focused set, because a parked terminal (Backlog view, occluded
     * window) is unfocused but still holds a grid. Main leaves those PTYs
     * alone; see SessionManager.scheduleRestingGridRestore.
     */
    setMounted: (sessionIds: string[]) => Promise<void>;
    /**
     * User pressed Ctrl+C in this session's terminal. The renderer
     * sends \x03 directly to the PTY (via `write`); this is a parallel
     * signal that lets the activity engine recover quickly when the
     * agent's PostToolUseFailure / Stop hooks don't fire (the engine
     * otherwise has to wait for the 5-min stuck-pending-tools hatch).
     *
     * Behavior: schedules a 3-second settle timer. If the engine is
     * still in `thinking` after that window AND the agent's own hooks
     * haven't recovered (pendingToolCount or turnActive non-zero),
     * the engine commits a synthetic `Interrupted` transition. If the
     * agent's hooks DID fire and the engine already cleared, the
     * synthetic is a no-op.
     */
    notifyUserInterrupt: (sessionId: string) => Promise<void>;
    /**
     * Inject a model/effort change into a transient (command-terminal)
     * session's live PTY. The session-keyed counterpart to
     * `tasks.setRuntimeOverride` for sessions that have no task row; no DB
     * persistence, best-effort live slash injection only.
     */
    injectSettings: (input: SessionInjectSettingsInput) => Promise<SessionInjectSettingsResult>;
  };

  // Usage statistics (the dashboard opened from the title bar).
  usage: {
    /** Composite usage-statistics payload: KPIs + bucketed time series +
     *  by-model/by-agent breakdowns, per-project or app-wide. Read-only.
     *  Pass `drill` to re-scope everything to one local day (chart click);
     *  `customWindow` to a user-picked month span (drill takes precedence). */
    getDashboardStats: (scope: UsageStatsScope, period: UsageTimePeriod, drill?: UsageDayDrill | null, customWindow?: UsageCustomWindow | null) => Promise<UsageDashboardStats>;
  };

  // Voice-to-text dictation (push-to-talk -> live transcript -> focused text
  // field, or a terminal when nothing writable has focus).
  // Channels are by session id, not task-scoped, so they carry no projectId
  // (same category as session write). See .claude/rules/ipc-7-layer-parity.md.
  dictation: {
    /** Begin a dictation session; resolves the engine from config + hardware. */
    start: (options: DictationStartOptions) => Promise<DictationStartResult>;
    /** Finalize and return the committed text (also pushed via onFinal).
     *  `expectedFrames` is the total number of PCM frames the renderer sent for
     *  this utterance; finalize waits (briefly, bounded) until they have all been
     *  ingested before the decode, so the tail is never cut off by the audio
     *  frames (fire-and-forget) racing this invoke. */
    stop: (dictationSessionId: string, expectedFrames?: number) => Promise<string>;
    /** Abort without committing. */
    cancel: (dictationSessionId: string) => Promise<void>;
    /**
     * Inject finalized text into a focused terminal WITHOUT submitting (no
     * Enter; the user presses Enter themselves). Newlines are collapsed to
     * spaces. Returns true if the text was written.
     */
    commit: (sessionId: string, text: string) => Promise<boolean>;
    /**
     * Auto-submit path: erase `eraseCount` chars of live preview, then paste +
     * submit `text` through the robust paste engine (settle -> separate Enter ->
     * submission evidence with retry). A plain `\r` appended to the live text
     * does NOT submit - the TUI reads an Enter in the same write as the text with
     * stale state. Resolves true if a submit signal was observed, false if the
     * paste engine exhausted its retries (text left in the input for manual send).
     */
    submit: (sessionId: string, text: string, eraseCount: number) => Promise<boolean>;
    /** Hardware profile + available engines for the settings panel. */
    getInfo: (config: DictationConfig) => Promise<DictationInfo>;
    /** Live revising hypothesis stream (renders in the popup only). */
    onPartial: (callback: (dictationSessionId: string, text: string) => void) => () => void;
    /** Finalized text stream. */
    onFinal: (callback: (dictationSessionId: string, text: string) => void) => () => void;
    /** Stream one PCM frame into the funnel (fire-and-forget, no round-trip). */
    sendAudioChunk: (chunk: DictationAudioChunk) => void;
    /** Ensure microphone access (macOS prompt on first use). */
    requestMic: () => Promise<DictationMicPermission>;
    /** Model download progress (first-use auto-download). */
    onModelProgress: (callback: (progress: DictationModelProgress) => void) => () => void;
    /** Pre-download the model for the given config (settings Download button).
     *  Resolves when present; no-op for the remote/stub engines. */
    downloadModel: (config: DictationConfig) => Promise<void>;
    /** Write raw bytes straight into a terminal session (the `live` experience
     *  types partials directly into the focused input; payload may include
     *  `\x7f` backspaces to erase the previous partial). Fire-and-forget. */
    liveWrite: (sessionId: string, payload: string) => void;
    /** Pre-load the engine for the given config so the next push-to-talk is
     *  instant (the model load happens ahead of the press, not during it). Pass
     *  `null` to release the warm engines (dictation disabled). Fire-and-forget. */
    prewarm: (config: DictationConfig | null) => void;
  };

  // Config
  config: {
    get: () => Promise<AppConfig>;
    getGlobal: () => Promise<AppConfig>;
    set: (config: DeepPartial<AppConfig>) => Promise<void>;
    /** Synchronous, blocking persist of a config partial. Used only on the quit/unload
     *  path so the final state reaches disk before the renderer tears down (an async
     *  set() can be dropped mid-teardown). Same merge semantics as set(). */
    setSync: (config: DeepPartial<AppConfig>) => void;
    getProjectOverrides: () => Promise<DeepPartial<AppConfig> | null>;
    setProjectOverrides: (overrides: DeepPartial<AppConfig>) => Promise<void>;
    getProjectOverridesByPath: (projectPath: string) => Promise<DeepPartial<AppConfig> | null>;
    setProjectOverridesByPath: (projectPath: string, overrides: DeepPartial<AppConfig>) => Promise<void>;
    syncDefaultToProjects: (partial: DeepPartial<AppConfig>) => Promise<number>;
    /** Fires after ANY window's config:set persists (including this one). Bare signal;
     *  re-fetch via config.get()/loadConfig() to pick up the new effective config. Lets
     *  pop-out windows (and the main window) live-sync theme/settings across windows. */
    onChanged: (callback: () => void) => () => void;
  };

  // Keybindings
  keybindings: {
    /** Probe whether each canonical combo can be claimed as a system-wide global
     *  shortcut. 'taken' means another app/OS already owns it (so it may not
     *  reach Kangentic); 'available' means it is free; 'unsupported' means the
     *  combo cannot be expressed as an accelerator and was not probed. */
    probeGlobal: (combos: string[]) => Promise<Record<string, 'available' | 'taken' | 'unsupported'>>;
  };

  // Agent commands
  agent: {
    listCommands: (cwd?: string) => Promise<AgentCommand[]>;
    summarize: (input: AgentSummarizeInput) => Promise<AgentSummarizeResult>;
  };

  // Agents
  agents: {
    // forceRefresh bypasses the main-process cache and re-probes detection
    // (the Agent settings "re-detect" button); omit/false uses the cache.
    list: (forceRefresh?: boolean) => Promise<AgentDetectionInfo[]>;
    /** Reachability probe for an agent's configured remote execution server
     *  ("Test connection" in the Agent settings tab). Reads the server
     *  record directly from config rather than accepting one as an argument,
     *  since the password never needs to round-trip through the renderer. */
    probeExecutionServer: (agentName: string) => Promise<RemoteServerStatus>;
  };

  // Handoffs
  handoffs: {
    list: (taskId: string) => Promise<HandoffRecord[]>;
  };

  // Shell
  shell: {
    getAvailable: () => Promise<Array<{ name: string; path: string }>>;
    getDefault: () => Promise<string>;
    openPath: (dirPath: string) => Promise<string>;
    openExternal: (url: string) => Promise<void>;
    showItemInFolder: (fullPath: string) => Promise<void>;
    exec: (command: string, cwd: string) => Promise<{ pid: number | undefined }>;
  };

  // Fonts
  font: {
    getAvailable: () => Promise<string[]>;
  };

  // Git
  git: {
    detect: (forceRefresh?: boolean) => Promise<{ found: boolean; path: string | null; version: string | null; meetsMinimum: boolean }>;
    listBranches: () => Promise<string[]>;
    diffFiles: (input: GitDiffFilesInput) => Promise<GitDiffFilesResult>;
    fileContent: (input: GitFileContentInput) => Promise<GitFileContentResult>;
    subscribeDiff: (worktreePath: string) => void;
    unsubscribeDiff: (worktreePath: string) => void;
    onDiffChanged: (callback: () => void) => () => void;
    checkPendingChanges: (input: GitPendingChangesInput) => Promise<GitPendingChangesResult>;
    branchSummary: (input: GitBranchSummaryInput) => Promise<GitBranchSummaryResult>;
    commitGraph: (input: GitCommitGraphInput) => Promise<GitCommitGraphResult>;
    fileHistory: (input: GitFileHistoryInput) => Promise<GitFileHistoryResult>;
    blame: (input: GitBlameInput) => Promise<GitBlameResult>;
  };

  // Dialog
  dialog: {
    selectFolder: (options?: SelectFolderOptions) => Promise<string | null>;
  };

  // Notifications
  notifications: {
    show: (input: NotificationInput) => void;
    onClicked: (callback: (projectId: string, taskId: string) => void) => () => void;
  };

  // Window controls
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    flashFrame: (flash: boolean) => void;
    isFocused: () => Promise<boolean>;
  };

  // Pop-out windows: detach a registered surface (stats, changes, browser, a single
  // file's diff) into its own OS-level BrowserWindow. See src/shared/pop-out.ts.
  popOut: {
    /** Resolves false when the kind's `maxInstances` cap refused the open (no
     *  window was created or focused); true otherwise. */
    open: <K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]) => Promise<boolean>;
    close: <K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]) => Promise<void>;
    focus: <K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]) => Promise<void>;
    isOpen: <K extends PopOutKind>(kind: K, params: PopOutParamsByKind[K]) => Promise<boolean>;
    /** instanceKeys (popOutInstanceKey) of every currently-open pop-out window. */
    listOpen: () => Promise<string[]>;
    onChanged: (callback: (openInstanceKeys: string[]) => void) => () => void;
    /** Synchronous boot value: this window's own descriptor if it was opened as a
     *  pop-out (read from additionalArguments in preload), else null for the main window. */
    descriptor: PopOutDescriptor | null;
  };

  // Analytics
  analytics: {
    trackRendererError: (message: string, context?: RendererErrorContext) => void;
  };

  // App
  app: {
    getVersion: () => Promise<string>;
  };

  // Updater
  updater: {
    checkForUpdate: () => Promise<void>;
    installUpdate: () => Promise<void>;
    onUpdateDownloaded: (callback: (info: UpdateDownloadedInfo) => void) => () => void;
  };

  // Announcements (remote feed; active = filtered for this client in main.
  // history = the local archive sidecar, which also owns per-entry read-state)
  announcements: {
    getActive: () => Promise<Announcement[]>;
    getHistory: () => Promise<AnnouncementArchiveEntry[]>;
    markRead: (announcementId: string) => Promise<void>;
    onChanged: (callback: (payload: AnnouncementsChangedPayload) => void) => () => void;
  };

  // Backlog Attachments
  backlogAttachments: {
    list: (backlogTaskId: string) => Promise<BacklogAttachment[]>;
    add: (input: { backlog_task_id: string; filename: string; data: string; media_type: string }) => Promise<BacklogAttachment>;
    remove: (id: string) => Promise<void>;
    getDataUrl: (id: string) => Promise<string>;
    open: (id: string) => Promise<string>;
  };

  // Backlog
  backlog: {
    list: () => Promise<BacklogTask[]>;
    create: (input: BacklogTaskCreateInput) => Promise<BacklogTask>;
    update: (input: BacklogTaskUpdateInput) => Promise<BacklogTask>;
    delete: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
    bulkDelete: (ids: string[]) => Promise<void>;
    promote: (input: BacklogPromoteInput) => Promise<Task[]>;
    demote: (input: BacklogDemoteInput) => Promise<BacklogTask>;
    renameLabel: (oldName: string, newName: string) => Promise<number>;
    deleteLabel: (name: string) => Promise<number>;
    remapPriorities: (mapping: Record<number, number>) => Promise<number>;
    onChangedByAgent: (callback: (projectId?: string) => void) => () => void;
    onLabelColorsChanged: (callback: () => void) => () => void;
    importCheckCli: (source: ExternalSource) => Promise<ImportCheckCliResult>;
    importFetch: (input: ImportFetchInput) => Promise<ImportFetchResult>;
    importExecute: (input: ImportExecuteInput) => Promise<ImportExecuteResult>;
    importSourcesList: () => Promise<ImportSource[]>;
    importSourcesAdd: (input: { source: ExternalSource; url: string }) => Promise<ImportSource>;
    importSourcesRemove: (id: string) => Promise<void>;
    asana: {
      authStatus: () => Promise<AsanaAuthStatus>;
      setPat: (input: AsanaSetPatInput) => Promise<AsanaSetPatResult>;
      clearCredential: () => Promise<void>;
    };
  };

  // Mobile Bridge -- machine-global (like config), not project-scoped.
  /** Agent Monitor. Machine-global: no channel here takes a projectId, because the
   *  snapshot deliberately spans every registered project. */
  monitor: {
    /** Full cross-project snapshot. Per-PROJECT setup (repos, swimlane names) is
     *  resolved once and memoized, but the row build is O(sessions): each monitored
     *  session costs a `tasks.getById` and a `sessions.findByAnyId`. Both are
     *  indexed reads against an already-warm handle, and the push side is debounced
     *  250ms, so this is cheap in practice - but it is not the O(projects) it was
     *  once described as, and a project with many concurrent agents pays per agent. */
    getSnapshot: () => Promise<MonitorSnapshot>;
    /** Register this renderer as a live monitor consumer and get a fresh snapshot
     *  back. Main only builds and pushes MONITOR_CHANGED snapshots while at least
     *  one renderer is subscribed, so an unmounted monitor costs no per-event
     *  snapshot builds. Main drops the subscription itself when the renderer
     *  navigates or is destroyed. */
    subscribe: () => Promise<MonitorSnapshot>;
    /** Explicit counterpart of subscribe, called when the monitor closes. */
    unsubscribe: () => Promise<void>;
    /** Ask MAIN to reveal a task in the main window. Used by the detached monitor,
     *  whose own stores cannot reach the board. */
    revealTask: (projectId: string, taskId: string) => Promise<void>;
    /** Everything the task-detail surface needs about a task's OWN project, so a
     *  host that is not that project's board can render it. Null when the project
     *  or task is gone (a race with a delete), so the caller closes rather than
     *  renders a husk. */
    getTaskDetail: (projectId: string, taskId: string) => Promise<TaskDetailBundle | null>;
    /** Fired when the snapshot's DB-resident half changes (session spawned/exited, task
     *  retitled or moved). Live activity does NOT come through here - it rides the
     *  existing unbuffered SESSION_ACTIVITY push and is patched into rows in place. */
    onChanged: (callback: (snapshot: MonitorSnapshot) => void) => () => void;
    /** Start or stop the live output-peek stream for THIS renderer. Subscribe-gated
     *  because it is the one monitor push with a standing cost in main (a PTY
     *  output listener plus a sampling timer); a closed monitor costs nothing. */
    setPeekSubscribed: (subscribed: boolean) => Promise<void>;
    /** Changed output peeks, keyed by session id. Only sessions whose visible text
     *  actually changed are sent, so a repainting TUI whose content is unchanged
     *  produces no traffic. Patched onto rows in place, like activity. */
    onPeek: (callback: (peeks: Record<string, string[]>) => void) => () => void;
  };

  /**
   * Task-detail ownership: which renderer hosts which task's detail.
   *
   * Machine-global arbitration, not a task mutation. Main is the only place that
   * can answer, because a pop-out is a separate renderer with its own stores and
   * neither host can see the other's open windows. The two rules it enforces are
   * documented in src/main/task-detail/detail-owner-registry.ts.
   */
  taskDetailOwnership: {
    /** Ask where this task's detail should open. Main focuses the target window,
     *  and pushes `onOpenHere` to it unless it is already open. */
    requestOpen: (
      projectId: string,
      taskId: string,
      host: TaskDetailHost,
    ) => Promise<TaskDetailDestination>;
    /**
     * Report the COMPLETE set of task details this surface currently has mounted,
     * derived from its window store.
     *
     * There is deliberately no `claim` / `release` pair: incremental bookkeeping
     * could lose a release and strand a claim, leaving the task permanently
     * unopenable. A full-set report is self-repairing, and removing the incremental
     * calls from this surface makes reintroducing them a compile error.
     */
    syncOwned: (
      host: TaskDetailHost,
      entries: ReadonlyArray<{ projectId: string; taskId: string }>,
    ) => void;
    /** Main asking a surface in this renderer to mount a task detail. */
    onOpenHere: (
      callback: (projectId: string, taskId: string, host: TaskDetailHost) => void,
    ) => () => void;
    /** Main asking a surface in this renderer to let go, because another took it. */
    onCloseHere: (
      callback: (projectId: string, taskId: string, host: TaskDetailHost) => void,
    ) => () => void;
    /**
     * The details held by OTHER renderers, pushed whenever ownership changes.
     *
     * Terminal ownership is "one xterm per PTY", and before this the bottom panel
     * could only see its own renderer's detail windows - so a detail hosted in the
     * detached Agent Monitor left the main window free to mount a second xterm on
     * the same live PTY. Already filtered to exclude this renderer's own claims.
     */
    onRemoteOwnersChanged: (
      callback: (owners: TaskDetailRemoteOwner[]) => void,
    ) => () => void;
  };

  mobile: {
    getStatus: () => Promise<MobileBridgeStatus>;
    startPairing: () => Promise<MobileStartPairingResult>;
    cancelPairing: () => Promise<void>;
    listDevices: () => Promise<MobilePairedDevice[]>;
    revokeDevice: (deviceId: string) => Promise<void>;
    renameDevice: (deviceId: string, displayName: string) => Promise<void>;
    setDeviceCapabilities: (deviceId: string, capabilities: MobileCapabilityVerb[]) => Promise<void>;
    /** Reachability probe for a candidate relay URL ("Test connection" in the Mobile Devices
     *  tab). Takes the URL as an argument rather than reading it from config, since testing
     *  BEFORE committing a save is the point; never throws. */
    testRelay: (relayUrl: string) => Promise<RemoteServerStatus>;
    onPairingSas: (callback: (payload: MobilePairingSasPayload) => void) => () => void;
    onPairingConfirmed: (callback: (payload: MobilePairingConfirmedPayload) => void) => () => void;
    onPairingEnded: (callback: (payload: MobilePairingEndedPayload) => void) => () => void;
    onStateChanged: (callback: () => void) => () => void;
    /** Sessions a phone holds a terminal-wanting stream subscription for (not the
     *  list-only feed). The bottom panel suspends its terminal for these - the
     *  resting park owns their grid - so it renders a placeholder instead of an
     *  xterm that would fit the PTY to its strip. */
    getTerminalStreams: () => Promise<string[]>;
    onTerminalStreamsChanged: (callback: (sessionIds: string[]) => void) => () => void;
  };

  // Board Config
  boardConfig: {
    exists: () => Promise<boolean>;
    export: () => Promise<void>;
    apply: (projectId: string) => Promise<string[]>;
    onChanged: (callback: (projectId: string) => void) => () => void;
    onShortcutsChanged: (callback: (projectId: string) => void) => () => void;
    /** The board's named Board Profiles (see `BoardProfile`). Empty when the board has none. */
    getBoardProfiles: () => Promise<BoardProfile[]>;
    /** Replace the board's Board Profiles. Team-scoped: `tasks.profile_id` is resolved on every machine that opens the board. */
    setBoardProfiles: (profiles: BoardProfile[]) => Promise<void>;
    /** An agent (MCP) rewrote this project's Board Profiles; re-read them. */
    onBoardProfilesChanged: (callback: (projectId: string) => void) => () => void;
    getShortcuts: () => Promise<(ShortcutConfig & { source: 'team' | 'local' })[]>;
    setShortcuts: (actions: ShortcutConfig[], target: 'team' | 'local') => Promise<void>;
    setDefaultBaseBranch: (branch: string) => Promise<void>;
  };

  // Clipboard
  clipboard: {
    readImage: () => Promise<string | null>;
    writeText: (text: string) => Promise<void>;
  };

  // Browser pane: embedded webview capture-and-send
  browser: {
    captureAndSend: (input: BrowserCaptureInput) => Promise<{ filePath: string }>;
    /**
     * Per-task Browser pane URLs. `projectId` is the project of the TASK, not
     * the open board's: a popped-out pane outlives a project switch, so
     * resolving these against the ambient current project wrote one project's
     * task URL into another project's sidecar.
     */
    getUrls: (taskId: string, projectId?: string | null) => Promise<{ projectDefault: string | null; taskOverride: string | null }>;
    setTaskUrl: (taskId: string, url: string, projectId?: string | null) => Promise<void>;
    clearTaskUrl: (taskId: string, projectId?: string | null) => Promise<void>;
    clearStorage: () => Promise<void>;
    /**
     * Sync this task's cookie jar with the project identity jar before the guest
     * attaches, so the pane opens already signed into shared non-localhost (IdP)
     * sessions. Keyed by `taskId` + `projectId` (the jar follows the task, not the
     * worktree path). Never rejects.
     */
    ensureJar: (taskId: string, projectId: string | null) => Promise<void>;
    /** Register an open Browser pane's guest webContents for kangentic_browser_* targeting. */
    registerPane: (input: BrowserPaneRegisterInput) => Promise<void>;
    /** Unregister a Browser pane (on unmount). Pass the webContentsId this
     *  instance registered with so the main process only clears the registry
     *  entry if it still points at this exact guest (see
     *  unregisterIfMatches in browser-pane-registry.ts) - guards the
     *  in-app-pane-vs-pop-out-pane handoff race. Omit to unregister
     *  unconditionally. */
    unregisterPane: (sessionId: string, webContentsId?: number) => Promise<void>;
    /**
     * Subscribe to Ctrl+wheel zoom changes that fire inside the embedded
     * webview. The main process applies the zoom and broadcasts the resulting
     * factor so the toolbar % can stay in sync.
     */
    /** Ctrl+wheel zoom applied to a guest. `webContentsId` identifies WHICH pane,
     *  since one window can host several and each must ignore the others'. */
    onZoomChanged: (callback: (factor: number, webContentsId: number) => void) => () => void;
    /**
     * Main asking this renderer to open a task's Browser pane, on behalf of the
     * `kangentic_browser_open_pane` MCP tool. Main has already validated the
     * project, the per-project browser gate, the task, and the URL (which it
     * seeded into the task sidecar), so the handler's only job is to set the
     * pane open and make sure a task-detail window exists for it.
     */
    onPaneOpenRequest: (callback: (projectId: string, taskId: string) => void) => () => void;
    /**
     * Main asking this renderer to close Browser panes, on behalf of
     * `kangentic_browser_close_pane`. The taskIds are computed by main from the
     * pane registry: the renderer must not re-derive them, because
     * `browserOpenTasks` is not project-keyed and the board store only holds the
     * OPEN project's tasks, so a backgrounded project's retained pane would be
     * invisible to a board lookup.
     */
    onPaneCloseRequest: (callback: (projectId: string, taskIds: string[]) => void) => () => void;
    /**
     * An agent is dispatching CDP input into a Browser pane's guest right now
     * (`active: true`), or has just finished (`active: false`).
     *
     * A synthesized mousedown makes Chromium focus the guest, which blurs
     * whatever the user was typing into. This side cannot detect that on its own:
     * clicking into a `<webview>` routes input to the guest widget and produces no
     * mousedown on the host document, so "was there a trusted user gesture" is not
     * a safe discriminator. Main IS able to say exactly when it is driving, so it
     * announces the interval and the pane restores the user's focus if it moved.
     *
     * `webContentsId` identifies WHICH guest, since one window can host several
     * panes and each must ignore the others'.
     * See `.claude/rules/agent-driven-focus.md`.
     */
    onAgentInput: (callback: (webContentsId: number, active: boolean) => void) => () => void;
    /**
     * A file download started from a Browser pane has finished. The pane saves
     * silently to the OS Downloads folder (what Chrome does), so this push is
     * what stops an agent-triggered download from being invisible.
     */
    onDownloadDone: (callback: (download: BrowserDownloadDone) => void) => () => void;
    /**
     * The user typed into this guest while an agent was driving it. Main already
     * blocked the keystroke from the page and encoded it as terminal bytes; this
     * side routes it to the terminal the user was typing in, so their sentence
     * continues where they meant it to rather than landing in a web form.
     */
    onUserKeyDuringDrive: (
      callback: (webContentsId: number, data: string) => void,
    ) => () => void;
    /**
     * The user pressed or released a mouse BACK / FORWARD button while this
     * guest held focus.
     *
     * Forwarded from main because a guest consumes the mouse outright - measured
     * on a live guest, a real back press produced 31 events in the page and ZERO
     * on the host window - so nothing in the renderer can observe it directly.
     * `at` is stamped in MAIN: the renderer's own clock is congested by the work
     * a press starts (mic permission, engine load), which would turn a tap into
     * an apparent hold.
     */
    onGuestMouseButton: (
      callback: (event: GuestMouseButtonEvent) => void,
    ) => () => void;
  };

  // Search
  search: {
    everything: (input: SearchRequest) => Promise<SearchHit[]>;
  };

  // Conversation viewer (structured transcripts)
  transcripts: {
    get: (input: TranscriptGetRequest) => Promise<TranscriptGetResponse | TranscriptUnchangedResponse>;
    listSessions: (
      taskId: string,
      projectId?: string | null,
    ) => Promise<ConversationSessionMeta[]>;
  };

  // Conversation memory (search index) status + proactive surfaces.
  memory: {
    getStatus: () => Promise<MemoryStatus>;
    /** Purge the project's conversation index and re-run the backfill sweep
     *  (recovery from a corrupt/stale index). Resolves when the purge is done;
     *  the rebuild sweep continues in the background. */
    rebuildIndex: (projectId?: string | null) => Promise<void>;
  };

  // Platform
  platform: string;

  // Web utilities
  webUtils: {
    getPathForFile: (file: File) => string;
  };
}

// Browser pane: embedded webview capture-and-send
export interface BrowserPickedElement {
  selector: string;
  tagName: string;
  id?: string;
  classes: string[];
  testId?: string;
  ariaLabel?: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  rect: { x: number; y: number; width: number; height: number };
  computedStyles: Record<string, string>;
  outerHTML: string;
  ancestors: Array<{
    tagName: string;
    id?: string;
    classes: string[];
    testId?: string;
    role?: string;
  }>;
}

export interface BrowserCaptureInput {
  sessionId: string;
  taskId: string;
  /**
   * The agent's working directory (task.worktree_path ?? project.path).
   * Captures are written under this path so any agent's sandboxed file
   * tools can reach them via a relative path in the @-mention.
   */
  cwd: string;
  url: string;
  pngBase64: string;
  pickedElement: BrowserPickedElement | null;
  selectedText: string;
  note: string;
}

/**
 * Payload the renderer sends to register an open Browser pane's guest
 * webContents with the main-process pane registry (for kangentic_browser_*
 * targeting). projectId rides inside the payload (captured at interaction
 * time); this is registry bookkeeping, not a task-state mutation, so it is
 * not subject to the trailing-projectId mutation rule.
 */
export interface BrowserPaneRegisterInput {
  sessionId: string;
  taskId: string;
  projectId: string | null;
  /** The guest webview id from `webview.getWebContentsId()`. */
  webContentsId: number;
  url: string | null;
}

/** A finished Browser-pane download, reported to the renderer so it can toast. */
export interface BrowserDownloadDone {
  /** Basename actually written, which may carry a ` (n)` dedupe suffix. */
  fileName: string;
  /** Absolute path, for the toast's "Show in folder" action. */
  filePath: string;
  /** Electron's `DownloadItem` terminal state. */
  state: 'completed' | 'cancelled' | 'interrupted';
}

export interface SearchRequest {
  query: string;
  scope: 'current' | 'all';
  currentProjectId: string;
  /**
   * Retrieval mode for conversation hits. 'keyword' (default) = lexical FTS5;
   * 'smart' = hybrid lexical + semantic (falls back to lexical when the
   * semantic layer is unavailable). Omitted = 'keyword' (back-compat).
   */
  mode?: 'keyword' | 'smart';
}

/** Runtime state of the semantic (embedding) layer, for the palette Smart-mode
 *  UI. `lexical` = enabled but sqlite-vec unavailable, so search stays lexical. */
export type MemorySemanticState = 'disabled' | 'downloading' | 'lexical' | 'hybrid' | 'error';

/** Download/availability state of the selected embedding model. */
export type MemoryModelState = 'absent' | 'downloading' | 'ready' | 'error';

/** The selected embedding model's identity + download state, for the settings
 *  model card (mirrors the dictation model-status card). */
export interface MemoryModelStatus {
  id: string;
  displayName: string;
  tier: 'balanced' | 'accurate' | 'max';
  approxSizeMb: number;
  dimensions: number;
  state: MemoryModelState;
  /** 0..1 while `state === 'downloading'`. */
  progress?: number;
}

/** Where the embedding model runs. See `AppConfig.memory.acceleration`. */
export type MemoryAcceleration = 'auto' | 'gpu' | 'cpu';

export interface MemoryStatus {
  indexingEnabled: boolean;
  semantic: MemorySemanticState;
  /** Human-readable execution backend the embed worker actually initialized on
   *  (e.g. "DirectML (GPU)", "WebGPU (GPU)", "CPU"), for the settings model card.
   *  Undefined until the worker has embedded at least once this run. */
  activeBackend?: string;
  /** 0..1 while `semantic === 'downloading'`, else undefined. */
  modelProgress?: number;
  /** The selected model + its download state (present once semantic is on). */
  model?: MemoryModelStatus;
  /** When `semantic === 'lexical'`, the reason sqlite-vec failed to load (so the
   *  Memory tab can explain the degrade), or undefined if it simply is not loaded. */
  vecError?: string;
}

interface SearchHitBase {
  projectId: string;
  projectName: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export type SearchHit =
  | (SearchHitBase & {
      kind: 'task';
      taskId: string;
      displayId: number;
      taskTitle: string;
      archived: boolean;
      snippetField: 'title' | 'description';
    })
  | (SearchHitBase & {
      kind: 'backlog';
      backlogId: string;
      backlogTitle: string;
      snippetField: 'title' | 'description';
    })
  | (SearchHitBase & {
      kind: 'session_event';
      taskId: string;
      taskTitle: string;
      sessionId: string;
      agentName: string;
      eventTs: number;
      eventKey: string;
      eventType: string;
    })
  | (SearchHitBase & {
      kind: 'project';
      projectPath: string;
    })
  | (SearchHitBase & {
      kind: 'conversation';
      /** Owning task, or null for a session whose task row was removed. */
      taskId: string | null;
      taskTitle: string;
      /** Kangentic session id (sessions.id); the conversation-viewer anchor. */
      sessionId: string;
      agentName: string;
      /** memory_chunks.id of the matched chunk; step-2 fetch / context expansion key. */
      chunkId: number;
      /** TranscriptEntry uuid the matched chunk starts at; the scroll-to target.
       *  Null when the chunk lost its anchor (older index rows). */
      turnUuid: string | null;
      /** Dominant role of the matched chunk: 'user' | 'assistant' | 'tool_result' | 'system'
       *  | 'mixed'. Drives the result-row badge. */
      turnKind: string;
      /** Epoch ms of the matched turn; scroll-to ts fallback + relative-time display. */
      turnTs: number | null;
      /** Relevance, higher = better. Phase 1: normalized bm25. Phase 2: RRF.
       *  Conversation hits render sorted by this within their group. */
      score: number;
      /** How the hit was produced. Semantic-only hits carry an empty
       *  match range (matchStart === matchEnd) so the row skips the <mark>. */
      matchKind: 'lexical' | 'semantic' | 'hybrid';
      /** True when this session has a live agent right now (sessions.status
       *  running/queued). Selecting the hit then opens the live task terminal
       *  instead of the read-only conversation viewer, and the row badges it as
       *  "Terminal" vs "History". */
      sessionActive: boolean;
      /** How many chunks in this conversation matched. The hit is the best-scoring
       *  one; the row shows "N matches" when this is > 1 (results are collapsed to
       *  one row per conversation). */
      matchCount: number;
    });

export type SearchHitKind = SearchHit['kind'];

// =============================================================================
// Conversation viewer (structured transcripts)
// =============================================================================
// Backing types for the human-facing conversation viewer, which renders the
// structured `TranscriptEntry[]` for a task's ENTIRE lifecycle: every session
// the task has ever accumulated (a model switch, an agent change, an isolated
// swimlane move each spin up a distinct sessions row), stitched into one
// chronological timeline with a `session_boundary` divider between them. This
// is unconditional - not a user setting - so "the conversation for this task"
// always means its full history end to end, regardless of what changed
// mid-task. A session with no task_id (rare - a transient/orphan record) falls
// back to just its own entries, since there is no task to unify across.

export interface TranscriptGetRequest {
  /** Kangentic session id (sessions.id) or the agent-native session id) -
   *  used only to resolve WHICH task to show; every session belonging to that
   *  task is included regardless of which one was passed. */
  sessionId: string;
  /** Interaction-time project id. Read-only, but preferred over the ambient
   *  current project (a conversation hit can target another project). */
  projectId?: string | null;
  /** The `revision` of the last `TranscriptGetResponse` this caller received
   *  for this task. When it matches the task's CURRENT revision, the handler
   *  returns a `TranscriptUnchangedResponse` instead of the full payload,
   *  skipping the multi-MB structured clone on an idle live-poll tick. Omit
   *  on the first fetch for a session (nothing to compare against yet). */
  knownRevision?: number;
}

/** Where a rendered conversation's content came from. `none` = neither the
 *  native history nor an index fallback was available. For a stitched
 *  multi-session view this describes the LATEST session (the one live-polling
 *  cares about); earlier sessions may individually be 'index' or 'none'. */
export type TranscriptSource = 'live' | 'index' | 'none';

export type TranscriptUnavailableReason =
  | 'unsupported_agent'
  | 'no_agent_session_id'
  | 'file_missing';

export interface TranscriptGetResponse {
  /** The LATEST contributing session's id (the one live-polling watches). */
  sessionId: string;
  taskId: string | null;
  taskTitle: string;
  /** The LATEST contributing session's agent. A session_boundary divider and
   *  each assistant entry's own agentName (when present) carry the others. */
  agentName: string;
  /** ISO 8601 start of the LATEST contributing session. */
  startedAt: string;
  /** LATEST contributing session's record status. `running`/`queued` mean the
   *  transcript may still grow, so an open viewer live-refreshes; other states
   *  are static. Null when no session was found at all. */
  sessionStatus: SessionRecordStatus | null;
  source: TranscriptSource;
  /** LATEST contributing session's located native history file/db path, or null. */
  sourcePath: string | null;
  /** Every session's entries concatenated oldest-first, with a
   *  `session_boundary` system entry inserted between sessions. A session
   *  with no task (orphan) has exactly one contributing session: itself. */
  entries: TranscriptEntry[];
  /** True when ANY contributing session's content came from the index
   *  fallback (block structure lossy for that stretch). */
  degraded: boolean;
  unavailableReason?: TranscriptUnavailableReason;
  /** Every session that contributed entries, oldest first - lets the viewer's
   *  session picker jump to where each one begins in the unified scroll. */
  sessions: ConversationSessionMeta[];
  /** Bumps only when `entries` actually changed content (see
   *  `resolveTaskTranscript`'s stitch memo). Round-trip this as the next
   *  request's `knownRevision` to get a `TranscriptUnchangedResponse` on an
   *  idle poll instead of the full payload. */
  revision: number;
}

/** Returned by `transcripts.get` instead of a full `TranscriptGetResponse`
 *  when the caller's `knownRevision` matches the task's current revision -
 *  nothing has changed, so there is nothing to ship over IPC. */
export interface TranscriptUnchangedResponse {
  unchanged: true;
  revision: number;
}

/** One selectable session in the conversation viewer's session picker. */
export interface ConversationSessionMeta {
  sessionId: string;
  agentName: string;
  startedAt: string;
  exitedAt: string | null;
  isolatedSwimlaneId: string | null;
  status: SessionRecordStatus;
}


// =============================================================================
// Product diagnostics types
// =============================================================================
// Backing types for the `src/main/diagnostics/` product subsystem and the MCP
// tools that read its output. These ship in all builds.

/**
 * One line of captured console output. Persisted as NDJSON to
 * `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`.
 *
 * `args` is the result of stringifying each `console.*` argument. Errors are
 * captured with name + message + (source-mapped) stack. Plain objects are
 * `JSON.stringify`d with a circular-safe replacer.
 */
export interface LogEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  level: 'error' | 'warn' | 'info' | 'debug' | 'log';
  source: 'main' | 'renderer' | 'preload';
  /** Stringified arguments passed to the `console.*` call. */
  args: string[];
}

/**
 * One captured fatal error. Persisted as a single JSON file at
 * `<projectRoot>/.kangentic/logs/crashes/<ts>.json`. Always written, no toggle.
 */
export interface CrashRecord {
  /** ISO 8601 timestamp. */
  ts: string;
  kind:
    | 'main-uncaught-exception'
    | 'main-unhandled-rejection'
    | 'render-process-gone'
    | 'preload-error'
    | 'renderer-window-error'
    | 'renderer-unhandled-rejection';
  /** Process source. For renderer errors this is the webContents id. */
  source: 'main' | 'renderer' | 'preload';
  message: string;
  /** Source-mapped stack when available. */
  stack: string | null;
  /** Renderer-window URL or main-process module path at the time of error. */
  origin: string | null;
  /** Additional context (e.g. render-process-gone reason+exitCode). */
  context: Record<string, unknown> | null;
  /** Versions captured for bug-report reproducibility. */
  versions: { kangentic: string; electron: string; node: string; chrome: string };
}

/**
 * Per-process resource usage snapshot. Returned by
 * `kangentic_get_process_metrics`. Wraps `app.getMetrics()` and adds platform
 * + uptime context.
 */
export interface ProcessMetrics {
  ts: string;
  uptimeSec: number;
  platform: NodeJS.Platform;
  arch: string;
  versions: { kangentic: string; electron: string; node: string; chrome: string };
  processes: {
    pid: number;
    type: string;
    name?: string;
    cpu: { percentCPUUsage: number };
    memory: { workingSetSize: number; peakWorkingSetSize: number; privateBytes?: number };
    creationTime?: number;
  }[];
}

/**
 * One IPC traffic record. Persisted as NDJSON to
 * `<projectRoot>/.kangentic/logs/ipc-<YYYY-MM-DD>.jsonl` only when the
 * `developer.recordIpcTraffic` toggle is on. Channels in the
 * known-sensitive allowlist (settings writes, MCP config, auth) appear
 * with `args: { redacted: true, channel }` instead of the real payload.
 *
 * Two directions are recorded: inbound `ipcMain.handle` invocations
 * (renderer -> main) and outbound `webContents.send` pushes (main ->
 * renderer). Inbound entries leave `direction` absent so existing log
 * readers see no change; outbound pushes set `direction: 'out'`.
 */
/**
 * Placeholder substituted for an args/result payload whose serialized form
 * exceeds the recorder's size cap. Keeps each JSONL line small (a single ~1.2MB
 * `task:list-archived` result would otherwise be stringified in full on the main
 * thread) while preserving enough signal to identify the oversized channel.
 */
export interface IpcPayloadTruncated {
  truncated: true;
  /** UTF-16 length of the full serialized payload (-1 when unserializable). */
  serializedChars: number;
  /** First ~2KB of the serialized JSON, enough to identify the payload shape. */
  preview: string;
}

export interface IpcLogEntry {
  ts: string;
  channel: string;
  /**
   * Traffic direction. Absent or `'in'` means an inbound `ipcMain.handle`
   * invocation; `'out'` means a main -> renderer `webContents.send` push.
   */
  direction?: 'in' | 'out';
  /** Captured args array, a redaction placeholder, or an over-cap truncation marker. */
  args: unknown[] | { redacted: true; channel: string } | IpcPayloadTruncated;
  /** Captured result, a redaction placeholder, or an over-cap truncation marker. Omitted on error. */
  result?: unknown | { redacted: true; channel: string } | IpcPayloadTruncated;
  /** Handler round-trip time in ms. Always `0` for outbound pushes (no round trip to measure). */
  durationMs: number;
  /**
   * When set, the handler threw, or (for an outbound push) the push was
   * dropped because the renderer window was destroyed. `result` is omitted.
   */
  error?: { name: string; message: string };
}

/**
 * Per-project worktree summary. Returned by `kangentic_list_worktrees`.
 * Includes the main checkout plus every git worktree. Pure read-only.
 */
export interface WorktreeRecord {
  /** Absolute path to the worktree root. */
  path: string;
  /** Currently checked-out branch name, or null for detached HEAD. */
  branch: string | null;
  /**
   * Configured base branch the worktree compares against (if recorded
   * in kangentic state for this worktree's task). null for the main
   * checkout or unmapped worktrees.
   */
  baseRef: string | null;
  /** True when the working tree has uncommitted modifications. */
  dirty: boolean;
  /** Commits ahead of `baseRef` (or upstream when no base). null when unknown. */
  commitsAhead: number | null;
  /** Commits behind `baseRef` (or upstream when no base). null when unknown. */
  commitsBehind: number | null;
  /** ISO 8601 timestamp of the last commit on the current branch. */
  lastCommitTs: string | null;
  /** True when this is the project's main checkout (not a worktree under .kangentic/). */
  isMainCheckout: boolean;
}

/**
 * One project's worktree set. Top-level shape of `kangentic_list_worktrees`.
 */
export interface ProjectWorktrees {
  projectId: string;
  projectName: string;
  projectPath: string;
  worktrees: WorktreeRecord[];
}


declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
