import path from 'node:path';
import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell, toForwardSlash } from '../../../../shared/paths';
import { isBareShellToken } from '../../../../shared/shell-quote';
import { resolveBridgeScript } from '../../shared/bridge-utils';
import { runCliPrintAnswer } from '../../shared/cli-answer';
import { cliPathForTarget, resolveCliTarget, type CliPlace } from '../../shared/cli-target';
import { prepareWslHookTransport, wslHookEventCommand } from '../../shared/wsl-hook-transport';
import { AiderSessionHistoryParser } from './session-history-parser';
import { createAiderCommandInjectionVerifier } from './command-injection-verifier';
import type { AgentAdapter, AgentInfo, AnswerFromContextOptions, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Characters /bin/sh still reads inside `"`, so an inner `"` cannot hold them.
 * A backslash is live there too, but both paths are forward-slashed first.
 */
const LIVE_IN_DOUBLE_QUOTES = /["$`]/;

/**
 * The idle command Aider runs through its own shell (`subprocess.run` with
 * `shell=True`: cmd.exe on Windows, /bin/sh elsewhere), so it carries a quoting
 * layer of its own inside the argument `quoteArg` builds around it.
 *
 * A path that is a bare shell token needs no inner quotes. Any other path is
 * quoted for the inner shell in a form the outer shell can carry:
 *  - A unix-like outer shell carries `"`: literally inside POSIX and fish
 *    single quotes, and as `\"` inside the double-quoted string quoteArg
 *    writes for nushell. A path holding `"`, `$` or a backtick sends no
 *    command, since /bin/sh would expand or end on it inside `"`.
 *  - PowerShell off Windows carries `'` inside its double quotes, and /bin/sh
 *    reads everything inside `'` literally.
 *  - On Windows, PowerShell and cmd cannot carry the `"` that cmd needs: a
 *    Windows double-quoted argument writes a content `"` as `'` (see
 *    `escapeForDoubleQuotedShell`). Under cmd a C-runtime `\"` would carry a
 *    path with a space, but cmd flips its quote state on that escape, so a `&`
 *    in the path would start a second command.
 *
 * Where no form works this returns null and no command is sent. The prompt
 * regex stays the idle signal, and `--notifications` alone would make Aider
 * fall back to its own desktop notification.
 */
function buildNotificationsCommand(bridgePath: string, eventsPath: string, shell: string | undefined): string | null {
  const outerShellIsUnixLike = shell ? isUnixLikeShell(shell) : process.platform !== 'win32';
  const innerPaths: string[] = [];
  for (const innerPath of [bridgePath, eventsPath]) {
    if (isBareShellToken(innerPath)) {
      innerPaths.push(innerPath);
    } else if (outerShellIsUnixLike) {
      if (LIVE_IN_DOUBLE_QUOTES.test(innerPath)) return null;
      innerPaths.push(`"${innerPath}"`);
    } else if (process.platform !== 'win32') {
      innerPaths.push(`'${innerPath.replace(/'/g, "'\\''")}'`);
    } else {
      return null;
    }
  }
  return `node ${innerPaths.join(' ')} idle`;
}

/**
 * The idle command for an Aider in a WSL distro: the WSL hook transport's
 * `event idle`, which Kangentic hands the event bridge's logic as the node
 * bridge's `idle` call. Aider runs it with `subprocess.run(command, shell=True,
 * capture_output=True)` and passes no stdin, so the command inherits the
 * terminal; the transport reads its stdin into the record, so stdin is closed
 * here or that read would wait on the user's keyboard. Null when the
 * transport cannot be written: the prompt regex stays the idle signal.
 */
function buildWslNotificationsCommand(eventsOutputPath: string, place: CliPlace): string | null {
  try {
    return `${wslHookEventCommand(prepareWslHookTransport(path.dirname(eventsOutputPath)), place, 'idle')} </dev/null`;
  } catch (error) {
    console.warn('[aider] Could not prepare the WSL hook transport; idle falls back to the prompt pattern:', error);
    return null;
  }
}

/**
 * Aider CLI adapter - integrates the Aider AI pair programming tool
 * (https://aider.chat) behind the generic AgentAdapter interface.
 *
 * Aider is simpler than Claude Code: no session resume, no structured
 * status/event output, no trust mechanism, no hooks, and no settings
 * merging. Detection and command building are inlined.
 */
export class AiderAdapter implements AgentAdapter {
  readonly name = 'aider';
  readonly displayName = 'Aider';
  readonly sessionType = 'aider_agent';
  readonly supportsCallerSessionId = false;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Ask (Read-Only Questions)' },
    { mode: 'default', label: 'Code (Confirm Changes)' },
    { mode: 'acceptEdits', label: 'Architect (Two-Model Design)' },
    { mode: 'bypassPermissions', label: 'Auto Yes (Skip Confirmations)' },
  ];
  readonly defaultPermission: PermissionMode = 'bypassPermissions';
  // An Aider installed in a WSL distro runs there: the session starts its
  // Linux path, its idle notification publishes through the WSL hook transport,
  // and an answer run takes its history files in the distro's form. Its chat
  // history is a file in the project folder, which Windows reads as before.
  readonly supportsWslCli = true;

  // Aider uses the shared AgentDetector via composition (keeps the
  // single-file layout while deduplicating detection logic across
  // all four adapters).
  private readonly detector = new AgentDetector({
    binaryName: 'aider',
    // Aider is most commonly installed via `pip install --user`, which puts
    // it in ~/.local/bin (covered by standardUnixFallbackPaths). Homebrew
    // and manual installs in /opt/homebrew/bin, /usr/local/bin are also
    // covered there.
    fallbackPaths: standardUnixFallbackPaths('aider'),
    parseVersion: (raw) => raw.replace(/^aider\s+/i, '').trim() || null,
    // A `\\wsl.localhost\<distro>\...` path is probed inside the distro.
    supportsWslCli: true,
  });

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Aider has no trust mechanism - no-op
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;
    const place = options.cliTarget ?? null;
    const parts: string[] = [quoteArg(place ? place.linuxCliPath : options.agentPath, shell)];

    // --message with shell-safe quoting (only when prompt is provided)
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push('--message', quoteArg(safePrompt, shell, { multiline: true }));
    }

    // Chat mode: plan → ask (read-only), acceptEdits → architect (two-model)
    // default and bypassPermissions use the default code mode (no flag needed)
    if (options.permissionMode === 'plan' || options.permissionMode === 'dontAsk') {
      parts.push('--chat-mode', 'ask');
    } else if (options.permissionMode === 'acceptEdits' || options.permissionMode === 'auto') {
      parts.push('--architect');
    }

    // Auto-approve: --yes skips all confirmation prompts
    if (options.permissionMode === 'bypassPermissions') {
      parts.push('--yes');
    }

    // Prevent Aider from auto-committing (Kangentic manages git)
    parts.push('--no-auto-commits');

    // Suppress shell command suggestions in the terminal. Aider suggests
    // shell commands by default (args.py --suggest-shell-commands=True),
    // which adds noise in Kangentic-managed sessions.
    parts.push('--no-suggest-shell-commands');

    // Restore previous chat context when resuming a task.
    // This isn't session resume (Aider has no session IDs), but it
    // reloads .aider.chat.history.md so the agent remembers prior work.
    if (options.resume) {
      parts.push('--restore-chat-history');
    }

    // Inject --notifications-command to write idle events via event-bridge.
    // Aider fires this when the LLM finishes generating and is waiting for input.
    if (options.eventsOutputPath) {
      const notificationsCommand = place
        ? buildWslNotificationsCommand(options.eventsOutputPath, place)
        : buildNotificationsCommand(
          toForwardSlash(resolveBridgeScript('event-bridge')),
          toForwardSlash(options.eventsOutputPath),
          shell,
        );
      if (notificationsCommand) {
        parts.push('--notifications', '--notifications-command', quoteArg(notificationsCommand, shell));
      }
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: Aider has no hooks and no native session IDs.
   *
   * - Activity: PTY-only. Idle is detected via prompt regex matching
   *   Aider's mode-specific prompts at end of output.
   * - Session ID: omitted - Aider has no resume mechanism.
   * - Session history: parsed from .aider.chat.history.md to extract
   *   session cost and token counts for the session usage card.
   *
   * Prompt format (from aider/io.py get_input): `{edit_format}> `
   * where edit_format varies by mode:
   *   code (default) → `> ` (bare, model default matches so no prefix)
   *   ask            → `ask> `
   *   architect      → `architect> `
   *   help           → `help> `
   *   context        → `context> `
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Only its prompt pattern says a turn ended.
    reportsTurnEnd: false,
    activity: ActivityDetection.pty((data: string) => {
      const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      return /(?:^|\n)\s*(?:architect|ask|help|context)?>\s*$/.test(clean);
    }),
    sessionHistory: {
      locate: (options) => AiderSessionHistoryParser.locate(options),
      parse: (content, mode) => AiderSessionHistoryParser.parse(content, mode),
      isFullRewrite: true,
    },
  };

  // Aider does not use hooks - no-op
  removeHooks(_directory: string): void {}

  getExitSequence(): string[] {
    // Ctrl+C to interrupt, then /exit for graceful shutdown so Aider
    // can flush .aider.chat.history.md before termination.
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Aider writes output immediately (no alternate screen buffer).
    // Any non-empty data means the agent is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return AiderSessionHistoryParser.locate({ agentSessionId, cwd });
  }

  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      // CONFIRM-ONLY. `.aider.chat.history.md` has no per-entry timestamps and
      // is shared per project directory, so the verifier guards on the FILE's
      // mtime and only accepts the LAST user block - see the module comment.
      return createAiderCommandInjectionVerifier();
    }
    // 'paste': Aider exposes no hook or structured signal; the paste engine's
    // activity and data-floor backstops cover it.
    return null;
  }

  /**
   * CONFIRM-ONLY: aider is not installed on the measuring machine, so its flush
   * latency is unmeasured. It may confirm and retry, but must never authorize
   * the restart escalation performs.
   */
  canEscalateOnVerificationFailure(): boolean {
    return false;
  }

  /**
   * Aider has no session id at all - `runtime` declares no `sessionIdCapture`,
   * because it keeps ONE `.aider.chat.history.md` per project directory rather
   * than a per-session transcript. `cwd` alone identifies its history.
   */
  requiresAgentSessionIdForVerification(): boolean {
    return false;
  }

  readonly answerCapabilities = { streaming: false, search: false, model: true, effort: false };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * `--message-file` sends one message from a file and exits, so a prompt of
   * any size stays off the command line. `--chat-mode ask` is Aider's own
   * read-only mode: it answers without editing.
   *
   * The rest keeps a headless run from stopping to ask something it cannot
   * answer, or touching anything: `--no-git` (the scratch directory is not a
   * repository, and Aider would otherwise offer to create one), `--yes` for any
   * other confirmation, `--no-auto-commits`, no update check, no model
   * warnings, and plain unstreamed output.
   *
   * Its history files go in the run directory, not the working directory: the
   * working directory is the answer home every question shares, and Aider
   * APPENDS to `.aider.chat.history.md` and `.aider.input.history` there, so
   * every answer's prompt would pile up in one file. `--no-restore-chat-history`
   * keeps an earlier answer out of this one.
   *
   * From Aider's published options; not yet run against an installed Aider on
   * the machine this was written on, which is why `extractAiderAnswer` strips
   * the status lines Aider is documented to print rather than parsing a format.
   *
   * The prompt, its rules and the retrieval budget are all built upstream and
   * handed over whole; this only decides the CLI's flags.
   */
  async answerFromContext(
    prompt: string,
    cliPath: string,
    cwd: string,
    model?: string | null,
    options?: AnswerFromContextOptions,
  ): Promise<string> {
    const runDirectory = options?.runDirectory ?? cwd;
    // An Aider installed in a WSL distro runs there, and opens its history
    // files by the paths the distro sees.
    const cliTarget = await resolveCliTarget(cliPath, true);
    const historyFile = (fileName: string): string => {
      const windowsPath = path.join(runDirectory, fileName);
      return cliTarget ? cliPathForTarget(windowsPath, cliTarget) : windowsPath;
    };
    return runCliPrintAnswer({
      cliPath,
      cliTarget,
      // The model flag is OMITTED when none is chosen: passing an
      // empty value is an error.
      args: [
        '--chat-mode', 'ask',
        '--no-git',
        '--no-auto-commits',
        '--yes',
        '--no-pretty',
        '--no-stream',
        '--no-check-update',
        '--no-show-model-warnings',
        '--no-suggest-shell-commands',
        '--no-restore-chat-history',
        '--chat-history-file', historyFile('.aider.chat.history.md'),
        '--input-history-file', historyFile('.aider.input.history'),
        ...(model ? ['--model', model] : []),
      ],
      prompt,
      cwd,
      promptVia: 'file',
      promptFileFlag: '--message-file',
      promptDirectory: runDirectory,
      extractRaw: extractAiderAnswer,
    });
  }
}

/**
 * The lines Aider prints before an answer: its version banner, the model and
 * repo summary, and any startup notice.
 */
const AIDER_BANNER_LINE = /^(?:Aider v\d|(?:Main |Editor )?[Mm]odel: .+ with .+ format|Weak model:|Git repo:|Repo-map:|Added .* to the chat|Warning:|Use \/help|https:\/\/aider\.chat)/;
/** The line Aider prints after one: `Tokens: 2.3k sent, 145 received. Cost: ...`. */
const AIDER_TOKENS_LINE = /^Tokens: .* sent, .* received/;

/**
 * The answer between Aider's banner and its token line. Only the ends are
 * trimmed: filtering every line dropped an answer's own "Cost: $136.74 across
 * three sessions", and an answer about task costs writes lines like that.
 */
export function extractAiderAnswer(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && (lines[start].trim() === '' || AIDER_BANNER_LINE.test(lines[start].trim()))) start += 1;
  let end = lines.length;
  while (end > start && (lines[end - 1].trim() === '' || AIDER_TOKENS_LINE.test(lines[end - 1].trim()))) end -= 1;
  return lines.slice(start, end).join('\n').trim();
}
