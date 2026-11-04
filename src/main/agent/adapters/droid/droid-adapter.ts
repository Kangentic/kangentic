import { DroidDetector } from './detector';
import { DroidCommandBuilder, removeMcpConfig, droidMcpWiringEnabled } from './command-builder';
import { captureSessionIdFromFilesystem, locateSessionFile } from './session-id-capture';
import { droidTranscriptFilePath, parseDroidTranscript, readDroidTranscriptPage } from './transcript-parser';
import { migrateDroidProjectData } from './project-relocation';
import { discoverDroidCapabilities } from './capability-discovery';
import { parseDroidSessionIdFromHook } from './hook-manager';
import { parseBridgeEventLine } from '../../shared/hook-utils';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import { runCliPrintAnswer } from '../../shared/cli-answer';
import { SharedFolderHolds } from '../../shared/shared-folder-holds';
import type { RemoteFileDeclaration } from '../../shared/remote-files';
import { resolveCliTarget, type CliPlace } from '../../shared/cli-target';
import type {
  AgentAdapter,
  AgentInfo,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedTranscript,
  SummarizeOptions,
  AnswerFromContextOptions,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
} from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  AgentLiveTelemetryUnsupported,
  SubmissionContextType,
  SubmissionVerifier,
  AgentCapabilities,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * `droid exec`'s model and effort flags for a headless run: `--model <id>` and
 * `-r <level>` (0.218.0's `droid exec --help`), each omitted when unset.
 */
export function droidExecModelArgs(model?: string | null, effort?: string | null): string[] {
  return [...(model ? ['--model', model] : []), ...(effort ? ['-r', effort] : [])];
}

/**
 * Factory Droid CLI adapter.
 *
 * Empirically validated against Droid 0.109.1. Run
 * `scripts/probe-droid.js` to regenerate the full probe report
 * locally (its output is gitignored, not committed). The probe
 * confirms:
 *   - Detection via `droid` on PATH (`droid --version` -> bare semver)
 *   - BYOK auth via `customModels[]` in `~/.factory/settings.json`
 *     (use the entry's `id` field, not its `model` field, with `-m`)
 *   - Headless new + resume via `droid exec` (separate flow; not used
 *     by this adapter, which spawns the interactive TUI)
 *   - SYMMETRIC interactive resume: `droid --cwd <cwd> --resume <uuid>`
 *     starts the TUI with prior conversation context preserved
 *   - Cursor-hide first-output marker (`\x1b[?25l`)
 *   - Session UUID capture via `~/.factory/sessions/<cwd-slug>/<uuid>.jsonl`
 *
 * Hooks via `--settings <path>` did NOT fire on Droid 0.109, and do on
 * 0.218.0 (measured in `droid exec`). Activity stays PTY-driven (silence
 * timer + cursor-hide first-output, as for Aider/Cursor/Warp); the hooks
 * Kangentic passes (`hook-manager.ts`) add the tool calls, the waits on the
 * user, the session id and the session's lifecycle, so a Droid that ignores
 * them runs exactly as before.
 *
 * The permission modes, the hook events beyond those measured, the browser
 * policy, WSL hooks and the model list were built from Factory's docs and
 * 0.218.0's `--help` (2026-11-03), not run against a signed-in TUI. See
 * docs/integrations/agents/droid.md, "Built from documentation".
 */
export class DroidAdapter implements AgentAdapter {
  readonly name = 'droid';
  readonly displayName = 'Droid';
  readonly sessionType = 'droid_agent';
  /**
   * False: Droid generates session UUIDs internally. Kangentic reads the
   * UUID after spawn from the SessionStart hook (`runtime.sessionId.fromHook`),
   * or from `~/.factory/sessions/<cwd-slug>/<id>.jsonl` when no hook reports
   * one (`runtime.sessionId.fromFilesystem`).
   */
  readonly supportsCallerSessionId = false;
  /** The resume command carries the prompt as its positional argument. */
  readonly resumePromptDelivery = 'command-line' as const;
  // The SessionStart hook, else its session files (`runtime.sessionId`).
  readonly capturesInteractiveSessionId = true;
  // The literal URL goes into the folder's `.factory/mcp.json`.
  readonly kangenticMcp = 'shared-folder' as const;
  /** A Droid installed in a WSL distro runs there (#286). */
  readonly supportsWslCli = true;
  /**
   * On a remote host over SSH the CLI is `droid` from the host's own login PATH (#913). Activity there
   * is PTY-driven only: the hooks settings file (`droid-settings.json`) is written for a local or WSL
   * Droid alone, and no session id is captured, so a session on a host resumes as a fresh start.
   */
  readonly remoteCliName = 'droid';
  /**
   * The launch modes Droid's own flags give (`droidPermissionFlags`):
   * `--use-spec` and `--auto low|medium|high`, from 0.218.0's `droid --help`.
   * The TUI still changes either mid-session (Shift+Tab, Ctrl+L). Interactive
   * Droid has no flag that skips every prompt, so no entry promises one.
   */
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Spec Mode (Plan First)' },
    { mode: 'default', label: 'Default (Ask for Each Action)' },
    { mode: 'acceptEdits', label: 'Auto Low (Safe Edits)' },
    { mode: 'auto', label: 'Auto Medium (Local Development)' },
    { mode: 'bypassPermissions', label: 'Auto High (Push and Deploy)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';
  /**
   * Droid's file tools all name their file in `tool_input.file_path`: Factory's
   * hooks guides match `Create|Edit|ApplyPatch` and read that field
   * (https://docs.factory.com/harness/hooks.md). Not seen in a captured
   * transcript, whose fixture holds only a `Read` call.
   */
  readonly fileChangeTools = [
    { tool: 'Create', pathField: 'file_path' },
    { tool: 'Edit', pathField: 'file_path' },
    { tool: 'ApplyPatch', pathField: 'file_path' },
  ] as const;

  private readonly detector = new DroidDetector();
  private readonly commandBuilder = new DroidCommandBuilder();
  // Sessions relying on `<cwd>/.factory/mcp.json`, per cwd. The file is
  // project-shared, so without this a session exiting would strip the entry
  // out from under a concurrent session in the same directory. Per-task
  // worktrees usually make that impossible, but a project with no worktree
  // configured runs every task in the project root. See SharedFolderHolds.
  private readonly mcpHolds = new SharedFolderHolds();

  /**
   * The one file a Droid on a remote host has edited on the host (#913): the project's
   * `.factory/mcp.json`, where Kangentic's entry is merged beside the user's servers. It holds only a
   * `${KANGENTIC_MCP_TOKEN}` reference (the token travels in the spawn environment), so it needs no
   * owner-only mode. Droid has no trust store and no home file of ours.
   */
  remoteFiles(): RemoteFileDeclaration {
    return { home: [], project: ['.factory/mcp.json'] };
  }

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // No trust dialog: Droid does not prompt for directory approval.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    const droidOptions = { droidPath: agentPath, ...rest };
    const command = this.commandBuilder.buildDroidCommand(droidOptions);
    // buildDroidCommand writes .factory/mcp.json whenever MCP is wired. Hold
    // it until this session releases, so concurrent sessions in the same cwd
    // serialize their cleanup.
    if (droidMcpWiringEnabled(droidOptions)) {
      this.mcpHolds.retain(options.ptySessionId, options.cwd);
    }
    return command;
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * PTY-based activity detection. Silence timer drives idle
   * transitions (Droid's TUI goes quiet when waiting on input);
   * cursor-hide marks the first usable output.
   *
   * The hooks passed in a per-session `--settings` file (never the user's
   * `~/.factory/settings.json`) report tool calls, the waits on the user and
   * the session's lifecycle through `statusFile.parseEvent`, and the session
   * id through `sessionId.fromHook` (`hook-manager.ts` lists each event). The
   * activity kind stays `pty`:
   * hook events never suppress a `pty` agent's tracker, so its silence
   * fallback keeps ending turns, and a wait (`permission`) is left alone by
   * the silence timer, which fires only while the session is thinking.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Only terminal silence says a turn ended: no Stop hook is wired.
    reportsTurnEnd: false,
    activity: ActivityDetection.pty(),
    statusFile: {
      // Droid writes no status line; the events file is the hooks'.
      parseStatus: () => null,
      parseEvent: parseBridgeEventLine,
      isFullRewrite: false,
    },
    sessionId: {
      // The SessionStart hook names the session itself (`session_id`, every
      // Droid hook's payload), so a second Droid started in the same folder
      // cannot hand this session its id.
      fromHook: parseDroidSessionIdFromHook,
      // The fallback when no hook reports one (a WSL distro whose transport
      // failed, a Droid that ignores `--settings`): the JSONL file Droid
      // writes at session start. The first id to arrive wins.
      fromFilesystem: captureSessionIdFromFilesystem,
    },
  };

  /**
   * Droid 0.109.x has no per-session telemetry channel Kangentic can
   * subscribe to: `/cost` and `/context` are post-hoc TUI commands,
   * `OTEL_TELEMETRY_ENDPOINT` is out-of-band, and the post-hoc
   * `<uuid>.settings.json` schema is undocumented. ContextBar would
   * otherwise spin forever - declare an unavailable affordance pointing
   * users at the in-TUI surfaces. See docs/integrations/agents/droid.md.
   */
  readonly liveTelemetryUnsupported: AgentLiveTelemetryUnsupported = {
    unavailableLabel: 'Telemetry: TUI only',
    unavailableTitle:
      'Droid does not stream live telemetry to Kangentic.\n' +
      'Run /cost or /context inside the Droid TUI to see model, tokens, and cost.\n' +
      'Tracked upstream: Factory-AI/factory (see docs/integrations/agents/droid.md).',
  };

  /**
   * Delivers the Kangentic MCP token to the Droid process. The project's
   * `.factory/mcp.json` references it as `${KANGENTIC_MCP_TOKEN}`, which
   * Droid expands at connect time, so the secret never reaches disk.
   */
  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildDroidEnv({ droidPath: agentPath, ...rest });
  }

  removeHooks(directory: string, sessionId?: string): void {
    // This adapter writes no hook config, but it does write a project-scoped
    // .factory/mcp.json entry that should not outlive the session. Strip it
    // only once the last session using that directory releases, so a sibling
    // session in the same cwd does not lose its MCP server mid-run. A call
    // with no session id (the project-delete sweep, after every session is
    // already killed) drops every hold on the directory and strips it.
    const folder = this.mcpHolds.release(sessionId, directory);
    if (folder) removeMcpConfig(folder);
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // UserPromptSubmit did not fire in `droid exec` 0.218.0, so there is no
    // proven prompt-submit event channel. Callers fall back to time-based
    // settle (paste) or time-settle (command-injection).
    return null;
  }

  getExitSequence(): string[] {
    // Droid's TUI accepts `/quit` as a graceful exit; Ctrl+C is the
    // hard fallback. Sending both mirrors the Gemini exit sequence
    // and is safe -- Droid ignores additional input after exit.
    return ['\x03', '/quit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Empirically verified: Droid hides the cursor when its Ink-based
    // TUI takes over the terminal. The shimmer overlay lifts as soon
    // as we see this sequence.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string, place?: CliPlace | null): Promise<string | null> {
    // A Droid on a remote host keeps its session files on the host; this computer's mirror of its
    // home never holds them, so polling would only wait.
    if (place?.kind === 'ssh') return null;
    return locateSessionFile({ agentSessionId, cwd, place });
  }

  async parseTranscript(agentSessionId: string, cwd: string, place?: CliPlace | null): Promise<ParsedTranscript> {
    const filePath = droidTranscriptFilePath(agentSessionId, cwd, place ?? null);
    const entries = await parseDroidTranscript(agentSessionId, filePath);
    return { entries, sourcePath: filePath };
  }

  /** One page of the transcript's history for the Conversation viewer. */
  readTranscriptPage(
    agentSessionId: string,
    cwd: string,
    request: TranscriptPageReadRequest,
    place?: CliPlace | null,
  ): Promise<TranscriptPageReadResult> {
    return readDroidTranscriptPage(agentSessionId, droidTranscriptFilePath(agentSessionId, cwd, place ?? null), request);
  }

  async discoverCapabilities(cliPath: string, forceRefresh?: boolean): Promise<AgentCapabilities> {
    // The models `droid exec --help` lists, for the headless runs that take
    // `--model`. The column pickers stay hidden: interactive `droid` 0.218.0
    // has no `--model` flag.
    return discoverDroidCapabilities(cliPath, forceRefresh);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // Droid is TUI-first. No per-spawn model/effort override.
    return [];
  }

  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    // `droid exec` runs non-interactively. Default output format is `text`. The prompt
    // is delivered as a positional arg (also accepts stdin pipes; we use args for
    // explicit alignment with documented usage).
    return runCliPrintSummarize({
      cliPath,
      args: ['exec', '-o', 'text', ...droidExecModelArgs(options?.model, options?.effort)],
      prompt: buildSummarizePrompt(prompt),
      cwd,
      promptVia: 'arg',
      // A Droid installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
    });
  }

  /**
   * `effort`: `droid exec -r, --reasoning-effort <level>` (0.218.0's `--help`),
   * whose levels are each model's own (`effortLevelsByModel`); the caller passes
   * only a level the chosen model lists. No `defaultEffort`: an unset level
   * passes no flag, and Droid uses the model's own default.
   */
  readonly answerCapabilities = { streaming: false, search: false, model: true, effort: true };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * `droid exec` is already non-interactive and makes no edits without an
   * explicit auto level, so there is no separate read-only flag to pass (the
   * probe's file write and shell command both ended "insufficient permission").
   *
   * The prompt is PIPED, which `droid exec` documents. An answer prompt runs to
   * about 50k characters, past the Windows command-line limit, so the
   * positional form `summarize` uses cannot carry one.
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
      // A Droid installed in a WSL distro runs there.
      cliTarget: await resolveCliTarget(cliPath, true),
      // The model and effort flags are OMITTED when none is chosen: passing
      // an empty value is an error.
      args: ['exec', '-o', 'text', ...droidExecModelArgs(model, options?.effort)],
      prompt,
      cwd,
    });
  }

  /**
   * Droid keys its session files (~/.factory/sessions/<cwd-slug>/) to the
   * absolute project path, outside the project folder. Rename the slug
   * directory so sessions stay locatable after a relocation. Best-effort and
   * non-destructive; see migrateDroidProjectData.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateDroidProjectData(oldPath, newPath);
  }
}
