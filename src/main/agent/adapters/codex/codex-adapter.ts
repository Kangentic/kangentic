import { CodexDetector } from './detector';
import { CodexCommandBuilder } from './command-builder';
import { removeHooks as removeCodexHooks } from './hook-manager';
import { CodexSessionHistoryParser } from './session-history-parser';
import { createCodexCommandInjectionVerifier } from './command-injection-verifier';
import { parseCodexTranscript, locateCodexTranscriptFile, readCodexTranscriptPage } from './transcript-parser';
import { migrateCodexProjectData } from './project-relocation';
import { ensureWorktreeTrust, removeWorktreeTrust } from './trust-manager';
import { CodexStatusParser } from './status-parser';
import { CodexHookTrustCheck } from './hook-trust';
import { discoverCodexCapabilities } from './capability-discovery';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import { resolveCliTarget, toStoredCliTarget, type CliPlace } from '../../shared/cli-target';
import { runCliPrintAnswer } from '../../shared/cli-answer';
import { SharedFolderHolds } from '../../shared/shared-folder-holds';
import type {
  AgentAdapter,
  AgentInfo,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedTranscript,
  SummarizeOptions,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
} from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier, AgentCapabilities, AgentLaunchOptionInfo } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/** How long a spawn waits for the hook trust read before going without hooks. */
const HOOK_TRUST_SETTLE_MS = 8_000;

/**
 * Codex CLI adapter - wraps CodexDetector, CodexCommandBuilder, and
 * codex-hook-manager behind the generic AgentAdapter interface.
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  readonly sessionType = 'codex_agent';
  readonly supportsCallerSessionId = false;
  // A Codex installed in a WSL distro, configured by its \\wsl.localhost path:
  // run in the distro's shell, its hooks through the WSL transport's script,
  // its trust and rollouts in the distro's CODEX_HOME (cli-target.ts).
  readonly supportsWslCli = true;
  // The startup banner in its own output names the session (`runtime.sessionId`).
  readonly capturesInteractiveSessionId = true;
  // `-c mcp_servers.kangentic.*` overrides, the token in the session's env.
  readonly kangenticMcp = 'per-session' as const;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Safe Read-Only Browsing' },
    { mode: 'dontAsk', label: 'Read-Only Non-Interactive (CI)' },
    { mode: 'default', label: 'Automatically Edit, Ask When Needed' },
    { mode: 'acceptEdits', label: 'Auto (Preset)' },
    { mode: 'bypassPermissions', label: 'Dangerous Full Access' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  /**
   * Codex boots an optional cloud ChatGPT Apps MCP connector on startup
   * (`apps` feature, stable and on by default per `codex features list`),
   * which can hang the whole session at "Booting MCP server: codex_apps"
   * (openai/codex#20167, #19284, #16550). `--disable apps` skips it for
   * Kangentic-launched sessions only - the user's `~/.codex/config.toml`
   * is never touched. See command-builder.ts for where `disableApps`
   * becomes the CLI flag.
   */
  readonly launchOptions: readonly AgentLaunchOptionInfo[] = [{
    id: 'disableApps',
    label: 'Disable ChatGPT Apps',
    description: "Skips Codex's optional ChatGPT Apps connector, which can hang startup. Doesn't touch your global config.",
    default: false,
  }];

  private readonly detector = new CodexDetector();
  private readonly commandBuilder = new CodexCommandBuilder();
  // Sessions active per project root. Originally tracked ownership of a
  // project-shared `.codex/hooks.json` we wrote on spawn. Codex 0.128
  // redesigned the hook system (hooks now live in `~/.codex/config.toml` or
  // in a Codex plugin folder), so Kangentic no longer writes that file -
  // `buildHooks` only sweeps stale legacy entries from pre-upgrade installs.
  // The holds stay because concurrent sessions in one project still race on
  // that legacy cleanup. A hold records the project root, so a worktree
  // session's release (which arrives with the worktree path) sweeps the root
  // the build swept. See SharedFolderHolds.
  private readonly hookHolds = new SharedFolderHolds();

  /** Codex's own answer for the trust of Kangentic's hooks, per binary (hook-trust.ts). */
  private readonly hookTrust = new CodexHookTrustCheck();

  /**
   * Background commands (task #859): the rollout reports a command still
   * running at its yield (`Process running with session ID N`, which Codex's
   * hooks never report: a yielded command fires no PostToolUse) and a poll
   * that finds it exited. No launch hint, since no hook fires at the yield.
   */
  readonly backgroundCommands = { source: 'session-history', launchHint: false } as const;

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    const info = await this.detector.detect(overridePath);
    // Read the hook trust as soon as the binary is known, so the first spawn
    // (which awaits it in ensureTrust) rarely waits. A Codex in a WSL distro
    // is read there, for the hooks it runs, keyed by its version.
    if (info.found && info.path) {
      const target = info.cliTarget ? await resolveCliTarget(info.path, true).catch(() => null) : null;
      if (target && info.version) {
        this.hookTrust.start(info.path, { target, version: info.version });
      } else {
        this.hookTrust.start(info.path);
      }
    }
    return info;
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(workingDirectory: string, place?: CliPlace | null): Promise<void> {
    // Codex DOES have a directory-trust dialog (this was previously
    // documented here as a no-op because it was believed not to). Because
    // trust is keyed on the git repo root and every task gets its own
    // worktree, the user would otherwise be prompted on EVERY task with no
    // answer that carries forward. See trust-manager.ts. A Codex in a WSL
    // distro keeps its trust in the distro's config.toml.
    await ensureWorktreeTrust(workingDirectory, place ?? null);
    // Every spawn path awaits this before buildCommand, which reads the
    // result synchronously. A read still running after the bound leaves this
    // session without hooks rather than holding the spawn.
    await this.hookTrust.settle(HOOK_TRUST_SETTLE_MS);
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, model, effort, ...rest } = options;
    const command = this.commandBuilder.buildCodexCommand({
      codexPath: agentPath,
      model,
      effort,
      ...rest,
      codexHookStateOverride: this.hookTrust.stateOverrideFor(agentPath),
    });
    // buildCodexCommand sweeps any stale legacy `.codex/hooks.json` in the
    // project root whenever eventsOutputPath is present. Hold that root until
    // this session releases, so concurrent sessions serialize their cleanup.
    if (options.eventsOutputPath) {
      this.hookHolds.retain(options.ptySessionId, options.projectRoot || options.cwd);
    }
    return command;
  }

  /**
   * Delivers the Kangentic MCP token to the Codex process via the environment
   * rather than argv. The companion `-c mcp_servers.kangentic.env_http_headers`
   * override in the built command names this variable; Codex resolves it at
   * MCP-connect time. See `KANGENTIC_MCP_TOKEN_ENV` in command-builder.ts for
   * why the token must not appear on the command line.
   */
  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    const { agentPath, model, effort, ...rest } = options;
    return this.commandBuilder.buildCodexEnv({
      codexPath: agentPath,
      model,
      effort,
      ...rest,
    });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: how Codex exposes activity state and session IDs.
   *
   * - Activity: hooks (`hooks_and_pty`, task #859). Kangentic's hooks report
   *   prompts, tools, permission waits and turn ends; the rollout adds what no
   *   hook reports (a failed turn, an interrupt, background commands). The PTY
   *   silence timer runs until a hook delivers a turn-initiating event, and
   *   for the whole session when Codex did not confirm the hooks' trust.
   * - Session ID (fromHook): reads `session_id` from the SessionStart
   *   hookContext (`thread_id` on older payloads). fromOutput stays the path
   *   for a session without hooks.
   * - Session ID (fromOutput): Codex v0.118+ prints "session id: <uuid>" in
   *   the startup header; older versions printed "codex resume thr_..." at exit.
   *   This UUID is used to locate the rollout file on disk.
   * - sessionHistory: tails ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<id>.jsonl
   *   for real-time model, context window, and token counts. See CodexSessionHistoryParser.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Codex has no status line (parseStatus returns null). Its hooks write
    // events.jsonl through the workspace bridge copy, registered as `-c`
    // overrides (hook-manager.ts) once Codex confirmed their trust.
    statusFile: {
      parseStatus: CodexStatusParser.parseStatus,
      parseEvent: CodexStatusParser.parseEvent,
      isFullRewrite: false,
    },
    // The Stop hook's Idle ends a turn for onTurnEnded (task #859).
    //
    // The PTY fallback has no detectIdle callback. The `›` (U+203A)
    // guillemet is NOT idle-specific - it's always visible in the Codex Ink
    // TUI's prompt area, even during active tool execution, so using it
    // caused false idle transitions. Codex goes completely SILENT when idle
    // (no TUI redraws), so PtyActivityTracker's silence timer
    // (`PTY_SILENCE_THRESHOLD_MS`) fires reliably for a session without hooks.
    reportsTurnEnd: true,
    activity: ActivityDetection.hooksAndPty(),
    sessionId: {
      fromHook(hookContext) {
        try {
          const context = JSON.parse(hookContext);
          const sessionId = context.session_id ?? context.thread_id ?? context.threadId;
          if (typeof sessionId === 'string') {
            console.log(`[codex] Captured session ID from hook: ${sessionId.slice(0, 16)}...`);
            return sessionId;
          }
          console.warn(`[codex] SessionStart hookContext missing session_id. Keys: ${Object.keys(context).join(', ')}`);
          return null;
        } catch {
          console.warn('[codex] Failed to parse SessionStart hookContext');
          return null;
        }
      },
      fromOutput(data) {
        const headerMatch = data.match(/session id:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (headerMatch) return headerMatch[1];
        const resumeMatch = data.match(/codex\s+resume\s+(thr_\S+)/);
        return resumeMatch ? resumeMatch[1] : null;
      },
      // Codex 0.118 neither prints the session UUID in PTY output nor
      // fires hooks (both verified empirically - see the fixtures in
      // tests/fixtures/agent-pty/codex.txt). 0.128 added a `session id:`
      // line to the startup banner (caught by fromOutput above), but the
      // rollout-file scan remains the authoritative fallback for older
      // versions and for cases where the banner scrolls before we can
      // capture it.
      fromFilesystem: CodexSessionHistoryParser.captureSessionIdFromFilesystem,
    },
    sessionHistory: {
      locate: CodexSessionHistoryParser.locate,
      parse: CodexSessionHistoryParser.parse,
      isFullRewrite: false,
      // The rollout carries no turn starts or ends, so its reads must not
      // turn the PTY tracker off: a session whose hooks never flow keeps it.
      suppressesPtyFallback: false,
    },
  };

  removeHooks(directory: string, sessionId?: string): void {
    const folder = this.hookHolds.release(sessionId, directory);
    // Null while another session in the project still holds it.
    if (folder) removeCodexHooks(folder);
  }

  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      // Codex writes the user turn to its rollout JSONL on SUBMIT, measured at
      // 61-108ms and flat against a 4.6s turn (see command-injection-verifier.ts
      // for the numbers and scripts/measure-injection-flush.mjs for the rig).
      return createCodexCommandInjectionVerifier();
    }
    // 'paste': no verifier yet. Codex's UserPromptSubmit hook now reports a
    // submission, but no paste flush has been measured against it, so the
    // paste engine keeps its activity-event and data-floor backstops.
    return null;
  }

  /**
   * Codex handles slash input in the TUI and never writes it to the rollout
   * file. Measured: an unrecognized `/...` produced "Unrecognized command" and
   * no record at all. Absence therefore cannot distinguish "rejected" from
   * "ran client-side", so slash auto_commands are left unverified rather than
   * risking an escalation that restarts a working session.
   */
  canVerifySlashSubmission(): boolean {
    return false;
  }

  getExitSequence(): string[] {
    // Codex sessions are API-backed (server-side threads) - no local
    // conversation state to flush. Ctrl+C is sufficient.
    return ['\x03'];
  }

  detectFirstOutput(data: string): boolean {
    // Codex CLI hides the cursor when its TUI takes over the terminal.
    // Detecting ESC[?25l fires after the shell prompt noise but before
    // the TUI draws the startup banner. This keeps the shell command
    // hidden behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string, place?: CliPlace | null): Promise<string | null> {
    return CodexSessionHistoryParser.locate({ agentSessionId, cwd, cliTarget: toStoredCliTarget(place ?? null) });
  }

  async parseTranscript(agentSessionId: string, _cwd: string, place?: CliPlace | null): Promise<ParsedTranscript> {
    const filePath = locateCodexTranscriptFile(agentSessionId, place ?? null);
    if (!filePath) return { entries: [], sourcePath: null };
    const entries = await parseCodexTranscript(agentSessionId, filePath);
    return { entries, sourcePath: filePath };
  }

  /** One page of the transcript's history for the Conversation viewer. */
  async readTranscriptPage(
    agentSessionId: string,
    _cwd: string,
    request: TranscriptPageReadRequest,
    place?: CliPlace | null,
  ): Promise<TranscriptPageReadResult> {
    const filePath = locateCodexTranscriptFile(agentSessionId, place ?? null);
    if (!filePath) return { status: 'unavailable', reason: 'file_missing' };
    return readCodexTranscriptPage(agentSessionId, filePath, request);
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverCodexCapabilities(cliPath);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // Codex does not support live `/model` or `/reasoning-effort` slash commands.
    // Model/effort changes require respawn (handled by task-move.ts fallback).
    return [];
  }

  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    // `codex exec` runs non-interactively. The `--skip-git-repo-check` flag avoids
    // failing in non-git working directories. Prompt is delivered via stdin.
    // The answer run's read-only sandbox and `--ephemeral`, so a title is not
    // kept as a session to resume. It keeps the title runner's 15 s bound
    // rather than calling `answerFromContext`: no title has been measured on
    // Codex yet (the CLI here was logged out).
    return runCliPrintSummarize({
      cliPath,
      args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', ...(options?.model ? ['--model', options.model] : [])],
      prompt: buildSummarizePrompt(prompt),
      cwd,
      // A Codex installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
    });
  }

  readonly answerCapabilities = { streaming: false, search: false, model: true, effort: false };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * `--sandbox read-only` is Codex's read-only mode, and `exec` never asks for
   * approval, so there is nothing to approve and nothing it may change.
   *
   * No `--ask-for-approval`: it is an interactive flag that `codex exec`
   * rejects, so the shipped call failed before it reached the model.
   *
   * `--ephemeral` ("run without persisting session files to disk", codex
   * 0.154's own help): an answer is not a session to resume, and every run
   * otherwise added one to `~/.codex/sessions`. Streaming (`--json`) and
   * search (a `-c mcp_servers` override) stay off until a logged-in run
   * verifies them; this machine's Codex answers 401.
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
      // The model flag is OMITTED when none is chosen: passing an
      // empty value is an error.
      args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', ...(model ? ['--model', model] : [])],
      prompt,
      cwd,
      // A Codex installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
    });
  }

  /**
   * Codex trust is keyed per directory and cannot be inherited, so Kangentic
   * writes one entry per task worktree. Dropping it here is what keeps
   * `~/.codex/config.toml` tracking live worktrees instead of growing by one
   * dead table per task, forever.
   */
  async onWorktreeRemoved(worktreePath: string, place?: CliPlace | null): Promise<void> {
    await removeWorktreeTrust(worktreePath, place ?? null);
  }

  /**
   * Codex resolves resume by session id, so its rollout JSONLs survive a move
   * untouched. The one path-keyed store that breaks is the per-project trust
   * header in ~/.codex/config.toml; rewrite it so the relocated project stays
   * trusted. Best-effort and non-destructive; see migrateCodexProjectData.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateCodexProjectData(oldPath, newPath);
  }
}
