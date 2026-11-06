import { identifyGeminiUserSetupFailure } from './startup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';
import { GeminiDetector } from './detector';
import { GeminiCommandBuilder, GEMINI_WSL_HOOK_COPY_NAME } from './command-builder';
import type { RemoteFileDeclaration } from '../../shared/remote-files';
import { removeHooks as removeGeminiHooks } from './hook-manager';
import { ensureWorktreeTrust, removeWorktreeTrust } from './trust-manager';
import { GeminiSessionHistoryParser } from './session-history-parser';
import { parseGeminiTranscript, parseGeminiTranscriptWindow, locateGeminiTranscriptFile, readGeminiTranscriptPage, resolveGeminiTranscriptFile } from './transcript-parser';
import { migrateGeminiProjectData } from './project-relocation';
import { GeminiStatusParser } from './status-parser';
import { discoverGeminiCapabilities } from './capability-discovery';
import { randomUUID } from 'node:crypto';
import { buildSummarizePrompt, titleFromAnswer } from '../../shared/auto-name';
import { SharedFolderHolds } from '../../shared/shared-folder-holds';
import { runCliPrintAnswer, forwardStreamLines, ANSWER_STREAM_OUTPUT_BUDGET } from '../../shared/cli-answer';
import { resolveCliTarget, toStoredCliTarget, type CliPlace } from '../../shared/cli-target';
import { extractGeminiAnswer, geminiAnswerEvents, removeGeminiChat } from './answer-stream';
import type {
  AgentAdapter,
  AgentInfo,
  AnswerFromContextOptions,
  ParsedSubagentUsage,
  ParsedTranscriptWindow,
  SubagentTranscriptSignature,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedTranscript,
  SummarizeOptions,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
} from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SubmissionContextType,
  SubmissionVerifier,
  AgentCapabilities,
  TranscriptToolCounts,
  TranscriptUsage,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';
import { geminiTranscriptToolCounts, geminiTranscriptToolResultTokens, geminiTranscriptUsage } from './transcript-usage';
import { geminiModelDisplayName, modelFromGeminiCommand } from './model-display-name';
import { proveGeminiConversationGone } from './conversation-gone';
import { parseGeminiSubagentUsage, statGeminiSubagentTranscripts } from './subagent-usage';

/** Where a transcript read finds the chat file: a path the caller already has, else the session id and cwd. */
interface TranscriptReadInput {
  transcriptPath?: string | null;
  agentSessionId?: string | null;
  cwd?: string | null;
  place?: CliPlace | null;
}

/** 500 ms polls the spawn-time reader gives Gemini to write its chat file: 30 s. */
const GEMINI_SPAWN_LOCATE_ATTEMPTS = 60;

function geminiRunTranscriptPath(input: TranscriptReadInput): string | null {
  if (input.transcriptPath) return input.transcriptPath;
  if (!input.agentSessionId || !input.cwd) return null;
  return locateGeminiTranscriptFile(input.agentSessionId, input.cwd, input.place ?? null);
}

/**
 * Gemini CLI adapter - wraps GeminiDetector, GeminiCommandBuilder,
 * GeminiStatusParser, and gemini-hook-manager behind the generic
 * AgentAdapter interface.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly name = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly sessionType = 'gemini_agent';
  // `--session-id <uuid>` starts a session under the id Kangentic chose
  // (command-builder.ts; v0.41.0 and later, config.ts v0.66.0). Run headless
  // on 0.66.0: the chat is named for the chosen id (gemini-real-rewind.test.ts).
  readonly supportsCallerSessionId = true;
  /** The resume command carries the prompt (positional, or `-p` when non-interactive). */
  readonly resumePromptDelivery = 'command-line' as const;
  // No `capturesInteractiveSessionId`: the contract keeps it for an agent that
  // takes no chosen id. `runtime.sessionId` still reads the id from the session
  // file, the hook and the shutdown banner; once the chosen id is known a
  // capture is dropped (`SessionIdManager`).
  // The folder's `.gemini/settings.json` names the URL and token as env
  // references, which Gemini expands from the session's own environment
  // (`buildEnv`), so each session reaches its own URL (task #859, measured on
  // 0.64.0).
  readonly kangenticMcp = 'per-session' as const;
  // A background `run_shell_command` (or a Ctrl+B) reports its PID in the
  // result, and an AfterTool `additionalContext` reaches the model
  // (GEMINI_BACKGROUND_COMMAND_SPEC, measured on 0.64.0).
  readonly backgroundCommands = { source: 'hooks', launchHint: true } as const;
  /** A Gemini installed in a WSL distro runs there (#286). */
  readonly supportsWslCli = true;
  /** On a host over SSH the CLI is `gemini` from the host's own login PATH (#913). */
  readonly remoteCliName = 'gemini';
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only Research)' },
    { mode: 'default', label: 'Default (Confirm Actions)' },
    { mode: 'acceptEdits', label: 'Auto Edit (Auto-Approve Edits)' },
    { mode: 'bypassPermissions', label: 'YOLO (Auto-Approve All)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';
  // Gemini CLI scans a bracketed paste for image paths and attaches a match
  // as an `[Image <name>]` chip, quoted or not. Verified against 0.60.0 with
  // png, jpg and gif (bmp chipped too, but the Gemini API does not list bmp,
  // so it is left to the PNG normalization the drop path applies; webp was
  // not probed and takes the same normalization). A path containing a space
  // is turned into an `@"..."` file reference instead of a chip, which Gemini
  // also reads at submit.
  readonly pastedImageNativeExtensions = ['png', 'jpg', 'jpeg', 'gif'];
  // `--include-directories` per directory (command-builder.ts): the CLI's own
  // way to widen the workspace its read tools reach without an approval.
  readonly supportsReadableDirectories = true;
  // Gemini appends every `--resume` of a conversation to one chat file, and
  // each tool call carries its own timestamp, so tool counts and result tokens
  // can be read for one run's window (transcript-usage.ts).
  readonly scopesTranscriptReadsByTime = true;
  // The file-changing built-in tools and the argument naming the file, from
  // https://geminicli.com/docs/tools/file-system/ (last updated Apr 10, 2026):
  // `write_file` (WriteFile) and `replace` (Edit), both by `file_path`.
  readonly fileChangeTools = [
    { tool: 'write_file', pathField: 'file_path' },
    { tool: 'replace', pathField: 'file_path' },
  ] as const;

  private readonly detector = new GeminiDetector();
  private readonly commandBuilder = new GeminiCommandBuilder();
  // Sessions holding `.gemini/settings.json` per folder. Gemini has no
  // per-session settings flag, so the file is shared across concurrent
  // sessions in the same folder, and removeHooks() strips it only when the
  // folder's last session releases. Keyed by session id: see SharedFolderHolds.
  private readonly hookHolds = new SharedFolderHolds();

  /** See `startup-failure.ts`. */
  identifyUserSetupFailure(finalOutput: string): UserSetupMatch | null {
    return identifyGeminiUserSetupFailure(finalOutput);
  }

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  /**
   * What a Gemini on an SSH host edits outside the session folder. The trust file is read and merged
   * by `ensureTrust` (without it Gemini disables MCP), the project settings carry the hooks and the
   * `mcpServers.kangentic` reference entry (the user's own file, merged and stripped), and the hook
   * script copy is what those hooks run. Nothing here holds a token: the settings name the MCP URL
   * and token as `${VAR}` references the session's environment fills.
   */
  remoteFiles(): RemoteFileDeclaration {
    return {
      home: ['.gemini/trustedFolders.json'],
      project: ['.gemini/settings.json', `.kangentic/${GEMINI_WSL_HOOK_COPY_NAME}`],
    };
  }

  async ensureTrust(workingDirectory: string, place?: CliPlace | null): Promise<void> {
    // Gemini DOES have a folder-trust system (this was previously documented
    // here as a no-op because Gemini had none). An untrusted folder disables
    // every configured MCP server, including ours, so pre-trusting the
    // worktree is what makes the Kangentic MCP entry take effect. See
    // trust-manager.ts. A Gemini in a WSL distro is trusted in the distro.
    await ensureWorktreeTrust(workingDirectory, place ?? null);
  }

  /**
   * When no ancestor is already trusted, `ensureTrust` records one entry per
   * task worktree, so `~/.gemini/trustedFolders.json` needs the same cleanup
   * Codex's `config.toml` does or it grows by a dead entry per task forever.
   */
  async onWorktreeRemoved(worktreePath: string, place?: CliPlace | null): Promise<void> {
    await removeWorktreeTrust(worktreePath, place ?? null);
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, model, effort, ...rest } = options;
    const geminiOptions = { geminiPath: agentPath, model, effort, ...rest };
    const command = this.commandBuilder.buildGeminiCommand(geminiOptions);
    // Every spawn that writes the folder-shared .gemini/settings.json (an
    // events pipeline or MCP wiring) holds it until its session releases.
    // Same gate as the sibling Qwen adapter.
    if (this.commandBuilder.shouldWriteMergedSettings(geminiOptions)) {
      this.hookHolds.retain(options.ptySessionId, options.cwd);
    }
    return command;
  }

  /**
   * The MCP URL and token the folder-shared settings file names by reference,
   * delivered through the PTY environment so neither touches disk or argv.
   */
  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    const { agentPath, model, effort, ...rest } = options;
    return this.commandBuilder.buildGeminiEnv({ geminiPath: agentPath, model, effort, ...rest });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: how Gemini exposes activity state and session IDs.
   *
   * - Activity: hook-based primary (Gemini's documented base hook schema
   *   includes activity events), with PTY silence-timer fallback if hooks
   *   fail at runtime. The sessionHistory hook provides the authoritative
   *   model + tokens stream from Gemini's native chat file.
   * - Session ID (fromHook): Gemini's base hook input schema includes
   *   `session_id` (and sometimes camelCase `sessionId`) on every hook stdin.
   * - Session ID (fromOutput): Gemini prints "gemini --resume '<uuid>'" and
   *   "Session ID: <uuid>" in the shutdown summary.
   * - sessionHistory: reads ~/.gemini/tmp/<basename(cwd)>/chats/session-*.json
   *   whole-file on every write to extract model + tokens from the latest
   *   assistant message. See GeminiSessionHistoryParser.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Hook-driven status.json + events.jsonl pipeline. Gemini has no
    // status line (parseStatus returns null), but the event-bridge hook
    // output is parsed via parseEvent so tool_start/idle events drive
    // activity transitions and captureHookSessionIds can fire.
    statusFile: {
      parseStatus: GeminiStatusParser.parseStatus,
      parseEvent: GeminiStatusParser.parseEvent,
      isFullRewrite: false,
    },
    // Its AfterAgent hook reaches the engine as an Idle event.
    reportsTurnEnd: true,
    activity: ActivityDetection.hooksAndPty((data: string) => {
      // Patterns derived from real Gemini 0.37 PTY captures (see
      // tests/unit/agent-pty-detection.test.ts and the .bin fixtures).
      // Gemini's TUI paints box-drawing borders (`╰────╯`) around every
      // interactive surface - the trust dialog, the input prompt, and
      // the auth dialog all close with this border. The presence of a
      // closed box border in a chunk's tail means the TUI has finished
      // painting a frame and is waiting for input.
      const clean = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '');
      return /\u2570[\u2500]+\u256F/.test(clean) || /I'm ready\./.test(clean);
    }),
    sessionId: {
      fromHook(hookContext) {
        try {
          const context = JSON.parse(hookContext);
          const sessionId = context.session_id ?? context.sessionId;
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            console.log(`[gemini] Captured session ID from hook: ${sessionId.slice(0, 16)}...`);
            return sessionId;
          }
          console.warn(`[gemini] SessionStart hookContext missing session_id. Keys: ${Object.keys(context).join(', ')}`);
          return null;
        } catch {
          console.warn('[gemini] Failed to parse SessionStart hookContext');
          return null;
        }
      },
      fromOutput(data) {
        const resumeMatch = data.match(/gemini\s+--resume\s+'?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'?/);
        if (resumeMatch) return resumeMatch[1];
        const headerMatch = data.match(/Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        return headerMatch ? headerMatch[1] : null;
      },
      // Gemini 0.37 neither includes session_id reliably in hook stdin
      // nor prints it in PTY output until shutdown. The only source at
      // runtime is the session JSON file Gemini writes synchronously at
      // session start. This scan is the primary capture path.
      fromFilesystem: GeminiSessionHistoryParser.captureSessionIdFromFilesystem,
    },
    sessionHistory: {
      // With the id chosen at launch the reader attaches at spawn, before
      // Gemini writes its chat file. v0.66.0 writes it in its recording
      // service's initialize (chatRecordingService.ts), which waits on the
      // CLI's boot, so this waits as long as the folder scan capture did
      // (30 s). A capture arriving later is dropped, so nothing else would
      // attach the reader.
      locate: (options) => GeminiSessionHistoryParser.locate({ ...options, maxAttempts: GEMINI_SPAWN_LOCATE_ATTEMPTS }),
      parse: GeminiSessionHistoryParser.parse,
      isFullRewrite: true,
    },
  };

  removeHooks(directory: string, sessionId?: string): void {
    const folder = this.hookHolds.release(sessionId, directory);
    // Null while another session in the folder still needs the file.
    if (folder) removeGeminiHooks(folder);
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Gemini's hook-manager wires its `BeforeAgent` event to EventType.Prompt,
    // but coordinating hook-based paste confirmation with command-injection
    // JSONL parsing is complex. Callers fall back to time-based settle (paste)
    // or time-settle (command-injection).
    return null;
  }

  getExitSequence(): string[] {
    return ['\x03', '/quit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Gemini CLI hides the cursor when its TUI takes over the terminal.
    // Detecting ESC[?25l fires after the shell prompt noise but before
    // the TUI draws the startup banner. This keeps the shell command
    // hidden behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string, place?: CliPlace | null): Promise<string | null> {
    return GeminiSessionHistoryParser.locate({ agentSessionId, cwd, cliTarget: toStoredCliTarget(place ?? null) });
  }

  async parseTranscript(agentSessionId: string, cwd: string, place?: CliPlace | null, reportedPath?: string | null): Promise<ParsedTranscript> {
    const filePath = resolveGeminiTranscriptFile(agentSessionId, cwd, place ?? null, reportedPath);
    if (!filePath) return { entries: [], sourcePath: null };
    const entries = await parseGeminiTranscript(agentSessionId, filePath);
    return { entries, sourcePath: filePath };
  }

  /**
   * One bounded window of the chat file, retaining nothing: the indexer walks
   * the whole conversation with it, and the message trail and a turn end's
   * reply read from it. `attributedMessageIds` is unused: a reply's uuid is its
   * message id, so a copy in a later window updates the same ledger row.
   */
  async parseTranscriptWindow(
    agentSessionId: string,
    cwd: string,
    startByte: number,
    maxBytes: number,
    _attributedMessageIds?: Set<string>,
    place?: CliPlace | null,
    reportedPath?: string | null,
  ): Promise<ParsedTranscriptWindow> {
    const filePath = resolveGeminiTranscriptFile(agentSessionId, cwd, place ?? null, reportedPath);
    if (!filePath) return { entries: [], sourcePath: null, nextByteOffset: startByte, totalBytes: 0, firstByteOffset: startByte, endByte: startByte };
    const window = await parseGeminiTranscriptWindow(agentSessionId, filePath, startByte, maxBytes);
    return { ...window, sourcePath: filePath };
  }

  /** One page of the transcript's history for the Conversation viewer. */
  readTranscriptPage(
    agentSessionId: string,
    cwd: string,
    request: TranscriptPageReadRequest,
    place?: CliPlace | null,
    reportedPath?: string | null,
  ): Promise<TranscriptPageReadResult> {
    return readGeminiTranscriptPage(agentSessionId, resolveGeminiTranscriptFile(agentSessionId, cwd, place ?? null, reportedPath), request);
  }

  /**
   * Whether the conversation's chat file is gone from everywhere Gemini keeps
   * one, so a resume starts fresh from a recap instead of failing
   * (conversation-gone.ts). The reported path is the SessionStart hook's
   * `transcript_path`.
   */
  proveConversationGone(params: {
    agentSessionId: string;
    reportedPaths: ReadonlyArray<string>;
    cwd: string;
    place?: CliPlace | null;
  }): Promise<boolean> {
    return proveGeminiConversationGone(params);
  }

  /** The session's subagent chats under `chats/<session id>/` (subagent-usage.ts). */
  statSubagentTranscripts(agentSessionId: string, cwd: string, place?: CliPlace | null, reportedPath?: string | null): SubagentTranscriptSignature | null {
    return statGeminiSubagentTranscripts(agentSessionId, cwd, place ?? null, reportedPath);
  }

  /** Each subagent reply's tokens for the turn-usage ledger (subagent-usage.ts). */
  parseSubagentUsage(agentSessionId: string, cwd: string, place?: CliPlace | null, reportedPath?: string | null): Promise<ParsedSubagentUsage> {
    return parseGeminiSubagentUsage(agentSessionId, cwd, place ?? null, reportedPath);
  }

  /** Cumulative tokens from the chat file (transcript-usage.ts). */
  async transcriptUsage(input: TranscriptReadInput): Promise<TranscriptUsage | null> {
    const filePath = geminiRunTranscriptPath(input);
    return filePath ? geminiTranscriptUsage(filePath) : null;
  }

  /** Distinct tool calls in the run's window, by tool (transcript-usage.ts). */
  async transcriptToolCounts(input: TranscriptReadInput & { sinceMs?: number | null; untilMs?: number | null }): Promise<TranscriptToolCounts | null> {
    const filePath = geminiRunTranscriptPath(input);
    return filePath ? geminiTranscriptToolCounts(filePath, input.sinceMs, input.untilMs) : null;
  }

  /** Estimated result tokens per tool in the run's window (transcript-usage.ts). */
  async transcriptToolResultTokens(input: TranscriptReadInput & { sinceMs?: number | null; untilMs?: number | null }): Promise<Record<string, number> | null> {
    const filePath = geminiRunTranscriptPath(input);
    return filePath ? geminiTranscriptToolResultTokens(filePath, input.sinceMs, input.untilMs) : null;
  }

  /** The `--model` this command pins, labelled from its id (model-display-name.ts). */
  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    const id = modelFromGeminiCommand(command);
    if (!id) return null;
    return { id, displayName: geminiModelDisplayName(id) ?? id };
  }

  /** A label for a model id learned from telemetry, in Gemini's own word order. */
  modelDisplayName(modelId: string): string | null {
    return geminiModelDisplayName(modelId);
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverGeminiCapabilities(cliPath);
  }

  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    // `/model set <name>` switches the model. A bare `/model <name>` does not:
    // at v0.66.0 the parent command forwards to `manage` and opens the model
    // dialog, ignoring the argument. Without `--persist` the user's saved
    // default is left alone. Source:
    // https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/cli/src/ui/commands/modelCommand.ts
    // and https://geminicli.com/docs/reference/commands/ (Oct 9, 2026).
    if (spec.modelChanged && spec.model) {
      sequence.push(`/model set ${spec.model}`);
    }
    // Gemini has no effort concept, so skip effort handling
    return sequence;
  }

  /**
   * A title on the answer run: plan mode, and the chat it saves removed after.
   * The plain run this replaced kept every title as a chat for 30 days.
   * Measured on the title prompt in an empty folder: a clean title in 3.6 s.
   */
  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    return titleFromAnswer(await this.answerFromContext(buildSummarizePrompt(prompt), cliPath, cwd, options?.model, {
      runDirectory: options?.runDirectory,
      onUsage: options?.onUsage,
    }));
  }

  /**
   * Streams (measured on 0.61.0: `stream-json` writes assistant text as
   * `message` deltas), but does not search. In the runs tried, a headless
   * plan-mode run never registered our MCP tool, not even from a trusted
   * folder with the server marked `trust: true` (the server connected and the
   * tool was "not registered"), and asked to search, the model handed the
   * question to its own `codebase_investigator` subagent. Default mode was
   * tried only with the built-in tools narrowed to `read_file`.
   */
  readonly answerCapabilities = { streaming: true, search: false, model: true, effort: false };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * Gemini's `plan` approval mode is its read-only research mode.
   *
   * `--skip-trust`, because the answer runs in a directory Gemini has never
   * been asked to trust, and without it the headless run stops at the
   * folder-trust check instead of answering (measured: it answered once the
   * flag was added).
   *
   * `--session-id` names the chat Gemini saves, so it can be removed after:
   * Gemini keeps every chat for 30 days with no switch to turn that off.
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
    const onEvent = options?.onEvent;
    const sessionId = randomUUID();
    // A Gemini installed in a WSL distro runs there, and saves its chat there.
    const cliTarget = await resolveCliTarget(cliPath, true);
    try {
      return await runCliPrintAnswer({
        cliPath,
        cliTarget,
        // The model flag is OMITTED when none is chosen: passing an
        // empty value is an error.
        args: [
          '--skip-trust',
          '--output-format', 'stream-json',
          '--approval-mode', 'plan',
          '--session-id', sessionId,
          ...(model ? ['--model', model] : []),
        ],
        prompt,
        cwd,
        extractRaw: extractGeminiAnswer,
        outputBudget: ANSWER_STREAM_OUTPUT_BUDGET,
        ...(onEvent
          ? { onChunk: forwardStreamLines((line) => { for (const event of geminiAnswerEvents(line)) onEvent(event); }) }
          : {}),
      });
    } finally {
      // Best effort, as the other adapters' cleanups are: a registry that
      // holds something other than a folder name must not replace the answer.
      await removeGeminiChat(cwd, sessionId, cliTarget).catch(() => undefined);
    }
  }

  /**
   * Gemini keys per-project data through ~/.gemini/projects.json (path ->
   * slug), with chats/history under ~/.gemini/tmp|history/<slug>/ and trust in
   * ~/.gemini/trustedFolders.json. Rewrite the registry key, markers, and trust
   * entry so sessions stay resumable after a relocation. Best-effort and
   * non-destructive; see migrateGeminiProjectData.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateGeminiProjectData(oldPath, newPath);
  }
}
