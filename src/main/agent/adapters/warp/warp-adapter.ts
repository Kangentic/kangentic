import { WarpDetector } from './version-detector';
import { cliPathForTarget } from '../../shared/cli-target';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Warp CLI adapter - integrates the Warp AI agent CLI (`oz`)
 * (https://docs.warp.dev/reference/cli/cli) behind the generic
 * AgentAdapter interface.
 *
 * Warp is simpler than Claude Code: no session resume, no structured
 * status/event output, no trust mechanism, no hooks, and no settings
 * merging. Permissions are managed via Warp agent profiles (--profile),
 * not individual CLI flags. Command building is inlined.
 *
 * `oz` does not support `--version`, so its detector (`WarpDetector`) is the
 * shared one with `dump-debug-info` as the version command.
 */
export class WarpAdapter implements AgentAdapter {
  readonly name = 'warp';
  readonly displayName = 'Oz CLI';
  readonly sessionType = 'warp_agent';
  readonly supportsCallerSessionId = false;
  /** Warp's oz keeps no session id Kangentic can resume, so every start is fresh. */
  readonly resumePromptDelivery = 'no-resume' as const;
  // Warp manages permissions via agent profiles (--profile <ID>), not
  // individual CLI flags. These labels are informational only - no
  // permission-mode-to-flag mapping exists in buildCommand().
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan Only (Read-Only)' },
    { mode: 'default', label: 'Default' },
    { mode: 'bypassPermissions', label: 'Auto (Skip Confirmations)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';
  // An oz installed in a WSL distro runs there. Oz wires no hooks, reads no
  // transcript and is handed no MCP server, so its own path and `-C` in the
  // distro's form are all it needs.
  readonly supportsWslCli = true;

  private readonly detector = new WarpDetector();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Warp has no trust mechanism - no-op
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;
    const place = options.cliTarget ?? null;
    const parts: string[] = [quoteArg(place ? place.linuxCliPath : options.agentPath, shell), 'agent', 'run'];

    // Working directory, as the distro sees it for an oz installed in one.
    if (options.cwd) {
      parts.push('-C', quoteArg(place ? cliPathForTarget(options.cwd, place) : options.cwd, shell));
    }

    // Name for grouping and traceability
    if (options.taskId) {
      parts.push('--name', quoteArg(options.taskId, shell));
    }

    // Warp permissions are managed via agent profiles, not individual
    // CLI flags. No permission-mode-to-flag mapping needed.

    // --prompt with shell-safe quoting (only when prompt is provided).
    // Placed after all flags with -- end-of-options guard so prompt
    // content starting with "-" isn't misinterpreted as a CLI flag. The
    // guard goes through quoteArg: PowerShell's binder eats a bare --
    // before a .ps1 shim sees $args, and the quoted form survives.
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push(quoteArg('--', shell), '--prompt', quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: Warp has no hooks and no session resume.
   *
   * - Activity: PTY-only with silence timer. `oz agent run` is a
   *   one-shot runner that runs the agent locally, in the cwd (the
   *   remote form is `oz agent run-cloud`) - it streams output then exits.
   *   There is no interactive idle prompt. The silence timer handles
   *   the idle transition once output stops streaming.
   * - Session ID: omitted - Warp has no CLI-level resume mechanism.
   *
   * No detectIdle callback is provided because `oz agent run` has no
   * interactive prompt to match. The PTY silence timer
   * (`PTY_SILENCE_THRESHOLD_MS` in PtyActivityTracker) is the sole idle
   * detection mechanism.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    // Only terminal silence says a turn ended.
    reportsTurnEnd: false,
    activity: ActivityDetection.pty(),
  };

  // Warp does not use hooks - no-op
  removeHooks(_directory: string): void {}

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Warp has no hooks or structured verification signals.
    // Callers fall back to time-based settle (paste) or time-settle (command-injection).
    return null;
  }

  getExitSequence(): string[] {
    // Warp has no session resume mechanism. Ctrl+C exits cleanly.
    return ['\x03'];
  }

  detectFirstOutput(data: string): boolean {
    // Warp streams output immediately (no alternate screen buffer).
    // Any non-empty data means the agent is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(_agentSessionId: string, _cwd: string): Promise<string | null> {
    // Warp has no native session history files accessible via CLI.
    return null;
  }
}
