import path from 'node:path';
import { GooseDetector } from './detector';
import { interpolateTemplate } from '../../shared/template-utils';
import { runCliPrintAnswer } from '../../shared/cli-answer';
import { resolveCliTarget, type CliPlace } from '../../shared/cli-target';
import type { RemoteFileDeclaration } from '../../shared/remote-files';
import { buildSummarizePrompt, titleFromAnswer } from '../../shared/auto-name';
import { ensureLocalGitExcludes } from '../../shared/git-exclude';
import { SharedFolderHolds } from '../../shared/shared-folder-holds';
import { parseBridgeEventLine } from '../../shared/hook-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import type {
  AgentAdapter,
  AgentInfo,
  ParsedTranscript,
  SpawnCommandOptions,
  SummarizeOptions,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
} from '../../agent-adapter';
import type {
  AgentCapabilities,
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SessionAttachment,
  SessionContext,
  SubmissionContextType,
  SubmissionVerifier,
  TranscriptToolCounts,
  TranscriptUsage,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';
import { GooseProgramStatusParser } from './program-status-parser';
import {
  GOOSE_EVENTS_PATH_ENV,
  GOOSE_PLUGIN_NAME,
  GOOSE_WSL_HOOK_COPY_NAME,
  gooseWindowsHookPath,
  removeGooseHooks,
  writeGooseHooks,
} from './hook-manager';
import { gooseDatabaseStamp, gooseSessionUsage, gooseSessionsDatabasePath, readGooseSession } from './session-store';
import {
  readGooseTail,
  readGooseToolCounts,
  readGooseToolResultTokens,
  readGooseTranscriptPage,
  readGooseTranscriptUsage,
} from './transcript-parser';

/**
 * Goose CLI adapter - integrates Block's Goose agent CLI (`goose`)
 * (https://github.com/aaif-goose/goose) behind the generic AgentAdapter
 * interface.
 *
 * What each part is built from (Goose 1.57.0, the latest release when this was
 * written; none of it was run against a real Goose, which was not installed):
 *
 * - Hooks (`hook-manager.ts`): Goose's hooks guide,
 *   https://goose-docs.ai/docs/guides/context-engineering/hooks . A plugin in
 *   `<cwd>/.agents/plugins/kangentic-goose/` reports session start and end,
 *   each prompt, each tool's start and end, and each turn's end (Stop) to the
 *   event bridge. Goose runs hooks with `sh -c`, so on Windows `buildEnv`
 *   appends Git for Windows' `bin` folder to PATH when no `sh` is on it. With
 *   no Git for Windows at all, activity falls back to the PTY timer.
 * - Waits on the user: Goose 1.56's OSC 7501 program status on the terminal
 *   (`program-status-parser.ts`), since no hook marks a question or approval.
 * - The session store (`session-store.ts`, `transcript-parser.ts`): Goose's logs
 *   guide, https://goose-docs.ai/docs/guides/logs , for the SQLite database's
 *   path, and Goose's source for its tables. It gives the conversation viewer,
 *   the lifetime tokens and tool counts, and the live model, context and cost.
 * - Session resume: Goose takes a caller-supplied session name (`--name`), so
 *   the engine's id is the name (`supportsCallerSessionId = true`) and a resume
 *   is `-r -n <id>`.
 * - Autonomy: the `GOOSE_MODE` env var, not a spawn flag, through `buildEnv`.
 * - Model: `--model` on `goose run` and `goose session`
 *   (https://goose-docs.ai/docs/guides/goose-cli-commands), passed only when a
 *   column names one. Goose has no command that lists models, so the picker is
 *   free-form and the adapter keeps no model list (cli-features-over-custom-layers).
 *
 * Kangentic's MCP server is not wired: `--with-streamable-http-extension` takes
 * a URL and no headers, and the server needs the token in a header.
 */

/**
 * Kangentic permission mode -> Goose `GOOSE_MODE` value. A `Record` over the
 * full `PermissionMode` union makes a newly added mode a compile error here
 * rather than a silent wrong-mode spawn.
 *
 * Goose's four modes, per its published permission-modes docs (2026-09-16),
 * not a live probe:
 * - `chat`: no tools at all. Not "read-only" - the agent cannot read files
 *   either, so a plan-mode Goose session reasons without repo access.
 * - `smart_approve`: file modifications need approval, reads do not.
 * - `approve`: every action needs approval. Stricter than `smart_approve`,
 *   so nothing maps to it: it sits BELOW `default` on the permissiveness
 *   ladder the dropdown is ordered by.
 * - `auto`: modify/create/delete and run shell commands without approval.
 *
 * `acceptEdits` is the case with no faithful target. Everywhere else in
 * Kangentic it means "auto-approve edits, still gate shell commands", and
 * Goose has no such mode: the only way to stop prompting on edits is `auto`,
 * which also stops prompting on shell. Mapping it to `auto` made the SHIPPED
 * DEFAULT (`DEFAULT_APP_CONFIG.agent.permissionMode` is `acceptEdits`,
 * `src/shared/types.ts`) a fully unattended agent that the user never chose,
 * because `resolveEffectivePermissionMode` falls through to the global
 * setting and never consults `permissions` below. So it resolves DOWN to
 * `smart_approve`: prompting on a write is recoverable, an unrequested `rm`
 * is not. `bypassPermissions` remains the explicit opt-in to full autonomy.
 */
const GOOSE_MODE_BY_PERMISSION: Record<PermissionMode, string> = {
  plan: 'chat',
  dontAsk: 'chat',
  default: 'smart_approve',
  acceptEdits: 'smart_approve',
  auto: 'auto',
  bypassPermissions: 'auto',
};

/** How often a live session's row is read for its model, context and cost. */
const GOOSE_USAGE_POLL_MS = 3000;

/** What `attachSession` needs to know about a launch `buildCommand` saw. */
interface GooseSessionLaunch {
  sessionName: string | null;
  place: CliPlace | null;
}

export class GooseAdapter implements AgentAdapter {
  readonly name = 'goose';
  readonly displayName = 'Goose CLI';
  readonly sessionType = 'goose_agent';
  // Goose accepts a caller-supplied session name (`--name`), which we resume
  // with `-r -n <id>`. The engine stores the id it generates and passes it back
  // on resume (transition-engine.ts).
  readonly supportsCallerSessionId = true;
  /** `goose run -r -n <id> -t "<prompt>" -s` carries the prompt into the resumed session. */
  readonly resumePromptDelivery = 'command-line' as const;
  // A Goose installed in a WSL distro runs there. Its hooks publish through the
  // WSL hook transport, its session database stays in the distro and is not
  // read, and it is handed no MCP server, so beyond that the CLI's own path,
  // its `GOOSE_MODE` (which crosses into the distro with the adapter's other
  // variables) and the answer run's target are all it needs.
  readonly supportsWslCli = true;
  // On a remote host over SSH (#913) the CLI is `goose` from the host's login PATH. `GOOSE_MODE` reaches
  // the host as the spawn's environment (`buildEnv`), and its provider settings stay in the host's own
  // Goose config. The activity hooks are a plugin in the project's folder, declared in `remoteFiles`.
  readonly remoteCliName = 'goose';

  /**
   * What a Goose on a remote host has edited on the host (#913): Kangentic's own plugin under
   * `.agents/plugins/kangentic-goose/` (wholly ours, no secret) and the folder's copy of the hook
   * transport's script that its hook commands run there.
   */
  remoteFiles(): RemoteFileDeclaration {
    return {
      home: [],
      project: [
        `.agents/plugins/${GOOSE_PLUGIN_NAME}/plugin.json`,
        `.agents/plugins/${GOOSE_PLUGIN_NAME}/hooks/hooks.json`,
        `.kangentic/${GOOSE_WSL_HOOK_COPY_NAME}`,
      ],
    };
  }
  // Goose maps each entry to a `GOOSE_MODE` value in buildEnv (not a CLI flag),
  // via GOOSE_MODE_BY_PERMISSION above. Three entries, one per distinct Goose
  // mode Kangentic can reach: `chat`, `smart_approve`, `auto`. `acceptEdits` is
  // deliberately NOT offered - Goose has no mode that auto-approves edits while
  // still gating shell commands, so an "Auto Edit" entry could only be a second
  // spelling of one of these three, promising a narrower autonomy than it grants.
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Chat Only, No File Access)' },
    { mode: 'default', label: 'Default (Smart Approve)' },
    { mode: 'bypassPermissions', label: 'Auto (Skip All Approvals)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  /**
   * A pasted image Goose cannot attach from its path is named in an instruction:
   * the developer extension's `read_image` tool opens a file by path (hooks
   * guide, "Tool Input Keys"). Whether a bare path in a paste attaches the image
   * on its own (`pastedImageNativeExtensions`) needs a live probe.
   */
  readonly pastedImageReferenceTemplate = 'Read this image: {path} ';

  /**
   * Goose's file-changing built-in tools and the field naming the file, from the
   * hooks guide's tool input table: `write` {path, content} and `edit` {path,
   * before, after}.
   */
  readonly fileChangeTools = [
    { tool: 'write', pathField: 'path' },
    { tool: 'edit', pathField: 'path' },
  ] as const;

  /**
   * Every message row carries `created_timestamp`, so the tool counts and result
   * tokens read only `[sinceMs, untilMs)`. Goose writes a resumed session's
   * turns to the same session, which is why the scope matters.
   */
  readonly scopesTranscriptReadsByTime = true;

  private readonly detector = new GooseDetector();
  /**
   * Sessions holding the hook plugin, per folder. Every Goose session in a
   * folder shares `<cwd>/.agents/plugins/kangentic-goose/`, so it is removed only
   * when the folder's last session releases.
   */
  private readonly hookHolds = new SharedFolderHolds();
  /** Launches `buildCommand` saw, keyed by PTY session id, for `attachSession`. */
  private readonly sessionLaunches = new Map<string, GooseSessionLaunch>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Goose has no trust mechanism - no-op.
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;

    // Goose runs in the process cwd; there is no start-in-dir flag, so the
    // PTY's cwd (set by the spawn chokepoint) is authoritative and no -C-style
    // flag is passed. A prompt uses `goose run -t <prompt> -s`: process the
    // prompt, then stay interactive so the user can continue the session. A
    // promptless spawn (an ordinary resume, or a plain terminal) opens a bare
    // interactive `goose session`.
    // A Goose in a WSL distro is started by the path the distro sees; the PTY's
    // cwd reaches it as its `/mnt` path.
    const place = options.cliTarget ?? null;
    if (options.ptySessionId) {
      this.sessionLaunches.set(options.ptySessionId, { sessionName: options.sessionId ?? null, place });
    }
    if (options.eventsOutputPath) this.installHooks(options, options.eventsOutputPath, place);

    const parts: string[] = [quoteArg(place ? place.linuxCliPath : options.agentPath, shell)];
    parts.push(options.prompt ? 'run' : 'session');

    // Resume a prior session by its caller-supplied name. The id is the same
    // value passed as --name on the fresh spawn.
    if (options.resume && options.sessionId) {
      parts.push('-r');
    }
    if (options.sessionId) {
      parts.push('-n', quoteArg(options.sessionId, shell));
    }

    // `--model` on both `run` and `session` (Goose CLI commands guide, "Control
    // Options"), only when the column names a model; otherwise Goose uses its
    // own configured `GOOSE_MODEL`. Placed before `-t` so the prompt never
    // reaches `configuredModelFromCommand`'s search.
    const model = options.model?.trim();
    if (model) parts.push('--model', quoteArg(model, shell));

    if (options.prompt) {
      // Non-unix shells (PowerShell, cmd) quote with double quotes, so an
      // embedded double quote in the prompt would close the argument early.
      // Swap them for single quotes, matching the Warp adapter.
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push('-t', quoteArg(safePrompt, shell, { multiline: true }));
      // -s / --interactive: drop into an interactive session after the prompt.
      // Omitted for a nonInteractive spawn_agent action, where `goose run -t`
      // alone is already the headless one-shot form: run the prompt and exit.
      // Leaving -s on would park a fire-and-forget automation in an
      // interactive session that never exits, which is what every sibling
      // adapter avoids by branching here (claude, codex, gemini, qwen, grok,
      // antigravity, copilot, kimi).
      if (!options.nonInteractive) {
        parts.push('-s');
      }
    }

    return parts.join(' ');
  }

  /**
   * Write the hook plugin into the session's folder and hold it there. The
   * plugin and, for a distro Goose, the transport script copy are hidden from
   * git, so they never ride along with an agent's `git add -A`.
   */
  private installHooks(options: SpawnCommandOptions, eventsOutputPath: string, place: CliPlace | null): void {
    ensureLocalGitExcludes(options.cwd, [
      `.agents/plugins/${GOOSE_PLUGIN_NAME}/`,
      ...(place ? ['.kangentic/'] : []),
    ]);
    writeGooseHooks(options.cwd, place ? { place, sessionDirectory: path.dirname(eventsOutputPath) } : null);
    this.hookHolds.retain(options.ptySessionId, options.cwd);
  }

  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    // Goose reads its approval mode from GOOSE_MODE (env or config), not a CLI
    // flag, so the permission dropdown is delivered here.
    //
    // The `?? ` is not dead code. `permission_mode` is an unconstrained TEXT
    // column read back through a bare cast, so the union is a compile-time
    // claim, not a runtime guarantee. Without the fallback an unrecognized
    // value yields `{ GOOSE_MODE: undefined }`, which reaches the PTY env as
    // the literal string "undefined" and makes Goose fall back to its OWN
    // default. Its docs give that default as AUTONOMOUS, so the failure mode
    // is not "ignores the column's permission setting", it is "silently runs
    // unattended". Degrade to this adapter's declared default instead.
    const gooseMode = GOOSE_MODE_BY_PERMISSION[options.permissionMode]
      ?? GOOSE_MODE_BY_PERMISSION[this.defaultPermission];
    const env: Record<string, string> = { GOOSE_MODE: gooseMode };
    // The hook commands read this session's events file from it
    // (`hook-manager.ts`). A distro Goose's hooks publish through the WSL
    // transport, which finds its folder on its own, so a Windows path the
    // distro could not open is not passed.
    if (options.eventsOutputPath && !options.cliTarget) {
      env[GOOSE_EVENTS_PATH_ENV] = options.eventsOutputPath;
      // Goose runs hooks with `sh -c` only, so a Windows terminal without `sh`
      // on PATH gets Git for Windows' `bin` folder appended, or no hook fires.
      if (process.platform === 'win32') Object.assign(env, gooseWindowsHookPath() ?? {});
    }
    return env;
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: the hook plugin's events, with the PTY silence timer as
   * the fallback for a session whose hooks never fire (Windows without `sh` on
   * PATH, or a plugin write that failed). The session id is caller-supplied
   * (see supportsCallerSessionId), so no capture strategy is needed.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Goose's Stop hook fires when it "finishes a turn" (hooks guide), mapped
    // to a real Idle in hook-manager.ts.
    reportsTurnEnd: true,
    activity: ActivityDetection.hooksAndPty(),
    statusFile: {
      parseStatus: () => null,
      parseEvent: parseBridgeEventLine,
      isFullRewrite: false,
    },
    // Goose 1.56+ writes an OSC 7501 program status to the terminal, the one
    // place it says it waits on the user (a question or a permission), which
    // no hook reports. The parser reports only those waits.
    streamOutput: {
      createParser: () => new GooseProgramStatusParser(),
    },
  };

  /**
   * Remove the hook plugin from a folder once its last Goose session releases.
   * With no `sessionId` (project delete's sweep) it is removed at once. The
   * session's launch record goes too: a spawn abandoned before `attachSession`
   * releases its hold here and never reaches the attachment's dispose.
   */
  removeHooks(directory: string, sessionId?: string): void {
    if (sessionId) this.sessionLaunches.delete(sessionId);
    const folder = this.hookHolds.release(sessionId, directory);
    if (folder) removeGooseHooks(folder);
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Goose stores each user turn in its session database, but a verifier is
    // declared only once the store is measured to flush on submit, which needs
    // a live Goose. Callers fall back to time-based settle (paste) or
    // time-settle (command-injection).
    return null;
  }

  getExitSequence(): string[] {
    // Goose's Ctrl+C is CONTEXTUAL (per its published CLI docs, 2026-09-16:
    // "clear the current line if text is entered, interrupt the current request
    // if processing, or exit the session if line is empty"): it clears the line
    // if text is entered, interrupts the request if one is processing, and
    // exits only when the line is already empty. A kill lands mid-turn far more often than at an
    // idle prompt (moving a card to Done while the agent works), where Ctrl+C
    // alone interrupts and leaves the session running until the teardown grace
    // expires and it is force-killed. So interrupt first, then exit explicitly,
    // the same shape Ollama uses for its REPL. Harmless once the process is
    // already gone: `writeExitSequence` swallows the write on a dead PTY.
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Goose streams output immediately; any non-empty data means it is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(_agentSessionId: string, _cwd: string): Promise<string | null> {
    // Goose keeps every session in one shared database, so no file is this
    // session's own: its mtime moves with every other Goose session, and a
    // reader that keyed staleness or a resume check on it would be misled. The
    // transcript methods below read the database by session name instead, and
    // the resume-conversation guard degrades safely to "cannot prove empty".
    return null;
  }

  /**
   * The conversation from Goose's session database (`transcript-parser.ts`). A
   * Goose in a WSL distro keeps its database in the distro, which is not read
   * from Windows (a WAL database over the distro's file share is not safe to
   * open), so its conversation reads as none yet.
   */
  async parseTranscript(agentSessionId: string, _cwd: string, place?: CliPlace | null): Promise<ParsedTranscript> {
    if (place) return { entries: [], sourcePath: null };
    const dbPath = gooseSessionsDatabasePath();
    const { entries, totalPosition } = readGooseTail(dbPath, agentSessionId);
    // The database is shared by every session, so its file size is not this one's.
    return { entries, sourcePath: dbPath, totalPosition };
  }

  /** One page of a session's history for the Conversation viewer; a distro's does not page. */
  async readTranscriptPage(
    agentSessionId: string,
    _cwd: string,
    request: TranscriptPageReadRequest,
    place?: CliPlace | null,
  ): Promise<TranscriptPageReadResult> {
    if (place) return { status: 'unavailable', reason: 'unsupported_agent' };
    return readGooseTranscriptPage(gooseSessionsDatabasePath(), agentSessionId, request);
  }

  /** Lifetime tokens, from the session row's `accumulated_*` sums. */
  async transcriptUsage(input: { agentSessionId?: string | null; place?: CliPlace | null }): Promise<TranscriptUsage | null> {
    if (input.place || !input.agentSessionId) return null;
    return readGooseTranscriptUsage(gooseSessionsDatabasePath(), input.agentSessionId);
  }

  /** Distinct tool calls by name, from the session's `toolRequest` blocks. */
  async transcriptToolCounts(input: {
    agentSessionId?: string | null;
    sinceMs?: number | null;
    untilMs?: number | null;
    place?: CliPlace | null;
  }): Promise<TranscriptToolCounts | null> {
    if (input.place || !input.agentSessionId) return null;
    return readGooseToolCounts(gooseSessionsDatabasePath(), input.agentSessionId, input.sinceMs ?? null, input.untilMs ?? null);
  }

  /** Estimated result tokens per tool name, from the session's `toolResponse` blocks. */
  async transcriptToolResultTokens(input: {
    agentSessionId?: string | null;
    sinceMs?: number | null;
    untilMs?: number | null;
    place?: CliPlace | null;
  }): Promise<Record<string, number> | null> {
    if (input.place || !input.agentSessionId) return null;
    return readGooseToolResultTokens(gooseSessionsDatabasePath(), input.agentSessionId, input.sinceMs ?? null, input.untilMs ?? null);
  }

  /**
   * Live model, context, tokens and cost for a session, read from its row in
   * Goose's session database every few seconds while the session lives. The
   * read is skipped while the database and its WAL are unchanged, and a usage
   * equal to the last one sent is not sent again. A distro Goose's database is
   * not read from Windows, so such a session reports nothing.
   *
   * It runs on main: one read-only, single-row lookup of Goose's own database,
   * the same kind of read OpenCode's session-id capture makes there. It parses
   * no transcript and touches no Kangentic index, which stay in the retrieval
   * worker (`retrieval-out-of-process.md`).
   */
  attachSession(context: SessionContext): SessionAttachment {
    const launch = this.sessionLaunches.get(context.sessionId) ?? null;
    const sessionName = launch?.sessionName ?? null;
    if (!sessionName || launch?.place) {
      return { dispose: () => { this.sessionLaunches.delete(context.sessionId); } };
    }
    const dbPath = gooseSessionsDatabasePath();
    let lastStamp: string | null = null;
    let lastUsage = '';
    const poll = (): void => {
      try {
        const stamp = gooseDatabaseStamp(dbPath);
        if (stamp === null || stamp === lastStamp) return;
        const row = readGooseSession(dbPath, sessionName);
        // The stamp is kept only once the row was read, so a session row Goose
        // has not written yet, or a failed read, is tried again on the next tick
        // rather than waiting for the database to change.
        if (!row) return;
        lastStamp = stamp;
        const usage = gooseSessionUsage(row);
        if (!usage) return;
        const serialized = JSON.stringify(usage);
        if (serialized === lastUsage) return;
        lastUsage = serialized;
        context.applyUsage(usage);
      } catch {
        // A failed read leaves the last usage in place; the next tick tries again.
      }
    };
    const timer = setInterval(poll, GOOSE_USAGE_POLL_MS);
    timer.unref?.();
    poll();
    return {
      dispose: () => {
        clearInterval(timer);
        this.sessionLaunches.delete(context.sessionId);
      },
    };
  }

  /**
   * Goose takes `--model` on every run (Goose CLI commands guide) but has no
   * command that lists the models a provider serves, so the Model field is
   * free-form and no list is kept (cli-features-over-custom-layers).
   */
  async discoverCapabilities(_cliPath: string): Promise<AgentCapabilities> {
    return { supportsModelOverride: true };
  }

  /**
   * The `--model` `buildCommand` passed, shown on the card until the session's
   * row reports its own. Searched only before the prompt's `-t`, so a prompt
   * that mentions `--model` is never read as one. Goose runs any provider's
   * model, so the id is shown as Goose names it.
   */
  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    const promptFlag = command.search(/\s-t\s/);
    const flagRegion = promptFlag === -1 ? command : command.slice(0, promptFlag);
    const match = flagRegion.match(/--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const id = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    return id ? { id, displayName: id } : null;
  }

  /**
   * A task title on the answer run below (read-only `chat` mode, no session
   * kept, only the response printed), as Gemini's and OpenCode's are. Built
   * from Goose's docs, not run against an installed Goose.
   */
  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    return titleFromAnswer(await this.answerFromContext(buildSummarizePrompt(prompt), cliPath, cwd, options?.model));
  }

  readonly answerCapabilities = { streaming: false, search: false, model: true, effort: false };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * `goose run -i -` reads its instructions from STDIN (Goose's documented
   * form for piped input), so a prompt of any size stays off the command line.
   * `--no-session` keeps a question from leaving a session file behind, and
   * `-q` prints only the model's response.
   *
   * Read-only is `GOOSE_MODE=chat`: no tools and no extensions at all. That is
   * exactly what a base answer needs, since the prompt carries the context.
   *
   * From Goose's published docs; not yet run against an installed Goose on the
   * machine this was written on.
   *
   * The prompt, its rules and the retrieval budget are all built upstream and
   * handed over whole; this only decides the CLI's flags.
   */
  async answerFromContext(
    prompt: string,
    cliPath: string,
    cwd: string,
    model?: string | null,
  ): Promise<string> {
    return runCliPrintAnswer({
      cliPath,
      // A Goose installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
      // The model flag is OMITTED when none is chosen: passing an
      // empty value is an error.
      args: ['run', '-i', '-', '--no-session', '-q', ...(model ? ['--model', model] : [])],
      prompt,
      cwd,
      env: { GOOSE_MODE: GOOSE_MODE_BY_PERMISSION.plan },
    });
  }
}
