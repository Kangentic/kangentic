import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { interpolateTemplate } from '../../shared/template-utils';
import { toClaudeModelArgument } from './model-display-name';
import { peekModelPickerAliasIds } from './model-picker-probe';
import { buildHooks, CLAUDE_BACKGROUND_SHELL_HINT_SPEC, CLAUDE_BRIDGE_SHELL, CLAUDE_PLAN_APPROVAL_SPEC } from './hook-manager';
import type { ClaudeHookEntry } from './hook-manager';
import {
  buildPlanApprovalCommand,
  planApprovalDecisionPath,
  type PlanApprovalHookSpec,
  type PlanToolApprovalHookSpec,
} from '../../shared/plan-approval-hook';
import { claudePlanToolApprovalSpec, planToolApprovalRules } from './plan-tool-approval';
import { buildBackgroundShellHintCommand } from '../../shared/background-shell-hint-hook';
import { offersMarkBackgroundService, shippedHintBridgePath } from '../../shared/background-command-hooks';
import { encodeHookSpec, quoteBridgePath } from '../../shared/hook-utils';
import { cliPathForTarget, type CliPlace } from '../../shared/cli-target';
import {
  prepareWslHookTransport,
  wslHookEventCommand,
  wslHookReplyCommand,
  wslStatusLineCommand,
} from '../../shared/wsl-hook-transport';
import { kangenticMcpServer, type KangenticMcpServer } from '../../shared/kangentic-mcp-server';

/** Kangentic's MCP server as an entry of Claude's `mcp.json`: HTTP with its token header, or the stdio bridge with the token in its `env`. */
export function claudeMcpServerEntry(server: KangenticMcpServer): Record<string, unknown> {
  return server.kind === 'http'
    ? { type: 'http', url: server.url, headers: { 'X-Kangentic-Token': server.token } }
    : { type: 'stdio', command: server.command, args: server.args, env: { [server.tokenEnv]: server.token } };
}
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
 * While a plan is approved automatically, the plan approval hook answers a
 * prompt for another server's tool these rules allow (plan-tool-approval.ts),
 * but never for Kangentic's own: its mutating tools keep prompting.
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

/** The `permissions` block: the lists Kangentic writes to, and every other key (`ask`, `additionalDirectories`, `defaultMode`) passed through. */
interface ClaudePermissions {
  allow?: string[];
  deny?: string[];
  [key: string]: unknown;
}

/** Subset of Claude Code settings.json that we read/write. */
interface ClaudeSettings {
  statusLine?: { type: string; command: string; refreshInterval?: number };
  hooks?: Record<string, ClaudeHookEntry[]>;
  permissions?: ClaudePermissions;
  autoMode?: { environment?: string[]; allow?: string[]; soft_deny?: string[]; hard_deny?: string[] };
  [key: string]: unknown; // preserve unknown keys from user's settings
}

/**
 * One settings file laid over another, one level deep, the way Claude Code
 * combines its own files: a key that holds a list on both sides keeps both
 * lists' entries, deduplicated with the base's first, and any other key takes
 * the overlay's value. Claude's settings docs: "When you set the same list
 * key, such as `permissions.allow`, in more than one file, Claude Code combines
 * the lists instead of picking one." Nested objects are not walked, since the
 * docs say nothing about how they merge, so an overlay's `env` replaces the
 * base's, as it always has here.
 */
function overlaySettingsLayer<T extends Record<string, unknown>>(base: T, overlay: T): T {
  const merged: Record<string, unknown> = { ...base, ...overlay };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = base[key];
    if (Array.isArray(baseValue) && Array.isArray(overlayValue)) {
      merged[key] = [...new Set([...baseValue, ...overlayValue])];
    }
  }
  return merged as T;
}

/**
 * Whether a renderer variable is on as Claude reads one: `1`, `true`, `yes`
 * or `on`, in any case. `0`, `false` and an empty value are off.
 */
function isEnvironmentFlagOn(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** True for a parsed settings file that is a JSON object, not an array, `null` or a scalar. */
function isPlainSettingsObject(parsed: unknown): parsed is ClaudeSettings {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
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

/**
 * Lay one `permissions` block over another: every key kept, lists combined
 * (`overlaySettingsLayer`). `allow` and `deny` are always present.
 */
function mergePermissions(
  base: ClaudePermissions | undefined,
  overlay: ClaudePermissions | undefined,
): (ClaudePermissions & { allow: string[]; deny: string[] }) | undefined {
  if (!base && !overlay) return undefined;
  const merged = overlaySettingsLayer(base ?? {}, overlay ?? {});
  return {
    ...merged,
    allow: Array.isArray(merged.allow) ? merged.allow : [],
    deny: Array.isArray(merged.deny) ? merged.deny : [],
  };
}

export class CommandBuilder {
  /** Path to session mcp.json written by createMergedSettings(), consumed by buildClaudeCommand(). */
  private lastMcpConfigPath: string | null = null;

  /**
   * The user's own `~/.claude/settings.json`, or an empty object when it is
   * missing, unreadable or not a JSON object. Read fresh each spawn (small
   * file, infrequent), so a change to it is honored on the next session. For a
   * Claude installed in a WSL distro (`place`), the distro home's file, which
   * is the one that Claude reads.
   */
  private readUserSettings(place: CliPlace | null = null): ClaudeSettings {
    const home = place ? place.facts.homeUnc : os.homedir();
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'));
      return isPlainSettingsObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * The Claude TUI renderer the user chose in their global
   * `~/.claude/settings.json` (where Claude's `/tui` command persists the `tui`
   * setting), or null when they have not chosen, so a `/tui` change is honored
   * on the next session.
   */
  private globalTuiChoice(place: CliPlace | null = null): unknown {
    // Treat `tui: null` (a reset sentinel, or a hand-edited file) the same as an
    // absent key: null is not a renderer choice.
    return this.readUserSettings(place).tui ?? null;
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
  fullscreenByDefault(options: Pick<CommandOptions, 'cwd' | 'projectRoot' | 'cliTarget'>): boolean {
    const projectChoice = this.readBaseSettings(options.projectRoot || options.cwd).tui;
    const choice = projectChoice === undefined || projectChoice === null
      ? this.globalTuiChoice(options.cliTarget ?? null)
      : projectChoice;
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
   *
   * A Claude installed in a WSL distro takes neither variable from this
   * machine's environment, which is not the one it runs in: a user who sets
   * one in the distro's shell profile overrides what crosses here, since the
   * profile runs after `WSLENV` sets it.
   */
  rendererEnvironment(
    options: Pick<CommandOptions, 'cwd' | 'projectRoot' | 'cliTarget'>,
    environment: NodeJS.ProcessEnv = process.env,
  ): Record<string, string> | null {
    if (!options.cliTarget && environment.CLAUDECODE === undefined) {
      const usersOwn: Record<string, string> = {};
      for (const key of ['CLAUDE_CODE_NO_FLICKER', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']) {
        const value = environment[key];
        if (value !== undefined && value !== '') usersOwn[key] = value;
      }
      if (Object.keys(usersOwn).length > 0) return usersOwn;
    }
    return this.fullscreenByDefault(options) ? { CLAUDE_CODE_NO_FLICKER: '1' } : null;
  }

  /**
   * Whether this spawn draws on the fullscreen renderer, in the alternate
   * screen, read from the variables `rendererEnvironment` hands it in the
   * order Claude ranks them: `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` on draws
   * classic whatever else is set, then `CLAUDE_CODE_NO_FLICKER` decides. No
   * variable means a renderer the user chose (`tui: "default"`), which is
   * classic, since Kangentic sets the variable whenever fullscreen is chosen
   * or nothing is.
   */
  drawsInAlternateScreen(
    options: Pick<CommandOptions, 'cwd' | 'projectRoot' | 'cliTarget'>,
    environment: NodeJS.ProcessEnv = process.env,
  ): boolean {
    const renderer = this.rendererEnvironment(options, environment);
    if (!renderer) return false;
    if (isEnvironmentFlagOn(renderer.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN)) return false;
    return isEnvironmentFlagOn(renderer.CLAUDE_CODE_NO_FLICKER);
  }

  buildClaudeCommand(options: CommandOptions): string {
    const { shell } = options;
    // A Claude installed in a WSL distro runs in that distro's shell, by the
    // path the distro sees, and every file it is handed is named that way too.
    const place = options.cliTarget ?? null;
    const parts = [quoteArg(options.cliTarget ? options.cliTarget.linuxCliPath : options.cliPath, shell)];

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
      parts.push('--settings', quoteArg(cliPathForTarget(mergedSettingsPath, place), shell));
    }

    // --mcp-config: deliver kangentic MCP server without modifying .mcp.json.
    // The config file lives in the session directory, written by createMergedSettings().
    // We do NOT use --strict-mcp-config because that would block the user's own
    // servers (e.g. context7) configured in .mcp.json.
    if (this.lastMcpConfigPath) {
      parts.push('--mcp-config', quoteArg(cliPathForTarget(this.lastMcpConfigPath, place), shell));
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
      parts.push('--add-dir', quoteArg(place ? cliPathForTarget(directory, place) : directory, shell));
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

    // The prompt as positional argument, on a fresh start and on a resume, where
    // it is the next turn of the resumed conversation.
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

  /**
   * The project root's `.claude/settings.json` with its `.claude/settings.local.json`
   * laid over it, read from disk on every call and returned as a new object the
   * caller may change. Nothing caches it, so a commit, a pull or an edit to either
   * file reaches the next session with no restart; two small reads cost nothing
   * beside the spawn they serve. Kangentic adds nothing to either file, so the
   * read is always the user's own settings.
   */
  private readBaseSettings(projectRoot: string): ClaudeSettings {
    // 1. Read project settings (committed, shared)
    let baseSettings: ClaudeSettings = {};
    const projectSettingsPath = path.join(projectRoot, '.claude', 'settings.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf-8'));
      // Only a plain object can be spread into the merged settings, as in the
      // Gemini and Qwen builders' reads.
      if (isPlainSettingsObject(parsed)) baseSettings = parsed;
    } catch {
      // No existing settings - start fresh
    }

    // 2. Lay local settings from project root (gitignored, personal) over them
    const localSettingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
    try {
      const localSettings: unknown = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
      if (!isPlainSettingsObject(localSettings)) return baseSettings;
      const { hooks: localHooks, permissions: localPermissions, ...localRest } = localSettings;
      const { hooks: baseHooks, permissions: basePermissions, ...baseRest } = baseSettings;
      const mergedPermissions = mergePermissions(basePermissions, localPermissions);
      baseSettings = {
        ...overlaySettingsLayer(baseRest, localRest),
        hooks: mergeHookArrays(baseHooks, localHooks),
        ...(mergedPermissions ? { permissions: mergedPermissions } : {}),
      };
    } catch {
      // No local settings
    }

    return baseSettings;
  }

  /**
   * Create a merged Claude settings file that includes the statusLine config
   * and event-bridge hooks. Merges project + local settings (read fresh),
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
    //    Claude writes "always allow" grants here during sessions, so the session
    //    file carries them on resume whatever Claude makes of a list in --settings
    //    beside the same list in a project file. We only merge permissions, not
    //    hooks (which are either empty or stale leftovers from before this unified
    //    approach).
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

    // A Claude installed in a WSL distro runs its status line and hooks in the
    // distro, which may have no node: they publish files through the session's
    // hook transport instead, and Kangentic does the bridges' work on them
    // (wsl-hook-transport.ts). The same events, directives and specs either way.
    const place = options.cliTarget ?? null;
    const wslHooks = place ? prepareWslHookTransport(sessionDir) : null;

    let statusLineCommand: string;
    if (wslHooks && place) {
      statusLineCommand = wslStatusLineCommand(wslHooks, place, options.statusOutputPath!);
    } else {
      // Resolve bridge scripts. In production, bridge scripts are copied next
      // to the main bundle by scripts/build.js. In dev (esbuild watch),
      // __dirname is .vite/build/ so we fall back to the source tree.
      const statusBridge = toForwardSlash(resolveBridgeScript('status-bridge'));
      const statusPath = toForwardSlash(options.statusOutputPath!);
      statusLineCommand = `node ${quoteBridgePath(statusBridge, CLAUDE_BRIDGE_SHELL)} ${quoteBridgePath(statusPath, CLAUDE_BRIDGE_SHELL)}`;
    }

    const merged: ClaudeSettings = {
      ...baseSettings,
      statusLine: {
        type: 'command',
        command: statusLineCommand,
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
      const planApprovalBridge = toForwardSlash(resolveBridgeScript('plan-approval-bridge'));
      const decisionPath = toForwardSlash(planApprovalDecisionPath(sessionDir));
      const planApprovalHook = (spec: PlanApprovalHookSpec | PlanToolApprovalHookSpec): string => (wslHooks && place
        ? wslHookReplyCommand(wslHooks, place, 'plan-approval', encodeHookSpec(spec))
        : buildPlanApprovalCommand(CLAUDE_BRIDGE_SHELL, planApprovalBridge, decisionPath, eventsPath, spec));
      const planApprovalCommand = planApprovalHook(CLAUDE_PLAN_APPROVAL_SPEC);
      // The same bridge, and the same decision file, on a prompt for an MCP
      // tool the user's allow rules name, which plan mode asks about anyway
      // (plan-tool-approval.ts). Registered only when a rule names one.
      const toolApprovalRules = planToolApprovalRules([baseSettings.permissions, this.readUserSettings(place).permissions]);
      const planToolApprovalCommand = toolApprovalRules
        ? planApprovalHook(claudePlanToolApprovalSpec(toolApprovalRules))
        : undefined;
      // The hint names kangentic_mark_background_service, which the MCP server
      // offers only to a connection that names a task session, so a session
      // without one (a Command Terminal, MCP turned off) gets no hint.
      let backgroundShellHintCommand: string | undefined;
      if (offersMarkBackgroundService(options)) {
        backgroundShellHintCommand = wslHooks && place
          ? wslHookReplyCommand(wslHooks, place, 'background-shell-hint', encodeHookSpec(CLAUDE_BACKGROUND_SHELL_HINT_SPEC))
          : buildBackgroundShellHintCommand(CLAUDE_BRIDGE_SHELL, shippedHintBridgePath(), CLAUDE_BACKGROUND_SHELL_HINT_SPEC);
      }
      merged.hooks = buildHooks(eventBridge, eventsPath, baseSettings.hooks || {}, {
        capturePromptText: options.capturePromptText === true,
        planApprovalCommand,
        planToolApprovalCommand,
        backgroundShellHintCommand,
        ...(wslHooks && place
          ? { eventCommand: (eventType: string, ...directives: string[]) => wslHookEventCommand(wslHooks, place, eventType, ...directives) }
          : {}),
      });
    }

    // The fullscreen renderer is turned on through the spawn environment, not
    // `tui` here (see fullscreenByDefault): a `tui` key in `--settings` arms
    // Claude's boot health check, which counts every Kangentic session that dies
    // young against the renderer. A `tui` the project's own settings carry
    // passes through untouched, as before.

    // Write the per-session MCP config pointing at the in-process HTTP
    // MCP server hosted by Kangentic main. The URL contains the project
    // ID so the server resolves the right CommandContext per request;
    // the X-Kangentic-Token header gates access. The token is rotated
    // on every Kangentic launch, so a stale mcp.json from a previous
    // run can't be reused.
    if (options.mcpServerEnabled !== false && options.mcpServerUrl && options.mcpServerToken) {
      // A Claude in a WSL distro on the default NAT network cannot reach this
      // machine's loopback, so it runs the transport's stdio bridge, which
      // hands each message to Kangentic with the token from its environment.
      const kangenticServer = kangenticMcpServer({ url: options.mcpServerUrl, token: options.mcpServerToken, place, directory: sessionDir });
      const mcpConfig = { mcpServers: { kangentic: claudeMcpServerEntry(kangenticServer) } };
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
