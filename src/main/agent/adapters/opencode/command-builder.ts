import path from 'node:path';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import type { CliTarget } from '../../shared/cli-target';
import { kangenticMcpServer, type KangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { buildHooks } from './hook-manager';
import { isOpenCodeV2, OPENCODE_REMOTE_NEEDS_V1, openCodeSupportsAutoApprove } from './version';
import type { PermissionMode, ResolvedExecutionTarget } from '../../../../shared/types';

export interface OpenCodeCommandOptions {
  opencodePath: string;
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
  mcpServerEnabled?: boolean;
  mcpServerUrl?: string;
  mcpServerToken?: string;
  model?: string;
  effort?: string;
  /**
   * The detected `opencode --version`, or null when detection has not run.
   * Picks the OpenCode 1 or OpenCode 2 command line (`version.ts`).
   */
  cliVersion?: string | null;
  /** Present only when this project's OpenCode execution mode is 'remote'. */
  executionTarget?: ResolvedExecutionTarget;
  /**
   * An OpenCode installed in a WSL distro (`CommandOptions.cliTarget`): started
   * by the path the distro sees, and on NAT networking given Kangentic's server
   * as the WSL hook transport's bridge. The activity plugin needs nothing more:
   * it is a file in the project, which the distro reads at its `/mnt` path, and
   * the spawn hands it `KANGENTIC_EVENTS_PATH` in the distro's form.
   */
  cliTarget?: CliTarget | null;
}

/**
 * Kangentic's server as OpenCode's `mcp` config names it: `remote` with the
 * token header for the loopback URL, or `local` for the WSL hook transport's
 * bridge, whose `command` is the program and its arguments in one array and
 * whose `environment` carries the token (OpenCode's MCP docs).
 */
export function openCodeKangenticMcpEntry(server: KangenticMcpServer): Record<string, unknown> {
  return server.kind === 'stdio'
    ? { type: 'local', command: [server.command, ...server.args], environment: { [server.tokenEnv]: server.token }, enabled: true }
    : { type: 'remote', url: server.url, enabled: true, headers: { 'X-Kangentic-Token': server.token } };
}

/**
 * Whether a spawn installs the activity plugin into the project's
 * `.opencode/plugins/`: a local spawn with an events pipeline. The builder
 * installs it and the adapter holds the project root for it, so both read
 * this one answer. Which plugin is the builder's to pick: OpenCode 2 does not
 * run OpenCode 1 plugins, so a V2 spawn gets its own (`buildHooks`).
 */
export function installsActivityPlugin(options: Pick<OpenCodeCommandOptions, 'eventsOutputPath' | 'executionTarget'>): boolean {
  return Boolean(options.eventsOutputPath) && !options.executionTarget;
}

/**
 * Build the shell command string that spawns OpenCode in interactive
 * TUI mode. CLI surface, OpenCode 1 (verified against /anomalyco/opencode docs):
 *
 *   opencode [--session <id>] [--prompt <text>] [--model <provider/model>]
 *
 * OpenCode 2 (`commands.ts` at v2.2.5) has neither `--agent` nor `--model`
 * on its TUI command, and by default joins or starts ONE background service
 * per user account that reads `OPENCODE_CONFIG_CONTENT` only when it starts.
 * So a V2 spawn is
 *
 *   opencode --standalone [--session <id> | --prompt <text>]
 *
 * `--standalone` gives the TUI a private `opencode serve --stdio` child that
 * inherits this spawn's env and ends when the TUI's stdin pipe to it closes,
 * which the OS does when the TUI dies. The agent and model ride in the
 * inline config instead (`buildOpenCodeEnv`).
 *
 * Important shape constraints:
 *
 * - The TUI's positional argument is a PROJECT DIRECTORY, not a prompt.
 *   Initial prompts must go through `--prompt <text>`, otherwise
 *   OpenCode tries to chdir into the prompt text. The PTY layer already
 *   sets the shell cwd, so we never emit a positional/`--dir` value.
 *
 * - Resume uses `--session <id>` (alias `-s`). The flag is part of the
 *   TUI command (the docs list it under "TUI - Terminal User
 *   Interface"), not the `run` subcommand. A resume carries no
 *   `--prompt`: nothing documents the prompt running on a session the TUI
 *   continues, so the adapter types a resume's message in instead
 *   (`resumePromptDelivery: 'typed'`).
 *
 * - The TUI's auto-approve flag, `--auto` (1.17.12 and later, and OpenCode
 *   2), is passed only for a Bypass column (`passesAutoApprove`), on a fresh
 *   spawn and a resume alike. OpenCode's autonomy model is "agents" (Build, Plan, custom) cycled
 *   at runtime via Tab. We map Kangentic's permission-mode dropdown to
 *   the `--agent <name>` flag for the initial spawn only - resume
 *   preserves the user's runtime Tab selection rather than overriding
 *   it. See `mapPermissionModeToAgent` below for the mode-to-agent
 *   table.
 *
 * - There is no merged settings file and no `--mcp-config` CLI flag.
 *   OpenCode reads MCP and provider config from `opencode.json` (project)
 *   or `~/.config/opencode/opencode.json` (global), plus the
 *   `OPENCODE_CONFIG_CONTENT` env var for inline overrides. The Kangentic
 *   MCP server is wired via `buildOpenCodeEnv()` below, which emits
 *   `OPENCODE_CONFIG_CONTENT` per PTY spawn so we never have to touch
 *   the user's checked-in `opencode.json`. Configs are deep-merged across
 *   sources, so user-defined `mcp.*` entries are preserved.
 */
export class OpenCodeCommandBuilder {
  buildOpenCodeCommand(options: OpenCodeCommandOptions): string {
    const { shell } = options;
    const openCode2 = isOpenCodeV2(options.cliVersion);

    // Remote mode: attach to the user-run server instead of spawning a local
    // session. The server owns providers/models/MCP/tools (per the task's
    // acceptance criteria), so - unlike the local branch below - this never
    // emits --model or installs the activity plugin (there is no local
    // project directory to write it into; the server's filesystem is not
    // ours to touch).
    if (options.executionTarget) {
      // `attach` and the server API remote mode speaks are OpenCode 1's.
      // Thrown, so the spawn is blocked with the reason rather than started
      // with flags OpenCode 2 rejects.
      if (openCode2) throw new Error(OPENCODE_REMOTE_NEEDS_V1);
      return buildOpenCodeAttachCommand(options, options.executionTarget, shell);
    }

    // Install the activity-stream plugin into the project's
    // `.opencode/plugins/` directory before the CLI launches. OpenCode
    // auto-discovers plugins from that directory at TUI startup, so no
    // CLI flag or `opencode.json` mutation is required. Mirrors the
    // `buildHooks` side effect in CodexCommandBuilder.buildCodexCommand.
    if (installsActivityPlugin(options)) {
      const projectRoot = options.projectRoot || options.cwd;
      buildHooks(projectRoot, openCode2);
    }

    const parts: string[] = [quoteArg(options.cliTarget ? options.cliTarget.linuxCliPath : options.opencodePath, shell)];

    // `--auto` is a flag on the TUI process, not a choice the session keeps,
    // so a resume passes it too.
    const autoApprove = passesAutoApprove(options);

    // OpenCode 2's TUI takes no `--agent` or `--model`: a fresh spawn names
    // them in config (`buildOpenCodeEnv`).
    if (openCode2) {
      parts.push('--standalone');
      if (autoApprove) parts.push('--auto');
      if (options.resume && options.sessionId) {
        parts.push('--session', quoteArg(options.sessionId, shell));
      } else if (options.prompt) {
        parts.push('--prompt', quotePrompt(options.prompt, shell));
      }
      return parts.join(' ');
    }

    if (autoApprove) parts.push('--auto');

    if (options.resume && options.sessionId) {
      parts.push('--session', quoteArg(options.sessionId, shell));
      // Resume attaches to the existing OpenCode session with no prompt:
      // the engine types a resume's message in once the TUI is ready
      // (`resumePromptDelivery: 'typed'`). We also
      // do not pass --agent on resume: the saved session already has
      // an active agent and the user may have Tab-switched mid-session.
      // Forcing it here would shadow that runtime choice.
      return parts.join(' ');
    }

    // Map Kangentic's permission-mode dropdown to OpenCode's --agent
    // flag for fresh spawns. Once the TUI is running the user controls
    // autonomy via Tab, so this only sets the initial state.
    const agentName = mapPermissionModeToAgent(options.permissionMode);
    if (agentName) {
      parts.push('--agent', quoteArg(agentName, shell));
    }

    // Per-column model override (format: provider/model, e.g., anthropic/claude-sonnet)
    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }

    if (options.prompt) {
      parts.push('--prompt', quotePrompt(options.prompt, shell));
    }

    return parts.join(' ');
  }

  /**
   * Build env vars that inject the Kangentic MCP server into OpenCode.
   *
   * OpenCode loads config from multiple sources and deep-merges them by
   * key. The `OPENCODE_CONFIG_CONTENT` env var is one of those sources,
   * with higher precedence than the project's `opencode.json`, so the
   * launch-fresh URL + token always win. Because the merge is per-key,
   * any user-defined `mcp.*` entries (filesystem, github, etc.) are
   * preserved alongside our `mcp.kangentic` entry.
   *
   * Schema verified against /anomalyco/opencode docs: remote MCP servers
   * use `type: "remote"` (not Claude's `"http"`), `url`, and optional
   * `headers`. We pass the per-launch token via the `X-Kangentic-Token`
   * header that the in-process MCP HTTP server expects.
   *
   * This only wires MCP for a LOCAL spawn (`opencode [project]`), where
   * the process we spawn is the server itself and legitimately reads its
   * own `OPENCODE_CONFIG_CONTENT` at startup. Returns `null` when there is
   * nothing to say: MCP wiring is disabled or missing its URL or token, and
   * (OpenCode 2 only) the spawn names no agent or model.
   */
  buildOpenCodeEnv(options: OpenCodeCommandOptions): Record<string, string> | null {
    // Remote mode (`options.executionTarget` set): the process Kangentic
    // spawns is `opencode attach <url>`, a stateless HTTP client to a
    // server that was started - and had its config, including any `mcp.*`
    // entries, fixed - independently and earlier. `attach`'s CLI surface
    // has no config-push flags (`--dir`, `--continue`, `--session`,
    // `--fork`, `--username`, `--password` only; verified against
    // `opencode attach --help`), so env vars set on the attach process,
    // including OPENCODE_CONFIG_CONTENT, are never read by the already-
    // running server and cannot wire MCP into it - this holds whether the
    // target host is loopback or genuinely remote. There is currently no
    // way for Kangentic to deliver its MCP tools to a remote OpenCode
    // session; see the `remoteModeCaveat` on the adapter.
    if (options.executionTarget) return null;

    const inlineConfig: Record<string, unknown> = {};
    // OpenCode 2's TUI has no `--agent` or `--model`, so a fresh V2 spawn
    // names them here: `default_agent` and `model` keep their V1 names in V2
    // config, and the standalone server the TUI starts inherits this env.
    // Measured on 2.2.5: `default_agent: "plan"` opens the TUI in Plan. A
    // resume names neither, as the V1 command does, so the session keeps the
    // agent the user last picked with Tab.
    if (isOpenCodeV2(options.cliVersion) && !(options.resume && options.sessionId)) {
      const agentName = mapPermissionModeToAgent(options.permissionMode);
      if (agentName) inlineConfig.default_agent = agentName;
      const model = options.model?.trim();
      if (model) inlineConfig.model = model;
    }

    if (options.mcpServerEnabled && options.mcpServerUrl && options.mcpServerToken) {
      // A distro OpenCode on NAT networking cannot reach this machine's loopback:
      // its server is the bridge, prepared in the session's directory, whose
      // relay the spawn attaches with the session.
      const place = options.cliTarget ?? null;
      const server: KangenticMcpServer = place && options.eventsOutputPath
        ? kangenticMcpServer({ url: options.mcpServerUrl, token: options.mcpServerToken, place, directory: path.dirname(options.eventsOutputPath) })
        : { kind: 'http', url: options.mcpServerUrl, token: options.mcpServerToken };
      // OpenCode 2 reads this V1 shape (a `type` on `mcp.<name>`) and
      // normalizes it to `mcp.servers.<name>` in memory (measured on 2.2.5).
      inlineConfig.mcp = { kangentic: openCodeKangenticMcpEntry(server) };
    }

    if (Object.keys(inlineConfig).length === 0) return null;
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig) };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}

/**
 * Build `opencode attach <url> [--dir <serverPath>] [--username u] [--password p]
 * [--session <id>] [--prompt <text>]`.
 *
 * Verified against /anomalyco/opencode docs: `attach` accepts `--dir`,
 * `--continue`/`-c`, `--session`/`-s`, `--fork`, `--username`/`-u`,
 * `--password`/`-p`. UNVERIFIED (no live server available while building
 * this): whether `attach` also accepts `--prompt` and `--agent`, which are
 * documented only for the local TUI command above. `attach` is described as
 * "connects a terminal to an already running backend server" - the same TUI,
 * so both are passed on a fresh (non-resume) spawn on the reasoning that an
 * unrecognized flag would surface as an immediate, visible spawn error rather
 * than a silent behavior change. If real usage shows otherwise, drop them
 * here rather than adjusting the local branch.
 *
 * No `--model` is ever emitted here: per the task's acceptance criteria the
 * remote server is the authority for providers and models.
 */
function buildOpenCodeAttachCommand(
  options: OpenCodeCommandOptions,
  target: ResolvedExecutionTarget,
  shell?: string,
): string {
  const parts: string[] = [quoteArg(options.cliTarget ? options.cliTarget.linuxCliPath : options.opencodePath, shell), 'attach', quoteArg(target.url, shell)];

  if (target.workingDirectory) {
    parts.push('--dir', quoteArg(target.workingDirectory, shell));
  }
  if (target.auth.kind === 'basic') {
    parts.push('--username', quoteArg(target.auth.username, shell));
    parts.push('--password', quoteArg(target.auth.password, shell));
  }

  if (options.resume && options.sessionId) {
    parts.push('--session', quoteArg(options.sessionId, shell));
    // No prompt on resume, mirroring the local --session resume convention.
    return parts.join(' ');
  }

  const agentName = mapPermissionModeToAgent(options.permissionMode);
  if (agentName) {
    parts.push('--agent', quoteArg(agentName, shell));
  }

  if (options.prompt) {
    parts.push('--prompt', quotePrompt(options.prompt, shell));
  }

  return parts.join(' ');
}

/**
 * The model a command names with `--model`, unquoted, or null. The builder
 * puts `--prompt` last, so only the command before it is read, and prompt
 * text that mentions `--model` is never taken for the flag.
 */
export function openCodeModelFromCommand(command: string): string | null {
  const flags = command.split(/\s--prompt(?:\s|$)/)[0];
  const match = /(?:^|\s)--model\s+(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/.exec(flags);
  const model = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  return model.length > 0 ? model : null;
}

/**
 * Whether a local TUI spawn passes `--auto`: the column's mode is Bypass and
 * the detected CLI has the flag (`openCodeSupportsAutoApprove`). `--auto` is
 * OpenCode's own "auto-approve permissions that are not explicitly denied"
 * (opencode.ai/docs/permissions, `opencode --help` on 1.18.31), so a rule the
 * user wrote as `deny` still holds. `attach` is never given it: nothing
 * documents the flag there.
 */
function passesAutoApprove(options: OpenCodeCommandOptions): boolean {
  return options.permissionMode === 'bypassPermissions' && openCodeSupportsAutoApprove(options.cliVersion);
}

/**
 * A prompt as one `--prompt` argument. A non-Unix shell (cmd.exe, PowerShell)
 * gets its double quotes swapped for single quotes first.
 */
function quotePrompt(prompt: string, shell?: string): string {
  const needsDoubleQuoteReplacement = shell ? !isUnixLikeShell(shell) : process.platform === 'win32';
  const safePrompt = needsDoubleQuoteReplacement ? prompt.replace(/"/g, "'") : prompt;
  return quoteArg(safePrompt, shell, { multiline: true });
}

/**
 * Map Kangentic's `PermissionMode` to the OpenCode primary-agent name
 * passed via `--agent <name>` on fresh spawn.
 *
 *   plan              -> "plan"  (built-in: read-only, no edits/bash)
 *   default           -> null    (omit flag - defer to user's `default_agent` config, falls back to "build")
 *   acceptEdits       -> "build" (built-in: full tool access)
 *   bypassPermissions -> "build" (plus `--auto` where the CLI has it, see `passesAutoApprove`)
 *   dontAsk / auto    -> null    (Claude/Gemini-shaped modes that can leak through; safe to defer)
 *
 * OpenCode's primary agents define their own per-tool permissions, so
 * we do not need to (and should not) inject a global `permission` block.
 * The Tab keybind cycles agents at runtime; this only sets the initial
 * pick. See `runtime.activity.kind = 'hooks_and_pty'` in the adapter
 * for the broader OpenCode integration model.
 */
function mapPermissionModeToAgent(mode: PermissionMode): string | null {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
    case 'bypassPermissions':
      return 'build';
    case 'default':
    case 'dontAsk':
    case 'auto':
    default:
      return null;
  }
}
