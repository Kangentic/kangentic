import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { buildHooks } from './hook-manager';
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
}

/**
 * Map Kangentic's PermissionMode to Codex CLI sandbox + approval flags.
 *
 * Codex no longer ships `--full-auto`; everything is now expressed via the
 * pair `--sandbox <mode>` and `--ask-for-approval <policy>`. Mappings:
 *   plan        → Safe read-only browsing (model can request escalation)
 *   dontAsk     → Read-only non-interactive (CI; failures returned to model)
 *   default     → Workspace-write, escalate on untrusted commands
 *   acceptEdits → Workspace-write, never ask (replaces old --full-auto)
 *   auto        → Workspace-write, model decides when to ask
 *   bypass      → Dangerous full access (no sandbox, no approval)
 */
function mapPermissionMode(mode: PermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'];
    case 'dontAsk':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
    case 'default':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'untrusted'];
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
 * Measured against codex-cli 0.141.0: the quoted form `url="http://..."`
 * becomes `url=\"http://...\"` after quoteArg's Windows escaping, and
 * PowerShell splits that into multiple argv tokens, so Codex dies with
 * `error: unexpected argument 'http://...\' found`. The form below was
 * verified on PowerShell, cmd, and Git Bash via `codex mcp list --json`, and
 * end to end against a live Kangentic MCP server.
 */
function buildMcpConfigArgs(options: CodexCommandOptions): string[] {
  if (!codexMcpWiringEnabled(options)) return [];
  const { shell } = options;
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

export class CodexCommandBuilder {
  buildCodexCommand(options: CodexCommandOptions): string {
    const { shell } = options;

    // Codex 0.128 redesigned the hook system; the legacy `.codex/hooks.json`
    // we used to write is no longer parsed and now produces a yellow warning
    // banner at session start. `buildHooks` is now a cleanup-only call that
    // strips Kangentic-owned entries from any pre-upgrade legacy file.
    // See hook-manager.ts for the full context. The eventsOutputPath gate
    // is preserved so non-hookable spawns (no events pipeline requested)
    // skip the disk sweep entirely.
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      buildHooks(projectRoot);
    }

    const parts: string[] = [];
    const isResume = Boolean(options.resume && options.sessionId);

    parts.push(quoteArg(options.codexPath, shell));

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

    // Working directory
    parts.push('-C', quoteArg(toForwardSlash(options.cwd), shell));

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

    // Prompt as positional argument. Deliberately skipped when resuming: the
    // resumed conversation already contains it, and re-sending would re-ask
    // the task prompt on every resume.
    if (!isResume && options.prompt) {
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
