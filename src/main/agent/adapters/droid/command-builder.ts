import fs from 'node:fs';
import path from 'node:path';
import { quoteArg, isUnixLikeShell, toForwardSlash } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import { cliPathForTarget, type CliTarget } from '../../shared/cli-target';
import { kangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { encodeHookSpec } from '../../shared/hook-utils';
import {
  BROWSER_POLICY_PROMPT,
  browserPolicyMatcher,
  buildBrowserPolicyCommand,
} from '../../shared/browser-policy-hook';
import { prepareWslHookTransport, wslHookEventCommand, wslHookReplyCommand } from '../../shared/wsl-hook-transport';
import { PATHS } from '../../../config/paths';
import { buildDroidHookSettings, droidBrowserPolicySpec, DROID_HOOK_SHELL } from './hook-manager';
import { droidBrowserServerNames } from './browser-servers';
import type { PermissionMode } from '../../../../shared/types';

/**
 * Factory Droid CLI command builder.
 *
 * Empirically validated against Droid 0.109.1 (see `scripts/probe-droid.js`):
 *   New session:    droid --cwd <cwd> "<prompt>"
 *   Resume session: droid --cwd <cwd> --resume <uuid> "<prompt>"
 *
 * Every other flag below is from Droid 0.218.0's own `droid --help` (read
 * 2026-11-03) and Factory's CLI reference
 * (https://docs.factory.com/droid-cli/cli-reference.md), and none was run
 * against a signed-in TUI:
 *   - `--settings <path>`: "runtime settings file merged for this process
 *     only". The one file Kangentic passes holds only its hooks
 *     (`hook-manager.ts`); model, BYOK `customModels[]` and the rest of the
 *     user's `~/.factory/settings.json` stay theirs.
 *   - `--use-spec` and `--auto low|medium|high`: the column's permission mode
 *     (`droidPermissionFlags`). In the TUI, Shift+Tab toggles Spec Mode and
 *     Ctrl+L cycles the autonomy level, so the user can still change either.
 *   - `--append-system-prompt <text>`: the Agent Browser policy.
 *
 * Model selection stays in the TUI (`/model`, Ctrl+N): 0.218.0's interactive
 * `--help` lists no `--model` flag, only `droid exec --help` does.
 *
 * MCP used to be manual here, on the grounds that Droid exposes no
 * `--mcp-config` flag and the alternatives were all stateful. That is no
 * longer the whole picture: Droid expands `${NAME}` against the process
 * environment inside `headers` values at connect time, and never rewrites
 * the file with the expanded value. So Kangentic writes a project-scoped
 * `<cwd>/.factory/mcp.json` containing only the env var NAME, and supplies
 * the value through `buildEnv`. No secret reaches disk, and
 * `~/.factory/mcp.json` is never touched.
 *
 * Verified against droid 0.189.0: `droid mcp list` in a directory carrying
 * the file below reports `kangentic  http  connected  [project]`.
 *
 * Other notes:
 * - Resume uses `droid --resume <uuid>`, NOT the exec-only `-s` flag.
 * - The session UUID is captured post-spawn from the SessionStart hook, or
 *   from `~/.factory/sessions/<cwd-slug>/<uuid>.jsonl` when no hook reports
 *   one. See `DroidAdapter.runtime.sessionId`.
 */
export interface DroidCommandOptions {
  droidPath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  /** The launch mode: Spec Mode or an autonomy level (`droidPermissionFlags`). */
  permissionMode: PermissionMode;
  projectRoot?: string;
  sessionId?: string;
  resume?: boolean;
  /** Accepted for parity; the adapter spawns the interactive TUI. */
  nonInteractive?: boolean;
  /** Accepted for parity; Droid writes no status file. */
  statusOutputPath?: string;
  /**
   * The session's events.jsonl. Its folder holds the per-session settings
   * file the hooks ride in (`writeHookSettings`), and the hooks append here.
   */
  eventsOutputPath?: string;
  shell?: string;
  /**
   * Whether to attach Kangentic's in-process MCP HTTP server. Default-on:
   * only an explicit `false` suppresses it.
   */
  mcpServerEnabled?: boolean;
  mcpServerUrl?: string;
  /** Delivered via `buildEnv`; the config file holds only the var NAME. */
  mcpServerToken?: string;
  /**
   * A Droid installed in a WSL distro (`CommandOptions.cliTarget`): named by
   * the path the distro sees, its working directory too, and on NAT
   * networking given Kangentic's server as the WSL hook transport's bridge.
   */
  cliTarget?: CliTarget | null;
  /** Carry the submitted prompt's text in the Prompt event (a Command Terminal's namer). */
  capturePromptText?: boolean;
  /** The Agent Browser switch: append the browser policy to Droid's system prompt. */
  browserAutomationEnabled?: boolean;
}

/**
 * The launch flags for a permission mode. Droid 0.218.0's `droid --help` lists
 * `--use-spec` ("Start in spec mode") and `--auto <level>` ("Autonomy level:
 * low|medium|high"); Factory's CLI reference describes the levels as safe
 * edits (low), local development such as installs, builds and local commits
 * (medium), and push and deploy (high). With no flag Droid asks before each
 * action. Interactive `droid` has no `--skip-permissions-unsafe` (only
 * `droid exec` does), so bypass maps to the highest level, which still blocks
 * what Droid blocks at every level.
 *
 * `dontAsk` runs read-only in Spec Mode, as Gemini's and Qwen's builders map it.
 *
 * These are the CLI's own flags, not a Kangentic settings layer
 * (`cli-features-over-custom-layers.md`); the TUI still changes either choice.
 * Why Droid maps them: docs/integrations/agents/droid.md, "Permission Modes".
 */
export function droidPermissionFlags(mode: PermissionMode): string[] {
  switch (mode) {
    case 'plan':
    case 'dontAsk':
      return ['--use-spec'];
    case 'acceptEdits':
      return ['--auto', 'low'];
    case 'auto':
      return ['--auto', 'medium'];
    case 'bypassPermissions':
      return ['--auto', 'high'];
    case 'default':
    default:
      return [];
  }
}

/** Env var Droid expands inside the mcp.json header value at connect time. */
export const KANGENTIC_MCP_TOKEN_ENV = 'KANGENTIC_MCP_TOKEN';

/** The per-session settings file, in the session's own folder beside events.jsonl. */
export const DROID_HOOK_SETTINGS_FILE = 'droid-settings.json';

/** Shared gate for the config write and `buildEnv`, so they cannot drift. */
export function droidMcpWiringEnabled(
  options: DroidCommandOptions,
): options is DroidCommandOptions & { mcpServerUrl: string; mcpServerToken: string } {
  return (
    options.mcpServerEnabled !== false
    && Boolean(options.mcpServerUrl)
    && Boolean(options.mcpServerToken)
  );
}

/**
 * Kangentic's entry in `.factory/mcp.json`. The URL for a Droid on this
 * machine or in a distro on mirrored networking. A distro on NAT networking
 * cannot reach this machine's loopback, so it gets the WSL hook transport's
 * stdio bridge, prepared in the session's own directory, with the token
 * passed to the bridge in its `env` as the same `${KANGENTIC_MCP_TOKEN}`
 * reference (Factory's MCP docs: Droid expands `${VAR}` in a server's `env`
 * and `headers` at load time). Like the URL, the bridge's script path is the
 * last session's to write it; a sibling's Droid connected at its own start.
 * Null when the bridge cannot be prepared: the session then runs without
 * Kangentic's tools, as one whose server failed to start would.
 */
function droidKangenticMcpEntry(
  options: DroidCommandOptions & { mcpServerUrl: string; mcpServerToken: string },
): Record<string, unknown> | null {
  const tokenReference = `\${${KANGENTIC_MCP_TOKEN_ENV}}`;
  const place = options.cliTarget ?? null;
  if (place) {
    if (!options.eventsOutputPath) return null;
    try {
      const server = kangenticMcpServer({
        url: options.mcpServerUrl,
        token: options.mcpServerToken,
        place,
        directory: path.dirname(options.eventsOutputPath),
      });
      if (server.kind === 'stdio') {
        return { type: 'stdio', command: server.command, args: server.args, env: { [server.tokenEnv]: tokenReference } };
      }
    } catch (error) {
      console.warn('[droid] Could not prepare the WSL MCP bridge; the session runs without Kangentic tools:', error);
      return null;
    }
  }
  return { type: 'http', url: options.mcpServerUrl, headers: { 'X-Kangentic-Token': tokenReference } };
}

export class DroidCommandBuilder {
  buildDroidCommand(options: DroidCommandOptions): string {
    const { shell } = options;
    // A Droid in a WSL distro is started by the path the distro sees.
    const place = options.cliTarget ?? null;
    const parts: string[] = [quoteArg(place ? place.linuxCliPath : options.droidPath, shell)];

    // Seed .git/info/exclude BEFORE the write so the mcp.json pre-existence
    // check reflects the user's file, not ours: the config otherwise sits
    // untracked in the worktree for the whole session, polluting git status
    // and riding along with any `git add -A` an agent runs.
    this.seedGitExcludes(options);
    this.writeMcpConfig(options);

    parts.push('--cwd', quoteArg(cliPathForTarget(options.cwd, place), shell));

    const settingsPath = this.writeHookSettings(options);
    // This machine's form is the one measured on 0.218.0; a distro gets its own.
    if (settingsPath) parts.push('--settings', quoteArg(place ? cliPathForTarget(settingsPath, place) : settingsPath, shell));

    parts.push(...droidPermissionFlags(options.permissionMode));

    // The browser policy is one line, quoted for the host shell by quoteArg.
    // It holds no quote, `$`, `%`, `!`, backtick or backslash, the characters
    // that quoting cannot hold on every shell (pinned in
    // tests/unit/claude-browser-policy.test.ts).
    if (options.browserAutomationEnabled === true) {
      parts.push('--append-system-prompt', quoteArg(BROWSER_POLICY_PROMPT, shell));
    }

    if (options.resume && options.sessionId) {
      // `--resume <uuid>` accepts the agent's own session UUID. The
      // captured ID lives in ~/.factory/sessions/<cwd-slug>/<uuid>.jsonl.
      parts.push('--resume', quoteArg(options.sessionId, shell));
    }

    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push(quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  /**
   * Write the per-session settings file holding Kangentic's hooks
   * (`buildDroidHookSettings`) beside the session's events file, and return
   * its path for `--settings`. A Droid in a WSL distro runs Linux hooks, so
   * its hooks publish through the WSL hook transport prepared in the session's
   * own folder (the file is per session, so no folder copy of the script is
   * needed), and Kangentic does the bridges' work on what they publish. Null,
   * and the session runs on the PTY tracker alone, when there is no events
   * path or when a write fails: the hooks only add detail, so a failed write
   * never blocks the spawn.
   */
  writeHookSettings(options: DroidCommandOptions): string | null {
    if (!options.eventsOutputPath) return null;
    const sessionDirectory = path.dirname(options.eventsOutputPath);
    const settingsPath = path.join(sessionDirectory, DROID_HOOK_SETTINGS_FILE);
    const place = options.cliTarget ?? null;
    try {
      const wsl = place ? { place, hooks: prepareWslHookTransport(sessionDirectory) } : null;
      // Registered on every spawn, whatever the Agent Browser switch says: the
      // bridge reads the switch from the global config on each call.
      const browserSpec = droidBrowserPolicySpec(droidBrowserServerNames({ cwd: options.cwd, place }), PATHS.configFile);
      const browserPolicy = {
        matcher: browserPolicyMatcher(browserSpec),
        command: wsl
          ? wslHookReplyCommand(wsl.hooks, wsl.place, 'browser-policy', encodeHookSpec(browserSpec))
          : buildBrowserPolicyCommand(DROID_HOOK_SHELL, toForwardSlash(resolveBridgeScript('browser-policy-bridge')), browserSpec),
      };
      const settings = buildDroidHookSettings(
        toForwardSlash(resolveBridgeScript('event-bridge')),
        toForwardSlash(options.eventsOutputPath),
        {
          capturePromptText: options.capturePromptText === true,
          browserPolicy,
          ...(wsl
            ? { eventCommand: (eventType: string, ...directives: string[]) => wslHookEventCommand(wsl.hooks, wsl.place, eventType, ...directives) }
            : {}),
        },
      );
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return settingsPath;
    } catch (error) {
      console.warn(`[droid] Could not write the hook settings file; the session runs without hooks: ${settingsPath}`, error);
      return null;
    }
  }

  /**
   * Hide the Kangentic-written runtime files from git for the untracked
   * case. `<cwd>/.factory/mcp.json` gets the created-by-us carve-out: a
   * file already present may be the user's own project MCP config, possibly
   * destined for a commit. The file holds no secret (the token is a
   * `${KANGENTIC_MCP_TOKEN}` env reference), so this is purely about
   * untracked-file noise in the task worktree.
   */
  private seedGitExcludes(options: DroidCommandOptions): void {
    if (!droidMcpWiringEnabled(options)) return;
    const patterns = ['.kangentic/'];
    if (!fs.existsSync(path.join(options.cwd, '.factory', 'mcp.json'))) {
      patterns.push('.factory/mcp.json');
    }
    ensureLocalGitExcludes(options.cwd, patterns);
  }

  /**
   * Write the project-scoped `<cwd>/.factory/mcp.json` entry for Kangentic's
   * MCP server, preserving any servers the user configured there.
   *
   * The header value is the literal `${KANGENTIC_MCP_TOKEN}`, which Droid
   * expands against the process environment when it opens the connection.
   * Factory documents that the file is never rewritten with the expanded
   * value, so the token stays out of version control even though this path
   * is inside the user's repo. `removeMcpConfig` strips the entry on session
   * exit so a stale URL does not linger.
   */
  writeMcpConfig(options: DroidCommandOptions): void {
    if (!droidMcpWiringEnabled(options)) return;
    const entry = droidKangenticMcpEntry(options);
    if (!entry) return;

    const factoryDir = path.join(options.cwd, '.factory');
    const configPath = path.join(factoryDir, 'mcp.json');

    let existing: { mcpServers?: Record<string, unknown> } = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch {
      // No existing config - start fresh.
    }

    const merged = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers ?? {}),
        kangentic: entry,
      },
    };

    try {
      fs.mkdirSync(factoryDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
    } catch (error) {
      console.error(`[droid] Failed to write MCP config: ${configPath}`, error);
    }
  }

  /**
   * Environment injected into the Droid PTY, holding the value that the
   * `${KANGENTIC_MCP_TOKEN}` reference in mcp.json resolves to. Shares
   * `droidMcpWiringEnabled` with the config write.
   */
  buildDroidEnv(options: DroidCommandOptions): Record<string, string> | null {
    if (!droidMcpWiringEnabled(options)) return null;
    return { [KANGENTIC_MCP_TOKEN_ENV]: options.mcpServerToken };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}

/**
 * Remove Kangentic's entry from `<directory>/.factory/mcp.json`, leaving any
 * user-defined servers intact and deleting the file when nothing remains.
 */
export function removeMcpConfig(directory: string): void {
  const configPath = path.join(directory, '.factory', 'mcp.json');

  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    parsed = raw;
  } catch {
    return;
  }

  if (!parsed.mcpServers || !('kangentic' in parsed.mcpServers)) return;

  delete parsed.mcpServers.kangentic;
  if (Object.keys(parsed.mcpServers).length === 0) delete parsed.mcpServers;

  try {
    if (Object.keys(parsed).length === 0) {
      fs.rmSync(configPath, { force: true });
      return;
    }
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2));
  } catch (error) {
    console.error(`[droid] Failed to clean up MCP config: ${configPath}`, error);
  }
}
