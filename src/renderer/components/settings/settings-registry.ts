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
  // ── Theme ──
  { id: 'theme', tabId: 'theme', label: 'Theme', description: 'Color scheme for the interface', scope: 'project', keywords: ['color', 'dark', 'light', 'appearance'] },

  // ── Layout ──
  { id: 'cardDensity', tabId: 'layout', label: 'Card Density', description: 'Amount of detail shown on task cards', scope: 'global', keywords: ['compact', 'comfortable', 'minimal', 'detailed'] },
  { id: 'columnWidth', tabId: 'layout', label: 'Column Width', description: 'Width of board columns', scope: 'global', keywords: ['narrow', 'wide', 'size'] },
  { id: 'terminalPanelVisible', tabId: 'layout', label: 'Terminal Panel', description: 'Show the terminal panel below the board', scope: 'global', keywords: ['bottom', 'panel', 'hide', 'terminal', 'visible'] },
  { id: 'statusBarVisible', tabId: 'layout', label: 'Status Bar', description: 'Show the status bar at the bottom of the window', scope: 'global', keywords: ['bottom', 'bar', 'hide', 'visible'] },
  { id: 'showBoardSearch', tabId: 'layout', label: 'Board Search Bar', description: 'Display the search bar above board columns. Press Ctrl+F (Cmd+F on Mac) to toggle.', scope: 'global', keywords: ['search', 'filter', 'find', 'board'] },
  { id: 'restoreWindowPosition', tabId: 'layout', label: 'Restore Window Position', description: 'Remember window size and position between launches', scope: 'global', keywords: ['size', 'bounds', 'remember'] },
  { id: 'animationsEnabled', tabId: 'layout', label: 'Animations', description: 'Enable transition and motion effects', scope: 'global', keywords: ['motion', 'reduce', 'transition', 'disable', 'accessibility'] },

  // ── Terminal ──
  { id: 'terminal.shell', tabId: 'terminal', label: 'Shell', description: 'Terminal shell used for agent sessions', scope: 'project', keywords: ['bash', 'powershell', 'zsh', 'fish'] },
  { id: 'terminal.fontSize', tabId: 'terminal', label: 'Font Size', description: 'Terminal text size in pixels', scope: 'project', keywords: ['px', 'text size'] },
  { id: 'terminal.fontFamily', tabId: 'terminal', label: 'Font Family', description: 'CSS font-family for the terminal', scope: 'project', keywords: ['monospace', 'typeface'] },
  { id: 'terminal.scrollbackLines', tabId: 'terminal', label: 'Scrollback Lines', description: 'Lines kept in the visible scrollback. Full session history is preserved for replay regardless of this value.', scope: 'project', keywords: ['buffer', 'history'] },
  { id: 'terminal.cursorStyle', tabId: 'terminal', label: 'Cursor Style', description: 'Terminal cursor appearance', scope: 'project', keywords: ['block', 'underline', 'bar'] },

  // ── Terminal > Context Bar ──
  { id: 'contextBar.showShell', tabId: 'terminal', label: 'Shell', description: 'Detected shell name', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showVersion', tabId: 'terminal', label: 'Version', description: 'Agent CLI version', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showModel', tabId: 'terminal', label: 'Model', description: 'Active model name', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showEffort', tabId: 'terminal', label: 'Effort', description: 'Claude reasoning effort level', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status', 'claude', 'reasoning', 'thinking', 'xhigh'] },
  { id: 'contextBar.showCost', tabId: 'terminal', label: 'Cost', description: 'Session API cost', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status', 'price'] },
  { id: 'contextBar.showTokens', tabId: 'terminal', label: 'Token Counts', description: 'Input / output totals', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showContextFraction', tabId: 'terminal', label: 'Context Window', description: 'Used / total tokens', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showProgressBar', tabId: 'terminal', label: 'Progress Bar', description: 'Usage bar and percentage', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status'] },
  { id: 'contextBar.showRateLimits', tabId: 'terminal', label: 'Rate Limits', description: 'Claude 5h / weekly quota bars', scope: 'global', section: 'Context Bar', keywords: ['context bar', 'status', 'claude', 'quota', 'plan', 'limit', '5h', 'weekly'] },

  // ── Agent ──
  { id: 'project.defaultAgent', tabId: 'agent', label: 'Default Agent', description: 'Which agent CLI to use for new sessions', scope: 'project', keywords: ['agent', 'claude', 'default'] },
  { id: 'agent.cliPaths', tabId: 'agent', label: 'CLI Paths', description: 'Paths to agent CLI binaries (auto-detected if empty)', scope: 'global', keywords: ['binary', 'executable'] },
  { id: 'agent.idleTimeoutMinutes', tabId: 'agent', label: 'Idle Timeout (minutes)', description: 'Auto-suspend sessions after this many minutes idle. 0 to disable.', scope: 'global', keywords: ['suspend', 'minutes'] },
  { id: 'agent.permissionMode', tabId: 'agent', label: 'Permissions', description: 'How the agent handles tool approvals', scope: 'project', keywords: ['allowlist', 'bypass', 'approve'] },

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
  { id: 'agent.maxConcurrentSessions', tabId: 'behavior', label: 'Max Concurrent Sessions', description: 'Limit how many agents can run at the same time', scope: 'global', section: 'Session Limits', keywords: ['parallel', 'limit'] },
  { id: 'agent.queueOverflow', tabId: 'behavior', label: 'When Max Sessions Reached', description: 'How new agent requests are handled when all slots are in use', scope: 'global', section: 'Session Limits', keywords: ['overflow', 'queue', 'reject'] },

  // ── Behavior ──
  { id: 'autoFocusIdleSession', tabId: 'behavior', label: 'Auto-Focus Idle Sessions', description: 'Automatically switch the bottom panel to idle sessions. Idle tabs are always highlighted regardless of this setting.', scope: 'global', keywords: ['switch', 'panel', 'attention'] },
  { id: 'agent.autoResumeSessionsOnRestart', tabId: 'behavior', label: 'Auto-Resume Agents on Restart', description: 'When a project opens, resume any agent sessions that were running at last close. When off, those sessions stay paused until you click Resume on each task. Turn off if resuming many agents at once slows your machine.', scope: 'global', keywords: ['resume', 'restart', 'startup', 'suspend', 'pause', 'stampede', 'auto', 'sessions', 'agents'] },

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
  theme: 'Theme',
  terminal: 'Terminal',
  agent: 'Agent',
  git: 'Git',
  shortcuts: 'Shortcuts',
  layout: 'Layout',
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
