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

export interface Project {
  id: string;
  name: string;
  path: string;
  github_url: string | null;
  default_agent: string;
  group_id: string | null;
  position: number;
  last_opened: string;
  created_at: string;
}

export interface AgentDetectionInfo {
  name: string;
  displayName: string;
  found: boolean;
  path: string | null;
  version: string | null;
  permissions: AgentPermissionEntry[];
  defaultPermission: PermissionMode;
}

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
  branch_name: string | null;
  pr_number: number | null;
  pr_url: string | null;
  base_branch: string | null;
  use_worktree: number | null;
  labels: string[];
  priority: number;
  attachment_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
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

export interface Swimlane {
  id: string;
  name: string;
  role: SwimlaneRole | null;
  position: number;
  color: string;
  icon: string | null;
  is_archived: boolean;
  is_ghost: boolean;
  permission_mode: PermissionMode | null;
  auto_spawn: boolean;
  auto_command: string | null;
  plan_exit_target_id: string | null;
  agent_override: string | null;
  handoff_context: boolean;
  created_at: string;
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
}

// === Session Persistence (DB) ===

export type SessionRecordStatus = 'running' | 'queued' | 'suspended' | 'exited' | 'orphaned';

export type SuspendedBy = 'user' | 'system';

export interface SessionRecord {
  id: string;
  task_id: string;
  session_type: string;
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
  total_duration_ms: number | null;
  tool_call_count: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  files_changed: number | null;
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

export interface SessionSummary {
  sessionId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  modelDisplayName: string;
  durationMs: number;
  toolCallCount: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  taskCreatedAt: string;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
}

// === Session Activity (Claude Code Hooks) ===

export type ActivityState = 'thinking' | 'idle';

// === Typesafe Enums for Hook Events, Event Types, and Tool Names ===

/** SessionEvent.type values (final values written to JSONL by event-bridge). */
export const EventType = {
  Prompt: 'prompt',
  ToolStart: 'tool_start',
  ToolEnd: 'tool_end',
  Idle: 'idle',
  Interrupted: 'interrupted',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Notification: 'notification',
  Compact: 'compact',
  TeammateIdle: 'teammate_idle',
  TaskCompleted: 'task_completed',
  ConfigChange: 'config_change',
  WorktreeCreate: 'worktree_create',
  WorktreeRemove: 'worktree_remove',
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
  // → idle (agent waiting)
  [EventType.Idle]: 'idle',
  [EventType.Interrupted]: 'idle',
  // → null (no state change, log-only)
  [EventType.Notification]: null,
  [EventType.SubagentStop]: null,
  [EventType.ToolEnd]: null,
  [EventType.SessionStart]: null,
  [EventType.SessionEnd]: null,
  [EventType.TeammateIdle]: null,
  [EventType.TaskCompleted]: null,
  [EventType.ConfigChange]: null,
  [EventType.WorktreeRemove]: null,
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
   * Polymorphic context for the event:
   * - For `tool_start`/`tool_end`: tool-specific info (file path, command)
   * - For `idle`: an `IdleReason` constant
   * - For `prompt`: a `PromptReason` constant (synthetic PTY path only)
   * - For `subagent_start`/`subagent_stop`: subagent type
   * - For `notification`: notification text
   */
  detail?: string;
}

// === Session Usage (Claude Code Status Line) ===

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
  model: {
    id: string;
    displayName: string;
  };
  /** Agent-reported session ID (from status.json). Used for stale ID recovery. */
  sessionId?: string;
  /** Claude-only. Other adapters do not set this field. */
  rateLimits?: {
    fiveHour: { usedPercentage: number; resetsAt: number };
    sevenDay: { usedPercentage: number; resetsAt: number };
  };
}

// === Usage Time Period Stats ===

export type UsageTimePeriod = 'live' | 'today' | 'week' | 'month' | 'all';

export interface PeriodUsageStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
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
}

export interface GitPendingChangesResult {
  hasPendingChanges: boolean;
  uncommittedFileCount: number;
  unpushedCommitCount: number;
}

export interface GitDiffFilesInput {
  worktreePath?: string;
  projectPath: string;
  baseBranch: string;
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
}

export interface GitFileContentResult {
  original: string;
  modified: string;
  language: string;
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

/** Recursively makes all properties optional. Arrays are kept whole (not element-partial). */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[] ? U[] : T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export interface NotificationConfig {
  desktop: {
    onAgentIdle: boolean;
    onAgentCrash: boolean;
    onPlanComplete: boolean;
  };
  toasts: {
    onAgentIdle: boolean;
    onAgentCrash: boolean;
    onPlanComplete: boolean;
    durationSeconds: number;
    maxCount: number;
  };
  cooldownSeconds: number;
}

export interface AppConfig {
  theme: ThemeMode;
  sidebarVisible: boolean;
  boardLayout: 'horizontal' | 'vertical';
  cardDensity: 'compact' | 'default' | 'comfortable';
  columnWidth: 'narrow' | 'default' | 'wide';
  terminalPanelVisible: boolean;
  animationsEnabled: boolean;
  statusBarVisible: boolean;

  terminal: {
    shell: string | null; // null = auto-detect
    fontFamily: string;
    fontSize: number;
    showPreview: boolean;
    panelHeight: number; // persisted terminal panel height in px
    panelCollapsed: boolean; // persisted collapsed state
    scrollbackLines: number;
    cursorStyle: 'block' | 'underline' | 'bar';
  };

  agent: {
    permissionMode: PermissionMode;
    cliPaths: Record<string, string | null>; // keyed by agent name, null = auto-detect
    maxConcurrentSessions: number;
    queueOverflow: 'queue' | 'reject';
    idleTimeoutMinutes: number; // 0 = disabled
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
  };

  mcpServer: {
    enabled: boolean;
  };

  contextBar: {
    showShell: boolean;
    showVersion: boolean;
    showModel: boolean;
    showCost: boolean;
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

  hasCompletedFirstRun: boolean;
  showBoardSearch: boolean;
  skipDeleteConfirm: boolean;
  skipDoneWorktreeConfirm: boolean;
  skipBoardConfigConfirm: boolean;
  autoFocusIdleSession: boolean;
  activateAllProjectsOnStartup: boolean;
  restoreWindowPosition: boolean;
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  windowMaximized: boolean;
  statusBarPeriod: UsageTimePeriod;
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
  sidebarVisible: true,
  boardLayout: 'horizontal',
  cardDensity: 'default',
  columnWidth: 'default',
  terminalPanelVisible: true,
  animationsEnabled: true,
  statusBarVisible: true,
  terminal: {
    shell: null,
    fontFamily: 'Menlo, Consolas, "Courier New", monospace',
    fontSize: 14,
    showPreview: false,
    panelHeight: 250,
    panelCollapsed: false,
    scrollbackLines: 5000,
    cursorStyle: 'block',
  },
  agent: {
    permissionMode: 'acceptEdits',
    cliPaths: {},
    maxConcurrentSessions: 8,
    queueOverflow: 'queue',
    idleTimeoutMinutes: 0,
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
  },
  mcpServer: {
    enabled: true,
  },
  contextBar: {
    showShell: true,
    showVersion: true,
    showModel: true,
    showCost: true,
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
    },
    toasts: {
      onAgentIdle: true,
      onAgentCrash: true,
      onPlanComplete: true,
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
  hasCompletedFirstRun: false,
  showBoardSearch: true,
  skipDeleteConfirm: false,
  skipDoneWorktreeConfirm: false,
  skipBoardConfigConfirm: false,
  autoFocusIdleSession: false,
  activateAllProjectsOnStartup: true,
  restoreWindowPosition: true,
  windowBounds: null,
  windowMaximized: false,
  statusBarPeriod: 'live',
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
  fileAttachments?: Array<{ url: string; filename: string; sizeBytes: number }>;
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
    fileAttachments?: Array<{ url: string; filename: string; sizeBytes: number }>;
  }>;
}

export interface ImportExecuteResult {
  imported: number;
  skippedDuplicates: number;
  skippedAttachments: number;
  items: BacklogTask[];
}

export interface ImportCheckCliResult {
  available: boolean;
  authenticated: boolean;
  error?: string;
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
  pendingAttachments?: Array<{
    filename: string;
    data: string; // base64
    media_type: string;
  }>;
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
  base_branch?: string | null;
  use_worktree?: number | null;
  labels?: string[];
  priority?: number;
}

export interface TaskSwitchBranchInput {
  taskId: string;
  newBaseBranch: string;
  enableWorktree?: boolean;
}

export interface TaskMoveInput {
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
}

export interface TaskUnarchiveInput {
  id: string;
  targetSwimlaneId: string;
}

export interface SwimlaneCreateInput {
  name: string;
  color?: string;
  icon?: string | null;
  is_archived?: boolean;
  permission_mode?: PermissionMode | null;
  auto_spawn?: boolean;
  auto_command?: string | null;
  plan_exit_target_id?: string | null;
  agent_override?: string | null;
  handoff_context?: boolean;
}

export interface SwimlaneUpdateInput {
  id: string;
  name?: string;
  color?: string;
  icon?: string | null;
  position?: number;
  is_archived?: boolean;
  is_ghost?: boolean;
  permission_mode?: PermissionMode | null;
  auto_spawn?: boolean;
  auto_command?: string | null;
  plan_exit_target_id?: string | null;
  agent_override?: string | null;
  handoff_context?: boolean;
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
}

/** Minimal parsing interface for agent-specific runtime behavior. */
export interface AgentParser {
  /**
   * Detect whether the agent has produced its first meaningful output.
   * Called on each PTY data flush. Return true to emit the 'first-output'
   * event that lifts the shimmer overlay in the renderer.
   */
  detectFirstOutput(data: string): boolean;
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
   * Omit entirely for agents without such files (Claude uses
   * status.json + event-bridge hooks; Aider has no equivalent).
   */
  readonly sessionHistory?: {
    /**
     * Given the agent-reported session ID (captured by the PTY
     * scraper via runtime.sessionId.fromOutput), locate the session
     * history file on disk. Returns an absolute path, or null if the
     * file cannot be found within the polling budget (~5 s) or if
     * the platform can't be supported (e.g. WSL from Windows).
     *
     * Implementations should: compute the expected directory from
     * cwd and the UTC date (Codex) or cwd basename (Gemini),
     * readdirSync, filter by a filename regex embedding
     * agentSessionId, poll every 500 ms for up to 5 s if not
     * immediately present.
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
 * One entry in a parsed agent transcript. Distinct from `SessionEvent`
 * (telemetry only) - this preserves the actual conversation content for
 * display in the Transcript tab.
 */
export type TranscriptEntry =
  | { kind: 'user'; uuid: string; ts: number; text: string }
  | { kind: 'assistant'; uuid: string; ts: number; model?: string; blocks: TranscriptBlock[] }
  | { kind: 'tool_result'; uuid: string; ts: number; toolUseId: string; content: string; isError?: boolean };

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
  /** Agent-specific parser for status/event output. Falls back to ClaudeStatusParser if omitted. */
  agentParser?: AgentParser;
  /** Human-readable agent name for diagnostic logs (e.g. "claude", "gemini").
   *  Survives production minification unlike `agentParser.constructor.name`. */
  agentName?: string;
  /** Sequence of strings to write to PTY before killing for graceful exit (e.g. ['\x03', '/exit\r']). */
  exitSequence?: string[];
}

export interface SpawnTransientSessionInput {
  projectId: string;
  /** Branch to checkout before spawning. If omitted, uses the project's default base branch. */
  branch?: string;
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
  role?: SwimlaneRole;
  icon?: string;
  color?: string;
  autoSpawn?: boolean;
  permissionMode?: PermissionMode | null;
  planExitTarget?: string; // name of target column
  archived?: boolean;
  autoCommand?: string | null;
  agentOverride?: string | null;
  handoffContext?: boolean;
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

export interface BoardConfig {
  version: number;
  columns: BoardColumnConfig[];
  actions: BoardActionConfig[];
  transitions: BoardTransitionConfig[];
  shortcuts?: ShortcutConfig[];
  defaultBaseBranch?: string;
  _modifiedBy?: string;
}

// === Preload API (exposed to renderer via contextBridge) ===

export interface ElectronAPI {
  // Projects
  projects: {
    list: () => Promise<Project[]>;
    create: (input: ProjectCreateInput) => Promise<Project>;
    delete: (id: string) => Promise<void>;
    open: (id: string) => Promise<void>;
    getCurrent: () => Promise<Project | null>;
    openByPath: (path: string) => Promise<Project>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    rename: (id: string, name: string) => Promise<Project>;
    setDefaultAgent: (id: string, agentName: string) => Promise<Project>;
    reorder: (ids: string[]) => Promise<void>;
    setGroup: (projectId: string, groupId: string | null) => Promise<void>;
    onAutoOpened: (callback: (project: Project) => void) => () => void;
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
    create: (input: TaskCreateInput) => Promise<Task>;
    update: (input: TaskUpdateInput) => Promise<Task>;
    delete: (id: string) => Promise<void>;
    move: (input: TaskMoveInput) => Promise<void>;
    listArchived: () => Promise<Task[]>;
    unarchive: (input: TaskUnarchiveInput) => Promise<Task>;
    bulkDelete: (ids: string[]) => Promise<void>;
    bulkUnarchive: (ids: string[], targetSwimlaneId: string) => Promise<void>;
    switchBranch: (input: TaskSwitchBranchInput) => Promise<Task>;
    onAutoMoved: (callback: (taskId: string, targetSwimlaneId: string, taskTitle: string, projectId?: string) => void) => () => void;
    onCreatedByAgent: (callback: (taskId: string, taskTitle: string, columnName: string, projectId?: string) => void) => () => void;
    onUpdatedByAgent: (callback: (taskId: string, taskTitle: string, projectId?: string) => void) => () => void;
    onDeletedByAgent: (callback: (taskId: string, taskTitle: string, projectId?: string) => void) => () => void;
    onSpawnProgress: (callback: (taskId: string, label: string | null) => void) => () => void;
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
    spawn: (input: SpawnSessionInput) => Promise<Session>;
    kill: (sessionId: string) => Promise<void>;
    suspend: (taskId: string) => Promise<void>;
    resume: (taskId: string, resumePrompt?: string) => Promise<Session>;
    reset: (taskId: string) => Promise<void>;
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<{ colsChanged: boolean }>;
    list: () => Promise<Session[]>;
    getScrollback: (sessionId: string) => Promise<string>;
    getUsage: (projectId?: string) => Promise<Record<string, SessionUsage>>;
    onData: (callback: (sessionId: string, data: string, projectId?: string) => void) => () => void;
    onFirstOutput: (callback: (sessionId: string, projectId?: string) => void) => () => void;
    onExit: (callback: (sessionId: string, exitCode: number, projectId?: string) => void) => () => void;
    onStatus: (callback: (sessionId: string, session: Session, projectId?: string) => void) => () => void;
    onUsage: (callback: (sessionId: string, data: SessionUsage, projectId?: string) => void) => () => void;
    getActivity: (projectId?: string) => Promise<Record<string, ActivityState>>;
    onActivity: (callback: (sessionId: string, state: ActivityState, projectId?: string, taskId?: string, taskTitle?: string, isPermission?: boolean) => void) => () => void;
    getEvents: (sessionId: string) => Promise<SessionEvent[]>;
    getEventsCache: (projectId?: string) => Promise<Record<string, SessionEvent[]>>;
    onEvent: (callback: (sessionId: string, event: SessionEvent, projectId?: string) => void) => () => void;
    onIdleTimeout: (callback: (sessionId: string, taskId: string, timeoutMinutes: number, projectId?: string) => void) => () => void;
    getSummary: (taskId: string) => Promise<SessionSummary | null>;
    listSummaries: () => Promise<Record<string, SessionSummary>>;
    spawnTransient: (input: SpawnTransientSessionInput) => Promise<{ session: Session; branch: string; checkoutError?: string }>;
    killTransient: (sessionId: string) => Promise<void>;
    getPeriodStats: (period: UsageTimePeriod) => Promise<PeriodUsageStats>;
    setFocused: (sessionIds: string[]) => Promise<void>;
  };

  // Config
  config: {
    get: () => Promise<AppConfig>;
    getGlobal: () => Promise<AppConfig>;
    set: (config: DeepPartial<AppConfig>) => Promise<void>;
    getProjectOverrides: () => Promise<DeepPartial<AppConfig> | null>;
    setProjectOverrides: (overrides: DeepPartial<AppConfig>) => Promise<void>;
    getProjectOverridesByPath: (projectPath: string) => Promise<DeepPartial<AppConfig> | null>;
    setProjectOverridesByPath: (projectPath: string, overrides: DeepPartial<AppConfig>) => Promise<void>;
    syncDefaultToProjects: (partial: DeepPartial<AppConfig>) => Promise<number>;
  };

  // Agent detection & commands
  agent: {
    detect: () => Promise<{ found: boolean; path: string | null; version: string | null }>;
    listCommands: (cwd?: string) => Promise<AgentCommand[]>;
  };

  // Agents
  agents: {
    list: () => Promise<AgentDetectionInfo[]>;
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
    exec: (command: string, cwd: string) => Promise<{ pid: number | undefined }>;
  };

  // Git
  git: {
    detect: () => Promise<{ found: boolean; path: string | null; version: string | null; meetsMinimum: boolean }>;
    listBranches: () => Promise<string[]>;
    diffFiles: (input: GitDiffFilesInput) => Promise<GitDiffFilesResult>;
    fileContent: (input: GitFileContentInput) => Promise<GitFileContentResult>;
    subscribeDiff: (worktreePath: string) => void;
    unsubscribeDiff: (worktreePath: string) => void;
    onDiffChanged: (callback: () => void) => () => void;
    checkPendingChanges: (input: GitPendingChangesInput) => Promise<GitPendingChangesResult>;
  };

  // Dialog
  dialog: {
    selectFolder: () => Promise<string | null>;
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

  // Analytics
  analytics: {
    trackRendererError: (message: string) => void;
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
  };

  // Board Config
  boardConfig: {
    exists: () => Promise<boolean>;
    export: () => Promise<void>;
    apply: (projectId: string) => Promise<string[]>;
    onChanged: (callback: (projectId: string) => void) => () => void;
    onShortcutsChanged: (callback: (projectId: string) => void) => () => void;
    getShortcuts: () => Promise<(ShortcutConfig & { source: 'team' | 'local' })[]>;
    setShortcuts: (actions: ShortcutConfig[], target: 'team' | 'local') => Promise<void>;
    setDefaultBaseBranch: (branch: string) => Promise<void>;
  };

  // Clipboard
  clipboard: {
    saveImage: (data: string, extension: string) => Promise<string>;
  };

  // Platform
  platform: string;

  // Web utilities
  webUtils: {
    getPathForFile: (file: File) => string;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
