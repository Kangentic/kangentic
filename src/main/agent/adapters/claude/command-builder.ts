import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { interpolateTemplate } from '../../shared/template-utils';
import { buildHooks } from './hook-manager';
import type { ClaudeHookEntry } from './hook-manager';
import type { CommandOptions } from '../../agent-adapter';

/**
 * Coarse seconds for the statusLine `refreshInterval`. Claude only runs the
 * statusLine command on event-driven triggers (after an assistant message,
 * /compact, permission-mode change, vim toggle - never at session start), so a
 * background / idle session can go a long time without writing status.json and
 * the board card never learns the live model + context %. `refreshInterval`
 * re-runs the command on a fixed timer regardless, which keeps status.json
 * flowing for unopened cards. Kept coarse (not the 1s minimum) on purpose: the
 * card already shows a correct model/agent placeholder instantly (see
 * TaskCard), so this only backfills the slow-moving live numbers; one node
 * bridge spawn per session per interval is plenty. Docs:
 * https://code.claude.com/docs/en/statusline (units are seconds, min 1).
 */
const STATUS_LINE_REFRESH_INTERVAL_SECONDS = 10;

/**
 * Allow rule injected into every spawned session's merged settings whenever
 * the kangentic MCP server is attached. The bare server-scope form
 * pre-approves every mcp__kangentic__* tool so agents Kangentic spawns never
 * see a permission prompt for Kangentic's own in-process tools in default /
 * acceptEdits mode, regardless of the project's committed settings.
 *
 * Allow rules cover default mode only. Plan mode does NOT honor allow rules;
 * plan-mode auto-approval of the read-only tools comes from their
 * `readOnlyHint` annotations (see src/main/agent/mcp-http/annotations.ts).
 */
const KANGENTIC_MCP_ALLOW_RULE = 'mcp__kangentic';

/** Subset of Claude Code settings.json that we read/write. */
interface ClaudeSettings {
  statusLine?: { type: string; command: string; refreshInterval?: number };
  hooks?: Record<string, ClaudeHookEntry[]>;
  permissions?: { allow?: string[]; deny?: string[] };
  [key: string]: unknown; // preserve unknown keys from user's settings
}

/**
 * Merge hook arrays per event type. Local hooks come after project hooks;
 * Kangentic hooks are appended last by the caller.
 */
function mergeHookArrays(
  base: Record<string, ClaudeHookEntry[]> | undefined,
  overlay: Record<string, ClaudeHookEntry[]> | undefined,
): Record<string, ClaudeHookEntry[]> {
  if (!base && !overlay) return {};
  if (!base) return { ...overlay! };
  if (!overlay) return { ...base };

  const merged: Record<string, ClaudeHookEntry[]> = { ...base };
  for (const [event, entries] of Object.entries(overlay)) {
    merged[event] = [...(merged[event] || []), ...entries];
  }
  return merged;
}

/** Deep-merge permissions: deduplicate allow/deny arrays. */
function mergePermissions(
  base: { allow?: string[]; deny?: string[] } | undefined,
  overlay: { allow?: string[]; deny?: string[] } | undefined,
): { allow: string[]; deny: string[] } | undefined {
  if (!base && !overlay) return undefined;
  const allow = [...new Set([...(base?.allow || []), ...(overlay?.allow || [])])];
  const deny = [...new Set([...(base?.deny || []), ...(overlay?.deny || [])])];
  return { allow, deny };
}

export class CommandBuilder {
  /** Cache of merged base settings (project + local) keyed by project root path. */
  private projectSettingsCache = new Map<string, ClaudeSettings>();

  /** Path to session mcp.json written by createMergedSettings(), consumed by buildClaudeCommand(). */
  private lastMcpConfigPath: string | null = null;

  /** Clear the cached project settings (e.g., when settings files change). */
  clearSettingsCache(): void {
    this.projectSettingsCache.clear();
  }

  /**
   * Whether the user has explicitly chosen a Claude TUI renderer in their global
   * `~/.claude/settings.json` (where Claude's `/tui` command persists the `tui`
   * setting). When they have, Kangentic must NOT inject its own `tui` default -
   * `--settings` would override the user's choice. Read fresh each spawn (small
   * file, infrequent) so a `/tui` change is honored on the next session.
   */
  private userHasGlobalTuiPreference(): boolean {
    try {
      const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const parsedGlobalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8')) as Record<string, unknown>;
      // Treat `tui: null` (a reset sentinel, or a hand-edited file) the same as an
      // absent key: null is not a renderer choice, so Kangentic should still inject
      // its fullscreen default rather than leave Claude on the classic renderer.
      return parsedGlobalSettings.tui !== undefined && parsedGlobalSettings.tui !== null;
    } catch {
      // No global settings file, or unreadable/invalid -> user has not chosen.
      return false;
    }
  }

  buildClaudeCommand(options: CommandOptions): string {
    const { shell } = options;
    const parts = [quoteArg(options.cliPath, shell)];

    // Build the --settings path. When statusOutputPath is provided we always
    // create a merged settings file that includes the statusLine config so
    // Claude Code pipes usage data to our bridge script.
    const mergedSettingsPath = options.statusOutputPath
      ? this.createMergedSettings(options)
      : null;

    // Permission mode flags
    switch (options.permissionMode) {
      case 'bypassPermissions':
        parts.push('--dangerously-skip-permissions');
        break;
      case 'plan':
        parts.push('--permission-mode', 'plan');
        break;
      case 'acceptEdits':
        parts.push('--permission-mode', 'acceptEdits');
        break;
      case 'dontAsk':
        parts.push('--permission-mode', 'dontAsk');
        break;
      case 'auto':
        parts.push('--permission-mode', 'auto');
        break;
      case 'default':
        break;
    }

    // --settings flag: all sessions (main repo and worktree) use a merged
    // settings file in the session directory
    if (mergedSettingsPath) {
      parts.push('--settings', quoteArg(toForwardSlash(mergedSettingsPath), shell));
    }

    // --mcp-config: deliver kangentic MCP server without modifying .mcp.json.
    // The config file lives in the session directory, written by createMergedSettings().
    // We do NOT use --strict-mcp-config because that would block the user's own
    // servers (e.g. context7) configured in .mcp.json.
    if (this.lastMcpConfigPath) {
      parts.push('--mcp-config', quoteArg(toForwardSlash(this.lastMcpConfigPath), shell));
      this.lastMcpConfigPath = null;
    }

    // Session: --resume for existing conversations, --session-id for new ones
    if (options.sessionId) {
      const flag = options.resume ? '--resume' : '--session-id';
      parts.push(flag, quoteArg(options.sessionId, shell));
    }

    // Per-column model and effort overrides. Both flags are session-scoped:
    // Claude does not persist them, so they are applied on every spawn (fresh
    // and resumed) until the column setting changes.
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }
    if (options.effort && options.effort.trim().length > 0) {
      parts.push('--effort', quoteArg(options.effort.trim(), shell));
    }

    // Non-interactive mode (print and exit) vs interactive
    if (options.nonInteractive) {
      parts.push('--print');
    }

    // The prompt as positional argument (omitted for resumed sessions)
    if (options.prompt) {
      // For double-quoted shells (PowerShell, cmd), replace double quotes
      // with single quotes to prevent quoting breakage: quoteArg wraps in
      // "..." and escapes " as \" which PowerShell misinterprets.
      // For single-quoted shells (bash, zsh, WSL), double quotes inside
      // single-quoted strings are preserved literally - no replacement needed.
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      // -- (end-of-options) prevents content like -> or --flag from being
      // parsed as CLI options regardless of shell quoting behavior.
      // multiline: true preserves newlines in the <task> XML envelope.
      parts.push('--', quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, vars: Record<string, string>): string {
    return interpolateTemplate(template, vars);
  }

  /** Read and merge project + local settings, with per-projectRoot caching. */
  private readBaseSettings(projectRoot: string): ClaudeSettings {
    const cached = this.projectSettingsCache.get(projectRoot);
    if (cached) return structuredClone(cached);

    // 1. Read project settings (committed, shared)
    let baseSettings: ClaudeSettings = {};
    const projectSettingsPath = path.join(projectRoot, '.claude', 'settings.json');
    try {
      const raw = fs.readFileSync(projectSettingsPath, 'utf-8');
      baseSettings = JSON.parse(raw);
    } catch {
      // No existing settings - start fresh
    }

    // 2. Deep-merge local settings from project root (gitignored, personal)
    const localSettingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
    try {
      const raw = fs.readFileSync(localSettingsPath, 'utf-8');
      const localSettings: ClaudeSettings = JSON.parse(raw);
      const { hooks: localHooks, permissions: localPerms, ...localRest } = localSettings;
      const mergedPerms = mergePermissions(baseSettings.permissions, localPerms);
      baseSettings = {
        ...baseSettings,
        ...localRest,
        hooks: mergeHookArrays(baseSettings.hooks, localHooks),
        ...(mergedPerms ? { permissions: mergedPerms } : {}),
      };
    } catch {
      // No local settings
    }

    this.projectSettingsCache.set(projectRoot, baseSettings);
    return structuredClone(baseSettings);
  }

  /**
   * Create a merged Claude settings file that includes the statusLine config
   * and event-bridge hooks. Deep-merges project + local settings (cached),
   * injects our hooks, and writes to the session directory.
   *
   * All sessions (main repo and worktree) use `--settings` pointing to
   * `.kangentic/sessions/<sessionId>/settings.json`. For worktrees, we also
   * read the worktree's `.claude/settings.local.json` to capture "always
   * allow" permission grants written by Claude during the session.
   */
  private createMergedSettings(options: CommandOptions): string {
    const isWorktree = options.projectRoot != null && options.cwd !== options.projectRoot;
    const projectRoot = options.projectRoot || options.cwd;

    let baseSettings = this.readBaseSettings(projectRoot);

    // 3. For worktrees: merge permissions from the worktree's settings.local.json.
    //    Claude writes "always allow" grants here during sessions. Without reading
    //    this on resume, grants would be lost since --settings (CLI precedence)
    //    overrides the local layer. We only merge permissions, not hooks (which
    //    are either empty or stale leftovers from before this unified approach).
    if (isWorktree) {
      const wtLocalPath = path.join(options.cwd, '.claude', 'settings.local.json');
      try {
        const raw = fs.readFileSync(wtLocalPath, 'utf-8');
        const wtLocal: ClaudeSettings = JSON.parse(raw);
        const wtPerms = wtLocal.permissions;
        if (wtPerms) {
          const mergedPerms = mergePermissions(baseSettings.permissions, wtPerms);
          if (mergedPerms) {
            baseSettings = { ...baseSettings, permissions: mergedPerms };
          }
        }
      } catch {
        // No worktree local settings (first run or no grants yet)
      }
    }

    // Resolve bridge scripts. In production, bridge scripts are copied next
    // to the main bundle by scripts/build.js. In dev (esbuild watch),
    // __dirname is .vite/build/ so we fall back to the source tree.
    const statusBridge = toForwardSlash(resolveBridgeScript('status-bridge'));
    const statusPath = toForwardSlash(options.statusOutputPath!);

    const merged: ClaudeSettings = {
      ...baseSettings,
      statusLine: {
        type: 'command',
        command: `node "${statusBridge}" "${statusPath}"`,
        refreshInterval: STATUS_LINE_REFRESH_INTERVAL_SECONDS,
      },
    };

    // Merge event-bridge hooks (preserve existing user hooks)
    const eventsPath = options.eventsOutputPath ? toForwardSlash(options.eventsOutputPath) : null;
    if (eventsPath) {
      const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
      merged.hooks = buildHooks(eventBridge, eventsPath, baseSettings.hooks || {});
    }

    // Default Claude's TUI renderer to fullscreen (alt-screen) for the embedded
    // experience. The classic main-screen renderer re-emits its WHOLE frame into
    // the normal-buffer scrollback on every resize, which piles up duplicate
    // banners in an embedded xterm and flickers on resize. The alt-screen renderer
    // - which Claude's own docs recommend for embedded terminal wrappers - has no
    // scrollback accumulation and no resize flicker. We only set this when the user
    // has NOT chosen a renderer themselves: `merged.tui` already carries any
    // project-level choice, and `userHasGlobalTuiPreference()` covers their global
    // ~/.claude/settings.json (where `/tui` persists). `--settings` outranks both,
    // so gating on both keeps Claude's native `/tui` control authoritative.
    if (merged.tui === undefined && !this.userHasGlobalTuiPreference()) {
      merged.tui = 'fullscreen';
    }

    // Session directory (used for the merged Claude settings file).
    // Derived from statusOutputPath which is required by every spawn path
    // (transition-engine, session-startup, transient-sessions), so the
    // `!` is safe.
    const sessionDir = path.dirname(options.statusOutputPath!);

    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      console.error(`[spawn_agent] Failed to create session directory: ${sessionDir}`, err);
      throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`);
    }

    // Write the per-session MCP config pointing at the in-process HTTP
    // MCP server hosted by Kangentic main. The URL contains the project
    // ID so the server resolves the right CommandContext per request;
    // the X-Kangentic-Token header gates access. The token is rotated
    // on every Kangentic launch, so a stale mcp.json from a previous
    // run can't be reused.
    if (options.mcpServerEnabled !== false && options.mcpServerUrl && options.mcpServerToken) {
      const mcpConfig = {
        mcpServers: {
          kangentic: {
            type: 'http' as const,
            url: options.mcpServerUrl,
            headers: { 'X-Kangentic-Token': options.mcpServerToken },
          },
        },
      };
      const mcpConfigPath = path.join(sessionDir, 'mcp.json');
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      this.lastMcpConfigPath = mcpConfigPath;

      // Pre-approve kangentic's own tools so a spawned agent never sees a
      // permission prompt for them in default / acceptEdits mode. Gated on
      // the SAME condition as the mcp.json write above (server actually
      // attached), so the rule is never injected when the server is absent.
      // This lives only in the per-session merged settings, which are
      // regenerated from base sources on every spawn and resume, never
      // written back to the user's own settings files. Append-if-absent so a
      // committed project rule or a Claude "always allow" grant merged
      // earlier is not duplicated. `deny` is untouched: an explicit user deny
      // of mcp__kangentic still wins (Claude Code deny outranks allow).
      const permissions = merged.permissions ?? {};
      const allowEntries = permissions.allow ?? [];
      if (!allowEntries.includes(KANGENTIC_MCP_ALLOW_RULE)) {
        merged.permissions = { ...permissions, allow: [...allowEntries, KANGENTIC_MCP_ALLOW_RULE] };
      }
    }

    // Write merged settings to <sessionDir>/settings.json (used with --settings flag)
    const mergedPath = path.join(sessionDir, 'settings.json');
    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));

    return mergedPath;
  }
}
