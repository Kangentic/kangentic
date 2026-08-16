import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { writeHooksFile, KANGENTIC_EVENTS_PATH_ENV } from './hook-manager';
import { writeMcpConfig, KANGENTIC_MCP_URL_ENV, KANGENTIC_MCP_TOKEN_ENV } from './mcp-config';
import type { PermissionMode } from '../../../../shared/types';

/**
 * Grok Build CLI command builder.
 *
 * Empirically validated against grok 1.0.0 (3cd0d0cbce) via `grok --help`
 * and the shipped user guide:
 *
 *   New session:    grok -s <uuid> --permission-mode <mode> [-m <model>]
 *                        [--reasoning-effort <effort>] -- "<prompt>"
 *   Resume session: grok --resume <uuid> --permission-mode <mode> [...]
 *   Headless:       grok -p "<prompt>" --output-format plain [...]
 *
 * Design notes:
 * - `-s/--session-id <uuid>` names a NEW session only (errors if the UUID
 *   already exists); `--resume <uuid>` resumes an existing one. Identical
 *   semantics to Claude's flags, so `supportsCallerSessionId = true` and
 *   the spawn pipeline pre-generates the UUID.
 * - `--permission-mode` accepts the exact PermissionMode vocabulary
 *   Kangentic uses (`default | plan | acceptEdits | auto | dontAsk |
 *   bypassPermissions`, verified in `grok --help`), so modes pass through
 *   1:1 with no mapping table. (Internally grok normalizes
 *   `acceptEdits`/`dontAsk` onto its own ladder - documented in
 *   10-hooks.md - but the CLI accepts all six as compat values.)
 * - NO `--cwd` flag is emitted. Grok keys its on-disk session store by the
 *   process working directory, URL-encoded byte-for-byte
 *   (`~/.grok/sessions/<encodeURIComponent(cwd)>/`), and the PTY already
 *   spawns in `options.cwd`. Passing a normalized/forward-slashed `--cwd`
 *   would risk keying the store under a DIFFERENT encoding than
 *   `session-paths.ts` computes, silently breaking locate/telemetry.
 * - NO screen-mode flags (`--fullscreen` / `--minimal` / `--no-alt-screen`)
 *   and no `--always-approve`: session-scoped native TUI controls the user
 *   owns (cli-features-over-custom-layers.md). The PTY probe shows grok
 *   picks the fullscreen alt-screen TUI on its own in an embedded terminal.
 * - The prompt is deliberately NOT re-sent on resume: the resumed
 *   conversation already contains it (Claude/Codex convention).
 *
 * Side effects (mirroring Droid's builder): wires the per-cwd hook file and
 * MCP config block before emitting the command - see hook-manager.ts and
 * mcp-config.ts for why both files are static and env-routed.
 */
export interface GrokCommandOptions {
  grokPath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string;
  sessionId?: string;
  resume?: boolean;
  nonInteractive?: boolean;
  /** Accepted for parity; grok has no statusline, so no status.json is wired. */
  statusOutputPath?: string;
  /** Per-session events.jsonl path, delivered to hooks via the PTY env. */
  eventsOutputPath?: string;
  shell?: string;
  /**
   * Whether to attach Kangentic's in-process MCP HTTP server. Default-on
   * (matching Claude, Codex, and Droid): only an explicit `false`
   * suppresses it.
   */
  mcpServerEnabled?: boolean;
  /** Streamable-HTTP endpoint carrying the caller-session id. Delivered via env, never argv or file. */
  mcpServerUrl?: string;
  /** Per-launch MCP token. Delivered via env, never argv or file. */
  mcpServerToken?: string;
  model?: string;
  effort?: string;
}

/**
 * Single gate shared by the MCP config write and `buildGrokEnv`, so the
 * file block and the env values it dereferences can never drift (the
 * pattern `buildenv-adapter-interface-guard.test.ts` enforces across
 * adapters). Default-on (`!== false`), matching Claude/Codex/Droid.
 */
export function grokMcpWiringEnabled(
  options: GrokCommandOptions,
): options is GrokCommandOptions & { mcpServerUrl: string; mcpServerToken: string } {
  return (
    options.mcpServerEnabled !== false
    && Boolean(options.mcpServerUrl)
    && Boolean(options.mcpServerToken)
  );
}

export class GrokCommandBuilder {
  buildGrokCommand(options: GrokCommandOptions): string {
    const { shell } = options;

    // Wire the per-cwd hook file (static, env-routed) whenever this spawn
    // participates in the events pipeline, and the MCP config block
    // whenever the server is attached. Both are idempotent rewrites.
    if (options.eventsOutputPath) {
      writeHooksFile(options.cwd);
    }
    if (grokMcpWiringEnabled(options)) {
      writeMcpConfig(options.cwd);
    }

    const parts: string[] = [quoteArg(options.grokPath, shell)];
    const isResume = Boolean(options.resume && options.sessionId);

    if (isResume) {
      parts.push('--resume', quoteArg(options.sessionId!, shell));
    } else if (options.sessionId) {
      parts.push('-s', quoteArg(options.sessionId, shell));
    }

    parts.push('--permission-mode', options.permissionMode);

    // Pre-approve Kangentic's own MCP tools so a board-driven session never
    // stalls on grok's interactive approval prompt for them (verified live:
    // without this, `kangentic__kangentic_get_current_task` sat on the
    // permission dialog with nobody present to answer). `--allow` with the
    // documented `MCPTool(<server>__<tool>)` rule shape is grok's native
    // permission-rules mechanism; an explicit user deny still wins (deny
    // rules override allow rules). This is the Claude-parity move: Claude's
    // builder injects the `mcp__kangentic` allow rule into its per-session
    // settings for the same reason. Session-scoped (argv only), gated on
    // the same predicate as the MCP wiring so it never fires when the
    // server is not attached.
    if (grokMcpWiringEnabled(options)) {
      parts.push('--allow', quoteArg('MCPTool(kangentic__*)', shell));
    }

    if (options.model && options.model.trim().length > 0) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }
    if (options.effort && options.effort.trim().length > 0) {
      parts.push('--reasoning-effort', quoteArg(options.effort.trim(), shell));
    }

    if (options.nonInteractive && !isResume && options.prompt) {
      // Headless single-turn: prints the response and exits.
      parts.push('-p', this.quotePrompt(options.prompt, shell), '--output-format', 'plain');
      return parts.join(' ');
    }

    if (!isResume && options.prompt) {
      // `--` (end-of-options) prevents prompt content like `--flag` from
      // being parsed as a CLI option regardless of shell quoting behavior.
      parts.push('--', this.quotePrompt(options.prompt, shell));
    }

    return parts.join(' ');
  }

  /**
   * Environment injected into the grok PTY. Three per-session values ride
   * here so that the two on-disk files stay static and shareable:
   *
   * - `KANGENTIC_EVENTS_PATH`: resolved by event-bridge.js's `env:` sentinel
   *   in the hook commands, routing each session's hook events to its own
   *   `events.jsonl` (and making the hooks a silent no-op in the user's own
   *   grok sessions, which lack the variable).
   * - `KANGENTIC_MCP_URL` / `KANGENTIC_MCP_TOKEN`: dereferenced by grok's
   *   documented `${VAR}` expansion inside the `[mcp_servers.kangentic]`
   *   block. The URL carries the caller-session id and the token rotates
   *   per launch, so neither may be written to disk or argv.
   */
  buildGrokEnv(options: GrokCommandOptions): Record<string, string> | null {
    const env: Record<string, string> = {};
    if (options.eventsOutputPath) {
      env[KANGENTIC_EVENTS_PATH_ENV] = options.eventsOutputPath;
    }
    if (grokMcpWiringEnabled(options)) {
      env[KANGENTIC_MCP_URL_ENV] = options.mcpServerUrl;
      env[KANGENTIC_MCP_TOKEN_ENV] = options.mcpServerToken;
    }
    return Object.keys(env).length > 0 ? env : null;
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  private quotePrompt(prompt: string, shell: string | undefined): string {
    // For double-quoted shells (PowerShell, cmd), replace double quotes with
    // single quotes to prevent quoting breakage: quoteArg wraps in "..." and
    // escapes " as \" which PowerShell misinterprets. Single-quoted shells
    // (bash, zsh, WSL) preserve double quotes literally - no replacement.
    const needsDoubleQuoteReplacement = shell
      ? !isUnixLikeShell(shell)
      : process.platform === 'win32';
    const safePrompt = needsDoubleQuoteReplacement
      ? prompt.replace(/"/g, "'")
      : prompt;
    return quoteArg(safePrompt, shell, { multiline: true });
  }
}
