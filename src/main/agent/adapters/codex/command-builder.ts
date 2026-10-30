import path from 'node:path';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { copyBridgeInto } from '../../shared/workspace-bridge-copy';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import { cliPathForTarget, type CliPlace, type CliTarget } from '../../shared/cli-target';
import { copyWslHookScriptInto, prepareWslHookTransport, wslReachesLoopback } from '../../shared/wsl-hook-transport';
import { kangenticMcpServer, type KangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { buildHooks, buildCodexHookOverrides, CODEX_EVENT_BRIDGE_COPY_NAME, CODEX_WSL_HOOK_COPY_NAME } from './hook-manager';
import { TASK_PROCESS_TAG_ENV, isValidTaskTagValue } from '../../../pty/process-tag/task-process-tag';
import type { PermissionMode } from '../../../../shared/types';

export interface CodexCommandOptions {
  codexPath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string;
  sessionId?: string;
  resume?: boolean;
  nonInteractive?: boolean;
  statusOutputPath?: string;
  eventsOutputPath?: string;
  shell?: string;
  /**
   * Whether to attach Kangentic's in-process MCP HTTP server. Default-on
   * (matching Claude and Qwen): only an explicit `false` suppresses it.
   */
  mcpServerEnabled?: boolean;
  /** Streamable-HTTP endpoint, `http://127.0.0.1:<port>/mcp/<projectId>/<callerSessionId>`. */
  mcpServerUrl?: string;
  /** Per-launch MCP token. Delivered via `buildEnv`, NEVER via argv. */
  mcpServerToken?: string;
  model?: string;
  effort?: string;
  /** Fully-defaulted launch-option values (`AgentLaunchOptionInfo.id` -> enabled). */
  launchOptions?: Record<string, boolean>;
  /** The task's `KANGENTIC_TASK_ID`; see `CommandOptions.taskProcessTag`. */
  taskProcessTag?: string;
  /**
   * The `hooks.state` override Codex itself confirmed for this binary
   * (`CodexHookTrustCheck`), or null/absent when it did not: the session then
   * runs without Kangentic's hooks, on the PTY tracker.
   */
  codexHookStateOverride?: string | null;
  /**
   * A Codex installed in a WSL distro (`CommandOptions.cliTarget`): named by
   * the path the distro sees, its working directory too, and its hooks run the
   * WSL hook transport's script instead of the node bridge.
   */
  cliTarget?: CliTarget | null;
}

/**
 * Map Kangentic's PermissionMode to Codex CLI sandbox + approval flags.
 *
 * Codex no longer ships `--full-auto`; everything is now expressed via the
 * pair `--sandbox <mode>` and `--ask-for-approval <policy>`. Mappings:
 *   plan        → Safe read-only browsing (model can request escalation)
 *   dontAsk     → Read-only non-interactive (CI; failures returned to model)
 *   default     → Workspace-write, model decides when to ask
 *   acceptEdits → Workspace-write, never ask (replaces old --full-auto)
 *   auto        → Workspace-write, model decides when to ask
 *   bypass      → Dangerous full access (no sandbox, no approval)
 *
 * `default` and `auto` launch alike. Codex 0.154.0 accepts only `on-request`
 * and `never` for `--ask-for-approval` and exits 2 on `untrusted` ("invalid
 * value 'untrusted'"), which `default` used to pass, so no Default-mode Codex
 * task started at all.
 */
function mapPermissionMode(mode: PermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'];
    case 'dontAsk':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
    case 'default':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
    case 'acceptEdits':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'];
    case 'auto':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
    case 'bypassPermissions':
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

/**
 * HTTP header the Kangentic MCP server authenticates with, and the name of
 * the environment variable that carries its value into the Codex process.
 *
 * Codex's `env_http_headers` maps a header name to the NAME of an environment
 * variable; Codex reads the value out of its own process env when it opens the
 * MCP connection. The token therefore never appears in argv. That matters
 * because the spawn command is echoed into terminal scrollback the user can
 * read, and on Windows PowerShell also persists typed lines to
 * `ConsoleHost_history.txt`, so an argv token would outlive the session in
 * plaintext on disk. No Kangentic adapter puts the MCP token in argv today.
 */
export const KANGENTIC_MCP_TOKEN_HEADER = 'X-Kangentic-Token';
export const KANGENTIC_MCP_TOKEN_ENV = 'KANGENTIC_MCP_TOKEN';

/**
 * Single gate shared by the `-c` flag builder and `CodexAdapter.buildEnv`.
 *
 * These MUST fire together. Flags without the env var leave Codex resolving an
 * unset variable and connecting with no auth header, which the server answers
 * with a 401 that surfaces only as an MCP server that silently does not work.
 * The env var without the flags is a harmless but pointless leak. Keeping the
 * predicate in one place makes that drift impossible.
 *
 * Default-on (`!== false`) matches Claude (`claude/command-builder.ts`) and
 * Qwen. Every spawn chokepoint passes an explicit boolean derived from
 * `config.mcpServer?.enabled ?? true`, so this is production-equivalent to
 * Copilot's explicit-true gate.
 */
export function codexMcpWiringEnabled(
  options: CodexCommandOptions,
): options is CodexCommandOptions & { mcpServerUrl: string; mcpServerToken: string } {
  return (
    options.mcpServerEnabled !== false
    && Boolean(options.mcpServerUrl)
    && Boolean(options.mcpServerToken)
  );
}

/**
 * Build the per-invocation `codex -c <key=value>` overrides that attach
 * Kangentic's streamable-HTTP MCP server.
 *
 * `-c` is Codex's own documented config mechanism and applies to this process
 * only: it never writes `~/.codex/config.toml` and never mutates global state,
 * so it satisfies `cli-features-over-custom-layers.md` rather than shadowing a
 * native control. There is no in-TUI way to attach a session-scoped server
 * whose URL carries a per-session caller id and whose token rotates on every
 * Kangentic launch; the alternatives (`codex mcp add`, editing `config.toml`,
 * redirecting `CODEX_HOME`, which also holds `auth.json`) are all the stateful
 * global mutation that rule exists to prevent.
 *
 * QUOTING CONTRACT. Do not "tidy" these into quoted TOML values. Both payloads
 * are deliberately free of quotes, braces, and whitespace, so `quoteArg` wraps
 * each in one flat pair of quotes that every shell parses identically. Codex
 * accepts them because `-c` falls back to a literal string when the value does
 * not parse as TOML (documented in `codex --help`), and because TOML bare keys
 * permit `-`, which lets the header name be a dotted key segment instead of an
 * inline table.
 *
 * A quoted value such as `url="http://..."` cannot arrive as written on
 * Windows, because quoteArg writes a content `"` as `'` there
 * (escapeForDoubleQuotedShell). The form below was verified against codex-cli
 * 0.141.0 on PowerShell, cmd, and Git Bash via `codex mcp list --json`, and end
 * to end against a live Kangentic MCP server.
 */
function buildMcpConfigArgs(options: CodexCommandOptions): string[] {
  if (!codexMcpWiringEnabled(options)) return [];
  const { shell } = options;
  const place = options.cliTarget ?? null;
  if (place && !wslReachesLoopback(place)) return buildWslMcpBridgeArgs(options, place);
  return [
    '-c',
    quoteArg(`mcp_servers.kangentic.url=${options.mcpServerUrl}`, shell),
    '-c',
    quoteArg(
      `mcp_servers.kangentic.env_http_headers.${KANGENTIC_MCP_TOKEN_HEADER}=${KANGENTIC_MCP_TOKEN_ENV}`,
      shell,
    ),
  ];
}

/** A value the hook overrides' QUOTING CONTRACT carries inside a TOML literal string. */
const TOML_LITERAL_SAFE = /^[^'"%`$\r\n]+$/;

/**
 * A Codex in a WSL distro on the default NAT network cannot reach this
 * machine's loopback, so its Kangentic server is the hook transport's stdio
 * bridge (`wslMcpServerLaunch`), and the token reaches the bridge by name
 * through `env_vars`, Codex's documented list of variables forwarded to a stdio
 * server: it stays out of argv, as it does for the HTTP form above. The same
 * QUOTING CONTRACT as buildHookArgs: TOML literal strings, and a value with a
 * quote or a shell-expanded character is not passed at all.
 */
function buildWslMcpBridgeArgs(options: CodexCommandOptions & { mcpServerUrl: string; mcpServerToken: string }, place: CliPlace): string[] {
  if (!options.eventsOutputPath) return [];
  let server: KangenticMcpServer;
  try {
    server = kangenticMcpServer({ url: options.mcpServerUrl, token: options.mcpServerToken, place, directory: path.dirname(options.eventsOutputPath) });
  } catch (error) {
    console.warn('[codex] Could not prepare the WSL MCP bridge; the session runs without Kangentic tools:', error);
    return [];
  }
  if (server.kind !== 'stdio') return [];
  if (![server.command, ...server.args].every((value) => TOML_LITERAL_SAFE.test(value))) {
    console.warn('[codex] The WSL MCP bridge path holds a character Codex cannot be passed safely; the session runs without Kangentic tools');
    return [];
  }
  const literalArray = (values: readonly string[]): string => `[${values.map((value) => `'${value}'`).join(',')}]`;
  return [
    `mcp_servers.kangentic.command='${server.command}'`,
    `mcp_servers.kangentic.args=${literalArray(server.args)}`,
    `mcp_servers.kangentic.env_vars=${literalArray([server.tokenEnv])}`,
  ].flatMap((value) => ['-c', quoteArg(value, options.shell)]);
}

/**
 * Keep the task's `KANGENTIC_TASK_ID` in the shells Codex starts.
 *
 * Every process an agent starts must carry the tag, or a terminal transition
 * cannot find what the task left running (src/main/pty/process-tag/). Codex
 * passes its own environment to tool shells through `shell_environment_policy`,
 * which by default inherits everything but a user can narrow
 * (`inherit = "core"`, `include_only`), and that strips the tag. A `set` entry
 * always wins over the inherit and filter steps. Measured on codex-cli 0.154.0
 * with `codex sandbox`: under `inherit=core` the variable is gone, with this
 * override it is back, and another `set` entry passed alongside survives, so the
 * dotted key adds to the user's `set` table rather than replacing it.
 *
 * Same QUOTING CONTRACT as buildMcpConfigArgs: a task id is a uuid, free of
 * quotes and whitespace, and Codex takes the non-TOML value as a literal string.
 */
function buildTaskProcessTagArgs(options: CodexCommandOptions): string[] {
  const tag = options.taskProcessTag;
  if (!tag || !isValidTaskTagValue(tag)) return [];
  return ['-c', quoteArg(`shell_environment_policy.set.${TASK_PROCESS_TAG_ENV}=${tag}`, options.shell)];
}

/**
 * Keep Codex's "Update available" prompt out of a Kangentic session (task
 * #859). It is a modal at TUI startup whose highlighted first option is
 * "Update now", so an `auto_command` typed into a session showing it, or an
 * Enter meant for the agent, updates and exits Codex instead (measured: a
 * probe's Enter updated 0.154.0 to 0.163.0 and the session ended). Codex
 * documents the key; this applies to the process only and writes nothing, so
 * the user's own terminal still offers updates. Same QUOTING CONTRACT as
 * buildMcpConfigArgs: a bare TOML boolean, no quotes.
 */
const NO_STARTUP_UPDATE_PROMPT_ARGS = ['-c', 'check_for_update_on_startup=false'];

function buildStartupUpdatePromptArgs(options: CodexCommandOptions): string[] {
  return NO_STARTUP_UPDATE_PROMPT_ARGS.map((part) => quoteArg(part, options.shell));
}

/**
 * Kangentic's hooks for this session, in Codex's session-flags layer (task
 * #859). Only with an events file and a trust state Codex confirmed for this
 * binary; without one the TUI would stop at its "Hooks need review" dialog.
 *
 * QUOTING CONTRACT, the same rule as buildMcpConfigArgs from another side: the
 * values hold no `"` at all. Every TOML string in them is a literal ('...'),
 * the hook command is bare tokens (`codexHookCommand`), and a trust key holds
 * no `'`, so `quoteArg` wraps each value in one pair of quotes every shell
 * reads the same way. The bridge runs from a workspace copy because its
 * relative path is the one that is always a bare token.
 */
function buildHookArgs(options: CodexCommandOptions): string[] {
  const stateOverride = options.codexHookStateOverride;
  if (!options.eventsOutputPath || !stateOverride) return [];
  const inDistro = Boolean(options.cliTarget);
  try {
    // Keep the copy out of `git status` and an agent's `git add -A` in a
    // worktree whose committed .gitignore does not list .kangentic/.
    ensureLocalGitExcludes(options.cwd, ['.kangentic/']);
    if (inDistro) {
      // A Codex in a WSL distro publishes through the session's hook folder,
      // which its env names (KANGENTIC_WSL_HOOK_DIR), by the workspace copy
      // of the transport's script.
      prepareWslHookTransport(path.dirname(options.eventsOutputPath));
      copyWslHookScriptInto(options.cwd, CODEX_WSL_HOOK_COPY_NAME);
    } else {
      copyBridgeInto(options.cwd, 'event-bridge', CODEX_EVENT_BRIDGE_COPY_NAME);
    }
  } catch (error) {
    console.warn(
      inDistro
        ? '[codex] Could not prepare the WSL hook script; the session runs without hooks:'
        : '[codex] Could not copy the event bridge into the workspace; the session runs without hooks:',
      error,
    );
    return [];
  }
  return [...buildCodexHookOverrides(inDistro ? 'wsl' : 'node'), stateOverride].flatMap((value) => ['-c', quoteArg(value, options.shell)]);
}

export class CodexCommandBuilder {
  buildCodexCommand(options: CodexCommandOptions): string {
    const { shell } = options;

    // Codex 0.128 redesigned the hook system; the legacy `.codex/hooks.json`
    // we used to write is no longer parsed and now produces a yellow warning
    // banner at session start. `buildHooks` is a cleanup-only call that
    // strips Kangentic-owned entries from any pre-upgrade legacy file; the
    // hooks themselves are `-c` overrides (buildHookArgs below). The
    // eventsOutputPath gate is preserved so non-hookable spawns (no events
    // pipeline requested) skip the disk sweep entirely.
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      buildHooks(projectRoot);
    }

    const parts: string[] = [];
    const isResume = Boolean(options.resume && options.sessionId);

    const place = options.cliTarget ?? null;
    parts.push(quoteArg(options.cliTarget ? options.cliTarget.linuxCliPath : options.codexPath, shell));

    if (isResume) {
      // Resume is a subcommand: codex resume <sessionId> ...
      parts.push('resume', quoteArg(options.sessionId!, shell));
    } else if (options.nonInteractive) {
      parts.push('-q', '--json');
    }

    // Every flag below is accepted by BOTH `codex` and `codex resume`
    // (verified against `codex resume --help` on 0.141.0), so the two branches
    // share one emission path. They did not always: the resume branch used to
    // return early after `-C`, silently dropping the permission mode, the
    // model override, and the MCP wiring from every resumed session.

    // Working directory, as the CLI sees it (forward slashes here, /mnt in a WSL distro)
    parts.push('-C', quoteArg(cliPathForTarget(options.cwd, place), shell));

    // Approval mode
    parts.push(...mapPermissionMode(options.permissionMode));

    // Skip the optional cloud ChatGPT Apps MCP connector, which can hang
    // startup at "Booting MCP server: codex_apps" (openai/codex#20167).
    if (options.launchOptions?.disableApps) {
      parts.push('--disable', 'apps');
    }

    // Per-column model override
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }

    // Kangentic's MCP server. Must precede the positional prompt, since
    // Codex's grammar is `codex [OPTIONS] [PROMPT]`.
    parts.push(...buildMcpConfigArgs(options));
    parts.push(...buildTaskProcessTagArgs(options));
    parts.push(...buildStartupUpdatePromptArgs(options));
    parts.push(...buildHookArgs(options));

    // Prompt as positional argument, on a resume too: `codex resume <id>
    // [PROMPT]` takes one ("Optional user prompt to start the session",
    // `codex resume --help` on 0.141.0), and a resume's prompt is only ever the
    // message the spawn chose to carry (a column's message, held messages),
    // never the task prompt again (resolveSpawnIntent).
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      // Unconditionally multiline. A `.cmd` head would truncate this at the
      // first newline (#353), but by here `codexPath` has already been through
      // resolveShimLaunch at the spawn chokepoint, which either swapped in the
      // sibling shim that carries newlines or flattened the prompt itself. The
      // decision is shell and packaging knowledge, not Codex knowledge, so it
      // stays out of this builder and out of the other thirteen.
      parts.push(quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  /**
   * Environment injected into the Codex PTY.
   *
   * Paired with the `env_http_headers` override emitted by
   * `buildCodexCommand`: that flag names this variable, Codex reads it from
   * its own process env at MCP-connect time, and the token stays out of argv.
   * Shares `codexMcpWiringEnabled` with the flag builder so the two can never
   * disagree. Returns null when MCP is off or incompletely configured, which
   * the spawn chokepoints coalesce to "no env override at all".
   */
  buildCodexEnv(options: CodexCommandOptions): Record<string, string> | null {
    if (!codexMcpWiringEnabled(options)) return null;
    return { [KANGENTIC_MCP_TOKEN_ENV]: options.mcpServerToken };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
