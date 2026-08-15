import { DroidDetector } from './detector';
import { DroidCommandBuilder, removeMcpConfig, droidMcpWiringEnabled } from './command-builder';
import { captureSessionIdFromFilesystem, locateSessionFile } from './session-id-capture';
import { droidTranscriptFilePath, parseDroidTranscript } from './transcript-parser';
import { migrateDroidProjectData } from './project-relocation';
import { discoverDroidCapabilities } from './capability-discovery';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions, SettingsChangeSpec, ParsedTranscript } from '../../agent-adapter';
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
 * Hooks via `--settings <path>` did NOT fire empirically (Droid 0.109
 * appears to ignore hook entries injected through `--settings`). This
 * adapter therefore uses PTY-only activity detection (silence timer +
 * cursor-hide first-output) -- same approach as Aider/Cursor/Warp.
 * Hook integration is a v2 enhancement once a path is verified.
 */
export class DroidAdapter implements AgentAdapter {
  readonly name = 'droid';
  readonly displayName = 'Droid';
  readonly sessionType = 'droid_agent';
  /**
   * False: Droid generates session UUIDs internally. We capture the
   * UUID after spawn from `~/.factory/sessions/<cwd-slug>/<id>.jsonl`
   * (see runtime.sessionId.fromFilesystem).
   */
  readonly supportsCallerSessionId = false;
  /**
   * Droid's interactive TUI handles permission/autonomy decisions
   * in-band: shift+tab cycles low/medium/high autonomy, and `/model`
   * + Ctrl+D pins the default model. Kangentic intentionally does
   * not duplicate that UX with side overrides -- a single "Default"
   * permission entry surfaces in the selector and the user controls
   * everything from the TUI.
   */
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'default', label: 'Default (use Droid TUI controls)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  private readonly detector = new DroidDetector();
  private readonly commandBuilder = new DroidCommandBuilder();
  // Set of taskIds currently relying on `<cwd>/.factory/mcp.json`, keyed by
  // that cwd. The file is project-shared, so without this a task exiting
  // would strip the entry out from under a concurrent session in the same
  // directory. Per-task worktrees usually make that impossible, but a
  // project with no worktree configured runs every task in the project root.
  // Same pattern as GeminiAdapter.hookHolders and CodexAdapter.hookHolders.
  private readonly mcpHolders = new Map<string, Set<string>>();

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
    // buildDroidCommand writes .factory/mcp.json whenever MCP is wired.
    // Retain a reference so concurrent sessions in the same cwd serialize
    // their cleanup.
    if (droidMcpWiringEnabled(droidOptions)) {
      this.retainMcpConfig(options.cwd, options.taskId);
    }
    return command;
  }

  private retainMcpConfig(directory: string, taskId: string): void {
    let holders = this.mcpHolders.get(directory);
    if (!holders) {
      holders = new Set<string>();
      this.mcpHolders.set(directory, holders);
    }
    holders.add(taskId);
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * PTY-based activity detection. Silence timer drives idle
   * transitions (Droid's TUI goes quiet when waiting on input);
   * cursor-hide marks the first usable output.
   *
   * Hook integration is intentionally absent in v1 -- empirically
   * Droid 0.109's hook system did not fire for hooks injected via
   * `--settings <path>`, and we deliberately do not mutate the user's
   * `~/.factory/settings.json` to inject project-level hooks.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.pty(),
    sessionId: {
      // The TUI does not print the session UUID in stdout, so the
      // only reliable capture path is the JSONL file Droid writes
      // synchronously at session start.
      fromFilesystem: captureSessionIdFromFilesystem,
    },
  };

  /**
   * Droid 0.109.x has no per-session telemetry channel Kangentic can
   * subscribe to: `/cost` and `/context` are post-hoc TUI commands,
   * `OTEL_TELEMETRY_ENDPOINT` is out-of-band, and the post-hoc
   * `<uuid>.settings.json` schema is undocumented. ContextBar would
   * otherwise spin forever - declare an unavailable affordance pointing
   * users at the in-TUI surfaces. See docs/agent-integration.md.
   */
  readonly liveTelemetryUnsupported: AgentLiveTelemetryUnsupported = {
    unavailableLabel: 'Telemetry: TUI only',
    unavailableTitle:
      'Droid does not stream live telemetry to Kangentic.\n' +
      'Run /cost or /context inside the Droid TUI to see model, tokens, and cost.\n' +
      'Tracked upstream: Factory-AI/factory (see docs/agent-integration.md).',
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

  removeHooks(directory: string, taskId?: string): void {
    // This adapter writes no hook config, but it does write a project-scoped
    // .factory/mcp.json entry that should not outlive the session. Strip it
    // only once the last task using that directory releases, so a sibling
    // session in the same cwd does not lose its MCP server mid-run.
    const holders = this.mcpHolders.get(directory);
    if (holders && taskId) {
      holders.delete(taskId);
      if (holders.size > 0) return;
    }
    // Reached either by the last holder releasing or by a no-taskId call (the
    // project-delete sweep, which force-strips after every session is already
    // killed). Both mean nothing may still be holding this directory, so drop
    // the entry rather than leaving a Set that can never be released.
    this.mcpHolders.delete(directory);
    removeMcpConfig(directory);
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Droid 0.109 ignores hooks injected via --settings, so there is no
    // prompt-submit event channel. Callers fall back to time-based settle (paste)
    // or time-settle (command-injection).
    return null;
  }

  clearSettingsCache(): void {
    // No-op: this adapter writes no settings files, so there is no
    // cache to clear.
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

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return locateSessionFile({ agentSessionId, cwd });
  }

  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    const filePath = droidTranscriptFilePath(agentSessionId, cwd);
    const entries = await parseDroidTranscript(filePath);
    return { entries, sourcePath: filePath };
  }

  async discoverCapabilities(_cliPath: string): Promise<AgentCapabilities> {
    // Droid is TUI-first. Model/effort selection stays in the TUI.
    // Return supportsModelOverride: false to hide the dropdowns.
    return discoverDroidCapabilities(_cliPath);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // Droid is TUI-first. No per-spawn model/effort override.
    return [];
  }

  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    // `droid exec` runs non-interactively. Default output format is `text`. The prompt
    // is delivered as a positional arg (also accepts stdin pipes; we use args for
    // explicit alignment with documented usage).
    return runCliPrintSummarize({
      cliPath,
      args: ['exec', '-o', 'text'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
      promptVia: 'arg',
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
