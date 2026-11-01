import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { NAMED_THEMES } from '../../../shared/types';
import { AUTO_FETCH_INTERVAL_MS, PR_REFRESH_INTERVAL_MS } from '../../../shared/refresh-intervals';
import { translateText } from '../../i18n/translate';
import type { SettingScope } from './setting-scope';
import { SETTINGS_TABS } from './settings-tabs';

/** A cadence in whole minutes, as the copy below names it. */
const minutesOf = (milliseconds: number): number => Math.round(milliseconds / 60_000);

export interface SettingDefinition {
  /**
   * Unique key, normally the config path it writes, e.g. 'terminal.fontSize'.
   * A row that writes the same key under several parents takes the shared
   * part: `notifications.onAgentIdle` is one dropdown writing both
   * `notifications.desktop.onAgentIdle` and `notifications.toasts.onAgentIdle`,
   * and `settings-tab-scope-parity.test.ts` pins each such id to its event key.
   */
  id: string;
  /** Tab this setting belongs to */
  tabId: string;
  /**
   * Display label, a `msg` descriptor (runtime macro), never a string, so a
   * new row cannot ship untranslatable text. Read through `settingProps`,
   * which resolves it.
   */
  label: MessageDescriptor;
  /** Short description */
  description: MessageDescriptor;
  /** Setting scope for panel filtering */
  scope: SettingScope;
  /** Section within the tab (e.g. 'Context Bar') */
  section?: MessageDescriptor;
  /** Extra search keywords not in label/description. English, never translated:
   *  settings search matches them beside the translated text. */
  keywords?: string[];
}

/**
 * The two cadence descriptions name a constant, so each is one plural message
 * with its value carried on the descriptor (the object form of `msg` takes no
 * values of its own).
 */
const AUTO_FETCH_DESCRIPTION: MessageDescriptor = {
  ...msg({ message: '{minutes, plural, one {Fetches every # minute so behind counts stay current; creating a worktree always fetches first.} other {Fetches every # minutes so behind counts stay current; creating a worktree always fetches first.}}' }),
  values: { minutes: minutesOf(AUTO_FETCH_INTERVAL_MS) },
};
const PR_AUTO_REFRESH_DESCRIPTION: MessageDescriptor = {
  ...msg({ message: '{minutes, plural, one {Checks each open PR about every # minute; off, it checks only when you open the project.} other {Checks each open PR about every # minutes; off, it checks only when you open the project.}}' }),
  values: { minutes: minutesOf(PR_REFRESH_INTERVAL_MS) },
};

/** Flat registry array. All settings in display order. */
export const SETTINGS_REGISTRY: SettingDefinition[] = [
  // ── General ──
  { id: 'project.location', tabId: 'general', label: msg`Project location`, description: msg`Folder on disk this project points at. Move it to a new location; all tasks, history, and worktrees move with it.`, scope: 'project', keywords: ['path', 'folder', 'directory', 'move', 'relocate', 'change directory', 'locate'] },

  // ── Theme ──
  { id: 'themeFollowsSystem', tabId: 'theme', label: msg`Follow system appearance`, description: msg`Use one theme when the system is light and another when it is dark.`, scope: 'project', keywords: ['os', 'auto', 'automatic', 'dark mode', 'light mode', 'match'] },
  // Every theme's name is a keyword, so searching "peach" lands on the picker.
  // `dark` and `light` stay as words because no label carries them any more (Graphite, Paper).
  { id: 'theme', tabId: 'theme', label: msg`Theme`, description: msg`Hover a tile to try it on the whole app, click to keep it.`, scope: 'project', keywords: ['color', 'scheme', 'appearance', 'swatch', 'dark', 'light', 'kangentic', ...NAMED_THEMES.map((theme) => theme.label.toLowerCase())] },

  // ── Language ──
  // Saved and applied through a restart (language.setLanguageAndRestart), never a
  // live switch. Keywords stay clear of Dictation's spoken "Language" row.
  { id: 'displayLanguage', tabId: 'language', label: msg`Language`, description: msg`Applies after a restart, and does not change agent output or terminal text.`, scope: 'global', section: msg`Display language`, keywords: ['display language', 'interface', 'translation', 'translate', 'ui language', 'menus', 'restart'] },

  // ── Board ──
  { id: 'columnWidth', tabId: 'board', label: msg`Column width`, description: msg`Width of board columns`, scope: 'global', keywords: ['narrow', 'wide', 'size'] },

  // ── Board > Config sync ──
  { id: 'skipBoardConfigConfirm', tabId: 'board', label: msg`Auto-apply board config changes`, description: msg`Apply a detected kangentic.json change immediately instead of asking to confirm.`, scope: 'global', section: msg`Config sync`, keywords: ['board config', 'kangentic.json', 'reconcile', 'reconciliation', 'apply', 'confirm', 'dialog', 'pull', 'auto'] },

  // ── Board > Board layout ──
  { id: 'terminalPanelVisible', tabId: 'board', label: msg`Terminal panel`, description: msg`Show the terminal panel below the board`, scope: 'global', section: msg`Board layout`, keywords: ['bottom', 'panel', 'hide', 'terminal', 'visible'] },
  { id: 'statusBarVisible', tabId: 'board', label: msg`Status bar`, description: msg`Show the status bar at the bottom of the window`, scope: 'global', section: msg`Board layout`, keywords: ['bottom', 'bar', 'hide', 'visible'] },

  // ── Task ──
  { id: 'cardDensity', tabId: 'task', label: msg`Card density`, description: msg`Amount of detail shown on task cards`, scope: 'global', keywords: ['compact', 'comfortable', 'minimal', 'detailed'] },
  { id: 'cardPreview', tabId: 'task', label: msg`Card preview`, description: msg`What each card shows under its title: the agent's latest message, its recent messages, or the task description.`, scope: 'global', keywords: ['preview', 'messages', 'description', 'trail', 'excerpt', 'agent', 'latest'] },
  { id: 'showTaskNumbers', tabId: 'task', label: msg`Ticket numbers`, description: msg`Show each task's #N number on its card`, scope: 'global', keywords: ['ticket', 'number', 'id', 'display', 'card', 'display_id', 'hash'] },

  // ── Task > Context Bar ──
  { id: 'contextBar.showShell', tabId: 'task', label: msg`Shell name`, description: msg`Detected shell name`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status'] },
  { id: 'contextBar.showVersion', tabId: 'task', label: msg`Version`, description: msg`Agent CLI version`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status'] },
  { id: 'contextBar.showElapsed', tabId: 'task', label: msg`Elapsed time`, description: msg`Ticking session duration`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status', 'duration', 'timer'] },
  // Note: model and effort are intentionally NOT in the registry. Those
  // pills double as the in-place picker triggers, so a "hide" toggle would
  // silently disable a feature, not just declutter chrome. They're a
  // permanent fixture of the context bar.
  { id: 'contextBar.showCost', tabId: 'task', label: msg`Cost`, description: msg`Session API cost`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status', 'price'] },
  { id: 'contextBar.showToolCalls', tabId: 'task', label: msg`Tool calls`, description: msg`Cumulative tool invocations`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status', 'tool', 'invocations'] },
  { id: 'contextBar.showAgentActive', tabId: 'task', label: msg`Agent active`, description: msg`Agent active time`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status', 'active'] },
  { id: 'contextBar.showTokens', tabId: 'task', label: msg`Token counts`, description: msg`Input / output totals`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status'] },
  { id: 'contextBar.showContextFraction', tabId: 'task', label: msg`Context window`, description: msg`Used / total tokens`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status'] },
  { id: 'contextBar.showProgressBar', tabId: 'task', label: msg`Progress bar`, description: msg`Usage bar and percentage`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status'] },
  { id: 'contextBar.showRateLimits', tabId: 'task', label: msg`Rate limits`, description: msg`Claude 5h / weekly quota bars`, scope: 'global', section: msg`Context bar`, keywords: ['context bar', 'status', 'claude', 'quota', 'plan', 'limit', '5h', 'weekly'] },

  // ── Changes ──
  { id: 'diffViewMode', tabId: 'changes', label: msg`Layout`, description: msg`Default layout for Git file diffs in the Changes panel: split (side by side) or inline (unified).`, scope: 'global', keywords: ['diff view', 'split', 'inline', 'side by side', 'side-by-side', 'unified', 'diff', 'changes', 'git', 'review', 'compare'] },
  { id: 'diffDefaultScope', tabId: 'changes', label: msg`Default diff scope`, description: msg`Which changes a freshly opened Changes panel shows: working (uncommitted edits), staged (index), or the full branch vs its base.`, scope: 'global', keywords: ['scope', 'working', 'staged', 'branch', 'uncommitted', 'index', 'diff', 'changes', 'git', 'review'] },
  { id: 'diffIgnoreWhitespace', tabId: 'changes', label: msg`Ignore whitespace`, description: msg`Hide whitespace-only changes in the diff to filter reformatting noise.`, scope: 'global', keywords: ['whitespace', 'trim', 'indent', 'reformat', 'diff', 'changes'] },
  { id: 'diffCollapseUnchanged', tabId: 'changes', label: msg`Collapse unchanged regions`, description: msg`Fold away large unchanged spans so a big file shows only the changed hunks with a little context.`, scope: 'global', keywords: ['collapse', 'fold', 'hide', 'unchanged', 'context', 'hunks', 'diff'] },
  { id: 'diffWrapLines', tabId: 'changes', label: msg`Wrap long lines`, description: msg`Soft-wrap long lines onto the next row instead of scrolling the diff horizontally.`, scope: 'global', keywords: ['wrap', 'word wrap', 'wordwrap', 'soft wrap', 'long lines', 'horizontal', 'scroll', 'diff', 'changes', 'markdown', 'prose'] },
  { id: 'diffUseInlineWhenNarrow', tabId: 'changes', label: msg`Inline when narrow`, description: msg`Render a narrow diff pane inline (unified) even when Side by side is selected, instead of squeezing two columns.`, scope: 'global', keywords: ['inline', 'unified', 'narrow', 'side by side', 'side-by-side', 'split', 'width', 'diff', 'changes'] },
  { id: 'diffFileSort', tabId: 'changes', label: msg`File sort`, description: msg`How the Changes panel orders files: by name, by status (added / modified / deleted), by size (most changes first), or by extension.`, scope: 'global', keywords: ['sort', 'order', 'name', 'status', 'size', 'extension', 'ext', 'files', 'diff', 'changes'] },
  { id: 'diffFlatList', tabId: 'changes', label: msg`Flat file list`, description: msg`Show changed files as a flat list of full paths instead of a nested directory tree.`, scope: 'global', keywords: ['flat', 'list', 'tree', 'directory', 'folder', 'nested', 'files', 'diff', 'changes'] },

  // ── Terminal (global-only; see the doc comments on AppConfig['terminal'] in shared/types.ts) ──
  { id: 'terminal.shell', tabId: 'terminal', label: msg`Shell`, description: msg`Terminal shell used for agent sessions`, scope: 'global', keywords: ['bash', 'powershell', 'zsh', 'fish'] },
  { id: 'terminal.fontSize', tabId: 'terminal', label: msg`Font size`, description: msg`Terminal text size in pixels`, scope: 'global', keywords: ['px', 'text size'] },
  { id: 'terminal.fontFamily', tabId: 'terminal', label: msg`Font family`, description: msg`CSS font-family for the terminal`, scope: 'global', keywords: ['monospace', 'typeface'] },
  { id: 'terminal.cursorStyle', tabId: 'terminal', label: msg`Cursor style`, description: msg`Terminal cursor appearance`, scope: 'global', keywords: ['block', 'underline', 'bar'] },

  // ── Terminal > Colors ──
  { id: 'terminal.colors', tabId: 'terminal', label: msg`Colors`, description: msg`Customize the terminal background, foreground, and cursor color`, scope: 'global', section: msg`Terminal`, keywords: ['colors', 'background', 'foreground', 'cursor', 'custom', 'terminal', 'appearance'] },

  // ── Agent > Project defaults ──
  { id: 'project.defaultAgent', tabId: 'agent', label: msg`Agent`, description: msg`Which agent CLI to use for new sessions`, scope: 'project', section: msg`Project defaults`, keywords: ['agent', 'claude', 'default'] },
  { id: 'project.defaultModel', tabId: 'agent', label: msg`Model`, description: msg`Model used for new sessions when no column or task override is set`, scope: 'project', section: msg`Project defaults`, keywords: ['model', 'opus', 'sonnet', 'default'] },
  { id: 'project.defaultEffort', tabId: 'agent', label: msg`Effort`, description: msg`Reasoning effort used for new sessions when no column or task override is set`, scope: 'project', section: msg`Project defaults`, keywords: ['effort', 'reasoning', 'xhigh', 'default'] },
  { id: 'agent.permissionMode', tabId: 'agent', label: msg`Permissions`, description: msg`How the agent handles tool approvals`, scope: 'project', section: msg`Project defaults`, keywords: ['allowlist', 'bypass', 'approve'] },

  // ── Agent > Agent CLI ──
  { id: 'agent.cliPaths', tabId: 'agent', label: msg`CLI path`, description: msg`This project's path to the agent CLI (auto-detected if empty)`, scope: 'project', section: msg`Agent CLI`, keywords: ['binary', 'executable', 'wsl', 'linux'] },
  // Keywords stay agent-agnostic: these rows render for ANY adapter that
  // declares `remoteExecution`, so naming one agent here would go stale the
  // moment a second one does (agent-adapters-boundary.md).
  { id: 'agent.executionMode', tabId: 'agent', label: msg`Execution`, description: msg`Run this agent locally, or attach to a server you run elsewhere`, scope: 'project', section: msg`Agent CLI`, keywords: ['remote', 'local', 'server', 'attach'] },
  { id: 'agent.executionServerUrl', tabId: 'agent', label: msg`Server URL`, description: msg`Address of the running server (e.g. http://10.0.0.5:4096)`, scope: 'global', section: msg`Agent CLI`, keywords: ['remote', 'url', 'server', 'host'] },
  { id: 'agent.executionServerAuth', tabId: 'agent', label: msg`Authentication`, description: msg`Leave blank if the server does not require credentials`, scope: 'global', section: msg`Agent CLI`, keywords: ['remote', 'auth', 'username', 'password', 'basic', 'optional'] },
  { id: 'agent.executionWorkingDirectory', tabId: 'agent', label: msg`Server working directory`, description: msg`Path on the server for this project's tasks. Leave blank to use the server's own default directory`, scope: 'project', section: msg`Agent CLI`, keywords: ['remote', 'directory', 'path', 'worktree', 'cwd', 'optional'] },
  // One registry entry backs the rows of EVERY adapter that declares
  // `launchOptions`; no agent name appears here, so the row never branches on
  // one (agent-adapters-boundary.md). The concrete per-option label/description
  // is adapter-authored and rendered as-is. The keywords below are seeded from
  // today's sole option (Codex's ChatGPT Apps hang) so users can search for the
  // symptom - revisit and generalize them when a second adapter adds one.
  { id: 'agent.launchOptions', tabId: 'agent', label: msg`Launch options`, description: msg`Optional startup features this agent CLI can turn off`, scope: 'global', section: msg`Agent CLI`, keywords: ['apps', 'feature', 'flag', 'disable', 'startup', 'hang', 'mcp', 'boot', 'connector'] },

  // ── Git ──
  // Card order on the tab: Branches, Worktrees, Pull requests.
  { id: 'git.defaultBaseBranch', tabId: 'git', label: msg`Default base branch`, description: msg`The branch new worktrees start from.`, scope: 'project', keywords: ['main', 'master', 'branches'] },
  { id: 'git.autoFetch', tabId: 'git', label: msg`Auto-fetch remote`, description: AUTO_FETCH_DESCRIPTION, scope: 'project', keywords: ['fetch', 'remote', 'origin', 'behind', 'stale', 'refresh', 'poll', 'branches'] },
  { id: 'git.worktreesEnabled', tabId: 'git', label: msg`Worktrees`, description: msg`Gives tasks the option to run in their own git worktree.`, scope: 'project', keywords: ['branch', 'isolate', 'enable', 'project folder'] },
  { id: 'git.autoCleanup', tabId: 'git', label: msg`Auto-cleanup`, description: msg`Remove a task's worktree when the task completes.`, scope: 'project', keywords: ['remove', 'delete', 'worktree'] },
  { id: 'git.linkNodeModules', tabId: 'git', label: msg`Link node_modules`, description: msg`Symlink the root node_modules into each worktree to skip a fresh install; workspace repos should turn it off.`, scope: 'project', keywords: ['symlink', 'junction', 'deps', 'install', 'node_modules', 'worktree', 'workspace', 'monorepo', 'pnpm'] },
  { id: 'git.copyFiles', tabId: 'git', label: msg`Copy files`, description: msg`Files copied into each new worktree, such as .env.`, scope: 'project', keywords: ['env', 'dotfiles', 'worktree'] },
  { id: 'git.initScript', tabId: 'git', label: msg`Post-worktree script`, description: msg`Runs after a worktree is created. Runs through cmd.exe on Windows, so POSIX-only syntax will not carry over.`, scope: 'project', keywords: ['install', 'setup', 'hook', 'init', 'worktree'] },
  { id: 'git.holdPromptForInitScript', tabId: 'git', label: msg`Hold prompt for script`, description: msg`The agent gets its first prompt once the script succeeds, not at once while the script still runs.`, scope: 'project', keywords: ['init', 'setup', 'post-worktree', 'script', 'install', 'prompt', 'wait', 'agent', 'start', 'faster'] },
  { id: 'git.prAutoRefresh', tabId: 'git', label: msg`Auto-refresh PRs`, description: PR_AUTO_REFRESH_DESCRIPTION, scope: 'project', keywords: ['pull request', 'pr', 'refresh', 'poll', 'merged', 'sync', 'stale', 'mergeable', 'ready', 'conflicts'] },
  { id: 'git.prBypassCountsAsReady', tabId: 'git', label: msg`Count merge bypass as ready`, description: msg`Shows a PR as ready when your admin bypass could merge it past a required review, never past a failing check.`, scope: 'project', keywords: ['github', 'admin', 'bypass', 'review', 'ready', 'blocked', 'behind', 'stale', 'out of date', 'branch protection', 'policy', 'policies', 'azure', 'pull request', 'pr'] },

  // ── Browser ──
  { id: 'browser.enabled', tabId: 'browser', label: msg`Browser pane`, description: msg`Embed a Browser pane in task windows that agents can open.`, scope: 'project', keywords: ['webview', 'embedded', 'preview', 'disable', 'security', 'agent'] },
  { id: 'browser.defaultUrl', tabId: 'browser', label: msg`Default URL`, description: msg`Project default URL when a task has no per-task override. Auto-saved when you first navigate the Browser pane.`, scope: 'project', keywords: ['webview', 'preview', 'localhost', 'dev server', 'url'] },
  { id: 'browser.clearStorage', tabId: 'browser', label: msg`Clear browser data`, description: msg`Wipe cookies, localStorage, IndexedDB, service workers, and HTTP/auth caches for the embedded browser. Saved URLs are kept.`, scope: 'global', keywords: ['cookies', 'cache', 'reset', 'logout', 'sign out', 'storage', 'privacy', 'wipe'] },

  // ── Browser Automation (global policy: agent control of the Browser pane) ──
  { id: 'browserAutomation.enabled', tabId: 'browserAutomation', label: msg`Browser automation`, description: msg`Let agents drive the Browser pane.`, scope: 'global', keywords: ['agent', 'mcp', 'automation', 'playwright', 'drive', 'control', 'webview', 'screenshot', 'click', 'enable', 'kangentic_browser'] },
  { id: 'browserAutomation.allowInteraction', tabId: 'browserAutomation', label: msg`Allow interaction`, description: msg`Click, type and drag. Off is read-only.`, scope: 'global', keywords: ['click', 'type', 'keypress', 'drag', 'observe', 'read only', 'interact'] },
  { id: 'browserAutomation.allowNavigation', tabId: 'browserAutomation', label: msg`Allow navigation`, description: msg`Open other URLs. Off keeps agents on the page you loaded.`, scope: 'global', keywords: ['navigate', 'url', 'loadurl', 'goto'] },
  { id: 'browserAutomation.restrictNavigationToLocalhost', tabId: 'browserAutomation', label: msg`Only localhost`, description: msg`Only localhost and private hosts, never public sites.`, scope: 'global', keywords: ['localhost', 'private', 'restrict', 'security', 'navigate', 'lan'] },
  { id: 'browserAutomation.allowEval', tabId: 'browserAutomation', label: msg`Allow eval`, description: msg`Run any JavaScript in the page, with its cookies.`, scope: 'global', keywords: ['eval', 'javascript', 'execute', 'runtime', 'arbitrary', 'security', 'kangentic_browser_eval'] },

  // ── Shortcuts ──
  { id: 'shortcuts', tabId: 'shortcuts', label: msg`Shortcuts`, description: msg`Custom commands accessible from the task detail dialog`, scope: 'project', keywords: ['command', 'shortcut', 'tool', 'open', 'launch', 'tortoisegit', 'vscode', 'terminal', 'explorer', 'quick action'] },

  // ── MCP Server ──
  { id: 'mcpServer.enabled', tabId: 'mcpServer', label: msg`MCP server`, description: msg`Give agents tools to work with your board.`, scope: 'global', keywords: ['mcp', 'tools', 'create task', 'agent', 'board', 'query', 'session', 'stats', 'kangentic', 'available tools', 'how it works'] },
  { id: 'mcpServer.connection', tabId: 'mcpServer', label: msg`MCP connection`, description: msg`Whether agents can reach the MCP server, here and from any WSL distro a CLI path points into.`, scope: 'global', keywords: ['test connection', 'connected', 'failed', 'reach', 'wsl', 'distro', 'mcp'] },

  // ── Behavior > Sessions ──
  { id: 'agent.maxConcurrentSessions', tabId: 'behavior', label: msg`Max concurrent sessions`, description: msg`Limit how many agents can run at the same time`, scope: 'global', section: msg`Sessions`, keywords: ['parallel', 'limit', 'queue', 'memory'] },
  { id: 'autoFocusIdleSession', tabId: 'behavior', label: msg`Auto-focus idle sessions`, description: msg`Automatically switch the bottom panel to idle sessions. Idle tabs stay highlighted either way.`, scope: 'global', section: msg`Sessions`, keywords: ['switch', 'panel', 'attention'] },
  { id: 'agent.autoResumeSessionsOnRestart', tabId: 'behavior', label: msg`Auto-resume agents on restart`, description: msg`Resume agent sessions that were running when the project last closed. Turn off if resuming many at once slows your machine.`, scope: 'global', section: msg`Sessions`, keywords: ['resume', 'restart', 'startup', 'suspend', 'pause', 'stampede', 'auto', 'sessions', 'agents'] },
  { id: 'stopLeftoverProcesses', tabId: 'behavior', label: msg`Stop leftover processes`, description: msg`Stop what an agent left running in its folder when its task is done, back in To Do, or deleted, or its Command Terminal ends.`, scope: 'global', section: msg`Sessions`, keywords: ['kill', 'background', 'dev server', 'port', 'orphan', 'reap', 'process', 'done', 'cleanup'] },

  // ── Performance ──
  // Graphics acceleration is a plain boolean and never a tri-state: an
  // "automatic" that silently resolved to software would leave the control
  // reading Automatic while acceleration was off. See AppConfig in
  // shared/types.ts and the recovery path in src/main/index.ts.
  { id: 'graphicsAccelerationEnabled', tabId: 'performance', label: msg`Graphics acceleration`, description: msg`Hardware rendering for the app window and terminals.`, scope: 'global', keywords: ['gpu', 'hardware', 'acceleration', 'graphics', 'rendering', 'webgl', 'chromium', 'software', 'driver', 'crash', 'slow'] },
  // Moved here from Board > Window: it toggles `.no-motion` on <html>
  // (config-store.ts), so it was never board chrome.
  { id: 'animationsEnabled', tabId: 'performance', label: msg`Animations`, description: msg`Transition and motion effects.`, scope: 'global', keywords: ['motion', 'reduce', 'transition', 'disable', 'accessibility', 'animation', 'performance'] },

  // ── Performance > Pausing agents ──
  // The labels finish the card's sentence ("Pause agents that are waiting on
  // you... when memory runs low / when idle"). The info tips stay true on every
  // platform: Windows, Linux and macOS each read their own memory signal.
  { id: 'agent.pauseIdleAgentsOnLowMemory', tabId: 'performance', label: msg`When memory runs low`, description: msg`When memory runs low, pause the agent that has waited on you longest, one a minute, until there is room.`, scope: 'global', section: msg`Pausing agents`, keywords: ['memory', 'low', 'pause', 'suspend', 'idle', 'agents', 'ram', 'swap', 'commit', 'pressure', 'out of memory'] },
  { id: 'agent.idleTimeoutEnabled', tabId: 'performance', label: msg`When idle`, description: msg`Pause any agent that has waited on you this many minutes, except one in a Command Terminal.`, scope: 'global', section: msg`Pausing agents`, keywords: ['idle', 'timeout', 'pause', 'suspend', 'agents', 'minutes', 'inactive'] },
  { id: 'agent.idleTimeoutMinutes', tabId: 'performance', label: msg`Minutes idle`, description: msg`How long an agent waits on you before the idle timer pauses it.`, scope: 'global', section: msg`Pausing agents`, keywords: ['idle timeout', 'minutes', 'pause', 'suspend', 'timeout'] },

  // ── Behavior > Windows ──
  { id: 'windowLightDismiss', tabId: 'behavior', label: msg`Close on outside click`, description: msg`Click empty space outside a task window to close it. Controls, task cards, and running terminals still act on the first click. The agent keeps running and reattaches when you reopen the task.`, scope: 'global', section: msg`Windows`, keywords: ['dismiss', 'click outside', 'window', 'peek', 'close', 'light dismiss', 'task window'] },
  { id: 'restoreWindowPosition', tabId: 'behavior', label: msg`Restore window position`, description: msg`Remember window size and position between launches`, scope: 'global', section: msg`Windows`, keywords: ['size', 'bounds', 'remember'] },

  // ── Notifications > Events ──
  { id: 'notifications.onAgentIdle', tabId: 'notifications', label: msg`Agent idle`, description: msg`When an agent finishes its turn, has a question, or needs your approval`, scope: 'global', section: msg`Events`, keywords: ['desktop', 'toast', 'alert'] },
  { id: 'notifications.onAgentCrash', tabId: 'notifications', label: msg`Agent crash`, description: msg`When an agent session ends unexpectedly. Desktop alerts on error exits only; toasts cover clean exits too.`, scope: 'global', section: msg`Events`, keywords: ['desktop', 'toast', 'alert', 'crash', 'exit', 'failed', 'ended'] },
  { id: 'notifications.onPlanComplete', tabId: 'notifications', label: msg`Plan complete`, description: msg`When a plan finishes and the task auto-moves`, scope: 'global', section: msg`Events`, keywords: ['desktop', 'toast', 'alert'] },
  { id: 'notifications.onWorkflowComplete', tabId: 'notifications', label: msg`Workflow complete`, description: msg`When every task in a workflow reaches Done`, scope: 'global', section: msg`Events`, keywords: ['desktop', 'toast', 'alert', 'workflow', 'linked tasks'] },
  { id: 'notifications.onWorkflowStalled', tabId: 'notifications', label: msg`Workflow stalled`, description: msg`When a running workflow cannot move a task on by itself`, scope: 'global', section: msg`Events`, keywords: ['desktop', 'toast', 'alert', 'workflow', 'stuck', 'recovery', 'linked tasks'] },
  { id: 'notifications.onSpawnStalled', tabId: 'notifications', label: msg`Spawn stalled`, description: msg`When a task spawn waits too long on the git queue while preparing`, scope: 'global', section: msg`Events`, keywords: ['desktop', 'toast', 'alert', 'queue', 'fetching', 'worktree', 'preparing'] },

  // ── Notifications > Delivery ──
  { id: 'notifications.toasts.durationSeconds', tabId: 'notifications', label: msg`Toast auto-dismiss`, description: msg`How long toasts remain visible`, scope: 'global', section: msg`Toasts`, keywords: ['timeout', 'seconds'] },
  { id: 'notifications.toasts.maxCount', tabId: 'notifications', label: msg`Max visible toasts`, description: msg`Maximum simultaneous toasts on screen`, scope: 'global', section: msg`Toasts`, keywords: ['limit', 'count'] },

  // ── Hotkeys ──
  { id: 'hotkeys', tabId: 'hotkeys', label: msg`Hotkeys`, description: msg`Rebind keyboard hotkeys`, scope: 'global', keywords: ['keyboard', 'hotkey', 'keybind', 'rebind', 'key', 'ctrl', 'cmd', 'shift', 'combo'] },

  // ── Dictation ──
  { id: 'dictation.enabled', tabId: 'dictation', label: msg`Voice dictation`, description: msg`Hold push-to-talk to speak into a terminal or text field.`, scope: 'global', section: msg`Voice dictation`, keywords: ['enable', 'off', 'disable', 'on', 'toggle', 'engine', 'streaming', 'live', 'whisper', 'parakeet', 'nemotron', 'sherpa', 'preset', 'mode', 'best', 'balanced', 'light', 'fastest', 'accuracy', 'license', 'remote', 'cloud', 'on-device', 'local', 'model', 'voice', 'dictation', 'speech', 'microphone', 'mic', 'transcribe', 'stt', 'push to talk'] },
  { id: 'dictation.language', tabId: 'dictation', label: msg`Language`, description: msg`The language you speak. The models adapt to your choice.`, scope: 'global', section: msg`Transcription`, keywords: ['language', 'locale', 'multilingual', 'spanish', 'portuguese', 'french', 'italian', 'german', 'english', 'voice', 'dictation'] },
  { id: 'dictation.autoSubmit', tabId: 'dictation', label: msg`Auto-submit`, description: msg`Press Enter after inserting, or leave the text for you to review and send.`, scope: 'global', section: msg`Voice dictation`, keywords: ['send', 'submit', 'enter', 'auto', 'release', 'commit', 'voice', 'dictation'] },
  { id: 'dictation.releaseBufferMs', tabId: 'dictation', label: msg`Release buffer`, description: msg`Keep capturing briefly after release so the last word is not clipped.`, scope: 'global', section: msg`Voice dictation`, keywords: ['release', 'buffer', 'tail', 'trailing', 'capture', 'delay', 'grace', 'clip', 'cutoff', 'word', 'voice', 'dictation', 'push to talk'] },
  { id: 'dictation.remote', tabId: 'dictation', label: msg`Cloud endpoint`, description: msg`OpenAI-compatible /v1/audio/transcriptions endpoint for the final text, used when Refinement model is Cloud endpoint. Only the final clip is sent; the live preview stays on this machine.`, scope: 'global', section: msg`Transcription`, keywords: ['remote', 'cloud', 'openai', 'endpoint', 'api', 'url', 'voice', 'dictation', 'refinement', 'custom'] },

  // ── Workflows ──
  { id: 'workflows.agentCard', tabId: 'workflows', label: msg`Workflow agent`, description: msg`Plans each workflow. Nothing starts until one is chosen.`, scope: 'global', keywords: ['workflow', 'agent', 'planner', 'planning', 'plan', 'model', 'effort', 'claude', 'haiku', 'sonnet', 'opus'] },
  { id: 'workflows.agent', tabId: 'workflows', label: msg`Agent`, description: msg`Which agent plans each workflow, in the Workflows view's left pane. No workflow agent starts until one is chosen.`, scope: 'global', section: msg`Workflow agent`, keywords: ['workflow', 'agent', 'planner', 'planning', 'plan', 'claude', 'pane'] },
  { id: 'workflows.model', tabId: 'workflows', label: msg`Model`, description: msg`The model it plans with. Required when the agent takes one.`, scope: 'global', section: msg`Workflow agent`, keywords: ['workflow', 'agent', 'planner', 'model', 'cost', 'tokens', 'haiku', 'sonnet', 'opus'] },
  { id: 'workflows.effort', tabId: 'workflows', label: msg`Effort`, description: msg`Unset runs at the agent's own level.`, scope: 'global', section: msg`Workflow agent`, keywords: ['workflow', 'agent', 'planner', 'effort', 'reasoning', 'speed', 'low', 'high'] },
  { id: 'automation.agentCard', tabId: 'workflows', label: msg`Automation agent`, description: msg`Judges conditions and workflow steps, and names tasks.`, scope: 'global', keywords: ['automation', 'condition', 'check', 'checks', 'workflow', 'step', 'judge', 'agent', 'model', 'turn end', 'only if', 'name', 'title', 'auto-name', 'rename', 'command terminal'] },
  { id: 'automation.agent', tabId: 'workflows', label: msg`Agent`, description: msg`Which agent answers Conditions and names tasks and Command Terminals; nothing runs until one is chosen.`, scope: 'global', section: msg`Automation agent`, keywords: ['automation', 'condition', 'check', 'agent', 'claude', 'codex', 'workflow', 'only if', 'name', 'title', 'auto-name'] },
  { id: 'automation.model', tabId: 'workflows', label: msg`Model`, description: msg`A small, fast model is usually enough to read one reply and answer yes or no.`, scope: 'global', section: msg`Automation agent`, keywords: ['automation', 'condition', 'check', 'model', 'cost', 'cheap', 'haiku', 'sonnet', 'tokens'] },
  { id: 'automation.effort', tabId: 'workflows', label: msg`Effort`, description: msg`Unset runs at the agent's recommended level.`, scope: 'global', section: msg`Automation agent`, keywords: ['automation', 'condition', 'check', 'effort', 'reasoning', 'speed', 'low', 'high'] },
  { id: 'workflows.agentPrompt', tabId: 'workflows', label: msg`Workflow agent prompt`, description: msg`The first message it gets for a new workflow.`, scope: 'global', keywords: ['workflow', 'agent', 'prompt', 'first message', 'planning', 'plan', 'brief', 'template', 'columns', 'instructions'] },

  // ── Knowledge Graph (tab id `knowledgeGraph`; the index, the local model that finds by meaning, the agent that answers) ──
  { id: 'knowledgeGraph.indexingEnabled', tabId: 'knowledgeGraph', label: msg`Index`, description: msg`What Quick Find and the Knowledge Graph search.`, scope: 'global', keywords: ['index', 'conversation', 'conversations', 'transcript', 'tasks', 'commits', 'sources', 'search', 'recall', 'memory', 'privacy', 'local', 'offline', 'history', 'rebuild'] },
  { id: 'knowledgeGraph.enabled', tabId: 'knowledgeGraph', label: msg`Knowledge Graph`, description: msg`Finds your work by meaning and answers questions.`, scope: 'global', keywords: ['knowledge graph', 'graph', 'semantic', 'semantic search', 'smart', 'embedding', 'vector', 'meaning', 'recall', 'search', 'model', 'local model', 'offline', 'memory', 'download', 'ask'] },
  { id: 'knowledgeGraph.localModel', tabId: 'knowledgeGraph', label: msg`Search quality`, description: msg`The local model that finds by meaning and draws the map; changing it re-indexes in the background.`, scope: 'global', section: msg`Knowledge Graph`, keywords: ['embedding', 'model', 'semantic', 'quality', 'size', 'accuracy', 'accurate', 'best', 'light', 'granite', 'bge', 'tier', 'download', 'license'] },
  // "Model acceleration", not "Hardware acceleration": Performance now owns a
  // row called Graphics acceleration, and two settings a user would read as
  // the same thing is worse than one slightly longer label. It stays HERE
  // rather than moving to Performance because "Search quality" above is the
  // other half of the same speed-versus-accuracy decision, and someone
  // troubleshooting a slow Knowledge Graph comes to this tab.
  { id: 'knowledgeGraph.acceleration', tabId: 'knowledgeGraph', label: msg`Model acceleration`, description: msg`Where the local model runs. Auto uses the GPU when there is one.`, scope: 'global', section: msg`Knowledge Graph`, keywords: ['gpu', 'cpu', 'hardware', 'acceleration', 'directml', 'webgpu', 'device', 'semantic', 'embedding', 'performance', 'offload', 'model'] },
  { id: 'knowledgeGraph.agent', tabId: 'knowledgeGraph', label: msg`Agent`, description: msg`Which agent answers your questions and writes the task summaries.`, scope: 'global', section: msg`Knowledge Graph`, keywords: ['answering', 'answer', 'ask', 'agent', 'memory', 'knowledge', 'graph', 'question', 'claude', 'codex', 'recall', 'semantic', 'cite', 'answers', 'summaries'] },
  { id: 'knowledgeGraph.model', tabId: 'knowledgeGraph', label: msg`Model`, description: msg`A small model answers as well and faster, but invents more details in task summaries.`, scope: 'global', section: msg`Knowledge Graph`, keywords: ['answering', 'model', 'answer', 'ask', 'memory', 'knowledge', 'graph', 'cost', 'cheap', 'haiku', 'sonnet', 'opus', 'tokens', 'budget', 'summary', 'summaries'] },
  { id: 'knowledgeGraph.effort', tabId: 'knowledgeGraph', label: msg`Effort`, description: msg`Higher effort answers slower and can help counts across many tasks; summaries always use the agent's default.`, scope: 'global', section: msg`Knowledge Graph`, keywords: ['answering', 'effort', 'reasoning', 'answer', 'ask', 'memory', 'knowledge', 'graph', 'speed', 'fast', 'cost', 'low', 'high'] },
  { id: 'knowledgeGraph.taskSummaries', tabId: 'knowledgeGraph', label: msg`Task summaries`, description: msg`A sentence or two per Done task, so questions find it.`, scope: 'global', section: msg`Index`, keywords: ['summary', 'summaries', 'summarize', 'finished', 'done', 'task', 'memory', 'knowledge', 'graph', 'search', 'cost', 'background'] },
  { id: 'knowledgeGraph.sourceCode', tabId: 'knowledgeGraph', label: msg`Source code`, description: msg`The project's code and docs, so answers can explain it.`, scope: 'global', section: msg`Index`, keywords: ['code', 'source', 'codebase', 'repository', 'files', 'docs', 'branch', 'ask', 'answer', 'knowledge', 'graph', 'embed', 'index'] },
  // ── Privacy (synthetic) ──
  { id: 'privacy.info', tabId: 'privacy', label: msg`Privacy`, description: msg`Anonymous analytics and data collection policy`, scope: 'global', keywords: ['telemetry', 'analytics', 'aptabase', 'gdpr', 'opt out', 'knowledge graph', 'agent'] },

  // ── Developer ──
  { id: 'developer.activityDebugOverlay', tabId: 'developer', label: msg`Activity engine debug overlay`, description: msg`A floating panel of each session's activity state and last transitions, also written to .kangentic/debug.`, scope: 'global', keywords: ['debug', 'overlay', 'diagnostic', 'engine', 'activity', 'thinking', 'idle', 'subagent', 'background', 'shell', 'reason', 'spinner'] },
  { id: 'developer.persistConsoleLogs', tabId: 'developer', label: msg`Persistent console logs`, description: msg`Also saves info, debug and log output to .kangentic/logs, beside the errors and warnings always kept.`, scope: 'global', keywords: ['console', 'logs', 'log', 'debug', 'info', 'ndjson', 'diagnostic', 'tail', 'persist'] },
  // Synthetic: crash capture is always on, so there is no config key behind it.
  { id: 'developer.crashReports', tabId: 'developer', label: msg`Crash reports`, description: msg`Every crash writes a record with its source-mapped stack to .kangentic/logs/crashes; it is always on.`, scope: 'global', keywords: ['crash', 'exception', 'rejection', 'stack', 'gpu', 'renderer', 'preload', 'diagnostic', 'error'] },
  { id: 'developer.recordIpcTraffic', tabId: 'developer', label: msg`Record IPC traffic`, description: msg`Logs each IPC call to .kangentic/logs with mutating channels redacted; on by default only in /preview.`, scope: 'global', keywords: ['ipc', 'traffic', 'record', 'channel', 'log', 'diagnostic', 'preview', 'redact'] },
  // The dev-only cards (src/devtools/renderer/DevToolsSections.tsx). Gated like
  // the cards, so a production build never finds a row it does not render.
  ...(__KANGENTIC_DEV__ ? ([
    { id: 'developer.previewInspectionServer', tabId: 'developer', label: msg`Inspection bridge`, description: msg`Serves screenshots, input, DOM and state queries to the devtools MCP tools, on a localhost port with no auth.`, scope: 'global', section: msg`Dev inspection bridge`, keywords: ['inspection', 'bridge', 'devtools', 'mcp', 'screenshot', 'dom', 'react', 'preview', 'localhost'] },
    { id: 'developer.previewEvalEnabled', tabId: 'developer', label: msg`Allow unsafe operations`, description: msg`Lets the devtools tools run JavaScript in the renderer, inject activity events and send raw terminal input.`, scope: 'global', section: msg`Dev inspection bridge`, keywords: ['eval', 'unsafe', 'javascript', 'inject', 'event', 'pty', 'input', 'devtools', 'stress'] },
    { id: 'developer.stallProfiler', tabId: 'developer', label: msg`Stall profiler`, description: msg`Profiles the main process and names a stall's heaviest functions in the event-loop report; costs CPU while on.`, scope: 'global', section: msg`Dev inspection bridge`, keywords: ['stall', 'profiler', 'profile', 'event loop', 'lag', 'cpu', 'main process', 'jank'] },
    // Synthetic: the Dev triggers card holds buttons, not settings.
    { id: 'developer.devTriggers', tabId: 'developer', label: msg`Dev triggers`, description: msg`Open the surfaces a dev session cannot reach on its own.`, scope: 'global', keywords: ['trigger', 'release notes', 'modal', 'whats new', 'announcements', 'feed', 'onboarding', 'checklist', 'dev'] },
  ] satisfies SettingDefinition[]) : []),

  // ── Mobile Devices ──
  { id: 'mobileBridge.enabled', tabId: 'mobile', label: msg`Mobile bridge`, description: msg`Connect a phone over an end-to-end encrypted relay.`, scope: 'global', keywords: ['mobile', 'phone', 'companion', 'pair', 'pairing', 'qr', 'relay', 'bridge', 'remote'] },
  // 'cloud' and 'kangentic cloud' are deliberate back-compat aliases, not
  // stray cruft: the hosted preset was labelled "Kangentic Cloud", then
  // "Kangentic Relay", and now "Kangentic" under the Relay card. Settings search
  // indexes registry fields only (never the rendered option labels), so these
  // keywords are the only thing that still finds this row for a user searching
  // from muscle memory.
  { id: 'mobileBridge.relayMode', tabId: 'mobile', label: msg`Relay`, description: msg`Forwards encrypted traffic and never holds your keys.`, scope: 'global', keywords: ['relay', 'server', 'hosted', 'local', 'custom', 'self-host', 'official', 'mobile', 'kangentic relay', 'cloud', 'kangentic cloud'] },
  // Search-index only: this row has no settings row of its own. The relay address
  // is an unlabelled field inside the Relay section (the picker directly above it
  // says which relay it addresses), so this entry exists to put "websocket",
  // "self-host", and "address" into the index. MobileDevicesTab's RELAY_SEARCH_IDS
  // lists it beside mobileBridge.relayMode, and a match on either reveals the
  // whole section. Do not go looking for its settingProps() call site.
  { id: 'mobileBridge.relayUrl', tabId: 'mobile', label: msg`Custom relay address`, description: msg`The self-hosted relay to dial when Relay is set to Custom.`, scope: 'global', keywords: ['relay', 'server', 'url', 'address', 'self-host', 'websocket', 'mobile', 'custom'] },
  { id: 'mobileBridge.pairing', tabId: 'mobile', label: msg`Pair a device`, description: msg`Scan a QR code with the Kangentic mobile app to pair a new phone.`, scope: 'global', keywords: ['pair', 'pairing', 'qr', 'scan', 'phone', 'mobile', 'sas', 'code'] },
  { id: 'mobileBridge.devices', tabId: 'mobile', label: msg`Phones`, description: msg`Phones paired to this desktop, identified by key fingerprint.`, scope: 'global', keywords: ['paired', 'devices', 'phone', 'revoke', 'rename', 'fingerprint', 'mobile'] },
  { id: 'mobileBridge.getApp', tabId: 'mobile', label: msg`Kangentic Mobile`, description: msg`The phone companion app for checking on agents, answering prompts, and reviewing diffs. Links out to its docs, where the install instructions live.`, scope: 'global', keywords: ['install', 'download', 'get the app', 'app', 'mobile', 'phone', 'android', 'ios', 'docs', 'play', 'store'] },
];

/** Lookup by ID for O(1) access. */
export const SETTINGS_BY_ID: Record<string, SettingDefinition> = Object.fromEntries(
  SETTINGS_REGISTRY.map((setting) => [setting.id, setting]),
);

/**
 * Allowlist of `scope: 'global'` settings deliberately kept inside a
 * `category: 'project'` tab (see .claude/rules/settings-tab-scope.md). Each
 * is unreachable with no project open; that is accepted only when the
 * setting is genuinely project-contextual and moving it would need a
 * duplicate picker in a second tab. Enforced by
 * tests/unit/settings-tab-scope-parity.test.ts: a new global landing in a
 * project tab fails until it is either moved or added here with a reason.
 */
export const PROJECT_TAB_GLOBALS: Record<string, string> = {
  'agent.launchOptions': 'Per-agent startup toggles, rendered only for the project\'s selected agent when it declares the capability.',
  'agent.executionServerUrl': 'Per-agent remote-execution server address, edited inline in the Agent tab\'s Execution block for the selected agent.',
  'agent.executionServerAuth': 'Per-agent remote-execution credentials, edited alongside executionServerUrl.',
  'browser.clearStorage': 'Wipes the embedded Browser pane\'s data; kept next to the pane it clears rather than a general system tab.',
};

/**
 * Tab label lookup for search matching against tab names. Derived from
 * SETTINGS_TABS rather than repeated, so the search and the sidebar always read
 * one message per tab. settings-tab-scope-parity.test.ts still checks every tab
 * has one.
 */
export const TAB_LABELS: Record<string, MessageDescriptor> = Object.fromEntries(
  SETTINGS_TABS.map((tab) => [tab.id, tab.label]),
);

/**
 * A registry entry as props for a `SettingsCard` or a card row (`CardRow`,
 * `CardToggleRow`, `CardChoiceRow`), with its text in the session's language.
 * Call it while rendering, never at module load, so it reads the active catalog.
 */
export function settingProps(id: string): { searchId: string; label: string; description: string } {
  const entry = SETTINGS_BY_ID[id];
  if (!entry) throw new Error(`Unknown setting ID: ${id}`);
  return { searchId: entry.id, label: translateText(entry.label), description: translateText(entry.description) };
}
