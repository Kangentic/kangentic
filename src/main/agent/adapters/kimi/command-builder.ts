import { toForwardSlash, quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import type { PermissionMode } from '../../../../shared/types';
import type { SpawnCommandOptions } from '../../agent-adapter';

/**
 * Build the shell command string for `kimi` invocations.
 *
 * Flag set was captured empirically from `kimi --help` (v1.37.0):
 *   --version / -V               version + exit
 *   --work-dir / -w <DIR>        working directory
 *   --add-dir <DIR>              additional workspace dirs (repeatable)
 *   --session / -S / --resume / -r <ID>   resume session (or pick if no ID)
 *   --continue / -C              resume previous session in work_dir
 *   --config <TEXT>              inline TOML/JSON
 *   --config-file <FILE>         config file path
 *   --model / -m <NAME>          LLM model
 *   --thinking / --no-thinking   thinking mode
 *   --yolo / --yes / -y          auto-approve
 *   --plan                       start in plan mode
 *   --prompt / --command / -p / -c <TEXT>   user prompt
 *   --print                      non-interactive (implicitly adds --yolo)
 *   --output-format <text|stream-json>      with --print
 *   --input-format  <text|stream-json>      with --print + stdin
 *   --final-message              with --print, only print final assistant msg
 *   --quiet                      alias for --print --output-format text --final-message
 *   --wire                       Wire JSON-RPC server (experimental)
 *   --mcp-config-file <FILE>     MCP config file (repeatable)
 *   --mcp-config <TEXT>          MCP config JSON (repeatable)
 *   --skills-dir <DIR>           custom skills dirs (repeatable)
 *   --max-steps-per-turn <N>     loop control
 *   --max-retries-per-step <N>   loop control
 *   --max-ralph-iterations <N>   loop control
 *
 * Subcommands (login/logout/term/acp/info/export/mcp/plugin/vis/web) are
 * orthogonal to the spawn flow and are not assembled here.
 *
 * Empirical notes:
 *   - `--print --output-format stream-json` does NOT take `--quiet`
 *     (validated: kimi rejects "Quiet mode implies output-format text").
 *   - Resume via `-r <uuid>` *appends* to the same `wire.jsonl`. The
 *     parser must therefore use append-mode byte-cursor tracking.
 *   - `--print` implicitly enables `--yolo`, so passing both is benign
 *     but redundant.
 */
export interface KimiCommandOptions extends Omit<SpawnCommandOptions, 'agentPath'> {
  kimiPath: string;
}

/**
 * Map Kangentic's PermissionMode to Kimi's flag set.
 *
 *   plan               → --plan (read-only mode)
 *   bypassPermissions  → --yolo (auto-approve all)
 *   default / acceptEdits / dontAsk / auto → no flag (interactive confirms)
 *
 * Aider/Cursor/Warp use the same coarse mapping. Kimi has no per-tool
 * granularity exposed via flags - the only knobs are --yolo and --plan.
 */
function mapPermissionMode(mode: PermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--plan'];
    case 'bypassPermissions':
      return ['--yolo'];
    case 'default':
    case 'dontAsk':
    case 'acceptEdits':
    case 'auto':
      return [];
  }
}

export class KimiCommandBuilder {
  buildKimiCommand(options: KimiCommandOptions): string {
    const { shell } = options;
    const parts: string[] = [quoteArg(options.kimiPath, shell)];

    // Working directory: Kimi accepts -w / --work-dir. We pass it
    // explicitly so spawning from a different cwd still operates on
    // the task directory. Forward-slash normalize so PowerShell and
    // bash both parse the path correctly.
    parts.push('-w', quoteArg(toForwardSlash(options.cwd), shell));

    // Session resumption. Kimi exposes both `--continue` (resume the
    // previous session for the work_dir) and `--session <id>` /
    // `-r <id>` (resume a specific session by UUID). For both initial
    // creation (caller-owned UUID via Session.create(work_dir,
    // session_id=...)) and resume, Kimi accepts the same `--session
    // <uuid>` form, so the resume flag is irrelevant to the argv shape.
    //
    // We always prefer the ID form: it is unambiguous across
    // reorderings of `kimi.json` and survives the user starting another
    // Kimi session in the same directory between Kangentic spawns.
    if (options.sessionId) {
      parts.push('--session', quoteArg(options.sessionId, shell));
    }

    // Permission mapping (--yolo / --plan / nothing).
    parts.push(...mapPermissionMode(options.permissionMode));

    // Non-interactive print mode produces stream-json which we feed
    // into the wire-parser pipeline. Without this flag the agent
    // expects an interactive TTY.
    if (options.nonInteractive) {
      parts.push('--print', '--output-format', 'stream-json');
    }

    // MCP: Kangentic's in-process MCP HTTP server is exposed by URL,
    // so we synthesize a minimal `--mcp-config` JSON entry. Kimi
    // accepts `--mcp-config <TEXT>` (repeatable) per `kimi --help`.
    // The schema follows fastmcp/Anthropic MCP convention:
    //   { "mcpServers": { "<name>": { "url": "...", "headers": {...} } } }
    if (options.mcpServerEnabled && options.mcpServerUrl) {
      const mcpConfig = {
        mcpServers: {
          kangentic: {
            url: options.mcpServerUrl,
            ...(options.mcpServerToken
              ? { headers: { 'X-Kangentic-Token': options.mcpServerToken } }
              : {}),
          },
        },
      };
      const json = JSON.stringify(mcpConfig);
      // Force single-quote wrapping on Unix shells (default), and
      // double-quote replacement on Windows. JSON contains plenty of
      // double quotes that PowerShell treats as string delimiters.
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safeJson = needsDoubleQuoteReplacement
        ? json.replace(/"/g, "'")
        : json;
      parts.push('--mcp-config', quoteArg(safeJson, shell));
    }

    // Prompt delivery. Empirically `--prompt <TEXT>` is the canonical
    // non-interactive entry point (alias of `-p`, `-c`, `--command`).
    // Aider/Codex append a positional arg, but Kimi's grammar is a
    // typed --prompt option, so we use the explicit flag form.
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push('--prompt', quoteArg(safePrompt, shell));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
