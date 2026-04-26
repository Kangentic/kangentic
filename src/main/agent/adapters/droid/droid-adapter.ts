import { DroidDetector } from './detector';
import { DroidCommandBuilder } from './command-builder';
import { captureSessionIdFromFilesystem, locateSessionFile } from './session-id-capture';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Factory Droid CLI adapter.
 *
 * Empirically validated against Droid 0.109.1 -- see
 * `scripts/probe-droid.js` for the full battery and
 * `.droid-probe-report.md` for the latest run output. The probe
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
    return this.commandBuilder.buildDroidCommand({ droidPath: agentPath, ...rest });
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

  removeHooks(_directory: string, _taskId?: string): void {
    // No-op: this adapter does not write any hook config.
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
}
