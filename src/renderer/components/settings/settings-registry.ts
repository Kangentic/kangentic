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
  // ── General ──
  { id: 'project.location', tabId: 'general', label: 'Project Location', description: 'Folder on disk this project points at. Move it to a new location; all tasks, history, and worktrees move with it.', scope: 'project', keywords: ['path', 'folder', 'directory', 'move', 'relocate', 'change directory', 'locate'] },

  // ── Theme ──
  { id: 'theme', tabId: 'theme', label: 'Theme', description: 'Color scheme for the interface', scope: 'project', keywords: ['color', 'dark', 'light', 'appearance'] },

  // ── Layout ──
  { id: 'cardDensity', tabId: 'layout', label: 'Card Density', description: 'Amount of detail shown on task cards', scope: 'global', keywords: ['compact', 'comfortable', 'minimal', 'detailed'] },
  { id: 'columnWidth', tabId: 'layout', label: 'Column Width', description: 'Width of board columns', scope: 'global', keywords: ['narrow', 'wide', 'size'] },
  { id: 'diffViewMode', tabId: 'layout', label: 'Git Diff View', description: 'Default layout for Git file diffs in the Changes panel: split (side by side) or inline (unified).', scope: 'global', keywords: ['split', 'inline', 'side by side', 'side-by-side', 'unified', 'diff', 'changes', 'git', 'review', 'compare'] },
  { id: 'terminalPanelVisible', tabId: 'layout', label: 'Terminal Panel', description: 'Show the terminal panel below the board', scope: 'global', keywords: ['bottom', 'panel', 'hide', 'terminal', 'visible'] },
  { id: 'statusBarVisible', tabId: 'layout', label: 'Status Bar', description: 'Show the status bar at the bottom of the window', scope: 'global', keywords: ['bottom', 'bar', 'hide', 'visible'] },
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
  // Note: model and effort are intentionally NOT in the registry. Those
  // pills double as the in-place picker triggers, so a "hide" toggle would
  // silently disable a feature, not just declutter chrome. They're a
  // permanent fixture of the context bar.
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
  { id: 'git.initScript', tabId: 'git', label: 'Post-Worktree Script', description: 'Shell script to run after worktree creation. Runs through cmd.exe on Windows, so POSIX-only syntax will not carry over.', scope: 'project', keywords: ['install', 'setup', 'hook'] },
  { id: 'git.linkNodeModules', tabId: 'git', label: 'Link node_modules', description: 'Symlink the root node_modules into each worktree so agents skip a fresh install. Disable to let the Post-Worktree Script install dependencies in the worktree itself.', scope: 'project', keywords: ['symlink', 'junction', 'deps', 'install', 'node_modules'] },
  { id: 'git.prRefreshIntervalMinutes', tabId: 'git', label: 'Auto-refresh PRs', description: 'How often to refresh linked PR state in the background', scope: 'project', keywords: ['pull request', 'pr', 'refresh', 'poll', 'merged', 'sync', 'stale'] },

  // ── Browser ──
  { id: 'browser.enabled', tabId: 'browser', label: 'Enable Browser Pane', description: 'Show the Browser pill in task detail headers. Disable for security-sensitive projects that should not embed external sites.', scope: 'project', keywords: ['webview', 'embedded', 'preview', 'disable', 'security'] },
  { id: 'browser.defaultUrl', tabId: 'browser', label: 'Default URL', description: 'Project default URL when a task has no per-task override. Auto-saved when you first navigate the Browser pane.', scope: 'project', keywords: ['webview', 'preview', 'localhost', 'dev server', 'url'] },
  { id: 'browser.clearStorage', tabId: 'browser', label: 'Clear Browser Data', description: 'Wipe cookies, localStorage, IndexedDB, service workers, and HTTP/auth caches for the embedded browser. Saved URLs are kept.', scope: 'global', keywords: ['cookies', 'cache', 'reset', 'logout', 'sign out', 'storage', 'privacy', 'wipe'] },

  // ── Shortcuts ──
  { id: 'shortcuts', tabId: 'shortcuts', label: 'Shortcuts', description: 'Custom commands accessible from the task detail dialog', scope: 'project', keywords: ['command', 'shortcut', 'tool', 'open', 'launch', 'tortoisegit', 'vscode', 'terminal', 'explorer', 'quick action'] },

  // ── MCP Server ──
  { id: 'mcpServer.enabled', tabId: 'mcpServer', label: 'Kangentic MCP Server', description: 'Give agents tools to interact with your board', scope: 'global', keywords: ['mcp', 'tools', 'create task', 'agent', 'board', 'query', 'session', 'stats'] },

  // ── Behavior > Session Limits ──
  { id: 'agent.maxConcurrentSessions', tabId: 'behavior', label: 'Max Concurrent Sessions', description: 'Limit how many agents can run at the same time', scope: 'global', section: 'Session Limits', keywords: ['parallel', 'limit'] },
  { id: 'agent.queueOverflow', tabId: 'behavior', label: 'When Max Sessions Reached', description: 'How new agent requests are handled when all slots are in use', scope: 'global', section: 'Session Limits', keywords: ['overflow', 'queue', 'reject'] },

  // ── Behavior ──
  { id: 'autoFocusIdleSession', tabId: 'behavior', label: 'Auto-Focus Idle Sessions', description: 'Automatically switch the bottom panel to idle sessions. Idle tabs are always highlighted regardless of this setting.', scope: 'global', keywords: ['switch', 'panel', 'attention'] },
  { id: 'agent.autoResumeSessionsOnRestart', tabId: 'behavior', label: 'Auto-Resume Agents on Restart', description: 'When a project opens, resume any agent sessions that were running at last close. When off, those sessions stay paused until you click Resume on each task. Turn off if resuming many agents at once slows your machine.', scope: 'global', keywords: ['resume', 'restart', 'startup', 'suspend', 'pause', 'stampede', 'auto', 'sessions', 'agents'] },
  { id: 'skipBoardConfigConfirm', tabId: 'behavior', label: 'Auto-Apply Board Config Changes', description: 'When a kangentic.json board change is detected (from a teammate or your own pulled-back commit), apply it immediately instead of showing the confirmation dialog.', scope: 'global', keywords: ['board config', 'kangentic.json', 'reconcile', 'reconciliation', 'apply', 'confirm', 'dialog', 'pull', 'auto'] },

  // ── Behavior > Task Windows ──
  { id: 'windowLightDismiss', tabId: 'behavior', label: 'Close on Outside Click', description: 'Click empty space outside a task window (anything but a button or the terminal panel) to dismiss it. Closing keeps the agent running and hands its terminal back to the panel; reopening the task reattaches.', scope: 'global', section: 'Task Windows', keywords: ['dismiss', 'click outside', 'window', 'peek', 'close', 'light dismiss', 'task window'] },

  // ── Notifications ──
  { id: 'notifications.onAgentIdle', tabId: 'notifications', label: 'Agent Idle', description: 'When an agent needs attention on a non-visible project', scope: 'global', keywords: ['desktop', 'toast', 'alert'] },
  { id: 'notifications.onPlanComplete', tabId: 'notifications', label: 'Plan Complete', description: 'When a plan finishes and the task auto-moves', scope: 'global', keywords: ['desktop', 'toast', 'alert'] },
  { id: 'notifications.onSpawnStalled', tabId: 'notifications', label: 'Spawn Stalled', description: 'When a task spawn waits too long on the git queue while preparing', scope: 'global', keywords: ['desktop', 'toast', 'alert', 'queue', 'fetching', 'worktree', 'preparing'] },
  { id: 'notifications.toasts.durationSeconds', tabId: 'notifications', label: 'Toast Auto-Dismiss', description: 'How long toasts remain visible', scope: 'global', keywords: ['timeout', 'seconds'] },
  { id: 'notifications.toasts.maxCount', tabId: 'notifications', label: 'Max Visible Toasts', description: 'Maximum simultaneous toasts on screen', scope: 'global', keywords: ['limit', 'count'] },

  // ── Hotkeys ──
  { id: 'hotkeys', tabId: 'hotkeys', label: 'Hotkeys', description: 'Keyboard shortcuts and key bindings', scope: 'global', keywords: ['keyboard', 'shortcut', 'hotkey', 'keybind', 'rebind', 'key', 'ctrl', 'cmd', 'shift', 'combo'] },

  // ── Privacy (synthetic) ──
  { id: 'privacy.info', tabId: 'privacy', label: 'Privacy', description: 'Anonymous analytics and data collection policy', scope: 'global', keywords: ['telemetry', 'analytics', 'aptabase', 'gdpr', 'opt out'] },

  // ── Developer ──
  { id: 'developer.activityDebugOverlay', tabId: 'developer', label: 'Activity Engine Debug Overlay', description: 'Show a floating panel with live activity-engine state for every running session. Useful for diagnosing spinner / idle bugs.', scope: 'global', keywords: ['debug', 'overlay', 'diagnostic', 'engine', 'activity', 'thinking', 'idle', 'subagent', 'background', 'shell', 'reason'] },
];

/** Lookup by ID for O(1) access. */
export const SETTINGS_BY_ID: Record<string, SettingDefinition> = Object.fromEntries(
  SETTINGS_REGISTRY.map((setting) => [setting.id, setting]),
);

/** Tab label lookup for search matching against tab names. */
export const TAB_LABELS: Record<string, string> = {
  general: 'General',
  theme: 'Theme',
  terminal: 'Terminal',
  agent: 'Agent',
  git: 'Git',
  browser: 'Browser',
  shortcuts: 'Shortcuts',
  layout: 'Layout',
  behavior: 'Behavior',
  hotkeys: 'Hotkeys',
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
