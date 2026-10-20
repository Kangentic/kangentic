import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { interpolateTemplate } from '../../shared/template-utils';
import { toClaudeModelArgument } from './model-display-name';
import { peekModelPickerAliasIds } from './model-picker-probe';
import { buildHooks, CLAUDE_BRIDGE_SHELL, CLAUDE_PLAN_APPROVAL_SPEC } from './hook-manager';
import type { ClaudeHookEntry } from './hook-manager';
import { buildPlanApprovalCommand, planApprovalDecisionPath } from '../../shared/plan-approval-hook';
import { quoteBridgePath } from '../../shared/hook-utils';
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
 * Allow rules cover default/acceptEdits mode only. Plan mode does NOT honor
 * allow rules; plan-mode auto-approval of the read-only tools comes from
 * their `readOnlyHint` annotations (see src/main/agent/mcp-http/annotations.ts).
 *
 * `--permission-mode auto` ALSO does not honor this list: auto mode runs an
 * entirely separate natural-language classifier (`autoMode.allow` /
 * `soft_deny` / `hard_deny`, evaluated against a policy description, not a
 * tool-name match - see https://code.claude.com/docs/en/auto-mode-config).
 * Without an explicit `autoMode.allow` entry, a mutating kangentic tool
 * (e.g. kangentic_move_task) falls through to the classifier's built-in
 * defaults, which do not know Kangentic's own board tools are safe, and can
 * soft-deny them - surfacing as a rejected tool call with nobody present in
 * a headless, board-driven session to answer the resulting prompt. See
 * KANGENTIC_AUTO_MODE_ALLOW_RULE below.
 */
const KANGENTIC_MCP_ALLOW_RULE = 'mcp__kangentic';

/**
 * The built-in tools a read-only launch keeps: reading and searching files,
 * nothing that writes or runs. ToolSearch too, since Claude defers MCP tools
 * behind it: without it the agent sees Kangentic's tools listed and every call
 * fails "No such tool available" (measured on the workflow agent's first save).
 */
const READ_ONLY_TOOLS = 'Read,Grep,Glob,ToolSearch';

/**
 * Auto-mode classifier allow rule for Kangentic's own MCP tools (see the
 * KANGENTIC_MCP_ALLOW_RULE comment above for why this is needed separately
 * from `permissions.allow`). Natural language, not a tool-name pattern - this
 * is what the auto-mode classifier itself expects.
 */
const KANGENTIC_AUTO_MODE_ALLOW_RULE =
  "Kangentic's own board and session tools (mcp__kangentic__*) are always allowed: they only read or mutate this local Kanban board's own state (tasks, columns, sessions) inside a project the user has already opened in Kangentic, never external systems or files outside the project.";

/** Subset of Claude Code settings.json that we read/write. */
interface ClaudeSettings {
  statusLine?: { type: string; command: string; refreshInterval?: number };
  hooks?: Record<string, ClaudeHookEntry[]>;
  permissions?: { allow?: string[]; deny?: string[] };
  autoMode?: { environment?: string[]; allow?: string[]; soft_deny?: string[]; hard_deny?: string[] };
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
   * The Claude TUI renderer the user chose in their global
   * `~/.claude/settings.json` (where Claude's `/tui` command persists the `tui`
   * setting), or null when they have not chosen. Read fresh each spawn (small
   * file, infrequent) so a `/tui` change is honored on the next session.
   */
  private globalTuiChoice(): unknown {
    try {
      const globalSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const parsedGlobalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8')) as Record<string, unknown>;
      // Treat `tui: null` (a reset sentinel, or a hand-edited file) the same as an
      // absent key: null is not a renderer choice.
      return parsedGlobalSettings.tui ?? null;
    } catch {
      // No global settings file, or unreadable/invalid -> user has not chosen.
      return null;
    }
  }

  /**
   * Whether Kangentic turns Claude's fullscreen renderer on for this spawn:
   * when neither the project's settings nor the user's own name a renderer, or
   * they name fullscreen. The `tui` setting takes `"default"` or
   * `"fullscreen"` (settings reference); any value but fullscreen is the
   * user's and is left alone. The classic main-screen renderer re-emits its
   * WHOLE frame into the normal-buffer scrollback on every resize, which piles
   * up duplicate banners in an embedded xterm and flickers on resize; the
   * alt-screen renderer, which Claude's own docs recommend for embedded
   * terminal wrappers, does neither.
   *
   * It is turned on with `CLAUDE_CODE_NO_FLICKER=1` (`rendererEnvironment`),
   * not with `tui: "fullscreen"` in `--settings`. Claude's docs make that
   * variable the per-session override of `tui` (settings reference, `tui`,
   * "Per-session overrides"), and say a session started with it "renders
   * fullscreen even after a failed start, and doesn't count it" (fullscreen
   * docs, "How Claude Code counts failed starts"). Measured on 2.1.302 and
   * 2.1.303 (`scripts/probe-claude-exit-paths.js --renderer no-flicker`), such
   * a session drew in the alt screen and never wrote a `fullscreenBootPending`
   * record. So no way a Kangentic session can die (a kill, a crash, a lost pty
   * host, an OS kill) can count against the renderer: two such deaths had
   * turned fullscreen off for the whole machine, the user's own terminals
   * included.
   *
   * The variable outranks the setting, a `tui: "default"` included (measured
   * on 2.1.303), which is why it is set only when no other renderer was chosen.
   */
  fullscreenByDefault(options: Pick<CommandOptions, 'cwd' | 'projectRoot'>): boolean {
    const projectChoice = this.cachedBaseSettings(options.projectRoot || options.cwd).tui;
    const choice = projectChoice === undefined || projectChoice === null ? this.globalTuiChoice() : projectChoice;
    return choice === null || choice === 'fullscreen';
  }

  /**
   * The renderer variables this spawn carries, or null.
   *
   * A user's own `CLAUDE_CODE_NO_FLICKER` or `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`
   * comes first: Claude's docs rank both above the `tui` setting, and
   * `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` above `CLAUDE_CODE_NO_FLICKER`.
   * Measured on 2.1.303: `CLAUDE_CODE_NO_FLICKER=0` beat `tui: "fullscreen"`,
   * and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` beat
   * `CLAUDE_CODE_NO_FLICKER=1`, both drawing classic. The spawn environment strips every inherited
   * `CLAUDE_CODE_*` key, so they are passed on here, explicitly, as the user
   * set them. Not when Kangentic itself runs inside a Claude session
   * (`CLAUDECODE` set, a dev build started from an agent's tool shell): those
   * values are the parent session's, and every Kangentic Claude session
   * carries `CLAUDE_CODE_NO_FLICKER=1`. Otherwise the default above applies.
   */
  rendererEnvironment(
    options: Pick<CommandOptions, 'cwd' | 'projectRoot'>,
    environment: NodeJS.ProcessEnv = process.env,
  ): Record<string, string> | null {
    if (environment.CLAUDECODE === undefined) {
      const usersOwn: Record<string, string> = {};
      for (const key of ['CLAUDE_CODE_NO_FLICKER', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']) {
        const value = environment[key];
        if (value !== undefined && value !== '') usersOwn[key] = value;
      }
      if (Object.keys(usersOwn).length > 0) return usersOwn;
    }
    return this.fullscreenByDefault(options) ? { CLAUDE_CODE_NO_FLICKER: '1' } : null;
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
    // Bypass available, not on: a plan hook's setMode reaches bypassPermissions
    // only in a session launched like this (probed on 2.1.302).
    if (options.bypassAvailable && options.permissionMode !== 'bypassPermissions') {
      parts.push('--allow-dangerously-skip-permissions');
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

    // A read-only launch (a workflow's own agent). `--tools` limits the built-in
    // tools in an interactive session too, and named, since on macOS and Linux
    // the default set leaves out Glob and Grep; MCP tools are untouched by it.
    // `--strict-mcp-config` then makes Kangentic's server the only one, which
    // here is the WANTED blocking of the user's own servers: any of them may
    // write. It does not reach Claude in Chrome, a built-in server that drives
    // the user's browser, so `--no-chrome` turns that off (measured: without it
    // a read-only launch still listed some 20 browser tools). What Kangentic's
    // server offers this caller is limited on its side
    // (`buildWorkflowAgentMcpServer`), so the server is the guarantee and these
    // flags are the second lock.
    if (options.readOnly) {
      parts.push('--tools', quoteArg(READ_ONLY_TOOLS, shell), '--strict-mcp-config', '--no-chrome');
    }
    // Other checkouts the agent may read with no permission prompt (a workflow
    // agent's other projects). One flag per directory: `--add-dir` takes a list,
    // and the prompt, which would otherwise join it, comes after `--` below.
    for (const directory of options.readableDirectories ?? []) {
      parts.push('--add-dir', quoteArg(directory, shell));
    }

    // Session: --resume for existing conversations, --session-id for new ones
    if (options.sessionId) {
      const flag = options.resume ? '--resume' : '--session-id';
      parts.push(flag, quoteArg(options.sessionId, shell));
    }

    // Per-column model and effort overrides. Both flags are session-scoped:
    // Claude does not persist them, so they are applied on every spawn (fresh
    // and resumed) until the column setting changes. A model written the way
    // the app displays it ("Opus", "Opus 5.5") is converted to Claude's own
    // spelling (`opus`, `claude-opus-5-5`) here, at the one place that knows
    // the value is going to Claude; stored values are never rewritten. See
    // toClaudeModelArgument for which values convert.
    if (options.model && options.model.trim().length > 0) {
      const modelArgument = toClaudeModelArgument(options.model, peekModelPickerAliasIds(options.cliPath));
      parts.push('--model', quoteArg(modelArgument, shell));
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
      // with single quotes. quoteArg does the same for every value it quotes
      // for those shells (escapeForDoubleQuotedShell).
      // Unix-like shells (bash, zsh, fish, WSL, and nushell, whose string
      // quoteArg double-quotes with `\"`) carry a double quote as written - no
      // replacement needed.
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      // -- (end-of-options) prevents content like -> or --flag from being
      // parsed as CLI options regardless of shell quoting behavior. It goes
      // through quoteArg because PowerShell's binder eats a bare -- before a
      // .ps1 shim sees $args; the quoted form reaches every launcher intact.
      // multiline: true preserves newlines in the <task> XML envelope.
      parts.push(quoteArg('--', shell), quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, vars: Record<string, string>): string {
    return interpolateTemplate(template, vars);
  }

  /** Read and merge project + local settings, with per-projectRoot caching. A copy the caller may change. */
  private readBaseSettings(projectRoot: string): ClaudeSettings {
    return structuredClone(this.cachedBaseSettings(projectRoot));
  }

  /** The cached merged settings themselves, for a read that changes nothing. */
  private cachedBaseSettings(projectRoot: string): Readonly<ClaudeSettings> {
    const cached = this.projectSettingsCache.get(projectRoot);
    if (cached) return cached;

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
    return baseSettings;
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
        command: `node ${quoteBridgePath(statusBridge, CLAUDE_BRIDGE_SHELL)} ${quoteBridgePath(statusPath, CLAUDE_BRIDGE_SHELL)}`,
        refreshInterval: STATUS_LINE_REFRESH_INTERVAL_SECONDS,
      },
    };

    // Merge event-bridge hooks (preserve existing user hooks)
    const eventsPath = options.eventsOutputPath ? toForwardSlash(options.eventsOutputPath) : null;
    if (eventsPath) {
      const eventBridge = toForwardSlash(resolveBridgeScript('event-bridge'));
      // Registered on every spawn, whatever the column says: the decision file
      // in the session's own directory decides at run time, so a column switched
      // to Automatic while this session plans is honored with no hook reload.
      // Without a decision file it answers nothing and the dialog shows.
      const planApprovalCommand = buildPlanApprovalCommand(
        CLAUDE_BRIDGE_SHELL,
        toForwardSlash(resolveBridgeScript('plan-approval-bridge')),
        toForwardSlash(planApprovalDecisionPath(path.dirname(options.statusOutputPath!))),
        eventsPath,
        CLAUDE_PLAN_APPROVAL_SPEC,
      );
      merged.hooks = buildHooks(eventBridge, eventsPath, baseSettings.hooks || {}, {
        capturePromptText: options.capturePromptText === true,
        planApprovalCommand,
      });
    }

    // The fullscreen renderer is turned on through the spawn environment, not
    // `tui` here (see fullscreenByDefault): a `tui` key in `--settings` arms
    // Claude's boot health check, which counts every Kangentic session that dies
    // young against the renderer. A `tui` the project's own settings carry
    // passes through untouched, as before.

    // Session directory (used for the merged Claude settings file).
    // Derived from statusOutputPath which is required by every spawn path
    // (transition-engine, session-startup, transient-sessions), so the
    // `!` is safe.
    const sessionDir = path.dirname(options.statusOutputPath!);

    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      console.error(`[spawn_agent] Failed to create session directory: ${sessionDir}`, err);
      throw new Error(`Cannot create session directory at ${sessionDir}: ${(err as Error).message}`, { cause: err });
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
      // sync-write-ok: this must throw, not degrade - a swallowed failure here
      // would spawn Claude with no MCP config, silently missing every
      // kangentic_* tool. The spawn preamble already reports and notifies
      // (notifySpawnBlocked) on any throw from buildCommand.
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

      // Auto-mode's classifier is a separate rule set from `permissions.allow`
      // (see KANGENTIC_MCP_ALLOW_RULE's comment). `$defaults` preserves the
      // classifier's built-in allow rules; only add it when the allow array
      // does not already exist, so a project's own `autoMode.allow` list
      // (which may deliberately omit `$defaults`) is never altered, only
      // appended to.
      const autoMode = merged.autoMode ?? {};
      const autoModeAllowEntries = autoMode.allow ?? ['$defaults'];
      if (!autoModeAllowEntries.includes(KANGENTIC_AUTO_MODE_ALLOW_RULE)) {
        merged.autoMode = { ...autoMode, allow: [...autoModeAllowEntries, KANGENTIC_AUTO_MODE_ALLOW_RULE] };
      }
    }

    // Write merged settings to <sessionDir>/settings.json (used with --settings flag)
    const mergedPath = path.join(sessionDir, 'settings.json');
    // sync-write-ok: this must throw, not degrade - buildCommand hands this
    // path straight to `--settings`, so a swallowed failure would spawn Claude
    // pointed at a settings file that does not exist. The spawn preamble
    // already reports and notifies (notifySpawnBlocked) on any throw here.
    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));

    return mergedPath;
  }
}
