import type { SettingScope } from './setting-scope';

export interface SettingDefinition {
  /** Unique key matching config path, e.g. 'terminal.fontSize' */
  id: string;
  /** Tab this setting belongs to */
  tabId: string;
  /** Display label */
  label: string;
  /** Short description */
  description: string;
  /** Setting scope for panel filtering */
  scope: SettingScope;
  /** Section within the tab (e.g. 'Context Bar') */
  section?: string;
  /** Extra search keywords not in label/description */
  keywords?: string[];
}

/** Flat registry array. All settings in display order. */
export const SETTINGS_REGISTRY: SettingDefinition[] = [
  // ── Appearance ──
  { id: 'theme', tabId: 'appearance', label: 'Theme', description: 'Color scheme for the interface', scope: 'project', keywords: ['color', 'dark', 'light'] },

  // ── Terminal ──
  { id: 'terminal.shell', tabId: 'terminal', label: 'Shell', description: 'Terminal shell used for agent sessions', scope: 'project', keywords: ['bash', 'powershell', 'zsh', 'fish'] },
  { id: 'terminal.fontSize', tabId: 'terminal', label: 'Font Size', description: 'Terminal text size in pixels', scope: 'project', keywords: ['px', 'text size'] },
  { id: 'terminal.fontFamily', tabId: 'terminal', label: 'Font Family', description: 'CSS font-family for the terminal', scope: 'project', keywords: ['monospace', 'typeface'] },
  { id: 'terminal.scrollbackLines', tabId: 'terminal', label: 'Scrollback Lines', description: 'Maximum lines kept in terminal buffer', scope: 'project', keywords: ['buffer', 'history'] },
  { id: 'terminal.cursorStyle', tabId: 'terminal', label: 'Cursor Style', description: 'Terminal cursor appearance', scope: 'project', keywords: ['block', 'underline', 'bar'] },

  // ── Terminal > Context Bar ──
  { id: 'contextBar.showShell', tabId: 'terminal', label: 'Shell', description: 'Detected shell name', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showVersion', tabId: 'terminal', label: 'Version', description: 'Agent CLI version', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showModel', tabId: 'terminal', label: 'Model', description: 'Active model name', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showCost', tabId: 'terminal', label: 'Cost', description: 'Session API cost', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status', 'price'] },
  { id: 'contextBar.showTokens', tabId: 'terminal', label: 'Token Counts', description: 'Input / output totals', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showContextFraction', tabId: 'terminal', label: 'Context Window', description: 'Used / total tokens', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showProgressBar', tabId: 'terminal', label: 'Progress Bar', description: 'Usage bar and percentage', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },

  // ── Agent ──
  { id: 'project.defaultAgent', tabId: 'agent', label: 'Default Agent', description: 'Which agent CLI to use for new sessions', scope: 'project', keywords: ['agent', 'claude', 'default'] },
  { id: 'claude.cliPath', tabId: 'agent', label: 'CLI Path', description: 'Path to agent CLI binary (auto-detected if empty)', scope: 'global', keywords: ['binary', 'executable'] },
  { id: 'claude.idleTimeoutMinutes', tabId: 'agent', label: 'Idle Timeout (minutes)', description: 'Auto-suspend sessions after this many minutes idle. 0 to disable.', scope: 'global', keywords: ['suspend', 'minutes'] },
  { id: 'claude.permissionMode', tabId: 'agent', label: 'Permissions', description: 'How the agent handles tool approvals', scope: 'project', keywords: ['allowlist', 'bypass', 'approve'] },

  // ── Git ──
  { id: 'git.worktreesEnabled', tabId: 'git', label: 'Enable Worktrees', description: 'Create git worktrees for agent tasks', scope: 'project', keywords: ['branch', 'isolate'] },
  { id: 'git.autoCleanup', tabId: 'git', label: 'Auto-cleanup', description: 'Remove worktrees when tasks complete', scope: 'project', keywords: ['remove', 'delete'] },
  { id: 'git.defaultBaseBranch', tabId: 'git', label: 'Default Base Branch', description: 'Branch to create worktrees from', scope: 'project', keywords: ['main', 'master'] },
  { id: 'git.copyFiles', tabId: 'git', label: 'Copy Files', description: 'Additional files copied into each worktree', scope: 'project', keywords: ['env', 'dotfiles'] },
  { id: 'git.initScript', tabId: 'git', label: 'Post-Worktree Script', description: 'Shell script to run after worktree creation', scope: 'project', keywords: ['install', 'setup', 'hook'] },

  // ── Shortcuts ──
  { id: 'shortcuts', tabId: 'shortcuts', label: 'Shortcuts', description: 'Custom commands accessible from the task detail dialog', scope: 'project', keywords: ['command', 'shortcut', 'tool', 'open', 'launch', 'tortoisegit', 'vscode', 'terminal', 'explorer', 'quick action'] },

  // ── MCP Server ──
  { id: 'mcpServer.enabled', tabId: 'mcpServer', label: 'Kangentic MCP Server', description: 'Give agents tools to create tasks, query the board, and view session stats', scope: 'global', keywords: ['mcp', 'tools', 'create task', 'agent', 'board', 'query'] },

  // ── Behavior > Session Limits ──
  { id: 'claude.maxConcurrentSessions', tabId: 'behavior', label: 'Max Concurrent Sessions', description: 'Limit how many agents can run at the same time', scope: 'global', section: 'Session Limits', keywords: ['parallel', 'limit'] },
  { id: 'claude.queueOverflow', tabId: 'behavior', label: 'When Max Sessions Reached', description: 'How new agent requests are handled when all slots are in use', scope: 'global', section: 'Session Limits', keywords: ['overflow', 'queue', 'reject'] },

  // ── Behavior ──
  { id: 'showBoardSearch', tabId: 'behavior', label: 'Show Board Search Bar', description: 'Display the search bar above board columns. Press Ctrl+F (Cmd+F on Mac) to toggle.', scope: 'global', keywords: ['search', 'filter', 'find', 'board'] },
  { id: 'skipDeleteConfirm', tabId: 'behavior', label: 'Skip Task Delete Confirmation', description: 'Delete tasks immediately without a confirmation dialog', scope: 'global', keywords: ['confirm', 'dialog'] },
  { id: 'autoFocusIdleSession', tabId: 'behavior', label: 'Auto-Focus Idle Sessions', description: 'Automatically switch the bottom panel to idle sessions. Idle tabs are always highlighted regardless of this setting.', scope: 'global', keywords: ['switch', 'panel', 'attention'] },
  { id: 'activateAllProjectsOnStartup', tabId: 'behavior', label: 'Launch All Projects on Startup', description: 'Start agents across all projects on launch, not just the current open one', scope: 'global', keywords: ['boot', 'open', 'activate'] },
  { id: 'restoreWindowPosition', tabId: 'behavior', label: 'Restore Window Position', description: 'Remember window size and position between launches', scope: 'global', keywords: ['size', 'bounds', 'remember'] },

  // ── Notifications ──
  { id: 'notifications.onAgentIdle', tabId: 'notifications', label: 'Agent Idle', description: 'When an agent needs attention on a non-visible project', scope: 'global', keywords: ['desktop', 'toast', 'alert'] },
  { id: 'notifications.onPlanComplete', tabId: 'notifications', label: 'Plan Complete', description: 'When a plan finishes and the task auto-moves', scope: 'global', keywords: ['desktop', 'toast', 'alert'] },
  { id: 'notifications.toasts.durationSeconds', tabId: 'notifications', label: 'Toast Auto-Dismiss', description: 'How long toasts remain visible', scope: 'global', keywords: ['timeout', 'seconds'] },
  { id: 'notifications.toasts.maxCount', tabId: 'notifications', label: 'Max Visible Toasts', description: 'Maximum simultaneous toasts on screen', scope: 'global', keywords: ['limit', 'count'] },

  // ── Privacy (synthetic) ──
  { id: 'privacy.info', tabId: 'privacy', label: 'Privacy', description: 'Anonymous analytics and data collection policy', scope: 'global', keywords: ['telemetry', 'analytics', 'aptabase', 'gdpr', 'opt out'] },
];

/** Lookup by ID for O(1) access. */
export const SETTINGS_BY_ID: Record<string, SettingDefinition> = Object.fromEntries(
  SETTINGS_REGISTRY.map((setting) => [setting.id, setting]),
);

/** Tab label lookup for search matching against tab names. */
export const TAB_LABELS: Record<string, string> = {
  appearance: 'Appearance',
  terminal: 'Terminal',
  agent: 'Agent',
  git: 'Git',
  shortcuts: 'Shortcuts',
  behavior: 'Behavior',
  mcpServer: 'MCP Server',
  notifications: 'Notifications',
  privacy: 'Privacy',
};

/** Helper to get props for a SettingRow from the registry. */
export function settingProps(id: string): { searchId: string; label: string; description: string } {
  const entry = SETTINGS_BY_ID[id];
  if (!entry) throw new Error(`Unknown setting ID: ${id}`);
  return { searchId: entry.id, label: entry.label, description: entry.description };
}
