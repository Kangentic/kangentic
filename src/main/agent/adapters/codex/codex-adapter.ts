import { identifyCodexUserSetupFailure } from './startup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';
import { CodexDetector } from './detector';
import { CodexCommandBuilder } from './command-builder';
import { removeHooks as removeCodexHooks } from './hook-manager';
import { CodexSessionHistoryParser } from './session-history-parser';
import { createCodexCommandInjectionVerifier } from './command-injection-verifier';
import { parseCodexTranscript, codexHostRolloutSearch, findCodexTranscriptFile, locateCodexTranscriptFile, readCodexTranscriptPage, CODEX_PATCH_TOOL, CODEX_PATCH_PATH_FIELD } from './transcript-parser';
import { migrateCodexProjectData } from './project-relocation';
import { ensureWorktreeTrust, removeWorktreeTrust } from './trust-manager';
import { CodexStatusParser } from './status-parser';
import { CodexHookTrustCheck, readHostCodexVersion } from './hook-trust';
import { CODEX_WSL_HOOK_COPY_NAME } from './hook-manager';
import type { RemoteFileDeclaration } from '../../shared/remote-files';
import { shimFamilyKey } from '../../shared/shim-family-key';
import { discoverCodexCapabilities } from './capability-discovery';
import { CodexModelCatalogCache, CATALOG_DISCOVERY_WAIT_MS, CATALOG_TTL_MS, FAILED_READ_RETRY_MS, catalogAcceptsEffort } from './model-catalog';
import { codexEffortExecArgs } from './command-builder';
import { codexTranscriptToolCounts, codexTranscriptToolResultTokens, codexTranscriptUsage } from './transcript-usage';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import { isPlainIdName, placeFromStored, resolveCliTarget, type CliPlace } from '../../shared/cli-target';
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
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier, AgentCapabilities, AgentLaunchOptionInfo, RemoteTranscriptSearch, StoredCliTarget, TranscriptUsage, TranscriptToolCounts } from '../../../../shared/types';
import type { AnswerFromContextOptions } from '../../agent-adapter';
import { ActivityDetection } from '../../../../shared/types';

/** How long a spawn waits for the hook trust and model list reads before going without them. */
const SPAWN_READS_SETTLE_MS = 8_000;

/**
 * Codex CLI adapter - wraps CodexDetector, CodexCommandBuilder, and
 * codex-hook-manager behind the generic AgentAdapter interface.
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  // Accounts are built (`accounts.ts`, `CODEX_ACCOUNT_SUPPORT`) and not enabled: no ChatGPT login was
  // available to run them on. This adapter declares none until they are run with two accounts.

  // Codex writes its plan's usage windows on each rollout `token_count` record
  // (`rate-limits.ts`), so the context bar shows its own limits on Codex sessions.
  readonly reportsRateLimits = true;
  readonly displayName = 'Codex CLI';
  readonly sessionType = 'codex_agent';
  readonly supportsCallerSessionId = false;
  /** `codex resume <id> [PROMPT]`: "Optional user prompt to start the session" (`codex resume --help`). */
  readonly resumePromptDelivery = 'command-line' as const;
  // A Codex installed in a WSL distro, configured by its \\wsl.localhost path:
  // run in the distro's shell, its hooks through the WSL transport's script,
  // its trust and rollouts in the distro's CODEX_HOME (cli-target.ts).
  readonly supportsWslCli = true;
  /** On a host over SSH the CLI is `codex` from the host's own login PATH (#913). */
  readonly remoteCliName = 'codex';
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

  /** Codex's own model list, per binary (model-catalog.ts). */
  private readonly modelCatalog = new CodexModelCatalogCache();

  /** The last whole `discoverCapabilities` answer per binary, and how long it is kept. */
  private readonly capabilitiesCache = new Map<string, { capabilities: AgentCapabilities; at: number; ttlMs: number }>();

  /**
   * Resume appends to the same rollout (`open_rollout_for_append` in
   * `codex-rs/rollout/src/recorder.rs` at rust-v0.163.0), and every rollout
   * line carries a `timestamp`, so the transcript reads below honor `sinceMs`
   * and `untilMs` (transcript-usage.ts).
   */
  readonly scopesTranscriptReadsByTime = true;

  /**
   * Codex edits every file through `apply_patch`, whose transcript entry names
   * the first file its patch touches as `file_path` (transcript-parser.ts,
   * `patchToolInput`), so the memory index's change corpus finds Codex's edits.
   */
  readonly fileChangeTools = [{ tool: CODEX_PATCH_TOOL, pathField: CODEX_PATCH_PATH_FIELD }];

  /**
   * Background commands (task #859): the rollout reports a command still
   * running at its yield (`Process running with session ID N`, which Codex's
   * hooks never report: a yielded command fires no PostToolUse) and a poll
   * that finds it exited. No launch hint, since no hook fires at the yield.
   */
  readonly backgroundCommands = { source: 'session-history', launchHint: false } as const;

  /** See `startup-failure.ts`. */
  identifyUserSetupFailure(finalOutput: string): UserSetupMatch | null {
    return identifyCodexUserSetupFailure(finalOutput);
  }

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    const info = await this.detector.detect(overridePath);
    // Read the hook trust as soon as the binary is known, so the first spawn
    // (which awaits it in ensureTrust) rarely waits. A Codex in a WSL distro
    // is read there, for the hooks it runs, keyed by its version.
    if (info.found && info.path) {
      if (!info.cliTarget) {
        this.hookTrust.start(info.path);
        this.modelCatalog.start(info.path);
      } else {
        // A distro whose facts cannot be read now is left unread, never read
        // as this machine's: its sessions then run without hooks until a later
        // detection reads it, as after a read that outlives its bound.
        const target = await resolveCliTarget(info.path, true).catch(() => null);
        if (target && info.version) this.hookTrust.start(info.path, { target, version: info.version });
        if (target) this.modelCatalog.start(info.path, target);
      }
    }
    return info;
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
    this.capabilitiesCache.clear();
  }

  /**
   * What a Codex on an SSH host edits outside the session folder: the user's `~/.codex/config.toml`,
   * where `ensureTrust` appends the folder's trust table (and `$CODEX_HOME` is not honored on a host),
   * and the hook script copy that the `-c` hook overrides run, relative to the project folder. Hooks,
   * the MCP server and the task tag all ride `-c` arguments and the session's environment, so
   * nothing else is written. The legacy `.codex/hooks.json` is never declared: its cleanup is for
   * files an old Kangentic wrote on this computer.
   */
  remoteFiles(): RemoteFileDeclaration {
    return {
      home: ['.codex/config.toml'],
      project: [`.kangentic/${CODEX_WSL_HOOK_COPY_NAME}`],
    };
  }

  /**
   * The rollout on a host. Its name holds a timestamp the id does not give, so the host searches for it. The
   * id comes from a hook or the banner, after the session starts, and the relay asks again when it does.
   */
  remoteTranscriptFiles(options: { agentSessionId: string; cliTarget: StoredCliTarget }): readonly RemoteTranscriptSearch[] {
    const place = placeFromStored(options.cliTarget);
    if (place?.kind !== 'ssh' || !isPlainIdName(options.agentSessionId)) return [];
    return [codexHostRolloutSearch(options.agentSessionId, place)];
  }

  async ensureTrust(workingDirectory: string, place?: CliPlace | null): Promise<void> {
    // Codex DOES have a directory-trust dialog (this was previously
    // documented here as a no-op because it was believed not to). Because
    // trust is keyed on the git repo root and every task gets its own
    // worktree, the user would otherwise be prompted on EVERY task with no
    // answer that carries forward. See trust-manager.ts. A Codex in a WSL
    // distro keeps its trust in the distro's config.toml.
    await ensureWorktreeTrust(workingDirectory, place ?? null);
    // A Codex on a host is never detected here, so its hook trust is read now, from the host, once
    // per host and version. A host without a Codex answers no version, and its session goes without hooks.
    if (place?.kind === 'ssh') {
      const version = await readHostCodexVersion(place).catch(() => null);
      if (version) this.hookTrust.startOnHost(place, version);
    }
    // Every spawn path awaits this before buildCommand, which reads both
    // results synchronously. A read still running after the bound leaves this
    // session without hooks, or without its effort override, rather than
    // holding the spawn. The two reads run at once, so the wait is the longer.
    await Promise.all([
      this.hookTrust.settle(SPAWN_READS_SETTLE_MS),
      this.modelCatalog.settle(SPAWN_READS_SETTLE_MS),
    ]);
  }

  /**
   * The effort a session spawn passes to the binary at `cliPath`, or
   * undefined. Only a level Codex's own `model/list` advertises for this model
   * (any listed model when none is set) goes through, and none goes through
   * without a list. Codex ignored the effort before this was built, and a
   * spawn's effort is not checked upstream (`resolveSpawnOverrides`): a column
   * whose agent changed keeps its effort, and an MCP override is accepted
   * unchecked while Codex lists no levels, so such a value must not start
   * failing turns. The title and answer runs need no gate: their callers pass
   * only a level `discoverCapabilities` reported.
   */
  private acceptedEffort(cliPath: string, effort: string | null | undefined, model: string | null | undefined): string | undefined {
    const level = effort?.trim();
    if (!level) return undefined;
    const catalog = this.modelCatalog.catalogFor(cliPath);
    if (catalog && catalogAcceptsEffort(catalog, level, model)) return level;
    console.log(`[codex] effort "${level}" left out: ${catalog ? 'Codex does not list it for this model' : 'no model list read for this Codex'}`);
    return undefined;
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, model, effort, ...rest } = options;
    const command = this.commandBuilder.buildCodexCommand({
      codexPath: agentPath,
      model,
      effort: this.acceptedEffort(agentPath, effort, model),
      ...rest,
      // A host's confirmed trust is kept by host, since its binary has no path here to look up by.
      codexHookStateOverride: options.cliTarget?.kind === 'ssh'
        ? this.hookTrust.stateOverrideForHost(options.cliTarget.hostId)
        : this.hookTrust.stateOverrideFor(agentPath),
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

  /**
   * On demand, any day's rollout: the whole sessions tree newest-first, with
   * no wait. The live telemetry keeps `CodexSessionHistoryParser.locate`
   * (`runtime.sessionHistory`), which polls today's and yesterday's folders for a
   * rollout the CLI is about to write.
   */
  async locateSessionHistoryFile(agentSessionId: string, _cwd: string, place?: CliPlace | null): Promise<string | null> {
    return findCodexTranscriptFile(agentSessionId, place ?? null);
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

  /** Lifetime tokens from the rollout's per-response usage (transcript-usage.ts). */
  async transcriptUsage(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    place?: CliPlace | null;
  }): Promise<TranscriptUsage | null> {
    const filePath = await this.rolloutFor(input);
    return filePath ? codexTranscriptUsage(filePath) : null;
  }

  /** Distinct tool calls in the rollout, named as the hooks name them, within `[sinceMs, untilMs)`. */
  async transcriptToolCounts(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    sinceMs?: number | null;
    untilMs?: number | null;
    place?: CliPlace | null;
  }): Promise<TranscriptToolCounts | null> {
    const filePath = await this.rolloutFor(input);
    return filePath ? codexTranscriptToolCounts(filePath, input.sinceMs, input.untilMs) : null;
  }

  /** Estimated result tokens per tool, reading only what the rollout appended since the last call. */
  async transcriptToolResultTokens(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
    sinceMs?: number | null;
    untilMs?: number | null;
    place?: CliPlace | null;
  }): Promise<Record<string, number> | null> {
    const filePath = await this.rolloutFor(input);
    return filePath ? codexTranscriptToolResultTokens(filePath, input.sinceMs, input.untilMs) : null;
  }

  /** The rollout of a session, found by its id (rollouts are named by id, not by cwd). */
  private async rolloutFor(input: { agentSessionId?: string | null; place?: CliPlace | null }): Promise<string | null> {
    if (!input.agentSessionId) return null;
    return findCodexTranscriptFile(input.agentSessionId, input.place ?? null);
  }

  /**
   * The model list and effort levels come from Codex's own `model/list`
   * (model-catalog.ts). `detect` starts that read; discovery waits for it at
   * most `CATALOG_DISCOVERY_WAIT_MS`, so a cold app-server never holds the
   * agent list, and answers without it on a timeout or failure. A forced
   * refresh (a model dropdown opening) reads again.
   */
  async discoverCapabilities(cliPath: string, forceRefresh = false): Promise<AgentCapabilities> {
    // The answer and condition runs ask on every run (they declare `effort`),
    // so a whole answer is kept and `--help` and the rollout scan are not run
    // each time. One built from the model list is kept for the list's own time
    // to live; one whose read settled with no list (an app-server that failed
    // or has no `model/list`) for the failed read's retry window. A read still
    // running when the wait gave up is asked again on the next call, and so is
    // a discovery that never reached the list (a distro whose facts it could
    // not read), whatever an earlier read left.
    const key = shimFamilyKey(cliPath);
    const cached = this.capabilitiesCache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.at < cached.ttlMs) return structuredClone(cached.capabilities);
    let reachedList = false;
    let builtFromList = false;
    const capabilities = await discoverCodexCapabilities(cliPath, async (target) => {
      reachedList = true;
      this.modelCatalog.start(cliPath, target, forceRefresh);
      const catalog = await this.modelCatalog.wait(cliPath, CATALOG_DISCOVERY_WAIT_MS);
      builtFromList = catalog !== null;
      return catalog;
    });
    // Judged by the list this answer was built from, not the list now: a read
    // that lands after the wait gave up must not keep a list-less answer.
    const settledWithoutList = reachedList && !builtFromList && this.modelCatalog.isSettled(cliPath) && !this.modelCatalog.catalogFor(cliPath);
    if (builtFromList || settledWithoutList) {
      this.capabilitiesCache.set(key, {
        capabilities: structuredClone(capabilities),
        at: Date.now(),
        ttlMs: builtFromList ? CATALOG_TTL_MS : FAILED_READ_RETRY_MS,
      });
    }
    return capabilities;
  }

  /**
   * The model the command was built with, so the card names it before the
   * rollout does. Read only from the flag region: every form emits
   * `check_for_update_on_startup=false` after `--model` and before the prompt,
   * so a prompt containing `--model` is never misread. The name is Codex's own
   * `displayName` from `model/list` when a read has one, else the id.
   */
  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    const flagEnd = command.indexOf('check_for_update_on_startup=false');
    const flagRegion = flagEnd === -1 ? command : command.slice(0, flagEnd);
    const match = flagRegion.match(/--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const id = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    if (!id) return null;
    return { id, displayName: this.modelCatalog.displayNameOf(id) ?? id };
  }

  /** Codex's own `displayName` for a model id learned from telemetry, from any `model/list` read so far. */
  modelDisplayName(modelId: string): string | null {
    return this.modelCatalog.displayNameOf(modelId);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // Codex's `/model` only opens a picker ("choose what model and reasoning
    // effort to use"; not in `supports_inline_args`, codex-rs/tui/src/slash_command.rs
    // at rust-v0.163.0), and no slash command sets effort, so there is nothing
    // to type. Model/effort changes require respawn (handled by task-move.ts fallback).
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
      args: [
        'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
        ...(options?.model ? ['--model', options.model] : []),
        // Already one of `discoverCapabilities`' levels: the caller passes only
        // a level the CLI reports (automation-agent.ts).
        ...codexEffortExecArgs(options?.effort),
      ],
      prompt: buildSummarizePrompt(prompt),
      cwd,
      // A Codex installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
    });
  }

  /**
   * `effort`: the run passes the level as `-c model_reasoning_effort=<level>`,
   * which `codex exec` takes (`codex exec --help`, codex-cli 0.163.0;
   * https://learn.chatgpt.com/docs/config-file/config-reference), and only a
   * level `model/list` reported reaches it. `low` keeps an answer cheap where
   * the model offers it. Built from documentation; not yet run signed in.
   */
  readonly answerCapabilities = { streaming: false, search: false, model: true, effort: true, defaultEffort: 'low' };

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
    options?: AnswerFromContextOptions,
  ): Promise<string> {
    return runCliPrintAnswer({
      cliPath,
      // The model flag is OMITTED when none is chosen: passing an
      // empty value is an error.
      args: [
        'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
        ...(model ? ['--model', model] : []),
        // Already one of `discoverCapabilities`' levels: the caller passes only
        // a level the CLI reports (answer-run.ts, automation-agent.ts).
        ...codexEffortExecArgs(options?.effort),
      ],
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
