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
  session_type: 'claude_agent' | 'run_script';
  claude_session_id: string | null;
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

/** All Claude Code hook event names (settings.json keys). */
export const HookEvent = {
  // Tool lifecycle
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  // Session lifecycle
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  // Agent stop
  Stop: 'Stop',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  // User interaction
  UserPromptSubmit: 'UserPromptSubmit',
  PermissionRequest: 'PermissionRequest',
  Notification: 'Notification',
  // Context management
  PreCompact: 'PreCompact',
  // Agent teams
  TeammateIdle: 'TeammateIdle',
  TaskCompleted: 'TaskCompleted',
  // Configuration
  ConfigChange: 'ConfigChange',
  // Worktree operations
  WorktreeCreate: 'WorktreeCreate',
  WorktreeRemove: 'WorktreeRemove',
} as const;
export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent];

/** Claude Code tool names we detect/react to. */
export const ClaudeTool = {
  Bash: 'Bash',
  ExitPlanMode: 'ExitPlanMode',
} as const;
export type ClaudeTool = (typeof ClaudeTool)[keyof typeof ClaudeTool];

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

export interface SessionEvent {
  ts: number;
  type: EventType;
  tool?: string;    // for tool_start/tool_end/interrupted
  detail?: string;  // file path, command, etc.
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
}

// === Session Display State (discriminated union for UI) ===

export type SessionDisplayState =
  | { kind: 'none' }
  | { kind: 'initializing' }
  | { kind: 'queued' }
  | { kind: 'running'; activity: ActivityState; usage: SessionUsage | null }
  | { kind: 'suspended' }
  | { kind: 'exited'; exitCode: number };

// === Bottom Panel Constants ===

/** Sentinel value for the Activity tab in the bottom panel. */
export const ACTIVITY_TAB = '__all__';

// === Configuration ===

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions';

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

  claude: {
    permissionMode: PermissionMode;
    cliPath: string | null; // null = auto-detect on PATH
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
  };

  notifications: NotificationConfig;

  backlog: {
    priorities: Array<{ label: string; color: string }>;
    labelColors: Record<string, string>;
  };

  hasCompletedFirstRun: boolean;
  showBoardSearch: boolean;
  skipDeleteConfirm: boolean;
  skipBoardConfigConfirm: boolean;
  autoFocusIdleSession: boolean;
  activateAllProjectsOnStartup: boolean;
  restoreWindowPosition: boolean;
  windowBounds: { x: number; y: number; width: number; height: number } | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
  sidebarVisible: true,
  boardLayout: 'horizontal',
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
  claude: {
    permissionMode: 'default',
    cliPath: null,
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
  skipBoardConfigConfirm: false,
  autoFocusIdleSession: false,
  activateAllProjectsOnStartup: true,
  restoreWindowPosition: true,
  windowBounds: null,
};

// === Claude Commands ===

export interface ClaudeCommand {
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

export type ExternalSource = 'github_issues' | 'github_projects' | 'azure_devops';

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
}

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
    rename: (id: string, name: string) => Promise<Project>;
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
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
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

  // Claude detection & commands
  claude: {
    detect: () => Promise<{ found: boolean; path: string | null; version: string | null }>;
    listCommands: (cwd?: string) => Promise<ClaudeCommand[]>;
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
