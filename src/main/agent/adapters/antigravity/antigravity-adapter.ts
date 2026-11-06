import { identifyAntigravityUserSetupFailure } from './startup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';
import fs from 'node:fs';
import { AntigravityDetector } from './detector';
import { AGY_SESSION_SETTINGS_FILE, AntigravityCommandBuilder, antigravityMcpWiringEnabled } from './command-builder';
import { removeHooks as removeAntigravityHooks } from './hook-manager';
import { ensureWorkspaceTrust, removeWorkspaceTrust } from './trust-manager';
import { migrateAntigravityProjectData } from './project-relocation';
import { AntigravityStatusParser } from './status-parser';
import { discoverAntigravityCapabilities } from './capability-discovery';
import {
  createAntigravityInjectionVerifier,
  locateAntigravityTranscriptFile,
  parseAntigravityTranscript,
  parseAntigravityTranscriptFile,
  readAntigravityTranscriptPage,
} from './transcript-parser';
import { antigravityTranscriptPath } from './data-paths';
import { runAntigravityPrint } from './print-runner';
import { buildSummarizePrompt, cleanSummarizeOutput } from '../../shared/auto-name';
import { forwardStreamLines, runCliPrintAnswer, ANSWER_STREAM_OUTPUT_BUDGET } from '../../shared/cli-answer';
import { SharedFolderHolds } from '../../shared/shared-folder-holds';
import type { RemoteFileDeclaration } from '../../shared/remote-files';
import { parseWslCliPath, peekCliTarget, placeFromStored, resolveCliTarget, type CliPlace } from '../../shared/cli-target';
import { openStdinJsonSession } from '../../shared/answer-session/stdin-json-session';
import {
  antigravityAnswerEvents,
  antigravityStreamConversationId,
  antigravityStreamUsage,
  isAntigravityResultLine,
  removeAntigravityConversation,
} from './answer-stream';
import type {
  AgentAdapter,
  AgentInfo,
  AnswerFromContextOptions,
  AnswerSession,
  AnswerSessionInput,
  ParsedTranscript,
  SettingsChangeSpec,
  SpawnCommandOptions,
  SummarizeOptions,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
} from '../../agent-adapter';
import type {
  AgentCapabilities,
  AgentLiveTelemetryUnsupported,
  AgentPermissionEntry,
  AdapterRuntimeStrategy,
  PermissionMode,
  PerToolStat,
  SubmissionContextType,
  SubmissionVerifier,
  TranscriptToolCounts,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

const CONVERSATION_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Hoisted: sessionId.fromOutput runs on every raw PTY chunk until capture
// lands (and for the no-hook fallback spawns, for the session's lifetime),
// so the patterns compile once here rather than per chunk.
const SHUTDOWN_CONVERSATION_RE = new RegExp(`agy\\s+--conversation=(${CONVERSATION_UUID})`);
const PRINT_CONVERSATION_RE = new RegExp(`"conversation_id"\\s*:\\s*"(${CONVERSATION_UUID})"`);
// Fallback for a truncated hookContext (the bridge caps the serialized
// payload at 2048 chars, and agy's PreInvocation payload carries the full
// prompt, so a long task description can push conversationId's JSON past
// clean parseability even though the field itself made the cut).
const HOOK_CONVERSATION_RE = new RegExp(`"conversationId"\\s*:\\s*"(${CONVERSATION_UUID})"`);

/**
 * Google Antigravity CLI (`agy`) adapter. Verified against a real agy 1.1.13
 * install (2026-08-16, the E1/E2/E3 rig runs): hooks, trust,
 * MCP-via-workspace-plugin, `--conversation` resume, the brain-dir
 * transcript, print mode, and the double-Ctrl+C exit. Built later from agy's
 * documentation and its 1.4.12 `--help`, and not yet run against a real agy:
 * the per-session status line, SessionStart and every-tool PreToolUse hooks,
 * `--mode auto`, help-derived effort levels, the live `/model` and `/effort`
 * swap, and the warm answer session (docs/integrations/agents/antigravity.md
 * lists each with its source). Antigravity shares `~/.gemini` with the Gemini
 * CLI but keeps its own subtree, its own trust store, and a different hook/MCP
 * schema - hence a sibling adapter rather than a Gemini variant.
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly name = 'antigravity';
  readonly displayName = 'Antigravity CLI';
  readonly sessionType = 'antigravity_agent';
  // No flag pre-assigns a NEW conversation id; agy allocates one lazily at
  // the first turn and Kangentic captures it (hooks / PTY scrape).
  readonly supportsCallerSessionId = false;
  /** `--conversation <id>` with `-i` (or `-p` when non-interactive) carries the prompt. */
  readonly resumePromptDelivery = 'command-line' as const;
  // Its hook at the first turn and the shutdown summary (`runtime.sessionId`).
  readonly capturesInteractiveSessionId = true;
  // The literal URL and token go into the folder's
  // `.agents/plugins/kangentic/mcp_config.json`.
  readonly kangenticMcp = 'shared-folder' as const;
  /** An agy installed in a WSL distro runs there (#286). */
  readonly supportsWslCli = true;
  /** On a remote host over SSH the CLI is `agy` from the host's own login PATH (#913). */
  readonly remoteCliName = 'agy';
  // Mapped onto agy's native modes in the command builder
  // (https://antigravity.google/docs/cli/modes): --mode plan / accept-edits /
  // auto, and --dangerously-skip-permissions. No flag leaves agy in the mode
  // its own settings save, `auto` where the sandbox and the account allow it.
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only Research)' },
    { mode: 'default', label: 'Default (Saved Agent Mode)' },
    { mode: 'acceptEdits', label: 'Accept Edits (Auto-Approve Edits)' },
    { mode: 'auto', label: 'Auto (Sandbox + Review)' },
    { mode: 'bypassPermissions', label: 'Skip Permissions (Auto-Approve All)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';
  /**
   * The status line's `quota` buckets are account-wide plan quotas
   * (statusline doc), reported as rate-limit windows by `parseStatus`. Main
   * stamps them with this agent, so the pill shows them only on agy sessions.
   */
  readonly reportsRateLimits = true;
  /**
   * The tools that change a file, each by the argument naming it. The names are
   * the hooks reference's tool list (https://antigravity.google/docs/hooks);
   * `TargetFile` is the argument agy's `write_to_file` call carries in its
   * transcript (measured on 1.1.13) and the one the hook detail reads first.
   */
  readonly fileChangeTools = [
    { tool: 'write_to_file', pathField: 'TargetFile' },
    { tool: 'replace_file_content', pathField: 'TargetFile' },
    { tool: 'multi_replace_file_content', pathField: 'TargetFile' },
  ] as const;

  private readonly detector = new AntigravityDetector();
  private readonly commandBuilder = new AntigravityCommandBuilder();
  // Sessions holding `.agents/hooks.json` and the MCP plugin dir per folder.
  // agy reads hooks and MCP servers only from the folder (`--settings` takes
  // settings.json keys, which carry neither), so both are shared across
  // concurrent sessions in one cwd; removeHooks() only strips them when the
  // folder's last session releases. See SharedFolderHolds.
  private readonly hookHolds = new SharedFolderHolds();

  /**
   * What an agy on a remote host has edited on the host (#913): the trust store (ensureTrust), the
   * workspace hooks file (merged with the user's own) and the Kangentic MCP plugin, wholly ours. The
   * plugin's `mcp_config.json` holds the session's MCP token in plaintext, so it is written owner-only.
   */
  remoteFiles(): RemoteFileDeclaration {
    const mcpConfig = '.agents/plugins/kangentic/mcp_config.json';
    return {
      home: ['.gemini/antigravity-cli/settings.json'],
      project: ['.agents/hooks.json', '.agents/plugins/kangentic/plugin.json', mcpConfig],
      private: [mcpConfig],
    };
  }

  /**
   * The per-session settings file `--settings` names (the status line that reports live telemetry). It
   * sits in the session's folder here, so the relay sends it to the same place on the host; a spawn
   * that wrote none sends nothing.
   */
  remoteSessionFiles(): readonly string[] {
    return [AGY_SESSION_SETTINGS_FILE];
  }

  /** See `startup-failure.ts`. */
  identifyUserSetupFailure(finalOutput: string): UserSetupMatch | null {
    return identifyAntigravityUserSetupFailure(finalOutput);
  }

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async discoverCapabilities(cliPath: string, forceRefresh?: boolean): Promise<AgentCapabilities> {
    return discoverAntigravityCapabilities(cliPath, forceRefresh);
  }

  async ensureTrust(workingDirectory: string, place?: CliPlace | null): Promise<void> {
    // Pre-seeding `trustedWorkspaces` skips the TUI's first-run workspace
    // trust confirmation, which would otherwise block an automated spawn. An
    // agy in a WSL distro is trusted in the distro's settings.
    await ensureWorkspaceTrust(workingDirectory, place ?? null);
  }

  /** Symmetric cleanup so trustedWorkspaces does not grow a dead entry per task. */
  async onWorktreeRemoved(worktreePath: string, place?: CliPlace | null): Promise<void> {
    await removeWorkspaceTrust(worktreePath, place ?? null);
  }

  /** Trust + `-c` continuity follow a moved project/worktree path. */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateAntigravityProjectData(oldPath, newPath);
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    const agyOptions = { agyPath: agentPath, ...rest };
    const command = this.commandBuilder.buildAntigravityCommand(agyOptions);
    // The build writes hooks.json for an events pipeline and the MCP plugin
    // dir for MCP wiring; either one holds the folder until this session
    // releases.
    if (options.eventsOutputPath || antigravityMcpWiringEnabled(agyOptions)) {
      this.hookHolds.retain(options.ptySessionId, options.cwd);
    }
    return command;
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  removeHooks(directory: string, sessionId?: string): void {
    const folder = this.hookHolds.release(sessionId, directory);
    // Null while another session in the folder still needs the hooks.
    if (folder) removeAntigravityHooks(folder);
  }

  /**
   * Seed the board card's model pill from a `--model <slug>` override before
   * telemetry could report it - which for Antigravity never comes (no usage
   * channel), making this the model pill's ONLY source.
   */
  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    // Search only the flag region before the prompt. agy has no end-of-options
    // marker; the builder delivers the prompt exclusively via `-i`/`-p`, and no
    // flag it emits before that point collides, so the first bare `-i`/`-p`
    // token bounds the flags. Without this a task text containing a literal
    // `--model <word>` would seed a bogus model pill that nothing ever
    // corrects (no live telemetry channel).
    const promptFlag = command.search(/\s-(?:i|p)\s/);
    const flagRegion = promptFlag === -1 ? command : command.slice(0, promptFlag);
    const match = flagRegion.match(/--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const id = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!id) return null;
    return { id, displayName: antigravityModelDisplayName(id) };
  }

  /**
   * Double Ctrl+C: the first prints "press ctrl+c again to exit" (or cancels
   * a running turn), the second exits gracefully - flushing
   * `last_conversations.json` and printing the shutdown summary whose
   * `agy --conversation=<uuid>` line the fromOutput scraper reads. Verified
   * against 1.1.13. The CLI reference now lists `/exit` (alias `/quit`), but
   * typed keys are safe only where measured, so the measured pair stays.
   */
  getExitSequence(): string[] {
    return ['\x03', '\x03'];
  }

  /**
   * The TUI's first paint (logo + "Welcome to the Antigravity CLI") arrives
   * as one burst well under a second after spawn. Any nonempty chunk after
   * the shell handoff means the CLI is drawing.
   */
  detectFirstOutput(data: string): boolean {
    return data.length > 0;
  }

  async locateSessionHistoryFile(agentSessionId: string, _cwd: string, place?: CliPlace | null): Promise<string | null> {
    // The transcript of an agy on a remote host is on the host; this computer's mirror of its home
    // never holds it, so polling would only wait.
    if (place?.kind === 'ssh') return null;
    // The brain-dir transcript appears when the first turn starts; poll
    // briefly since callers locate right after id capture.
    for (let attempt = 0; attempt < 10; attempt++) {
      const located = locateAntigravityTranscriptFile(agentSessionId, place ?? null);
      if (located) return located;
      await sleep(500);
    }
    return null;
  }

  async parseTranscript(agentSessionId: string, cwd: string, place?: CliPlace | null): Promise<ParsedTranscript> {
    return parseAntigravityTranscript(agentSessionId, cwd, place ?? null);
  }

  /** One page of the transcript's history for the Conversation viewer. */
  readTranscriptPage(
    agentSessionId: string,
    _cwd: string,
    request: TranscriptPageReadRequest,
    place?: CliPlace | null,
  ): Promise<TranscriptPageReadResult> {
    return readAntigravityTranscriptPage(agentSessionId, antigravityTranscriptPath(agentSessionId, place ?? null), request);
  }

  // No `parseTranscriptWindow`: the conversation indexer resumes a windowed
  // walk from a stored byte offset and chunks every window's entries, which
  // assumes an append-only file. agy writes steps out of order and more than
  // once (last write wins) and rewrites the transcript on compaction
  // (CHANGELOG 1.1.13), so a walk would index a re-emitted step twice and
  // resume into a rewritten file. The bounded tail parse stays the reader.

  /**
   * Cumulative tool-call counts read off the brain-dir transcript, so a
   * parked/suspended session's rollup does not report 0. Counts tool_use
   * blocks (each `tool_calls` entry of each PLANNER_RESPONSE step);
   * durations/interruptions are not derivable from the transcript.
   */
  async transcriptToolCounts(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    place?: CliPlace | null;
  }): Promise<TranscriptToolCounts | null> {
    const transcriptPath = input.transcriptPath
      ?? (input.agentSessionId ? antigravityTranscriptPath(input.agentSessionId, input.place ?? null) : null);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

    const parsed = await parseAntigravityTranscriptFile(transcriptPath);

    const byTool = new Map<string, number>();
    let toolCallCount = 0;
    for (const entry of parsed.entries) {
      if (entry.kind !== 'assistant') continue;
      for (const block of entry.blocks) {
        if (block.type !== 'tool_use') continue;
        toolCallCount += 1;
        byTool.set(block.name, (byTool.get(block.name) ?? 0) + 1);
      }
    }
    if (toolCallCount === 0) return null;

    const toolBreakdown: PerToolStat[] = Array.from(byTool.entries()).map(
      ([toolName, callCount]) => ({ toolName, callCount, totalDurationMs: 0, interruptedCount: 0 }),
    );
    return { toolCallCount, toolBreakdown };
  }

  /**
   * Command-injection verifier over the brain-dir transcript. Gated on the
   * measured submit-time flush (scripts/measure-injection-flush.mjs,
   * 2026-08-16 vs agy 1.1.13: worst observed append latency 84ms across
   * short AND long turns, so the transcript flushes on submit, not turn-end;
   * recorded in docs/architecture/automations/command-injection-measurements.md). Both `mode`s verify with
   * submitted semantics - the text became a USER_INPUT turn - because this
   * adapter never emits settings slash-commands (`command-match`'s discrete
   * invocation contract has no Antigravity producer).
   */
  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType !== 'command-injection') return null;
    return async (context) => {
      if (context.type !== 'command-injection' || !context.agentSessionId) return false;
      const verifier = createAntigravityInjectionVerifier(
        antigravityTranscriptPath(context.agentSessionId, placeFromStored(context.cliTarget)),
      );
      if (!verifier) return false;
      return verifier(context.text, context.sentAt ?? Date.now());
    };
  }

  /**
   * Slash text never reaches the transcript: the TUI rejects an unregistered
   * `/command` client-side ("Unknown command", measured in the slash probe),
   * so absence in history is ambiguous and slash auto_commands are tagged
   * verify: 'none' by prepareInjectionPlan.
   */
  canVerifySlashSubmission(): boolean {
    return false;
  }

  /**
   * Never escalate on a failed verification: escalation restarts the session
   * and destroys live work, and per the interface contract it requires the
   * verifier to have been watched confirming a real submission in a running
   * app - evidence the flush measurement alone does not provide.
   */
  canEscalateOnVerificationFailure(): boolean {
    return false;
  }

  /**
   * Auto-name via a hidden-PTY print run (`agy -p ... --output-format json`).
   * The PTY is load-bearing: `agy -p` hangs when stdio is not a TTY
   * (upstream #318), so the shared child_process summarize runner cannot be
   * used. Runs in a pre-trusted scratch cwd so it neither blocks on the
   * trust prompt nor hijacks the project workspace's `agy -c` mapping.
   *
   * NOT the answer run, whose plan mode was measured on the title prompt
   * (2026-10-13): it searched the web twice, tried a shell command, and came
   * back empty after 41 s and 36k tokens. This run titled the same prompt in
   * 4.7 s. It removes its conversation and reports its usage
   * (`runAntigravityPrint`).
   */
  async summarize(prompt: string, cliPath: string, _cwd: string, options?: SummarizeOptions): Promise<string> {
    // The answer run's model and effort flags, omitted when unset.
    const flags = [
      ...(options?.model ? ['--model', options.model] : []),
      ...(options?.effort ? ['--effort', options.effort] : []),
    ];
    const response = await runAntigravityPrint(cliPath, buildSummarizePrompt(prompt), flags, options?.onUsage);
    const cleaned = cleanSummarizeOutput(response);
    if (!cleaned) throw new Error('summarize produced empty output');
    return cleaned;
  }

  readonly answerCapabilities = { streaming: true, search: false, model: true, effort: true, defaultEffort: 'low' };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * NOT the hidden-PTY runner `summarize` uses. That runner passes the prompt
   * as one argv entry with its newlines collapsed, and an answer prompt runs to
   * about 50k characters: past the Windows command-line limit, and with its
   * structure destroyed even where it fit. That is why Antigravity could not
   * answer at all until now.
   *
   * Instead the prompt goes in on STDIN as a single stream-json user message.
   * agy reads one NDJSON message per line in that mode and runs a turn for
   * each, so one line is one turn, and closing stdin ends the run. Measured on
   * the current CLI over plain pipes, with no PTY: a 61,584-character prompt
   * answered from its middle row. (The non-TTY hang the PTY runner works around,
   * upstream #318, did not reproduce on this path.) `--print=` is print mode with
   * an empty inline prompt, since the prompt arrives on stdin.
   *
   * Read-only is `--mode plan`: the probe's file write and shell command were
   * both auto-denied ("a tool required the command permission that headless
   * mode cannot prompt for"). The run's cwd is the answer handler's scratch
   * directory, never the project, so it cannot overwrite that workspace's
   * `agy -c` mapping either.
   *
   * STREAMING: an `agent_response` step's `step_update` events carry
   * `text_delta` as the text is written (`answer-stream.ts`, measured on
   * 1.2.11).
   *
   * NO SEARCH. A workspace plugin does load our server (the interactive path's
   * mechanism), but the agent never reached it: asked to call the search, it
   * ran a shell command instead, and headless mode auto-denies any tool that
   * needs a permission it cannot prompt for. Not offered until a run shows the
   * tool called.
   *
   * Each run's conversation (its brain folder with the whole transcript, its
   * database and presence lock) is removed afterwards.
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
    let conversationId: string | null = null;
    // An agy installed in a WSL distro runs there, and its conversation is removed there.
    const cliTarget = await resolveCliTarget(cliPath, true);
    try {
      return await runCliPrintAnswer({
        cliPath,
        cliTarget,
        args: antigravityAnswerArgs(model, options?.effort),
        prompt: formatAntigravityUserMessage(prompt),
        cwd,
        // The result event also carries the run's usage, reported before the
        // runner can reject an empty answer: that run still cost what it says.
        extractRaw: (stdout: string) => {
          const usage = antigravityStreamUsage(stdout);
          if (usage) options?.onUsage?.(usage);
          return extractAntigravityStreamResponse(stdout);
        },
        // A stream is a transcript, not an answer: step updates and their
        // deltas carry far more than the answer text.
        outputBudget: ANSWER_STREAM_OUTPUT_BUDGET,
        onChunk: forwardStreamLines((line) => {
          conversationId ??= antigravityStreamConversationId(line);
          if (onEvent) for (const event of antigravityAnswerEvents(line)) onEvent(event);
        }),
      });
    } finally {
      if (conversationId) await removeAntigravityConversation(conversationId, cliTarget);
    }
  }

  /**
   * The same run as `answerFromContext`, kept open for a Knowledge Graph chat.
   * The headless doc (https://antigravity.google/docs/cli/headless) says one
   * `--input-format stream-json` process runs a full turn per stdin message,
   * ends each with its own `result` event, keeps one `conversation_id` for the
   * session, and exits once stdin closes. Same flags as the one-shot run, so
   * the same read-only `--mode plan`. Built from the documentation; the
   * one-shot run is the measured one.
   *
   * The session's conversation is removed once its process is gone, as the
   * one-shot run's is. Its id is read off every stdout line, the `init` event
   * that arrives before any turn included, so a prewarmed session nobody asks
   * leaves nothing behind either.
   */
  openAnswerSession(input: AnswerSessionInput): AnswerSession {
    // An agy installed in a WSL distro runs there. Opened synchronously, so
    // from the distro facts its detection already read; a distro path whose
    // facts are not read yet throws, and the pool answers with a fresh run.
    const cliTarget = peekCliTarget(input.cliPath, true);
    if (!cliTarget && parseWslCliPath(input.cliPath)) {
      throw new Error(`The WSL distro facts for ${input.cliPath} are not read yet`);
    }
    let conversationId: string | null = null;
    const session = openStdinJsonSession({
      cliPath: input.cliPath,
      cliTarget,
      args: antigravityAnswerArgs(input.model, input.effort),
      cwd: input.cwd,
      formatTurn: (prompt) => formatAntigravityUserMessage(prompt).trimEnd(),
      // Every line, the start-up `init` included, which arrives before any
      // turn: a session that is never asked still names its conversation.
      onLine: (line) => {
        conversationId ??= antigravityStreamConversationId(line);
      },
      createReducer: () => antigravityAnswerEvents,
      isTurnEnd: isAntigravityResultLine,
      extractAnswer: extractAntigravityStreamResponse,
    });
    void session.exited.then(async () => {
      if (conversationId) await removeAntigravityConversation(conversationId, cliTarget);
    });
    return session;
  }

  /**
   * The Command Terminal's live swap: `/model <name>` switches by "name, slug
   * or label" (CHANGELOG 1.1.22) and `/effort <level>` sets the level
   * (https://antigravity.google/docs/cli/commands/effort, CHANGELOG 1.1.5).
   * Model first, as Claude orders it, so the level lands on a model that has
   * it. Both also save the choice as agy's default for later sessions. A level
   * the model lacks is refused by agy's TUI with the levels it does support.
   */
  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    if (spec.modelChanged && spec.model) sequence.push(`/model ${spec.model}`);
    if (spec.effortChanged && spec.effort) sequence.push(`/effort ${spec.effort}`);
    return sequence;
  }

  /**
   * The fallback for a session that never reports usage. Live usage comes
   * from the per-session status line (`--settings`, status-parser.ts), which
   * only an agy whose `--help` lists `--settings` gets. An older agy has no
   * channel at all: neither the interactive transcript nor the hook payloads
   * carry usage (verified 1.1.13). The renderer shows this label only while no
   * model name is known, so a session whose status line reports hides it, and
   * one seeded from a `--model` override (configuredModelFromCommand) never
   * shows it.
   */
  readonly liveTelemetryUnsupported: AgentLiveTelemetryUnsupported = {
    unavailableLabel: 'Telemetry: TUI only',
    unavailableTitle:
      'This Antigravity session has not reported live telemetry to Kangentic.\n'
      + 'Older agy versions cannot; the agy TUI footer shows the active\n'
      + 'model and effort.',
  };

  /**
   * Runtime strategy - how agy exposes activity and session ids.
   *
   * - statusFile: the per-session status line -> status-bridge.js ->
   *   status.json, rewritten whole on every run (parseStatus maps the
   *   documented payload; an agy without `--settings` never writes it), and
   *   the hook -> event-bridge -> events.jsonl pipeline.
   * - Activity: hooks primary (PreInvocation -> prompt starts a turn,
   *   PreToolUse / PostToolUse bracket each tool, Stop -> idle ends it;
   *   Stop's payload carries `fullyIdle`), PTY
   *   silence fallback for print-mode spawns where hooks do not fire
   *   (verified) and for the no-space-free-path case where hook wiring is
   *   skipped. detectIdle matches the idle footer's "? for shortcuts",
   *   which never paints while a turn runs (the running footer shows
   *   "esc to cancel" instead).
   * - sessionId.fromHook: every hook payload carries `conversationId`
   *   (camelCase protojson). A new conversation's SessionStart delivers it
   *   before the first turn; the PreInvocation entry's captureHookContext
   *   covers a resumed conversation, which fires no SessionStart. The status
   *   line's `conversation_id` is deliberately not reported (status-parser.ts).
   * - sessionId.fromOutput: the graceful-shutdown summary prints
   *   `agy --conversation=<uuid>`, and a print-mode run emits
   *   `"conversation_id":"<uuid>"` in its JSON result. The suspend-time
   *   scrollback scan reads the former even when hooks never fired.
   * - No fromFilesystem: `last_conversations.json` is written only at CLI
   *   exit (verified), after the spawn-time polling window has closed.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    statusFile: {
      parseStatus: AntigravityStatusParser.parseStatus,
      parseEvent: AntigravityStatusParser.parseEvent,
      parseStatusEvents: AntigravityStatusParser.parseStatusEvents,
      isFullRewrite: true,
    },
    // Its turn-end hook reaches the engine as an Idle event.
    reportsTurnEnd: true,
    activity: ActivityDetection.hooksAndPty((data: string) => {
      const clean = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*[\x07\x1b]/g, '');
      return /\?\s+for shortcuts/.test(clean);
    }),
    sessionId: {
      fromHook(hookContext) {
        try {
          const context = JSON.parse(hookContext) as { conversationId?: unknown };
          if (typeof context.conversationId === 'string' && context.conversationId.length > 0) {
            console.log(`[antigravity] Captured conversation ID from hook: ${context.conversationId.slice(0, 16)}...`);
            return context.conversationId;
          }
          return null;
        } catch {
          // The bridge's 2048-char hookContext cap can truncate a large
          // PreInvocation payload mid-structure. The field itself often
          // survives inside the truncated prefix, so fall back to a direct
          // scan before giving up (see HOOK_CONVERSATION_RE).
          const truncatedMatch = hookContext.match(HOOK_CONVERSATION_RE);
          if (truncatedMatch) {
            console.log(`[antigravity] Captured conversation ID from truncated hook payload: ${truncatedMatch[1].slice(0, 16)}...`);
            return truncatedMatch[1];
          }
          return null;
        }
      },
      fromOutput(data) {
        const shutdownMatch = data.match(SHUTDOWN_CONVERSATION_RE);
        if (shutdownMatch) return shutdownMatch[1];
        const printMatch = data.match(PRINT_CONVERSATION_RE);
        return printMatch ? printMatch[1] : null;
      },
    },
  };
}

/**
 * Friendly display name for an agy model slug, mirroring the CLI's own
 * `agy models` display column: `gemini-3.1-pro-high` -> "Gemini 3.1 Pro
 * (High)", `claude-opus-4-6-thinking` -> "Claude Opus 4.6 Thinking",
 * `gpt-oss-120b-medium` -> "GPT-OSS 120B (Medium)". Heuristic; an
 * unrecognized shape falls back to the raw slug.
 */
export function antigravityModelDisplayName(slug: string): string {
  const rawParts = slug.split('-').filter((part) => part.length > 0);
  if (rawParts.length === 0) return slug;

  // Version numbers hyphenate in slugs (`claude-opus-4-6`) but render dotted
  // (`Opus 4.6`): merge runs of purely numeric tokens with dots.
  const parts: string[] = [];
  for (const part of rawParts) {
    const previous = parts[parts.length - 1];
    if (/^\d+$/.test(part) && previous !== undefined && /^\d+(\.\d+)*$/.test(previous)) {
      parts[parts.length - 1] = `${previous}.${part}`;
    } else {
      parts.push(part);
    }
  }

  let effortSuffix = '';
  const lastPart = parts[parts.length - 1];
  if (['high', 'medium', 'low'].includes(lastPart)) {
    parts.pop();
    effortSuffix = ` (${lastPart[0].toUpperCase()}${lastPart.slice(1)})`;
  }

  const words = parts.map((part) => {
    if (part === 'gpt') return 'GPT';
    if (part === 'oss') return 'OSS';
    // Parameter-count suffix: '120b' -> '120B'. Digit-only / already-caps
    // tokens ('20241022') pass through unchanged.
    if (/^\d/.test(part)) return part.toUpperCase() === part ? part : part.replace(/b$/, 'B');
    return part[0].toUpperCase() + part.slice(1);
  });

  // The GPT-OSS family hyphenates its first two tokens in agy's own display.
  if (words[0] === 'GPT' && words[1] === 'OSS') {
    return ['GPT-OSS', ...words.slice(2)].join(' ') + effortSuffix;
  }
  return words.join(' ') + effortSuffix;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The flags of every answer run, the one-shot and the warm session alike, so
 * the two cannot drift apart: read-only `--mode plan`, one stream-json user
 * message per stdin line, stream-json out, and `--print=` (print mode with an
 * empty inline prompt, since the prompt arrives on stdin). The model and
 * effort flags are OMITTED when none is chosen: passing an empty value is an
 * error.
 */
export function antigravityAnswerArgs(model?: string | null, effort?: string | null): string[] {
  return [
    '--mode', 'plan',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--print=',
  ];
}

/**
 * One user turn in agy's stream-json input shape, as a single NDJSON line.
 * `JSON.stringify` escapes every newline in the prompt, so a multi-line prompt
 * stays one line and one turn.
 */
export function formatAntigravityUserMessage(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`;
}

/**
 * The answer out of an agy stream-json run: the `response` of its `result`
 * event, which carries the turn's final text (`"status":"SUCCESS","response":
 * "..."`). Read from the event itself or from a nested `result` object, since
 * the envelope nests it. An empty string when no result arrived, which the
 * runner reports as a failed answer rather than inventing one.
 */
export function extractAntigravityStreamResponse(stdout: string): string {
  let response = '';
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const entry = record as Record<string, unknown>;
    if (entry.event !== 'result') continue;
    const nested = typeof entry.result === 'object' && entry.result !== null
      ? (entry.result as Record<string, unknown>)
      : null;
    const candidate = typeof entry.response === 'string'
      ? entry.response
      : typeof nested?.response === 'string' ? nested.response : null;
    if (candidate !== null) response = candidate;
  }
  return response;
}
