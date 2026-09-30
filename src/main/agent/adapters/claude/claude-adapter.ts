import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDetector } from './detector';
import { CommandBuilder } from './command-builder';
import { ClaudeStatusParser } from './status-parser';
import {
  locateClaudeTranscriptFile,
  parseClaudeTranscript,
  parseClaudeTranscriptWindow,
  parseClaudeTranscriptUsage,
  parseClaudeTranscriptToolCounts,
} from './transcript-parser';
import {
  CLAUDE_SUBAGENT_SPAWN_TOOL,
  locateClaudeSubagentDir,
  parseClaudeSubagentUsage,
  statClaudeSubagentDir,
} from './subagent-usage-parser';
import { resolveBackgroundTaskOutputFile } from './background-task-output';
import { reportTerminatedBackgroundShells } from './background-shell-transcript';
import { reportRejectedPromptTools } from './permission-rejection-transcript';
import { ensureWorktreeTrust, ensureMcpServerTrust } from './trust-manager';
import { ensureDiffPanelClosed } from './diff-panel';
import { migrateClaudeProjectData } from './project-relocation';
import { removeHooks as removeClaudeHooks } from './hook-manager';
import {
  runCliPrintSummarize,
  runCliPrintAnswer,
  buildSummarizePrompt,
  extractStreamedAnswer,
  createAnswerStreamReducer,
  forwardStreamLines,
  ANSWER_STREAM_OUTPUT_BUDGET,
  type AnswerStreamEvent,
} from '../../shared/auto-name';
import { openStdinJsonSession } from '../../shared/answer-session/stdin-json-session';
import { discoverClaudeStaticCapabilities, rescanClaudeModels } from './capability-discovery';
import { createSlashCommandVerifier } from './slash-command-verifier';
import { describeClaudeStartupFailure } from './startup-failure';
import { configuredModelFromClaudeCommand, buildModelCapabilityFields, toClaudeModelArgument } from './model-display-name';
import { ClaudeSessionHistoryParser } from './session-history-parser';
import type {
  AgentAdapter,
  AgentInfo,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedTranscript,
  ParsedTranscriptWindow,
  AnswerFromContextOptions,
  AnswerSession,
  AnswerSessionInput,
  ParsedSubagentUsage,
  SubagentTranscriptSignature,
} from '../../agent-adapter';

/**
 * The one tool an answering agent is allowed, by its full MCP name.
 *
 * `kangentic_search` in hybrid mode is the conversation retrieval Kangentic's
 * MCP server already serves to every spawned agent. Handing the answering agent
 * that same tool, and only that, is what lets a question the board facts cannot
 * settle be settled by the agent searching the transcripts itself.
 */
const ANSWER_RETRIEVAL_TOOL = 'mcp__kangentic__kangentic_search';

/**
 * Write a one-server MCP config for a single answer call and return its path.
 *
 * Under the OS temp dir with a unique name, never in the project: this file
 * carries a live token, the answer call runs from a neutral cwd on purpose, and
 * two answers in flight must not share a file. Deleted by the caller when the
 * call ends.
 */
export function writeScopedMcpConfig(
  retrieval: { url: string; token: string },
  directory: string = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-')),
): string {
  const configPath = path.join(directory, 'mcp.json');
  // sync-write-ok: the answer call names this file in --mcp-config and cannot
  // run without it. The throw reaches the KNOWLEDGE_GRAPH_ANSWER handler's catch,
  // which turns it into the reason the rail shows.
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      kangentic: {
        type: 'http',
        url: retrieval.url,
        headers: { 'X-Kangentic-Token': retrieval.token },
      },
    },
  }, null, 2));
  return configPath;
}

/**
 * Settings layered over the user's own for one answer call, named by
 * `--settings`. The user's settings still load (auth helpers, env); this only
 * overrides what an answer must not inherit.
 *
 * `advisorModel` is the one so far. A user who sets it (Claude Code's advisor
 * tool) had every answer consult that model, and `--tools ''` does not remove
 * the advisor. Measured on CLI 2.1.283 with `advisorModel: "opus"`, one table
 * question at Sonnet: 17 to 21 s and $0.12 to $0.18 with an Opus call, against
 * 3 to 5 s and no Opus call with `""`. `null` does NOT turn it off (two of three
 * runs still called Opus), so the empty string is the value. Some answers also
 * narrated the choice ("rather than consulting the advisor") in the reply.
 *
 * `autoMemoryEnabled` is the other. With it on, every run created
 * ~/.claude/projects/<its run directory>/memory, so each question left a
 * project folder behind even with `--no-session-persistence` (measured on CLI
 * 2.1.283: one folder per run, none with it off). It also keeps the user's own
 * memories out of an answer that may only draw on its prompt.
 *
 * A file rather than inline JSON because an npm `.cmd` shim sends the argument
 * through cmd.exe's quote doubling.
 */
const ANSWER_SETTINGS = { advisorModel: '', autoMemoryEnabled: false };

export function writeAnswerSettings(directory: string): string {
  const settingsPath = path.join(directory, 'settings.json');
  // sync-write-ok: the answer call names this file in --settings and cannot
  // run without it. The throw reaches the KNOWLEDGE_GRAPH_ANSWER handler's catch,
  // which turns it into the reason the chat shows.
  fs.writeFileSync(settingsPath, JSON.stringify(ANSWER_SETTINGS));
  return settingsPath;
}

/**
 * The flags of every answer run, one-shot or session. Writes the run's settings
 * (and its MCP config, when the agent may search) into `directory`.
 *
 * MINIMAL BY MEASUREMENT. A trivial ten-token prompt through this call carried
 * ~52,000 tokens of context: built-in tool definitions, every MCP server the
 * user has configured, and the project's CLAUDE.md. Ask needs none of it - the
 * prompt is self-contained and the rules tell the agent to answer only from
 * what is in it.
 *
 *   as it was                        ~52,000 tokens
 *   + --tools '' --strict-mcp-config ~26,800
 *   + a neutral cwd (the caller)      ~8,000
 *
 * `--tools ''` drops the built-in tools; `--strict-mcp-config` makes the scoped
 * `--mcp-config` the WHOLE server list, so a user's own servers do not leak
 * into a question about their task history, and `--allowedTools` pre-approves
 * the single search tool by name, so a headless run never blocks on a
 * permission prompt it has no way to answer.
 *
 * NOT `--permission-mode plan`, which this call carried as a "second lock"
 * until it was measured. On CLI 2.1.260, plan mode with `--model haiku`
 * answered from claude-sonnet-5 (message_start.model) at ~3x the notional cost
 * and with ~10k more tokens of system prompt; the identical call without plan
 * mode answered from haiku. What keeps this read-only is the empty tool list
 * plus the allowlist, and `--permission-prompts none` denies anything that
 * would ever prompt rather than letting a headless run block or be granted.
 *
 * The model and effort flags are OMITTED when unset, rather than passed empty:
 * `--model ''` is an error, and the absence of the flag is exactly what "use
 * the agent's own default" means to the CLI.
 */
function answerArgs(input: {
  directory: string;
  retrieval: AnswerFromContextOptions['retrieval'];
  streaming: boolean;
  model?: string | null;
  effort: string | null;
}): string[] {
  const settingsPath = writeAnswerSettings(input.directory);
  const mcpConfigPath = input.retrieval ? writeScopedMcpConfig(input.retrieval, input.directory) : null;
  return [
    '--print',
    // An answer is not a conversation to resume. Without this every run saved
    // its transcript, whole prompt included, as a new project under
    // ~/.claude/projects keyed by its one-off run directory: 49 folders from
    // one day of asking, each crowding the user's real projects out of the
    // resume picker and out of the model scan in capability-discovery.ts.
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--tools', '',
    '--strict-mcp-config',
    '--settings', settingsPath,
    ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath, '--allowedTools', ANSWER_RETRIEVAL_TOOL] : []),
    // stream-json is what makes progress visible, and partial messages are
    // what make it a STREAM: without them the CLI emits one line per completed
    // turn, so a one-turn answer arrives all at once at the end (measured:
    // first text at 4.8s of a 5.5s call); with them the model's deltas come
    // through as written (measured: 1.3s to the first). `--verbose` is
    // required alongside stream-json in print mode.
    ...(input.streaming ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'] : []),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
  ];
}

/** Low, or no level at all, answers without extended thinking; see
 *  `answerCapabilities` for the measurement behind the split. */
function answerEnv(effort: string | null): { env?: Record<string, string> } {
  return effort === null || effort === 'low' ? { env: { MAX_THINKING_TOKENS: '0' } } : {};
}

/** The line that ends a stream-json turn. */
function isResultLine(line: string): boolean {
  if (!line.includes('"result"')) return false;
  try {
    return (JSON.parse(line) as { type?: unknown }).type === 'result';
  } catch {
    return false;
  }
}

/**
 * Turn a stream of stdout chunks into a stream of answer events.
 *
 * Chunk boundaries fall anywhere, including mid-line, so lines are reassembled
 * before parsing: a partial JSON line is held until its newline arrives. The
 * tail left after the final chunk is not flushed on purpose - it is either
 * empty or an unterminated line the CLI never finished, and neither is an
 * event.
 */
export function makeStreamForwarder(onEvent: (event: AnswerStreamEvent) => void): (chunk: string) => void {
  // Stateful, so a turn that arrived as deltas is not shown a second time when
  // its complete `assistant` line follows.
  const reduce = createAnswerStreamReducer();
  return forwardStreamLines((line) => {
    for (const event of reduce(line)) onEvent(event);
  });
}
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  AgentCapabilities,
  SubmissionContextType,
  SubmissionVerifier,
  SubmissionContext,
  TranscriptUsage,
  TranscriptToolCounts,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';
import { peekModelPickerAliasIds } from './model-picker-probe';

/**
 * Claude Code adapter - wraps ClaudeDetector, CommandBuilder,
 * ClaudeStatusParser, trust-manager, and hook-manager behind
 * the generic AgentAdapter interface.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';
  readonly displayName = 'Claude Code';
  readonly sessionType = 'claude_agent';
  readonly supportsCallerSessionId = true;
  // Claude streams account-wide rate-limit windows in its status line, so the
  // ContextBar shows the rate-limit pill for any Claude session using the shared
  // global snapshot - even a freshly spawned one that has not reported its own yet.
  readonly reportsRateLimits = true;
  // Claude's own clipboard image paste fails silently on Windows Snipping Tool
  // images (claude-code #26679), so Kangentic captures the image itself and
  // hands Claude the saved file's path. Claude's prompt input scans a bracketed
  // paste for tokens ending in these extensions (`/\.(png|jpe?g|gif|webp)$/i`,
  // one surrounding quote pair stripped first), reads the file, and attaches it
  // as an `[Image #N]` chip in the user turn: no `Read` tool call, no extra
  // model round trip. A typed path never reaches that scan, which is why the
  // renderer delivers it through xterm's paste() rather than a raw write.
  readonly pastedImageNativeExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  // bmp and svg are outside Claude's native set, so they keep the explicit
  // Read instruction; the scan leaves the text alone and the agent reads it.
  // That reaches an svg (Read returns the markup) but not a bmp: Read refuses
  // a bmp as binary, on every delivery form. Verified against 2.1.276.
  readonly pastedImageReferenceTemplate = 'Read this image: {path} ';
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only)' },
    { mode: 'dontAsk', label: "Don't Ask (Deny Unless Allowed)" },
    { mode: 'default', label: 'Default (Allowlist)' },
    { mode: 'acceptEdits', label: 'Accept Edits' },
    { mode: 'auto', label: 'Auto (Classifier)' },
    { mode: 'bypassPermissions', label: 'Bypass (Unsafe)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new ClaudeDetector();
  private readonly commandBuilder = new CommandBuilder();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
    this.staticCapabilitiesCache = null;
  }

  // Cache only the static, --help-derived bits (effortLevels, supportsModelOverride
  // flag). They never change between dialog opens for a given binary, so we
  // avoid re-spawning `claude --help` every time the picker mounts. The model
  // list is rescanned on every call so newly-used models appear without
  // restarting Kangentic.
  private staticCapabilitiesCache: { cliPath: string; capabilities: AgentCapabilities } | null = null;

  // `forceRefresh` bypasses the /model picker probe's TTL for an on-demand
  // rescan (a model dropdown opening) so a newly shipped model surfaces without
  // a restart. The static `--help` bits are handled by invalidateDetectionCache,
  // which listAgents already calls on a forced refresh (it nulls this cache), so
  // they re-probe under force without any extra branch here.
  async discoverCapabilities(cliPath: string, forceRefresh = false): Promise<AgentCapabilities> {
    let staticCapabilities: AgentCapabilities;
    if (this.staticCapabilitiesCache && this.staticCapabilitiesCache.cliPath === cliPath) {
      staticCapabilities = this.staticCapabilitiesCache.capabilities;
    } else {
      staticCapabilities = await discoverClaudeStaticCapabilities(cliPath);
      this.staticCapabilitiesCache = { cliPath, capabilities: staticCapabilities };
    }

    if (!staticCapabilities.supportsModelOverride) {
      return staticCapabilities;
    }
    const rescan = await rescanClaudeModels(cliPath, forceRefresh);
    return rescan
      ? { ...staticCapabilities, ...buildModelCapabilityFields(rescan.models, rescan.aliases) }
      : staticCapabilities;
  }

  async ensureTrust(workingDirectory: string): Promise<void> {
    await ensureWorktreeTrust(workingDirectory);
    await ensureMcpServerTrust(workingDirectory);
    // Same file, same lock: keep 2.1.260's fullscreen diff panel closed at
    // launch. Runs per spawn on purpose - see diff-panel.ts for why.
    await ensureDiffPanelClosed();
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildClaudeCommand({ cliPath: agentPath, ...rest });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  // Claude uses caller-owned session IDs via --session-id, so no capture
  // needed. Authoritative telemetry comes from the hook-driven statusFile
  // pipeline (status.json + events.jsonl, written by Kangentic's injected
  // event-bridge.js / status-bridge.js into .kangentic/sessions/<sessionId>/
  // and watched by StatusFileReader). status.json is richer (display_name,
  // real context window, cost, rate limits) and stays the source of truth.
  //
  // But Claude Code only runs its statusLine when its TUI paints the
  // statusline, and a background (never-opened) session in the pwsh-wrapped
  // PTY never does that first paint - so status.json never appears and the
  // card is stuck on the spawn-time model placeholder. `sessionHistory`
  // wires Claude's native session log at ~/.claude/projects/<slug>/<id>.jsonl
  // (appended continuously, paint or not) into the live pipeline as a
  // FALLBACK: ClaudeSessionHistoryParser derives a live model + context %
  // from the latest assistant message. On the first status.json parse,
  // SessionManager detaches this reader (StatusFileReader.onFirstStatus ->
  // sessionHistoryReader.detach) so status.json's full-replace cleanly wins
  // and the two sources never race. (The same transcript is also read on
  // demand by transcript-parser.ts for the renderer's Transcript tab and
  // lifetime-token refinement.)
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.hooks(),
    statusFile: {
      parseStatus: ClaudeStatusParser.parseStatus,
      parseEvent: ClaudeStatusParser.parseEvent,
      isFullRewrite: true,
    },
    // Background-session fallback - see the comment block above. Append-mode
    // (isFullRewrite: false): the transcript is append-only JSONL.
    sessionHistory: {
      locate: ClaudeSessionHistoryParser.locate,
      parse: ClaudeSessionHistoryParser.parse,
      isFullRewrite: false,
    },
    // The bg-shell watcher stats this file for liveness when a named shell
    // has no captured OS PID (Incident B). Wrapped in an arrow so the optional
    // baseTmpDir parameter stays internal to the resolver.
    backgroundShells: {
      resolveOutputFile: (options) => resolveBackgroundTaskOutputFile(options),
      // Definitive reclaim (task #386): a shell's terminal <task-notification>
      // is delivered as a queued_command attachment, never a hooked user
      // turn, but IS appended to the native transcript. See
      // background-shell-transcript.ts for the full rationale.
      reportTerminatedShells: (options) => reportTerminatedBackgroundShells(options),
    },
    // A manual TUI deny aborts the turn with no hook of any kind - see
    // permission-rejection-transcript.ts for the full rationale. This is
    // the only signal that can clear a denied `permissionPending`.
    permissionPrompts: {
      reportRejectedPromptTools: (options) => reportRejectedPromptTools(options),
    },
  };

  removeHooks(directory: string): void {
    removeClaudeHooks(directory);
  }

  clearSettingsCache(): void {
    this.commandBuilder.clearSettingsCache();
  }

  getExitSequence(): string[] {
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Claude Code hides the cursor when its TUI takes over the terminal.
    // Detecting ESC[?25l fires after the shell prompt noise but before
    // the TUI draws the startup banner, keeping the shell command hidden
    // behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    return configuredModelFromClaudeCommand(command);
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    const filePath = locateClaudeTranscriptFile(agentSessionId, cwd);
    // locateClaudeTranscriptFile returns the computed path without checking existence.
    // Verify the file actually exists before returning it.
    try {
      fs.accessSync(filePath);
      return filePath;
    } catch {
      return null;
    }
  }

  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    const filePath = locateClaudeTranscriptFile(agentSessionId, cwd);
    const entries = await parseClaudeTranscript(filePath);
    return { entries, sourcePath: filePath };
  }

  /** Stateless bounded window, for the conversation indexer's whole-file walk.
   *  `attributedMessageIds` is the caller's bounded usage-attribution carry; the
   *  parser seeds from it, adds to it, and prunes it, so a message whose lines
   *  straddle a window seam is still counted once. */
  async parseTranscriptWindow(
    agentSessionId: string,
    cwd: string,
    startByte: number,
    maxBytes: number,
    attributedMessageIds?: Set<string>,
  ): Promise<ParsedTranscriptWindow> {
    const filePath = locateClaudeTranscriptFile(agentSessionId, cwd);
    const window = await parseClaudeTranscriptWindow(
      filePath, startByte, maxBytes, attributedMessageIds,
    );
    return { ...window, sourcePath: filePath };
  }

  /**
   * Staleness signature for the session's `subagents/` directory. Its own
   * signature, because a running subagent moves no byte of the main transcript.
   */
  statSubagentTranscripts(agentSessionId: string, cwd: string): SubagentTranscriptSignature | null {
    return statClaudeSubagentDir(locateClaudeSubagentDir(agentSessionId, cwd));
  }

  /** Every Task-tool subagent's tokens for this session, folded to one turn per
   *  API message. See `subagent-usage-parser.ts` for why the fold rule differs
   *  from the main transcript's. */
  async parseSubagentUsage(agentSessionId: string, cwd: string): Promise<ParsedSubagentUsage> {
    return parseClaudeSubagentUsage(agentSessionId, cwd);
  }

  /** Claude spawns a subagent with the `Task` tool, so a `Task` tool-use id is
   *  what a subagent's `.meta.json` records as its `toolUseId`. Matching on it is
   *  how the spawning turn is found again. */
  readonly subagentSpawnToolName = CLAUDE_SUBAGENT_SPAWN_TOOL;

  /** Claude's file-changing tools and the field naming the file, for the
   *  memory index's session changes. */
  readonly fileChangeTools = [
    { tool: 'Edit', pathField: 'file_path' },
    { tool: 'Write', pathField: 'file_path' },
    { tool: 'MultiEdit', pathField: 'file_path' },
    { tool: 'NotebookEdit', pathField: 'notebook_path' },
  ];

  /**
   * Lifetime cumulative tokens from Claude's own session JSONL. Prefers the
   * exact `transcriptPath` Claude reported in status.json; otherwise derives the
   * canonical `~/.claude/projects/<slug>/<id>.jsonl` path from the session id +
   * cwd. Returns null (caller falls back to the live snapshot) when neither a
   * path nor an id+cwd is available, or the file is missing/unparseable.
   */
  async transcriptUsage(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
  }): Promise<TranscriptUsage | null> {
    const filePath = input.transcriptPath
      ?? (input.agentSessionId && input.cwd
        ? locateClaudeTranscriptFile(input.agentSessionId, input.cwd)
        : null);
    if (!filePath) return null;
    return parseClaudeTranscriptUsage(filePath);
  }

  async transcriptToolCounts(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
  }): Promise<TranscriptToolCounts | null> {
    const filePath = input.transcriptPath
      ?? (input.agentSessionId && input.cwd
        ? locateClaudeTranscriptFile(input.agentSessionId, input.cwd)
        : null);
    if (!filePath) return null;
    return parseClaudeTranscriptToolCounts(filePath);
  }

  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    return runCliPrintSummarize({
      cliPath,
      args: ['--print', '--permission-mode', 'plan'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
    });
  }

  /**
   * Effort defaults to `low`, which answers without extended thinking (the fast
   * path, below). A higher level lifts that and lets the level decide how much
   * the model thinks. Measured on CLI 2.1.283, one table question with a
   * counting part, two runs each:
   *
   *   Sonnet low, thinking off              1.8 to 3.0 s   count right 0 of 2
   *   Sonnet low to high, level decides     1.5 to 4.2 s   count right 1 of 6
   *   Sonnet max, level decides             22 to 43 s     count right 2 of 2
   *   Haiku, thinking off                   1.5 to 1.8 s
   *   Haiku, level decides (any level)      12 to 19 s     Haiku ignores effort and thinks
   *
   * So `low` keeps the pin for every model, and a user who wants more care on a
   * hard question can buy it with a higher level.
   */
  readonly answerCapabilities = { streaming: true, search: true, model: true, effort: true, defaultEffort: 'low' };

  /**
   * The prompt arrives fully built - question, excerpts and rules - so this only
   * chooses the flags. The read-only guarantee is the EMPTY tool list plus the
   * one allowlisted search tool, with prompts switched off so nothing can be
   * granted at runtime. Not plan mode - see the note on the args.
   */
  async answerFromContext(
    prompt: string,
    cliPath: string,
    cwd: string,
    model?: string | null,
    options?: AnswerFromContextOptions,
  ): Promise<string> {
    // The ONE tool the agent may reach, when the caller offers it.
    //
    // Written to a temp file and named by `--mcp-config`, exactly as the
    // interactive spawn does in `command-builder.ts`. `--strict-mcp-config`
    // stays: it means this file is the WHOLE server list, so the user's own
    // servers still never load into a question about their task history. And
    // `--allowedTools` pre-approves the single search tool by name, so a
    // headless run never blocks on a permission prompt it has no way to answer.
    const retrieval = options?.retrieval;
    const streaming = options?.onEvent !== undefined;
    const effort = options?.effort ?? null;
    // The run's own directory for its config files; one made here, and removed
    // whole when the call ends, for a caller that passed none.
    const ownsDirectory = !options?.runDirectory;
    const configDirectory = options?.runDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-'));

    try {
      return await runCliPrintAnswer({
        cliPath,
        args: answerArgs({ directory: configDirectory, retrieval, streaming, model, effort }),
        // In stream mode stdout is a transcript of JSON lines, not the answer.
        // The final answer is the last assistant turn's text; the runner's
        // `extractRaw` seam is exactly where that reduction belongs.
        ...(streaming ? { extractRaw: extractStreamedAnswer } : {}),
        // And stdout is a transcript, not an answer: tool results and per-delta
        // envelopes for a two-paragraph answer run to hundreds of kilobytes.
        // The answer-sized budget killed the CLI mid-search.
        ...(streaming ? { outputBudget: ANSWER_STREAM_OUTPUT_BUDGET } : {}),
        // Forward each line's events as they land. A chunk can end mid-line,
        // so lines are reassembled across chunks before parsing.
        ...(streaming ? { onChunk: makeStreamForwarder(options.onEvent!) } : {}),
      // NO EXTENDED THINKING at the default level, and this is the latency of
      // the feature.
      //
      // Measured on a realistic 350-row prompt: thinking on took 4,038ms of API
      // time and generated 253 output tokens of which 231 - 91% - were thinking.
      // Off took 2,041ms and 19 tokens, and returned the IDENTICAL answer.
      //
      // Which is what you would expect from the shape of most of the work: the
      // prompt already contains the whole table and the task is to read and
      // report. A user who picks a higher effort gets thinking back, because a
      // count across hundreds of rows is where it measurably helped.
      //
      // `MAX_THINKING_TOKENS` is Claude Code's own control, which is why this
      // lives in the Claude adapter rather than in the shared runner.
        ...answerEnv(effort),
        prompt,
        cwd,
      });
    } finally {
      // The MCP config carries a live token. It exists only for the duration of
      // one call, and `force` because Windows may still hold the handle for a
      // beat after the child exits. A caller's run directory is the caller's
      // to remove. `force` only ignores a missing path, so a handle Windows still
      // holds throws EBUSY; caught, or it would replace the answer or the real
      // error, and the stale-directory sweep takes the folder later.
      if (ownsDirectory) {
        try {
          fs.rmSync(configDirectory, { recursive: true, force: true });
        } catch {
          // Left for the sweep in answer-run-directory.ts.
        }
      }
    }
  }

  /**
   * The same run as `answerFromContext`, kept open: `--input-format
   * stream-json` makes the CLI read one user turn per stdin line and answer
   * each, ending every turn with a `result` line. Same flags otherwise, so the
   * same read-only guarantee. Its config files live in `input.runDirectory`,
   * which the pool removes with the session.
   */
  openAnswerSession(input: AnswerSessionInput): AnswerSession {
    const effort = input.effort ?? null;
    return openStdinJsonSession({
      cliPath: input.cliPath,
      args: [
        ...answerArgs({ directory: input.runDirectory, retrieval: input.retrieval, streaming: true, model: input.model, effort }),
        '--input-format', 'stream-json',
      ],
      cwd: input.cwd,
      ...answerEnv(effort),
      formatTurn: (prompt) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }),
      createReducer: createAnswerStreamReducer,
      isTurnEnd: isResultLine,
      extractAnswer: extractStreamedAnswer,
    });
  }

  /**
   * Claude provides context-specific submission verifiers.
   *
   * - paste context: Claude emits EventType.Prompt via the UserPromptSubmit
   *   hook the moment the agent receives our submitted prompt. That same
   *   transition flips the session's activity to `thinking`, which the
   *   paste-engine's `'activity'` listener already resolves on. Returning
   *   null here keeps the fast path on the activity backstop rather than
   *   re-implementing event subscription inside a one-shot Promise.
   *
   * - command-injection context: Claude writes every slash invocation as
   *   a `local_command` entry in the session JSONL with `<command-name>`
   *   and `<command-args>` tags. The verifier polls that file for an entry
   *   matching exactly what we sent, so combined-args concatenation bugs
   *   (overlay-eaten Enter merging `/effort` into the previous `/model`
   *   invocation) are detected and retried. Requires agentSessionId, cwd,
   *   and sentAt in the context to bound the scan window.
   */
  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      return async (context: SubmissionContext) => {
        if (context.type !== 'command-injection' || !context.agentSessionId || !context.cwd) {
          return false;
        }
        const filePath = locateClaudeTranscriptFile(context.agentSessionId, context.cwd);
        const verifier = createSlashCommandVerifier(filePath);
        if (!verifier) return false;
        // sentAt comes from TerminalSubmit.submitKeystrokes and is the FIRST
        // Enter pressed for the command, held across its retries and the
        // scheduler's late re-check (see `firstSentAt` on the result). Falling
        // back to Date.now() preserves single-call use (e.g. ad-hoc verifier
        // invocation in tests) but the production path always supplies it.
        //
        // `mode` distinguishes an adapter-emitted settings command (must
        // parse as a discrete invocation with exactly these args) from a
        // user-supplied auto_command (only needs to have been submitted
        // verbatim). Defaulting to the stricter mode keeps older callers
        // behaving exactly as before.
        return verifier(context.text, context.sentAt ?? Date.now(), context.mode ?? 'command-match');
      };
    }
    return null;
  }

  /**
   * A `--resume` of a conversation the CLI can no longer find is the one
   * startup failure Claude names in its output. See `startup-failure.ts`.
   */
  describeStartupFailure(finalOutput: string, exitCode: number): string | null {
    return describeClaudeStartupFailure(finalOutput, exitCode);
  }

  /**
   * Claude accepts the slash forms `/model <id>` and `/effort <level>` as
   * valued commands that bypass the interactive picker - confirmed
   * empirically (scripts/probe-claude-model-forms.js for the CLI flag form,
   * and live-tested for the slash form). Order is /model before /effort
   * because /effort xhigh is Opus-only; setting the model first ensures
   * /effort lands on a model that accepts the requested level. The model is
   * converted to Claude's spelling ("Opus" -> `opus`) the same way the
   * `--model` flag is (see CommandBuilder).
   */
  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    if (spec.modelChanged && spec.model) {
      sequence.push(`/model ${toClaudeModelArgument(spec.model, peekModelPickerAliasIds())}`);
    }
    if (spec.effortChanged && spec.effort) sequence.push(`/effort ${spec.effort}`);
    return sequence;
  }

  /**
   * Claude keys its session transcripts (~/.claude/projects/<slug>/) and its
   * per-project state (~/.claude.json projects keys) to the absolute project
   * path, both outside the project folder. Migrate them so sessions stay
   * resumable after a relocation. Best-effort and non-destructive; see
   * migrateClaudeProjectData. Also invoked with a single worktree's old/new path
   * on the first resume after a worktree rename (resume-cwd-migration.ts), which
   * migrates only that worktree's slug.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateClaudeProjectData(oldPath, newPath);
  }
}
