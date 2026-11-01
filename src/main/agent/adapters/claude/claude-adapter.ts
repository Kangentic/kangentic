import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDetector } from './detector';
import { CommandBuilder, claudeMcpServerEntry } from './command-builder';
import { ClaudeStatusParser } from './status-parser';
import { kangenticMcpServer, startRunMcpRelay, type KangenticMcpServer } from '../../shared/kangentic-mcp-server';
import { findClaudeResumeTranscriptFile, findClaudeTranscriptFile, resolveClaudeTranscriptFile } from './transcript-locator';
import {
  parseClaudeTranscript,
  parseClaudeTranscriptWindow,
  parseClaudeTranscriptUsage,
  parseClaudeTranscriptToolCounts,
  parseClaudeTranscriptToolResultTokens,
  readClaudeTranscriptPage,
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
import { ensureClaudeSpawnConfig } from './trust-manager';
import { cliPathForTarget, hostPathForTarget, parseWslCliPath, peekCliTarget, placeFromStored, resolveCliTarget, type CliPlace, type CliTarget } from '../../shared/cli-target';
import { migrateClaudeProjectData } from './project-relocation';
import { removeHooks as removeClaudeHooks } from './hook-manager';
import { mayApproveClaudePlanTool } from './plan-tool-approval';
import { runWithSubscriptionFallback } from './subscription-fallback';
import { runCliPrintSummarize, buildSummarizePrompt, SUMMARIZE_JSON_OUTPUT_BUDGET } from '../../shared/auto-name';
import {
  runCliPrintAnswer,
  extractStreamedAnswer,
  createJsonResultExtractor,
  createAnswerStreamReducer,
  forwardStreamLines,
  ANSWER_JSON_OUTPUT_BUDGET,
  ANSWER_STREAM_OUTPUT_BUDGET,
  type AnswerStreamEvent,
} from '../../shared/cli-answer';
import { openStdinJsonSession } from '../../shared/answer-session/stdin-json-session';
import { discoverClaudeStaticCapabilities, rescanClaudeModels } from './capability-discovery';
import { createSlashCommandVerifier } from './slash-command-verifier';
import { describeClaudeStartupFailure } from './startup-failure';
import { proveClaudeConversationGone } from './conversation-gone';
import { claudeBackgroundSessionOf, claudeConfirmsBackgroundMove, resolveClaudeResumableSessionId, stopClaudeBackgroundSession } from './background-sessions';
import { configuredModelFromClaudeCommand, buildModelCapabilityFields, humanizeClaudeModelId, toClaudeModelArgument } from './model-display-name';
import { ClaudeSessionHistoryParser } from './session-history-parser';
import type {
  AgentAdapter,
  AgentInfo,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedTranscript,
  ParsedTranscriptWindow,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
  AnswerFromContextOptions,
  AnswerSession,
  AnswerSessionInput,
  HungTurnSpec,
  ParsedSubagentUsage,
  SubagentTranscriptSignature,
  SummarizeOptions,
} from '../../agent-adapter';
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
  ExitSequenceStep,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';
import { peekModelPickerAliasIds } from './model-picker-probe';

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
 * call ends. A Claude in a WSL distro on NAT networking gets the stdio bridge
 * instead of the URL (`kangenticMcpServer`), whose relay the run starts.
 */
export function writeScopedMcpConfig(
  retrieval: { url: string; token: string },
  directory: string = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-')),
  place: CliPlace | null = null,
): string {
  return writeScopedMcpServer(retrieval, directory, place).configPath;
}

function writeScopedMcpServer(
  retrieval: { url: string; token: string },
  directory: string,
  place: CliPlace | null,
): { configPath: string; server: KangenticMcpServer } {
  const configPath = path.join(directory, 'mcp.json');
  const server = kangenticMcpServer({ url: retrieval.url, token: retrieval.token, place, directory });
  // sync-write-ok: the answer call names this file in --mcp-config and cannot
  // run without it. The throw reaches the KNOWLEDGE_GRAPH_ANSWER handler's catch,
  // which turns it into the reason the rail shows.
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { kangentic: claudeMcpServerEntry(server) } }, null, 2));
  return { configPath, server };
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
  /** A Claude installed in a WSL distro, which reads its config files by the path the distro sees. */
  place?: CliPlace | null;
}): { args: string[]; mcpServer: KangenticMcpServer | null } {
  const cliFile = (windowsPath: string): string => (input.place ? cliPathForTarget(windowsPath, input.place) : windowsPath);
  const settingsPath = cliFile(writeAnswerSettings(input.directory));
  const written = input.retrieval ? writeScopedMcpServer(input.retrieval, input.directory, input.place ?? null) : null;
  const mcpConfigPath = written ? cliFile(written.configPath) : null;
  const args = [
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
    //
    // A run with no stream prints one JSON object instead of bare text: the
    // answer plus what the call cost (`usage`, `modelUsage`, `total_cost_usd`),
    // which is how a background call's model and tokens reach its record.
    // Verified on CLI 2.1.296 with these exact flags.
    ...(input.streaming
      ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages']
      : ['--output-format', 'json']),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
  ];
  return { args, mcpServer: written?.server ?? null };
}

/** Low, or no level at all, answers without extended thinking; see
 *  `answerCapabilities` for the measurement behind the split. */
function answerEnv(effort: string | null): { env?: Record<string, string> } {
  return effort === null || effort === 'low' ? { env: { MAX_THINKING_TOKENS: '0' } } : {};
}

/**
 * Run `work` with a directory for the run's config files: the caller's, or one
 * made here and removed whole when the call ends.
 *
 * The MCP config it may hold carries a live token, so it exists only for the
 * call. `force` because Windows may still hold the handle for a beat after the
 * child exits; `force` only ignores a missing path, so a handle Windows still
 * holds throws EBUSY, which is caught: it would otherwise replace the answer or
 * the real error, and the stale-directory sweep takes the folder later. A
 * caller's directory is the caller's to remove.
 */
async function withConfigDirectory<T>(runDirectory: string | undefined, work: (directory: string) => Promise<T>): Promise<T> {
  const directory = runDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-'));
  try {
    return await work(directory);
  } finally {
    if (!runDirectory) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // Left for the sweep in answer-run-directory.ts.
      }
    }
  }
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
 * The transcript a run-level read targets: the path Claude reported in its live
 * status.json when that file is there, whatever id it names, since the live
 * report moves to a `/clear` fork's file before the session row's id does.
 * Else wherever the locator finds the conversation (`transcript-locator.ts`).
 * With no session id or cwd to locate by, the reported path as given, else null.
 */
async function resolveRunTranscriptPath(input: {
  transcriptPath?: string | null;
  agentSessionId?: string | null;
  cwd?: string | null;
  place?: CliPlace | null;
}): Promise<string | null> {
  const place = input.place ?? null;
  // A Claude in a WSL distro reports its transcript by its Linux path.
  const reported = input.transcriptPath ? hostPathForTarget(input.transcriptPath, place) : null;
  if (reported && path.isAbsolute(reported) && await fs.promises.stat(reported).then(() => true, () => false)) {
    return reported;
  }
  if (input.agentSessionId && input.cwd) {
    return resolveClaudeTranscriptFile({ agentSessionId: input.agentSessionId, cwd: input.cwd, place });
  }
  return reported;
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
  /** `claude --resume <id> -- "<prompt>"`: the resumed session runs the prompt as its next turn. */
  readonly resumePromptDelivery = 'command-line' as const;
  /**
   * `claude` with no prompt opens the same interactive session `claude -- "<prompt>"`
   * does, at an empty input box, and a prompt typed or pasted there is the
   * conversation's first message. Only on the fullscreen renderer, whose input
   * box is in the alternate screen: the classic one never enters it, so the
   * spawn could never tell its input box from a screen drawn before it.
   */
  firstPromptMayBeTyped(options: SpawnCommandOptions): boolean {
    return this.commandBuilder.drawsInAlternateScreen(options);
  }
  // A Claude installed in a WSL distro, configured by its \\wsl.localhost path:
  // run in the distro's shell, its hooks through the WSL transport, its trust,
  // settings and transcripts in the distro's home (cli-target.ts).
  readonly supportsWslCli = true;
  // `--mcp-config` pointing at the session's own `mcp.json`.
  readonly kangenticMcp = 'per-session' as const;
  // `--tools` with the read-only set (`READ_ONLY_TOOLS` in command-builder.ts,
  // which keeps ToolSearch so the deferred Kangentic tools stay reachable),
  // plus `--strict-mcp-config`. `--tools` is the CLI's own restriction of the
  // built-in set, honoured in an interactive session; unlike plan mode it does
  // not reroute the model.
  readonly supportsReadOnlyLaunch = true;
  // A PermissionRequest hook matched to ExitPlanMode answers the plan prompt
  // alone (hook-manager.ts, CLAUDE_PLAN_APPROVAL_SPEC), and PostToolUse fires
  // for ExitPlanMode only once a plan is approved. Probed on 2.1.302: the
  // approver never ran for AskUserQuestion, whose dialog still showed. A second
  // entry matched to MCP tools answers an allowed one (plan-tool-approval.ts).
  readonly supportsPlanAutoApproval = true;
  // Background shells (task #857): PreToolUse/PostToolUse remaps in
  // hook-manager.ts report a Bash or PowerShell `run_in_background` launch,
  // KillBash and the transcript drain report the end, and a PostToolUse
  // `additionalContext` hint names the MCP tool beside the launch.
  readonly backgroundCommands = { source: 'hooks', launchHint: true } as const;
  // `--add-dir` per directory (command-builder.ts): the CLI's own way to widen
  // what a session may read and search without a prompt.
  readonly supportsReadableDirectories = true;
  // Claude streams account-wide rate-limit windows in its status line, so the
  // ContextBar shows the rate-limit pill for any Claude session using the shared
  // global snapshot - even a freshly spawned one that has not reported its own yet.
  readonly reportsRateLimits = true;
  // Claude appends every --resume of a conversation to one transcript, and its
  // tool-call cursor filters calls by timestamp, so a read can be scoped to one
  // run with sinceMs/untilMs (transcript-parser.ts, callsInWindow).
  readonly scopesTranscriptReadsByTime = true;
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

  async ensureTrust(workingDirectory: string, place?: CliPlace | null): Promise<void> {
    // One pass over ~/.claude.json: the directory trusted, the kangentic MCP
    // server enabled, and 2.1.260's fullscreen diff panel kept closed at
    // launch (per spawn on purpose - see diff-panel.ts for why). A Claude in a
    // WSL distro reads the distro's own file.
    await ensureClaudeSpawnConfig(workingDirectory, place ?? null);
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildClaudeCommand({ cliPath: agentPath, ...rest });
  }

  /** The renderer variables: the user's own, else `CLAUDE_CODE_NO_FLICKER=1` (see `CommandBuilder.rendererEnvironment`). */
  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    return this.commandBuilder.rendererEnvironment(options);
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
    // Its Stop hook reaches the engine as an Idle event.
    reportsTurnEnd: true,
    activity: ActivityDetection.hooks(),
    statusFile: {
      parseStatus: ClaudeStatusParser.parseStatus,
      parseEvent: ClaudeStatusParser.parseEvent,
      isFullRewrite: true,
      // Every process started with this session's --settings writes the same
      // status.json, and Claude Code's background daemon starts more than one
      // (a spare beside the moved conversation). A status id change is a
      // conversation switch only once a SessionStart that moves the
      // conversation named it.
      parseSessionStart: ClaudeStatusParser.parseSessionStart,
      // `/bg` moves the conversation into a background session and `/fork`
      // copies it there, with identical hooks: background-sessions.ts.
      confirmsBackgroundMove: claudeConfirmsBackgroundMove,
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

  /**
   * Esc first (it stops a running turn or declines an open permission prompt),
   * a pause so the TUI reads it as its own key, then Ctrl+C (clears a draft in
   * full, and is a harmless first press on an empty input), then `/exit`.
   * Measured on 2.1.302 with `scripts/probe-claude-exit-paths.js`: it ended
   * Claude idle, busy, with a draft typed and with a permission prompt open,
   * young and mature, in 0.9 to 1.3 s, and approved nothing; with an answer
   * streaming it took about 2 s, as every typed path did. The old `\x03` +
   * `/exit\r` failed two of those states: a turn still thinking took Ctrl+C as
   * an interrupt and put its prompt back, so `/exit` was appended and sent as
   * a second paid turn and Claude never exited, and an open permission prompt
   * took the Enter as yes and ran the tool.
   *
   * On Windows it serves only an agent whose shell died, and on Linux nothing
   * types it, since a kill, a suspend and a quit close the console or hang up
   * the terminal instead (`consoleCloseIsGraceful`). macOS is still typed into.
   */
  getExitSequence(): ExitSequenceStep[] {
    return ['\x1b', { delayMs: 400 }, '\x03', '/exit\r'];
  }

  /**
   * Closing Claude's console on Windows (`CTRL_CLOSE_EVENT`) is a graceful exit.
   * Measured on 2.1.302 idle, busy, with a draft and with a permission prompt
   * open, young and mature, and with an answer streaming: Claude ran its
   * SessionEnd hooks (reason `other`), withdrew its fullscreen boot record
   * within 170 ms of the close, typed nothing into any prompt, and exited by
   * itself 0.3 to 0.9 s after the close (about 1.9 s while streaming), tens of
   * milliseconds to 0.9 s after its shell.
   *
   * So is the hangup on Linux, node-pty's kill (SIGHUP to the shell, which
   * bash passes on to Claude). Measured on 2.1.304 in WSL2 in the same states
   * and ages (`scripts/probe-claude-exit-paths-linux.py`): SessionEnd (`other`)
   * within 162 ms, exit 0.33 to 0.71 s after the hangup, every young record
   * withdrawn, no turn sent, no tool run; the same with the terminal's master
   * closed as the shell exits, which is the quit. macOS is not measured and
   * keeps the typed sequence.
   */
  consoleCloseIsGraceful(platform: NodeJS.Platform): boolean {
    return platform === 'win32' || platform === 'linux';
  }

  /**
   * Measured 2026-10-25 on 437 turns of a board's workflow tasks: no healthy
   * turn went more than 10.0 minutes without a write to its transcript or a
   * subagent's, which is Claude Code's own cap on a foreground command (past it
   * the command moves to the background). Three hung turns went 114 minutes.
   * Twice the cap is the limit. Esc is Claude's interrupt of a busy turn; the
   * check never writes it to a permission prompt, where it would mean no.
   */
  readonly hungTurn: HungTurnSpec = { quietLimitMs: 20 * 60_000, interruptKeys: '\x1b' };

  /**
   * Any MCP tool but Kangentic's own: the most a session's allow rules can hand
   * the plan tool approval hook (plan-tool-approval.ts). Which of them the hook
   * answers is the session's own rules, decided in the hook.
   */
  mayApprovePlanTool(toolName: string): boolean {
    return mayApproveClaudePlanTool(toolName);
  }

  detectFirstOutput(data: string): boolean {
    // Claude Code hides the cursor when its TUI takes over the terminal. The
    // shell's startup frame can carry the same escape (seen under pwsh 7.6
    // and Windows PowerShell, seconds before Claude ran), so the match only
    // times the boot geometry re-assert; the launch overlay waits for Claude's
    // own output (see AgentOutputTracker).
    return data.includes('\x1b[?25l');
  }

  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    return configuredModelFromClaudeCommand(command);
  }

  // The same humanizer buildModelDisplayNames applies to discovered ids, so a
  // telemetry-learned row reads like its neighbours ("Opus 4.1", not the id).
  modelDisplayName(modelId: string): string | null {
    return humanizeClaudeModelId(modelId);
  }

  /**
   * Wherever Claude wrote the conversation: a `--resume` from another folder
   * keeps appending to the file under the folder it started in. See
   * `transcript-locator.ts` for the order the places are tried in.
   */
  locateSessionHistoryFile(
    agentSessionId: string,
    cwd: string,
    place?: CliPlace | null,
    reportedPath?: string | null,
  ): Promise<string | null> {
    return findClaudeTranscriptFile({ agentSessionId, cwd, place, reportedPath });
  }

  /**
   * Narrower than `locateSessionHistoryFile`: only the cwd's file or a parent
   * folder's, where Claude's own `--resume` was measured to read it. A history
   * under a renamed worktree's old slug is found by the locator's scan but not
   * by this, so the migrate-on-resume still moves it.
   */
  locateResumeHistoryFile(agentSessionId: string, cwd: string, place?: CliPlace | null): Promise<string | null> {
    return findClaudeResumeTranscriptFile({ agentSessionId, cwd, place });
  }

  proveConversationGone(params: {
    agentSessionId: string;
    reportedPaths: ReadonlyArray<string>;
    cwd: string;
    place?: CliPlace | null;
  }): Promise<boolean> {
    return proveClaudeConversationGone(params);
  }

  /** `/bg` moves a task's conversation into a background session its terminal does not own: background-sessions.ts. */
  stopBackgroundSession(options: { agentSessionId: string; cliPath: string }): Promise<boolean> {
    return stopClaudeBackgroundSession(options);
  }

  /** A fork into a background session resumes by its predecessor until its first turn: background-sessions.ts. */
  resolveResumableSessionId(options: { agentSessionId: string; cwd: string; place?: CliPlace | null }): Promise<string> {
    return resolveClaudeResumableSessionId(options);
  }

  /** `/bg` ends the transcript it moved out of by naming the session it moved into: background-sessions.ts. */
  backgroundSessionOf(options: { agentSessionId: string; cwd: string; place?: CliPlace | null }): Promise<string | null> {
    return claudeBackgroundSessionOf(options);
  }

  async parseTranscript(
    agentSessionId: string,
    cwd: string,
    place?: CliPlace | null,
    reportedPath?: string | null,
  ): Promise<ParsedTranscript> {
    const filePath = await resolveClaudeTranscriptFile({ agentSessionId, cwd, place, reportedPath });
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
    place?: CliPlace | null,
    reportedPath?: string | null,
  ): Promise<ParsedTranscriptWindow> {
    const filePath = await resolveClaudeTranscriptFile({ agentSessionId, cwd, place, reportedPath });
    const window = await parseClaudeTranscriptWindow(
      filePath, startByte, maxBytes, attributedMessageIds,
    );
    return { ...window, sourcePath: filePath };
  }

  /** One page of the transcript's history for the Conversation viewer. */
  async readTranscriptPage(
    agentSessionId: string,
    cwd: string,
    request: TranscriptPageReadRequest,
    place?: CliPlace | null,
    reportedPath?: string | null,
  ): Promise<TranscriptPageReadResult> {
    const filePath = await resolveClaudeTranscriptFile({ agentSessionId, cwd, place, reportedPath });
    return readClaudeTranscriptPage(filePath, request);
  }

  /**
   * Staleness signature for the session's `subagents/` directory. Its own
   * signature, because a running subagent moves no byte of the main transcript.
   */
  statSubagentTranscripts(
    agentSessionId: string,
    cwd: string,
    place?: CliPlace | null,
    reportedPath?: string | null,
  ): SubagentTranscriptSignature | null {
    return statClaudeSubagentDir(locateClaudeSubagentDir(agentSessionId, cwd, place ?? null, reportedPath ?? null));
  }

  /** Every Task-tool subagent's tokens for this session, folded to one turn per
   *  API message. See `subagent-usage-parser.ts` for why the fold rule differs
   *  from the main transcript's. */
  async parseSubagentUsage(
    agentSessionId: string,
    cwd: string,
    place?: CliPlace | null,
    reportedPath?: string | null,
  ): Promise<ParsedSubagentUsage> {
    return parseClaudeSubagentUsage(agentSessionId, cwd, place ?? null, reportedPath ?? null);
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
   * `transcriptPath` Claude reported in status.json when its file is there;
   * otherwise the locator finds the conversation from the session id + cwd
   * (`resolveRunTranscriptPath`). Returns null (caller falls back to the live
   * snapshot) when neither a path nor an id+cwd is available, or the file is
   * missing/unparseable.
   */
  async transcriptUsage(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    place?: CliPlace | null;
  }): Promise<TranscriptUsage | null> {
    const filePath = await resolveRunTranscriptPath(input);
    if (!filePath) return null;
    return parseClaudeTranscriptUsage(filePath);
  }

  async transcriptToolCounts(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    sinceMs?: number | null;
    untilMs?: number | null;
    place?: CliPlace | null;
  }): Promise<TranscriptToolCounts | null> {
    const filePath = await resolveRunTranscriptPath(input);
    if (!filePath) return null;
    return parseClaudeTranscriptToolCounts(filePath, input.sinceMs, input.untilMs);
  }

  async transcriptToolResultTokens(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    sinceMs?: number | null;
    untilMs?: number | null;
    place?: CliPlace | null;
  }): Promise<Record<string, number> | null> {
    const filePath = await resolveRunTranscriptPath(input);
    if (!filePath) return null;
    return parseClaudeTranscriptToolResultTokens(filePath, input.sinceMs, input.untilMs);
  }

  /**
   * A title on the answer run's flags. It used to be `--print --permission-mode
   * plan` in the project root with no model: every call landed on the CLI's
   * default model (Opus) and read the project's CLAUDE.md, built-in tools and
   * MCP servers, about 90k cache-write plus 31k cache-read tokens for a 4 to 8
   * word title (13 runs audited on 2026-10-13), and each left a transcript in
   * the project's resume list. `answerArgs` drops all of that, and `cwd` is the
   * answer home. No plan mode: it rerouted a `--model haiku` call to Sonnet
   * (see `answerArgs`). A stale `ANTHROPIC_API_KEY` is retried on the stored
   * login (`subscription-fallback.ts`).
   */
  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    const effort = options?.effort ?? null;
    // A Claude installed in a WSL distro runs there.
    const cliTarget = await resolveCliTarget(cliPath, true);
    return withConfigDirectory(options?.runDirectory, (directory) => {
      const { args } = answerArgs({ directory, retrieval: undefined, streaming: false, model: options?.model, effort, place: cliTarget });
      return runWithSubscriptionFallback((credentialEnv) => runCliPrintSummarize({
        cliPath,
        args,
        prompt: buildSummarizePrompt(prompt),
        cwd,
        extractRaw: createJsonResultExtractor(options?.onUsage),
        outputBudget: SUMMARIZE_JSON_OUTPUT_BUDGET,
        env: { ...answerEnv(effort).env, ...credentialEnv },
        cliTarget,
      }));
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
   * Remeasured on CLI 2.1.293 through the real Ask arguments (stream-json in and
   * out, the search tool allowed), on that same table question and on "What is
   * the most expensive task?" over a 717-task board, three runs each, median time
   * to the result line over the six:
   *
   *   Sonnet 5.5 low, thinking off          5.0 s          right 6 of 6
   *   Sonnet 5.5 max                        14.6 s         right 6 of 6
   *   Haiku 5.5 low, thinking off           3.8 s          right 6 of 6
   *   Haiku 5.5 high                        4.7 s          right 6 of 6
   *   Haiku 5.5 max                         21.8 s         right 6 of 6
   *
   * Haiku 5.5 does follow the level, and at low it answered both as well as
   * Sonnet, faster and at about a twentieth of the cost. The count Sonnet low
   * got wrong in the first table came out right at every level here. The two
   * setups differ (a bare `--print` with JSON out there, the app's own Ask call
   * here), so this does not say which change made the difference. So `low`
   * keeps the pin for every model, and a user who wants more care on a hard
   * question can buy it with a higher level.
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
    // A Claude installed in a WSL distro runs there.
    const cliTarget = await resolveCliTarget(cliPath, true);

    return withConfigDirectory(options?.runDirectory, async (configDirectory) => {
      const { args, mcpServer } = answerArgs({ directory: configDirectory, retrieval, streaming, model, effort, place: cliTarget });
      // A distro on NAT networking reaches the search tool through the bridge,
      // whose relay lives as long as this one call.
      const stopRelay = startRunMcpRelay(configDirectory, mcpServer);
      // A run whose answer already reached the user is not run a second time
      // on the stored login, which would show it twice.
      const callerOnEvent = options?.onEvent;
      let streamedEvent = false;
      const onEvent = callerOnEvent
        ? (event: AnswerStreamEvent) => {
          streamedEvent = true;
          callerOnEvent(event);
        }
        : undefined;
      try {
        return await runWithSubscriptionFallback(
          (credentialEnv) => this.runAnswer({ cliPath, cliTarget, args, prompt, cwd, effort, credentialEnv, onEvent, onUsage: options?.onUsage }),
          () => !streamedEvent,
        );
      } finally {
        stopRelay();
      }
    });
  }

  /** One print-mode answer run: the flags are the caller's, the stream handling is here. */
  private runAnswer(input: {
    cliPath: string;
    cliTarget: CliTarget | null;
    args: string[];
    prompt: string;
    cwd: string;
    effort: string | null;
    /** Variables this run unsets (`runWithSubscriptionFallback`). */
    credentialEnv: Record<string, undefined>;
    onEvent: AnswerFromContextOptions['onEvent'];
    onUsage: AnswerFromContextOptions['onUsage'];
  }): Promise<string> {
    const { cliPath, cliTarget, args, prompt, cwd, effort, credentialEnv, onEvent, onUsage } = input;
    return runCliPrintAnswer({
      cliPath,
      cliTarget,
      args,
      ...(onEvent
        ? {
          // In stream mode stdout is a transcript of JSON lines, not the
          // answer. The final answer is the last assistant turn's text; the
          // runner's `extractRaw` seam is exactly where that reduction belongs.
          extractRaw: (stdout: string) => extractStreamedAnswer(stdout, onUsage),
          // And stdout is a transcript, not an answer: tool results and
          // per-delta envelopes for a two-paragraph answer run to hundreds of
          // kilobytes. The answer-sized budget killed the CLI mid-search.
          outputBudget: ANSWER_STREAM_OUTPUT_BUDGET,
          // Forward each line's events as they land. A chunk can end
          // mid-line, so lines are reassembled across chunks before parsing.
          onChunk: makeStreamForwarder(onEvent),
        }
        : {
          // One JSON object: the answer inside an envelope of usage.
          extractRaw: createJsonResultExtractor(onUsage),
          outputBudget: ANSWER_JSON_OUTPUT_BUDGET,
        }),
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
      env: { ...answerEnv(effort).env, ...credentialEnv },
      prompt,
      cwd,
    });
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
    // A Claude installed in a WSL distro runs there. Opened synchronously, so
    // from the distro facts its detection already read. A distro path whose
    // facts are not read yet never runs here: the throw makes the pool answer
    // with a fresh run, which reads them.
    const cliTarget = peekCliTarget(input.cliPath, true);
    if (!cliTarget && parseWslCliPath(input.cliPath)) {
      throw new Error(`The WSL distro facts for ${input.cliPath} are not read yet`);
    }
    const { args, mcpServer } = answerArgs({ directory: input.runDirectory, retrieval: input.retrieval, streaming: true, model: input.model, effort, place: cliTarget });
    // The bridge's relay, on a distro on NAT networking, lives as long as the
    // session's process.
    const stopRelay = startRunMcpRelay(input.runDirectory, mcpServer);
    let session: AnswerSession;
    try {
      session = openStdinJsonSession({
        cliPath: input.cliPath,
        cliTarget,
        args: [...args, '--input-format', 'stream-json'],
        cwd: input.cwd,
        ...answerEnv(effort),
        formatTurn: (prompt) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }),
        createReducer: createAnswerStreamReducer,
        isTurnEnd: isResultLine,
        extractAnswer: extractStreamedAnswer,
      });
    } catch (error) {
      // A spawn that throws leaves no process whose exit would stop the relay.
      stopRelay();
      throw error;
    }
    void session.exited.then(stopRelay, stopRelay);
    return session;
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
        // Rebuilt every 25 ms poll, so the locator's cache keeps a conversation
        // filed under another folder to one stat per poll after the first find.
        const filePath = await resolveClaudeTranscriptFile({
          agentSessionId: context.agentSessionId,
          cwd: context.cwd,
          place: placeFromStored(context.cliTarget),
          reportedPath: context.transcriptPath,
        });
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
