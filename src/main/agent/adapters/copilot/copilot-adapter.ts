import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CopilotDetector } from './detector';
import { createCopilotAnswerReducer, extractCopilotAnswer } from './answer-stream';
import { CopilotCommandBuilder } from './command-builder';
import { removeSessionConfig } from './hook-manager';
import { CopilotStatusParser } from './status-parser';
import { CopilotStreamParser } from './stream-parser';
import { migrateCopilotProjectData } from './project-relocation';
import { discoverCopilotCapabilities } from './capability-discovery';
import { COPILOT_HISTORY_FILE_NAME, createCopilotCommandInjectionVerifier, resolveCopilotHistoryPath } from './command-injection-verifier';
import { buildSummarizePrompt, titleFromAnswer } from '../../shared/auto-name';
import { runCliPrintAnswer, forwardStreamLines, ANSWER_STREAM_OUTPUT_BUDGET } from '../../shared/cli-answer';
import { sharedFolderKey } from '../../shared/shared-folder-holds';
import type { AgentAdapter, AgentInfo, AnswerFromContextOptions, SpawnCommandOptions, SettingsChangeSpec, SummarizeOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier, AgentCapabilities } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * GitHub Copilot CLI adapter - wraps CopilotDetector, CopilotCommandBuilder,
 * and copilot-hook-manager behind the generic AgentAdapter interface.
 *
 * Copilot CLI (v1.0+) supports:
 * - statusLine config (same pattern as Claude Code)
 * - Hooks (preToolUse, postToolUse, agentStop, preCompact) in a per-session
 *   `<config home>/hooks/kangentic.json`
 * - Explicit session ID via --session-id <uuid> (new or resumed)
 * - Native --plan mode
 * - --yolo for full permission bypass
 */
export class CopilotAdapter implements AgentAdapter {
  readonly name = 'copilot';
  readonly displayName = 'GitHub Copilot CLI';
  readonly sessionType = 'copilot_agent';

  /**
   * Copilot supports caller-specified session IDs via --session-id <uuid>
   * (1.0.51+). Passing a new UUID starts a fresh session with that ID; passing
   * an existing UUID resumes it. Same semantics as Claude's --session-id.
   */
  readonly supportsCallerSessionId = true;
  // `--additional-mcp-config` pointing at a file in the session's own directory.
  readonly kangenticMcp = 'per-session' as const;
  // An async or still-running `powershell`/`bash` call reports its shellId in
  // the result, `stop_powershell`/`stop_bash` stop it, and a postToolUse
  // `additionalContext` reaches the model (COPILOT_BACKGROUND_COMMAND_SPEC,
  // measured on 1.0.100).
  readonly backgroundCommands = { source: 'hooks', launchHint: true } as const;

  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only)' },
    { mode: 'dontAsk', label: 'Plan Non-Interactive (CI)' },
    { mode: 'default', label: 'Default (Confirm Actions)' },
    { mode: 'acceptEdits', label: 'Allow All Tools' },
    { mode: 'auto', label: 'Autopilot (Allow All Tools)' },
    { mode: 'bypassPermissions', label: 'YOLO (Full Access)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new CopilotDetector();
  private readonly commandBuilder = new CopilotCommandBuilder();

  /**
   * Each session's own copilot-config directory, keyed by the session id its
   * command was built with (`ptySessionId`), with the folder it was built
   * for. The directory sits in the session's own dir, so nothing is shared:
   * a release removes that session's directory alone, and never another
   * session's of the same task. The project-delete sweep (no session id)
   * removes every directory recorded for its folder.
   */
  private readonly sessionConfigDirs = new Map<string, { folder: string; configDir: string }>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // Copilot CLI handles directory trust via --add-dir at runtime.
    // No pre-approval step needed.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, model, effort, ...rest } = options;
    const command = this.commandBuilder.buildCopilotCommand({
      copilotPath: agentPath,
      model,
      effort,
      ...rest,
    });
    // Track the session's config dir for cleanup. The session layer releases
    // with removeHooks(<cwd>, <the session's id>).
    if (options.eventsOutputPath && options.ptySessionId) {
      const configDir = path.resolve(path.dirname(options.eventsOutputPath), 'copilot-config');
      this.sessionConfigDirs.set(options.ptySessionId, { folder: options.cwd, configDir });
    }
    return command;
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: how Copilot exposes activity state and session data.
   *
   * - Activity: hooks primary (Copilot's preToolUse/postToolUse/agentStop),
   *   PTY silence timer as fallback.
   * - StatusFile: Copilot's statusLine is best-effort - empirically it
   *   does not fire in every PTY session (tested against v1.0.27 on Windows
   *   ConPTY), so we wire it but don't depend on it.
   * - StreamOutput: primary telemetry path. Parses (a) the NDJSON stream
   *   Copilot emits when invoked with `--output-format json`, and (b) the
   *   interactive TUI's bottom status bar for a known Copilot model label
   *   via regex. Either path populates `SessionUsage.model` so ContextBar
   *   lifts its "Starting agent..." spinner within the first few PTY
   *   chunks regardless of whether the user is running the agent
   *   interactively or headlessly.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    statusFile: {
      parseStatus: CopilotStatusParser.parseStatus,
      parseEvent: CopilotStatusParser.parseEvent,
      isFullRewrite: true,
    },
    streamOutput: {
      createParser: () => new CopilotStreamParser(),
    },
    // Its turn-end hook reaches the engine as an Idle event.
    reportsTurnEnd: true,
    activity: ActivityDetection.hooksAndPty(),
  };

  removeHooks(directory: string, sessionId?: string): void {
    if (sessionId) {
      // The session's own config dir, wherever it was built: the release
      // needs no folder match.
      const tracked = this.sessionConfigDirs.get(sessionId);
      if (!tracked) return;
      this.sessionConfigDirs.delete(sessionId);
      removeSessionConfig(tracked.configDir);
      return;
    }
    // No session id (the project-delete sweep): every session built for this
    // folder.
    const folderKey = sharedFolderKey(directory);
    for (const [trackedSessionId, tracked] of this.sessionConfigDirs) {
      if (sharedFolderKey(tracked.folder) !== folderKey) continue;
      removeSessionConfig(tracked.configDir);
      this.sessionConfigDirs.delete(trackedSessionId);
    }
  }

  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      // MEASURED at 36-38ms, the fastest of any adapter and flat against a 32s
      // turn. Copilot's HOOKS still do not fire on user-prompt submit - that
      // part of the old comment was right - but it keeps
      // `command-history-state.json` in its config home, which does record
      // every submission. Slash commands included. A Kangentic session's home
      // is its own copilot-config folder (`--config-dir`), so the verifier
      // reads the files of the sessions built for that folder, then the
      // global one. See command-injection-verifier.ts.
      return createCopilotCommandInjectionVerifier((context) => {
        const cwd = context.type === 'command-injection' ? context.cwd : undefined;
        const folderKey = cwd ? sharedFolderKey(cwd) : null;
        const sessionFiles = [...this.sessionConfigDirs.values()]
          .filter((tracked) => folderKey === null || sharedFolderKey(tracked.folder) === folderKey)
          .map((tracked) => path.join(tracked.configDir, COPILOT_HISTORY_FILE_NAME));
        return [...sessionFiles, resolveCopilotHistoryPath()];
      });
    }
    // 'paste': hooks fire on tool/agent boundaries (preToolUse, postToolUse,
    // agentStop, preCompact) but not on submit, so the paste engine's activity
    // and data-floor backstops cover it.
    return null;
  }

  /**
   * Copilot's prompt history is a single GLOBAL file with no session id in it,
   * so `cwd` and the agent session id play no part in locating it.
   */
  requiresAgentSessionIdForVerification(): boolean {
    return false;
  }

  /**
   * CONFIRM-ONLY. Copilot measured fastest of any adapter (38ms), and the file
   * is trivially located, so the usual path-resolution doubt does not apply.
   * What is unproven is the COMPARISON: the harness matched a nonce SUBSTRING,
   * while the verifier requires the whole entry to trim-equal the submitted
   * text, and no real capture of this file is committed to test the extractor
   * against. If Copilot normalises or decorates what it stores, every entry
   * misses and every auto_command escalates.
   *
   * The concurrency guard points the other way and is deliberate: the file is
   * global across sessions and projects, so a match is accepted from any of the
   * newest few entries. That biases the residual error toward a harmless false
   * POSITIVE. Escalation would convert the opposite error into a restart, which
   * is why it stays off until the extractor is pinned to a real capture.
   */
  canEscalateOnVerificationFailure(): boolean {
    return false;
  }

  clearSettingsCache(): void {
    // Copilot uses per-session config dirs, no shared settings cache.
  }

  getExitSequence(): string[] {
    // Ctrl+C to interrupt, then /exit to quit the Copilot CLI TUI.
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Copilot CLI hides the cursor when its TUI takes over the terminal.
    // Same heuristic as Codex and Gemini adapters.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(
    _agentSessionId: string,
    _cwd: string,
  ): Promise<string | null> {
    // Copilot session history file location is not yet empirically verified.
    // Activity events flow through the hooks pipeline (event-bridge JSONL).
    return null;
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverCopilotCapabilities(cliPath);
  }

  getInjectionSequence(spec: SettingsChangeSpec): string[] {
    const sequence: string[] = [];
    // Copilot supports `/model <model>` slash command for live model switching
    if (spec.modelChanged && spec.model) {
      sequence.push(`/model ${spec.model}`);
    }
    // Copilot supports `/reasoning-effort <level>` for live effort switching
    if (spec.effortChanged && spec.effort) {
      sequence.push(`/reasoning-effort ${spec.effort}`);
    }
    return sequence;
  }

  /**
   * A title on the answer run: nothing asked of the user, and the session
   * folder removed after. The plain run this replaced left a `session-state`
   * folder per title, which model discovery also reads. Measured on the title
   * prompt in an empty folder: a clean title in 8.0 s.
   */
  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    return titleFromAnswer(await this.answerFromContext(buildSummarizePrompt(prompt), cliPath, cwd, options?.model, {
      effort: options?.effort,
      runDirectory: options?.runDirectory,
      onUsage: options?.onUsage,
    }));
  }

  readonly answerCapabilities = { streaming: true, search: true, model: true, effort: true, defaultEffort: 'low' };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * Non-interactive with status output silenced, the prompt PIPED rather than
   * passed through `-p`. An answer prompt runs to about 50k characters, past the
   * Windows command-line limit, and Copilot reads a piped prompt the same way
   * (measured: a 61,584-character prompt answered from its middle row).
   *
   * Read-only without a flag: with no `--allow-tool` or `--allow-all-tools` a
   * non-interactive run has nothing that may write, and it refused both a file
   * write and a shell command in the probe.
   *
   * Effort is per MODEL in Copilot: `auto` refuses `--reasoning-effort` with
   * "does not support reasoning effort configuration", and that error reaches
   * the user verbatim rather than the flag being dropped behind their back.
   *
   * STREAMING is `--output-format json --stream on`: JSONL whose
   * `assistant.message_delta` lines carry the text as written
   * (`answer-stream.ts`, measured on CLI 1.0.88).
   *
   * SEARCH is our server added for this run only (`--additional-mcp-config`,
   * which augments the user's own config), approved by name (`--allow-tool`),
   * and made the ONLY tool the model can see: `--available-tools kangentic`
   * disabled every built-in tool in the probe (create, edit, powershell, view,
   * web_fetch among them) while the search worked. Stronger than not approving
   * them, since the model is never offered a write it could ask for.
   * `--disable-builtin-mcps` drops the GitHub server.
   *
   * The session is named up front (`--session-id`) and removed from
   * `~/.copilot/session-state` after the run: an answer is not a session to
   * resume, and each one left a folder there, which Copilot's model discovery
   * also reads.
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
    const retrieval = options?.retrieval;
    const onEvent = options?.onEvent;
    const sessionId = randomUUID();
    const searchArgs: string[] = [];
    // A run directory goes with its run. Without one the config lands in the
    // shared answer home, so this run removes it, token and all, when it ends.
    let strayConfigPath: string | null = null;
    if (retrieval) {
      const configPath = path.join(options?.runDirectory ?? cwd, 'copilot-answer-mcp.json');
      if (!options?.runDirectory) strayConfigPath = configPath;
      // sync-write-ok: the run names this file in --additional-mcp-config and
      // cannot search without it. The throw reaches the KNOWLEDGE_GRAPH_ANSWER
      // handler's catch, which shows it as the answer's failure.
      fs.writeFileSync(configPath, JSON.stringify({
        mcpServers: { kangentic: { type: 'http', url: retrieval.url, headers: { 'X-Kangentic-Token': retrieval.token } } },
      }));
      searchArgs.push(
        '--additional-mcp-config', `@${configPath}`,
        '--allow-tool', 'kangentic',
        '--available-tools', 'kangentic',
        '--disable-builtin-mcps',
      );
    }
    const reduce = createCopilotAnswerReducer();
    try {
      return await runCliPrintAnswer({
        cliPath,
        // The model and effort flags are OMITTED when none is chosen: passing an
        // empty value is an error.
        args: [
          '--silent',
          '--output-format', 'json',
          '--stream', onEvent ? 'on' : 'off',
          '--session-id', sessionId,
          '--no-ask-user',
          ...searchArgs,
          ...(model ? ['--model', model] : []),
          ...(options?.effort ? ['--reasoning-effort', options.effort] : []),
        ],
        prompt,
        cwd,
        extractRaw: extractCopilotAnswer,
        outputBudget: ANSWER_STREAM_OUTPUT_BUDGET,
        ...(onEvent
          ? { onChunk: forwardStreamLines((line) => { for (const event of reduce(line)) onEvent(event); }) }
          : {}),
      });
    } finally {
      await fs.promises.rm(path.join(os.homedir(), '.copilot', 'session-state', sessionId), { recursive: true, force: true })
        .catch(() => undefined);
      if (strayConfigPath) await fs.promises.rm(strayConfigPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Copilot records each session's working directory in
   * ~/.copilot/session-state/<uuid>/workspace.yaml; v1.0.52+ restores resume in
   * that saved cwd. Rewrite the cwd / git_root fields so resume reopens the
   * moved project. Best-effort and version-fragile; see migrateCopilotProjectData.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateCopilotProjectData(oldPath, newPath);
  }
}
