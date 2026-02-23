// === Database Models ===

export interface Project {
  id: string;
  name: string;
  path: string;
  github_url: string | null;
  default_agent: string;
  last_opened: string;
  created_at: string;
}

export interface Task {
  id: string;
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
  created_at: string;
  updated_at: string;
}

export interface Swimlane {
  id: string;
  name: string;
  position: number;
  color: string;
  is_terminal: boolean;
  created_at: string;
}

export type SkillType =
  | 'create_worktree'
  | 'spawn_agent'
  | 'send_command'
  | 'create_pr'
  | 'run_script'
  | 'cleanup_worktree'
  | 'kill_session'
  | 'webhook';

export interface Skill {
  id: string;
  name: string;
  type: SkillType;
  config_json: string;
  created_at: string;
}

export interface SkillConfig {
  // create_worktree
  baseBranch?: string;
  copyFiles?: string[];

  // spawn_agent
  agent?: string;
  promptTemplate?: string;
  permissionMode?: PermissionMode;
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
  skill_id: string;
  execution_order: number;
}

// === Session Management ===

export type SessionStatus = 'running' | 'queued' | 'idle' | 'exited' | 'suspended' | 'error';

export interface Session {
  id: string;
  taskId: string;
  pid: number | null;
  status: SessionStatus;
  shell: string;
  cwd: string;
  startedAt: string;
  exitCode: number | null;
}

// === Session Persistence (DB) ===

export type SessionRecordStatus = 'running' | 'suspended' | 'exited' | 'orphaned';

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
}

// === Session Usage (Claude Code Status Line) ===

export interface SessionUsage {
  contextWindow: {
    usedPercentage: number;
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

// === Configuration ===

export type PermissionMode = 'dangerously-skip' | 'project-settings' | 'plan-mode' | 'manual';

export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppConfig {
  theme: ThemeMode;
  accentColor: string;
  sidebarVisible: boolean;
  boardLayout: 'horizontal' | 'vertical';

  terminal: {
    shell: string | null; // null = auto-detect
    fontFamily: string;
    fontSize: number;
    showPreview: boolean;
  };

  claude: {
    permissionMode: PermissionMode;
    cliPath: string | null; // null = auto-detect on PATH
    maxConcurrentSessions: number;
    queueOverflow: 'queue' | 'reject';
  };

  git: {
    worktreesEnabled: boolean;
    autoCleanup: boolean;
    defaultBaseBranch: string;
    copyFiles: string[];
    initScript: string | null;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
  accentColor: '#3b82f6',
  sidebarVisible: true,
  boardLayout: 'horizontal',
  terminal: {
    shell: null,
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 14,
    showPreview: false,
  },
  claude: {
    permissionMode: 'project-settings',
    cliPath: null,
    maxConcurrentSessions: 5,
    queueOverflow: 'queue',
  },
  git: {
    worktreesEnabled: true,
    autoCleanup: true,
    defaultBaseBranch: 'main',
    copyFiles: ['.env', '.env.local', '.claude/settings.local.json'],
    initScript: null,
  },
};

// === IPC API Types ===

export interface TaskCreateInput {
  title: string;
  description: string;
  swimlane_id: string;
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
}

export interface TaskMoveInput {
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
}

export interface SwimlaneCreateInput {
  name: string;
  color?: string;
  is_terminal?: boolean;
}

export interface SwimlaneUpdateInput {
  id: string;
  name?: string;
  color?: string;
  position?: number;
  is_terminal?: boolean;
}

export interface SkillCreateInput {
  name: string;
  type: SkillType;
  config_json: string;
}

export interface SkillUpdateInput {
  id: string;
  name?: string;
  type?: SkillType;
  config_json?: string;
}

export interface ProjectCreateInput {
  name: string;
  path: string;
  github_url?: string;
}

export interface SpawnSessionInput {
  taskId: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  statusOutputPath?: string; // path for the status bridge JSON file
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
    onAutoOpened: (callback: (project: Project) => void) => () => void;
  };

  // Tasks
  tasks: {
    list: (swimlaneId?: string) => Promise<Task[]>;
    create: (input: TaskCreateInput) => Promise<Task>;
    update: (input: TaskUpdateInput) => Promise<Task>;
    delete: (id: string) => Promise<void>;
    move: (input: TaskMoveInput) => Promise<void>;
  };

  // Swimlanes
  swimlanes: {
    list: () => Promise<Swimlane[]>;
    create: (input: SwimlaneCreateInput) => Promise<Swimlane>;
    update: (input: SwimlaneUpdateInput) => Promise<Swimlane>;
    delete: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
  };

  // Skills
  skills: {
    list: () => Promise<Skill[]>;
    create: (input: SkillCreateInput) => Promise<Skill>;
    update: (input: SkillUpdateInput) => Promise<Skill>;
    delete: (id: string) => Promise<void>;
  };

  // Transitions
  transitions: {
    list: () => Promise<SwimlaneTransition[]>;
    set: (fromId: string, toId: string, skillIds: string[]) => Promise<void>;
    getForTransition: (fromId: string, toId: string) => Promise<SwimlaneTransition[]>;
  };

  // Sessions (PTY)
  sessions: {
    spawn: (input: SpawnSessionInput) => Promise<Session>;
    kill: (sessionId: string) => Promise<void>;
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    list: () => Promise<Session[]>;
    getScrollback: (sessionId: string) => Promise<string>;
    getUsage: () => Promise<Record<string, SessionUsage>>;
    onData: (callback: (sessionId: string, data: string) => void) => () => void;
    onExit: (callback: (sessionId: string, exitCode: number) => void) => () => void;
    onUsage: (callback: (sessionId: string, data: SessionUsage) => void) => () => void;
  };

  // Config
  config: {
    get: () => Promise<AppConfig>;
    set: (config: Partial<AppConfig>) => Promise<void>;
    getProjectOverrides: () => Promise<Partial<AppConfig> | null>;
    setProjectOverrides: (overrides: Partial<AppConfig>) => Promise<void>;
  };

  // Claude detection
  claude: {
    detect: () => Promise<{ found: boolean; path: string | null; version: string | null }>;
  };

  // Shell
  shell: {
    getAvailable: () => Promise<Array<{ name: string; path: string }>>;
    getDefault: () => Promise<string>;
  };

  // Window controls
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
