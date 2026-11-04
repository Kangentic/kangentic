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
import { aiderHistoryPath } from './history-paths';
import { discoverAiderCapabilities } from './capability-discovery';
import { aiderTranscriptUsage, parseAiderTranscript } from './transcript-parser';
import {
  aiderModelDisplayName,
  isBareCostLine,
  parseCostReport,
  parseModelAnnouncement,
  parseTokensReport,
} from './chat-history-markdown';
import type {
  AgentAdapter,
  AgentInfo,
  AnswerFromContextOptions,
  ParsedTranscript,
  SettingsChangeSpec,
  SpawnCommandOptions,
} from '../../agent-adapter';
import type {
  AgentCallUsage,
  AgentCapabilities,
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SubmissionContextType,
  SubmissionVerifier,
  TranscriptUsage,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Characters /bin/sh still reads inside `"`, so an inner `"` cannot hold them.
 * A backslash is live there too, but both paths are forward-slashed first.
 */
const LIVE_IN_DOUBLE_QUOTES = /["$`]/;

/** Any C0 control character or DEL, none of which belongs in a typed command. */
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

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
 * Aider has no session ids of its own, and no hooks, MCP client, trust
 * mechanism or settings merge. What it does have, and what this adapter builds on, is a markdown
 * chat history whose path the caller chooses and which a later run can
 * restore. Each Kangentic session gets its own history file (see
 * `history-paths.ts`), which carries the conversation, the model and the
 * tokens and cost of every message. Everything here is built from Aider's
 * published options and source (v0.86.1). Every flag it sends is checked
 * against a real `aider --help` capture (0.86.2); no Aider session has been
 * run against it.
 */
export class AiderAdapter implements AgentAdapter {
  readonly name = 'aider';
  readonly displayName = 'Aider';
  readonly sessionType = 'aider_agent';
  /**
   * The engine mints the id, and it names the session's history file
   * (`--chat-history-file`). Aider never sees it as an id.
   */
  readonly supportsCallerSessionId = true;
  /**
   * A resume restores the history (`--restore-chat-history`) and carries its
   * message on `--message`, which replies once and exits ("process reply then
   * exit (disables chat mode)", https://aider.chat/docs/config/options.html),
   * the same one-shot run a fresh start makes. Not `typed`: a typed message
   * waits only for the PTY to go quiet, and Aider sits quiet at a confirm prompt
   * (`(Y)es/(N)o`), which would take the message as its answer. A resume with
   * no message opens the restored conversation interactive.
   */
  readonly resumePromptDelivery = 'command-line' as const;
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

  // Detection is the shared AgentDetector, by composition.
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

    // The column's model and effort, ahead of the prompt so
    // configuredModelFromCommand never reads a `--model` out of task text.
    // `--model MODEL` and `--reasoning-effort VALUE`:
    // https://aider.chat/docs/config/options.html (Aider v0.86.1).
    if (options.model) parts.push('--model', quoteArg(options.model, shell));
    if (options.effort) parts.push('--reasoning-effort', quoteArg(options.effort, shell));

    // The session's own chat history (`--chat-history-file`), by absolute path
    // in the form the CLI opens it: a WSL Aider gets the distro's path. A
    // session with no id keeps Aider's default file.
    if (options.sessionId) {
      const historyPath = cliPathForTarget(aiderHistoryPath(options.cwd, options.sessionId), place);
      parts.push('--chat-history-file', quoteArg(historyPath, shell));
    }

    // --message with shell-safe quoting, on a fresh start and on a resume
    // (`resumePromptDelivery`): either way one reply, then Aider exits.
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

    // Auto-approve: `--yes-always` "Always say yes to every confirmation". The
    // flag has no `--yes` alias in aider/args.py; `--yes` only worked as an
    // argparse prefix abbreviation.
    if (options.permissionMode === 'bypassPermissions') {
      parts.push('--yes-always');
    }

    // Prevent Aider from auto-committing (Kangentic manages git)
    parts.push('--no-auto-commits');

    // Suppress shell command suggestions in the terminal. Aider suggests
    // shell commands by default (args.py --suggest-shell-commands=True),
    // which adds noise in Kangentic-managed sessions.
    parts.push('--no-suggest-shell-commands');

    // Resume: `--restore-chat-history` "Restore the previous chat history
    // messages" from the history file above, which holds only this
    // conversation (https://aider.chat/docs/config/options.html).
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
   * Runtime strategy: Aider has no hooks and no session ids of its own; the
   * id is caller-owned.
   *
   * - Activity: PTY-only. Idle is detected via prompt regex matching
   *   Aider's mode-specific prompts at end of output. The notifications
   *   command is not a turn-end signal: Aider rings it at the first wait after
   *   each LLM response, which can be a confirm prompt mid-turn (aider/io.py
   *   `ring_bell`, called from `get_input`, `confirm_ask` and `prompt_ask`).
   * - Session ID: omitted. The id is caller-owned (`supportsCallerSessionId`),
   *   so the history reader attaches at spawn with it.
   * - Session history: the session's own chat history markdown, for the
   *   model, tokens and cost on the usage card.
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
    // can flush its chat history file before termination.
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

  /** The session's chat history as a conversation (see `transcript-parser.ts`). */
  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    return parseAiderTranscript(agentSessionId, cwd);
  }

  /** The history records each run's start only, never a time per message. */
  readonly transcriptHasTimestamps = false;

  /** Every `Tokens:` report in the session's history, added up. */
  async transcriptUsage(input: { agentSessionId?: string | null; cwd?: string | null }): Promise<TranscriptUsage | null> {
    if (!input.agentSessionId || !input.cwd) return null;
    return aiderTranscriptUsage(input.agentSessionId, input.cwd);
  }

  /** Whether `--model` is in `aider --help` (see `capability-discovery.ts`). */
  async discoverCapabilities(cliPath: string, forceRefresh?: boolean): Promise<AgentCapabilities> {
    return discoverAiderCapabilities(cliPath, forceRefresh);
  }

  /**
   * The `--model` the builder put on the command, so the card names the model
   * before Aider's announcement reaches the history. Only the region before
   * `--message` is read, so a prompt quoting `--model` is never taken for it.
   */
  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    const messageFlag = command.search(/\s--message\s/);
    const flagRegion = messageFlag === -1 ? command : command.slice(0, messageFlag);
    const match = flagRegion.match(/\s--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const id = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    if (!id) return null;
    return { id, displayName: aiderModelDisplayName(id) };
  }

  /**
   * A Command Terminal's live swap: `/model <name>` "Switch the Main Model to a
   * new LLM" and `/reasoning-effort <level>` "Set the reasoning effort level"
   * (https://aider.chat/docs/usage/commands.html, Aider v0.86.1).
   *
   * A value carrying a control character is dropped: a `\r` would end the
   * command line and submit the rest as another Aider input, such as `/run`.
   */
  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    if (spec.modelChanged && spec.model && !CONTROL_CHARACTER.test(spec.model)) {
      sequence.push(`/model ${spec.model}`);
    }
    if (spec.effortChanged && spec.effort && !CONTROL_CHARACTER.test(spec.effort)) {
      sequence.push(`/reasoning-effort ${spec.effort}`);
    }
    return sequence;
  }

  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      // CONFIRM-ONLY. The chat history has no per-entry timestamps, so the
      // verifier guards on the FILE's mtime and only accepts the LAST user
      // block - see the module comment.
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
   * A task session's history is the file its id names; a session with no id
   * (a Command Terminal) writes Aider's shared default file, which `cwd` alone
   * identifies. The verifier reads whichever applies, so it needs no id.
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
   * repository, and Aider would otherwise offer to create one), `--yes-always`
   * for any other confirmation, `--no-auto-commits`, no update check, no model
   * warnings, and plain unstreamed output.
   *
   * What the run cost goes to `options.onUsage`, read from the `Tokens:` and
   * `Cost:` report Aider prints after the answer (`aiderAnswerUsage`).
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
        '--yes-always',
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
      extractRaw: (stdout) => {
        const onUsage = options?.onUsage;
        if (onUsage) {
          const usage = aiderAnswerUsage(stdout);
          if (usage) onUsage(usage);
        }
        return extractAiderAnswer(stdout);
      },
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

/** Where an answer run's stdout splits into banner, answer and usage report. */
interface AiderAnswerLayout {
  lines: string[];
  /** First answer line; everything before it is banner. */
  start: number;
  /** One past the last answer line; everything from it on is the usage report. */
  end: number;
}

function layoutAiderAnswer(stdout: string): AiderAnswerLayout {
  const lines = stdout.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && (lines[start].trim() === '' || AIDER_BANNER_LINE.test(lines[start].trim()))) start += 1;
  let end = lines.length;
  while (end > start) {
    const last = lines[end - 1].trim();
    // A bare `Cost:` line is the report's second half only right after its first.
    const previousIsTokensReport = end - 2 >= start && AIDER_TOKENS_LINE.test(lines[end - 2].trim());
    if (last === '' || AIDER_TOKENS_LINE.test(last)) {
      end -= 1;
    } else if (isBareCostLine(last) && previousIsTokensReport) {
      end -= 2;
    } else {
      break;
    }
  }
  return { lines, start, end };
}

/**
 * The answer between Aider's banner and its token line. Only the ends are
 * trimmed: filtering every line dropped an answer's own "Cost: $136.74 across
 * three sessions", and an answer about task costs writes lines like that.
 */
export function extractAiderAnswer(stdout: string): string {
  const { lines, start, end } = layoutAiderAnswer(stdout);
  return lines.slice(start, end).join('\n').trim();
}

/**
 * What an answer run cost, from the lines Aider printed around the answer: the
 * banner's `Model:` announcement and the trailing `Tokens:` / `Cost:` report
 * (formats in `chat-history-markdown.ts`). `sent` is reported as input tokens,
 * as Aider reports it: the prompt tokens of the call, which may include cached
 * ones. Null when no `Tokens:` report was printed.
 */
export function aiderAnswerUsage(stdout: string): AgentCallUsage | null {
  const { lines, start, end } = layoutAiderAnswer(stdout);
  let model: string | null = null;
  for (const line of lines.slice(0, start)) model = parseModelAnnouncement(line) ?? model;
  const report = lines.slice(end).map((line) => line.trim()).filter(Boolean).join(' ');
  const tokens = parseTokensReport(report);
  if (!tokens) return null;
  const cost = parseCostReport(report);
  return {
    model,
    inputTokens: tokens.sent,
    cacheCreationInputTokens: tokens.cacheWrite,
    cacheReadInputTokens: tokens.cacheHit,
    outputTokens: tokens.received,
    costUsd: cost ? cost.messageUsd : null,
  };
}
