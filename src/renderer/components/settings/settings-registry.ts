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
  { id: 'showTaskNumbers', tabId: 'layout', label: 'Ticket Numbers', description: "Show each task's #N number on its card", scope: 'global', keywords: ['ticket', 'number', 'id', 'display', 'card', 'display_id', 'hash'] },
  { id: 'terminalPanelVisible', tabId: 'layout', label: 'Terminal Panel', description: 'Show the terminal panel below the board', scope: 'global', keywords: ['bottom', 'panel', 'hide', 'terminal', 'visible'] },
  { id: 'statusBarVisible', tabId: 'layout', label: 'Status Bar', description: 'Show the status bar at the bottom of the window', scope: 'global', keywords: ['bottom', 'bar', 'hide', 'visible'] },
  { id: 'restoreWindowPosition', tabId: 'layout', label: 'Restore Window Position', description: 'Remember window size and position between launches', scope: 'global', keywords: ['size', 'bounds', 'remember'] },
  { id: 'animationsEnabled', tabId: 'layout', label: 'Animations', description: 'Enable transition and motion effects', scope: 'global', keywords: ['motion', 'reduce', 'transition', 'disable', 'accessibility'] },

  // ── Layout > Diff ──
  { id: 'diffViewMode', tabId: 'layout', label: 'Git Diff View', description: 'Default layout for Git file diffs in the Changes panel: split (side by side) or inline (unified).', scope: 'global', section: 'Diff', keywords: ['split', 'inline', 'side by side', 'side-by-side', 'unified', 'diff', 'changes', 'git', 'review', 'compare'] },
  { id: 'diffDefaultScope', tabId: 'layout', label: 'Default Diff Scope', description: 'Which changes a freshly opened Changes panel shows: working (uncommitted edits), staged (index), or the full branch vs its base.', scope: 'global', section: 'Diff', keywords: ['scope', 'working', 'staged', 'branch', 'uncommitted', 'index', 'diff', 'changes', 'git', 'review'] },
  { id: 'diffIgnoreWhitespace', tabId: 'layout', label: 'Ignore Whitespace', description: 'Hide whitespace-only changes in the diff to filter reformatting noise.', scope: 'global', section: 'Diff', keywords: ['whitespace', 'trim', 'indent', 'reformat', 'diff', 'changes'] },
  { id: 'diffCollapseUnchanged', tabId: 'layout', label: 'Collapse Unchanged Regions', description: 'Fold away large unchanged spans so a big file shows only the changed hunks with a little context.', scope: 'global', section: 'Diff', keywords: ['collapse', 'fold', 'hide', 'unchanged', 'context', 'hunks', 'diff'] },
  { id: 'diffFileSort', tabId: 'layout', label: 'File Sort', description: 'How the Changes panel orders files: by name, by status (added / modified / deleted), or by size (most changes first).', scope: 'global', section: 'Diff', keywords: ['sort', 'order', 'name', 'status', 'size', 'files', 'diff', 'changes'] },
  { id: 'diffFlatList', tabId: 'layout', label: 'Flat File List', description: 'Show changed files as a flat list of full paths instead of a nested directory tree.', scope: 'global', section: 'Diff', keywords: ['flat', 'list', 'tree', 'directory', 'folder', 'nested', 'files', 'diff', 'changes'] },

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
  { id: 'project.defaultAgent', tabId: 'agent', label: 'Agent', description: 'Which agent CLI to use for new sessions', scope: 'project', keywords: ['agent', 'claude', 'default'] },
  { id: 'project.defaultModel', tabId: 'agent', label: 'Model', description: 'Model used for new sessions when no column or task override is set', scope: 'project', keywords: ['model', 'opus', 'sonnet', 'default'] },
  { id: 'project.defaultEffort', tabId: 'agent', label: 'Effort', description: 'Reasoning effort used for new sessions when no column or task override is set', scope: 'project', keywords: ['effort', 'reasoning', 'xhigh', 'default'] },
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

  // ── Browser Automation (global policy: agent control of the Browser pane) ──
  { id: 'browserAutomation.enabled', tabId: 'browserAutomation', label: 'Enable Browser Automation', description: 'Let agents drive the embedded Browser pane via the kangentic_browser_* tools (screenshot, click, type, navigate, and more). Master switch - turn off to disable all agent browser control.', scope: 'global', keywords: ['agent', 'mcp', 'automation', 'playwright', 'drive', 'control', 'webview', 'screenshot', 'click'] },
  { id: 'browserAutomation.allowInteraction', tabId: 'browserAutomation', label: 'Allow Interaction', description: 'Let agents click, type, press keys, and drag in the pane. Turn off for observe-only (screenshots and DOM reads still work).', scope: 'global', keywords: ['click', 'type', 'keypress', 'drag', 'observe', 'read only', 'interact'] },
  { id: 'browserAutomation.allowNavigation', tabId: 'browserAutomation', label: 'Allow Navigation', description: 'Let agents point the pane at other URLs. Turn off to confine agents to the page you have loaded.', scope: 'global', keywords: ['navigate', 'url', 'loadurl', 'goto'] },
  { id: 'browserAutomation.allowEval', tabId: 'browserAutomation', label: 'Allow Eval', description: 'Let agents run arbitrary JavaScript in the loaded page (kangentic_browser_eval). Off by default - this is the one unbounded primitive and runs with the page cookies.', scope: 'global', keywords: ['eval', 'javascript', 'execute', 'runtime', 'arbitrary', 'security'] },
  { id: 'browserAutomation.restrictNavigationToLocalhost', tabId: 'browserAutomation', label: 'Restrict Navigation to Localhost', description: 'Only allow agents to navigate the pane to localhost / private hosts, never public sites. Off by default (any http(s) URL allowed).', scope: 'global', keywords: ['localhost', 'private', 'restrict', 'security', 'navigate', 'lan'] },

  // ── Shortcuts ──
  { id: 'shortcuts', tabId: 'shortcuts', label: 'Shortcuts', description: 'Custom commands accessible from the task detail dialog', scope: 'project', keywords: ['command', 'shortcut', 'tool', 'open', 'launch', 'tortoisegit', 'vscode', 'terminal', 'explorer', 'quick action'] },

  // ── MCP Server ──
  { id: 'mcpServer.enabled', tabId: 'mcpServer', label: 'Kangentic MCP Server', description: 'Give agents tools to interact with your board', scope: 'global', keywords: ['mcp', 'tools', 'create task', 'agent', 'board', 'query', 'session', 'stats'] },

  // ── Behavior > Sessions ──
  { id: 'agent.maxConcurrentSessions', tabId: 'behavior', label: 'Max Concurrent Sessions', description: 'Limit how many agents can run at the same time', scope: 'global', section: 'Sessions', keywords: ['parallel', 'limit'] },
  { id: 'agent.queueOverflow', tabId: 'behavior', label: 'When Max Sessions Reached', description: 'How new agent requests are handled when all slots are in use', scope: 'global', section: 'Sessions', keywords: ['overflow', 'queue', 'reject', 'limit'] },
  { id: 'autoFocusIdleSession', tabId: 'behavior', label: 'Auto-Focus Idle Sessions', description: 'Automatically switch the bottom panel to idle sessions. Idle tabs are always highlighted regardless of this setting.', scope: 'global', section: 'Sessions', keywords: ['switch', 'panel', 'attention'] },
  { id: 'agent.autoResumeSessionsOnRestart', tabId: 'behavior', label: 'Auto-Resume Agents on Restart', description: 'When a project opens, resume any agent sessions that were running at last close. When off, those sessions stay paused until you click Resume on each task. Turn off if resuming many agents at once slows your machine.', scope: 'global', section: 'Sessions', keywords: ['resume', 'restart', 'startup', 'suspend', 'pause', 'stampede', 'auto', 'sessions', 'agents'] },

  // ── Behavior > Board ──
  { id: 'skipBoardConfigConfirm', tabId: 'behavior', label: 'Auto-Apply Board Config Changes', description: 'When a kangentic.json board change is detected (from a teammate or your own pulled-back commit), apply it immediately instead of showing the confirmation dialog.', scope: 'global', section: 'Board', keywords: ['board config', 'kangentic.json', 'reconcile', 'reconciliation', 'apply', 'confirm', 'dialog', 'pull', 'auto'] },

  // ── Behavior > Task Windows ──
  { id: 'windowLightDismiss', tabId: 'behavior', label: 'Close on Outside Click', description: 'Click empty space outside a task window (anything but a button or the terminal panel) to dismiss it. Closing keeps the agent running and hands its terminal back to the panel; reopening the task reattaches.', scope: 'global', section: 'Task Windows', keywords: ['dismiss', 'click outside', 'window', 'peek', 'close', 'light dismiss', 'task window'] },

  // ── Notifications ──
  { id: 'notifications.onAgentIdle', tabId: 'notifications', label: 'Agent Idle', description: 'When an agent needs attention on a non-visible project', scope: 'global', keywords: ['desktop', 'toast', 'alert'] },
  { id: 'notifications.onPlanComplete', tabId: 'notifications', label: 'Plan Complete', description: 'When a plan finishes and the task auto-moves', scope: 'global', keywords: ['desktop', 'toast', 'alert'] },
  { id: 'notifications.onSpawnStalled', tabId: 'notifications', label: 'Spawn Stalled', description: 'When a task spawn waits too long on the git queue while preparing', scope: 'global', keywords: ['desktop', 'toast', 'alert', 'queue', 'fetching', 'worktree', 'preparing'] },
  { id: 'notifications.toasts.durationSeconds', tabId: 'notifications', label: 'Toast Auto-Dismiss', description: 'How long toasts remain visible', scope: 'global', keywords: ['timeout', 'seconds'] },
  { id: 'notifications.toasts.maxCount', tabId: 'notifications', label: 'Max Visible Toasts', description: 'Maximum simultaneous toasts on screen', scope: 'global', keywords: ['limit', 'count'] },

  // ── Hotkeys ──
  { id: 'hotkeys', tabId: 'hotkeys', label: 'Hotkeys', description: 'Rebind keyboard hotkeys', scope: 'global', keywords: ['keyboard', 'hotkey', 'keybind', 'rebind', 'key', 'ctrl', 'cmd', 'shift', 'combo'] },

  // ── Dictation ──
  { id: 'dictation.enabled', tabId: 'dictation', label: 'Voice dictation', description: 'Hold a key to dictate into the focused terminal. On-device by default; choose a Cloud refinement model to use your own endpoint.', scope: 'global', section: 'Transcription', keywords: ['enable', 'off', 'disable', 'on', 'toggle', 'engine', 'streaming', 'live', 'whisper', 'parakeet', 'sherpa', 'remote', 'cloud', 'on-device', 'local', 'model', 'voice', 'dictation', 'speech', 'microphone', 'mic', 'transcribe', 'stt', 'push to talk'] },
  { id: 'dictation.language', tabId: 'dictation', label: 'Language', description: 'The language you speak. The models below adapt to your choice.', scope: 'global', section: 'Transcription', keywords: ['language', 'locale', 'multilingual', 'spanish', 'portuguese', 'french', 'italian', 'german', 'english', 'voice', 'dictation'] },
  { id: 'dictation.punctuation', tabId: 'dictation', label: 'Punctuation and Capitalization', description: 'Add punctuation and capitalization to your dictated text.', scope: 'global', section: 'Transcription', keywords: ['punctuation', 'capitalization', 'casing', 'voice', 'dictation'] },
  { id: 'dictation.autoSubmit', tabId: 'dictation', label: 'Auto-submit', description: 'Press Enter automatically after inserting, or leave the text in the input for you to review and send.', scope: 'global', section: 'Input', keywords: ['send', 'submit', 'enter', 'auto', 'release', 'commit', 'voice', 'dictation'] },
  { id: 'dictation.releaseBufferMs', tabId: 'dictation', label: 'Release buffer', description: 'Keep capturing briefly after release so the last word is not clipped.', scope: 'global', section: 'Input', keywords: ['release', 'buffer', 'tail', 'trailing', 'capture', 'delay', 'grace', 'clip', 'cutoff', 'word', 'voice', 'dictation'] },
  { id: 'dictation.remote', tabId: 'dictation', label: 'Cloud Backend', description: 'OpenAI-compatible /v1/audio/transcriptions endpoint for the final text, used when the Refinement model is set to Cloud. The live preview still streams on-device; only the final clip is sent to this server.', scope: 'global', section: 'Cloud backend', keywords: ['remote', 'cloud', 'openai', 'endpoint', 'api', 'url', 'voice', 'dictation'] },

  // ── Memory (conversation search + recall) ──
  { id: 'memory.indexingEnabled', tabId: 'memory', label: 'Index conversations for search', description: 'Locally index agent conversation transcripts so you can search and recall them. Runs offline with no API key. Turn off to stop indexing and hide conversation search results.', scope: 'global', keywords: ['index', 'conversation', 'transcript', 'search', 'recall', 'memory', 'privacy', 'local', 'offline', 'history'] },
  { id: 'memory.semanticEnabled', tabId: 'memory', label: 'Semantic search', description: 'Match conversations by meaning, not just keywords. Downloads a small local model once, then runs fully offline. Requires conversation indexing.', scope: 'global', keywords: ['semantic', 'smart', 'embedding', 'vector', 'meaning', 'recall', 'search', 'model', 'offline', 'memory', 'download'] },
  { id: 'memory.embeddingModel', tabId: 'memory', label: 'Search quality', description: 'Faster and smaller, or slower and more accurate. The model is downloaded once and runs offline; switching re-indexes in the background.', scope: 'global', keywords: ['embedding', 'model', 'semantic', 'quality', 'size', 'accuracy', 'balanced', 'bge', 'tier', 'download'] },
  { id: 'memory.acceleration', tabId: 'memory', label: 'Hardware acceleration', description: 'Where the semantic model runs. Auto prefers the GPU when available, otherwise CPU.', scope: 'global', keywords: ['gpu', 'cpu', 'hardware', 'acceleration', 'directml', 'webgpu', 'device', 'semantic', 'embedding', 'performance', 'offload'] },
  // ── Privacy (synthetic) ──
  { id: 'privacy.info', tabId: 'privacy', label: 'Privacy', description: 'Anonymous analytics and data collection policy', scope: 'global', keywords: ['telemetry', 'analytics', 'aptabase', 'gdpr', 'opt out'] },

  // ── Developer ──
  { id: 'developer.activityDebugOverlay', tabId: 'developer', label: 'Activity Engine Debug Overlay', description: 'Show a floating panel with live activity-engine state for every running session. Useful for diagnosing spinner / idle bugs.', scope: 'global', keywords: ['debug', 'overlay', 'diagnostic', 'engine', 'activity', 'thinking', 'idle', 'subagent', 'background', 'shell', 'reason'] },

  // ── Mobile Devices ──
  // Dev-only until the mobile app launches: compiled out of production
  // builds (with the tab in AppSettingsPanel and the service gate in
  // register-all.ts / system.ts) so the bridge cannot leak into a release.
  ...(__KANGENTIC_DEV__
    ? ([
        { id: 'mobileBridge.enabled', tabId: 'mobile', label: 'Mobile Bridge', description: 'Let a paired phone connect to this desktop through an end-to-end encrypted relay.', scope: 'global', keywords: ['mobile', 'phone', 'companion', 'pair', 'pairing', 'qr', 'relay', 'bridge', 'remote'] },
        { id: 'mobileBridge.relayUrl', tabId: 'mobile', label: 'Relay Address', description: 'The relay this desktop connects to (self-hosted or Kangentic-hosted). The relay only ever sees encrypted traffic.', scope: 'global', keywords: ['relay', 'server', 'url', 'address', 'self-host', 'websocket', 'mobile'] },
        { id: 'mobileBridge.pairing', tabId: 'mobile', label: 'Pair a Device', description: 'Scan a QR code with the Kangentic mobile app to pair a new phone.', scope: 'global', keywords: ['pair', 'pairing', 'qr', 'scan', 'phone', 'mobile', 'sas', 'code'] },
        { id: 'mobileBridge.devices', tabId: 'mobile', label: 'Paired Devices', description: 'Phones paired to this desktop, their granted capabilities, and revocation.', scope: 'global', keywords: ['paired', 'devices', 'phone', 'revoke', 'capabilities', 'mobile'] },
      ] satisfies SettingDefinition[])
    : []),
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
  dictation: 'Dictation',
  mobile: 'Mobile Devices',
};

/** Helper to get props for a SettingRow from the registry. */
export function settingProps(id: string): { searchId: string; label: string; description: string } {
  const entry = SETTINGS_BY_ID[id];
  if (!entry) throw new Error(`Unknown setting ID: ${id}`);
  return { searchId: entry.id, label: entry.label, description: entry.description };
}
