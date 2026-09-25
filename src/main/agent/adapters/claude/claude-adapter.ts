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
import { resolveBackgroundTaskOutputFile } from './background-task-output';
import { reportTerminatedBackgroundShells } from './background-shell-transcript';
import { ensureWorktreeTrust, ensureMcpServerTrust } from './trust-manager';
import { migrateClaudeProjectData } from './project-relocation';
import { removeHooks as removeClaudeHooks } from './hook-manager';
import {
  runCliPrintSummarize,
  runCliPrintAnswer,
  buildSummarizePrompt,
  extractStreamedAnswer,
  createAnswerStreamReducer,
  ANSWER_STREAM_OUTPUT_BUDGET,
  type AnswerStreamEvent,
} from '../../shared/auto-name';
import { discoverClaudeStaticCapabilities, rescanClaudeModels } from './capability-discovery';
import { createSlashCommandVerifier } from './slash-command-verifier';
import { configuredModelFromClaudeCommand, buildModelDisplayNames } from './model-display-name';
import { ClaudeSessionHistoryParser } from './session-history-parser';
import type {
  AgentAdapter,
  AgentInfo,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedTranscript,
  ParsedTranscriptWindow,
  AnswerFromContextOptions,
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
export function writeScopedMcpConfig(retrieval: { url: string; token: string }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-'));
  const configPath = path.join(directory, 'mcp.json');
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
 * Turn a stream of stdout chunks into a stream of answer events.
 *
 * Chunk boundaries fall anywhere, including mid-line, so lines are reassembled
 * before parsing: a partial JSON line is held until its newline arrives. The
 * tail left after the final chunk is not flushed on purpose - it is either
 * empty or an unterminated line the CLI never finished, and neither is an
 * event.
 */
export function makeStreamForwarder(onEvent: (event: AnswerStreamEvent) => void): (chunk: string) => void {
  let pending = '';
  // Stateful, so a turn that arrived as deltas is not shown a second time when
  // its complete `assistant` line follows.
  const reduce = createAnswerStreamReducer();
  return (chunk) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      for (const event of reduce(line)) onEvent(event);
      newline = pending.indexOf('\n');
    }
  };
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
  // images (claude-code #26679), and a bare typed path is never auto-recognized
  // as an image (no @file support for images). Kangentic's own clipboard/drop
  // capture is reliable, so inject an explicit Read instruction pointing at the
  // saved temp PNG instead of a bare path.
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
    const models = await rescanClaudeModels(cliPath, forceRefresh);
    return models
      ? { ...staticCapabilities, models, modelDisplayNames: buildModelDisplayNames(models) }
      : staticCapabilities;
  }

  async ensureTrust(workingDirectory: string): Promise<void> {
    await ensureWorktreeTrust(workingDirectory);
    await ensureMcpServerTrust(workingDirectory);
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

  /** Stateless bounded window, for the conversation indexer's whole-file walk. */
  async parseTranscriptWindow(
    agentSessionId: string,
    cwd: string,
    startByte: number,
    maxBytes: number,
  ): Promise<ParsedTranscriptWindow> {
    const filePath = locateClaudeTranscriptFile(agentSessionId, cwd);
    const window = await parseClaudeTranscriptWindow(filePath, startByte, maxBytes);
    return { ...window, sourcePath: filePath };
  }

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
    const mcpConfigPath = retrieval ? writeScopedMcpConfig(retrieval) : null;
    const streaming = options?.onEvent !== undefined;

    try {
      return await runCliPrintAnswer({
        cliPath,
        // The flag is OMITTED when no model is chosen, rather than passed empty:
        // `--model ''` is an error, and the absence of the flag is exactly what
        // "use the agent's own default" means to the CLI.
        // MINIMAL BY MEASUREMENT. A trivial ten-token prompt through this call
        // carried ~52,000 tokens of context: built-in tool definitions, every MCP
        // server the user has configured, and the project's CLAUDE.md. Ask needs
        // none of it - the prompt is self-contained and the rules tell the agent
        // to answer only from what is in it.
        //
        //   as it was                       ~52,000 tokens
        //   + --tools '' --strict-mcp-config ~26,800
        //   + a neutral cwd (the caller)      ~8,000
        //
        // `--tools ''` drops the built-in tools; `--strict-mcp-config` makes
        // the scoped `--mcp-config` below the WHOLE server list, so a user's
        // own servers do not leak into a question about their task history.
        //
        // NOT `--permission-mode plan`, which this call carried as a "second
        // lock" until it was measured. On CLI 2.1.260, plan mode with
        // `--model haiku` answered from claude-sonnet-5 (message_start.model)
        // at ~3x the notional cost and with ~10k more tokens of system prompt;
        // the identical call without plan mode answered from haiku. The lock
        // was redundant and it was the most expensive line in the command.
        // What keeps this read-only is the empty tool list plus the allowlist,
        // and `--permission-prompts none` denies anything that would ever
        // prompt rather than letting a headless run block or be granted.
        args: [
          '--print',
          '--permission-prompts', 'none',
          '--tools', '',
          '--strict-mcp-config',
          ...(mcpConfigPath
            ? ['--mcp-config', mcpConfigPath, '--allowedTools', ANSWER_RETRIEVAL_TOOL]
            : []),
          // stream-json is what makes progress visible, and partial messages
          // are what make it a STREAM: without them the CLI emits one line per
          // completed turn, so a one-turn answer arrives all at once at the
          // end (measured: first text at 4.8s of a 5.5s call); with them the
          // model's deltas come through as written (measured: 1.3s to the
          // first). `--verbose` is required alongside stream-json in print
          // mode.
          ...(streaming
            ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages']
            : []),
          ...(model ? ['--model', model] : []),
        ],
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
      // NO EXTENDED THINKING, and this is the latency of the feature.
      //
      // Measured on a realistic 350-row prompt: thinking on took 4,038ms of API
      // time and generated 253 output tokens of which 231 - 91% - were thinking.
      // Off took 2,041ms and 19 tokens, and returned the IDENTICAL answer.
      //
      // Which is what you would expect from the shape of the work. The prompt
      // already contains the whole table, the arithmetic is computed before the
      // agent sees it, and the task is to read and report. There is nothing here
      // to reason toward, so the reasoning was latency the user pays for and no
      // answer they would not have got anyway.
      //
      // `MAX_THINKING_TOKENS` is Claude Code's own control, which is why this
      // lives in the Claude adapter rather than in the shared runner.
        env: { MAX_THINKING_TOKENS: '0' },
        prompt,
        cwd,
      });
    } finally {
      // The config carries a live token. It exists only for the duration of
      // one call, and `force` because Windows may still hold the handle for a
      // beat after the child exits.
      if (mcpConfigPath) fs.rmSync(mcpConfigPath, { force: true });
    }
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
        // sentAt comes from TerminalSubmit.submitKeystrokes's most-recent
        // Enter timestamp, re-advanced on each retry attempt. Falling back to
        // Date.now() preserves single-call use (e.g. ad-hoc verifier
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
   * Claude accepts the slash forms `/model <id>` and `/effort <level>` as
   * valued commands that bypass the interactive picker - confirmed
   * empirically (scripts/probe-claude-model-forms.js for the CLI flag form,
   * and live-tested for the slash form). Order is /model before /effort
   * because /effort xhigh is Opus-only; setting the model first ensures
   * /effort lands on a model that accepts the requested level.
   */
  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    if (spec.modelChanged && spec.model) sequence.push(`/model ${spec.model}`);
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
