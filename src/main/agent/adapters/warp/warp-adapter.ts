import which from 'which';
import { execWarpVersion } from './version-detector';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Warp CLI adapter - integrates the Warp AI agent CLI (`oz`)
 * (https://docs.warp.dev/reference/cli/cli) behind the generic
 * AgentAdapter interface.
 *
 * Warp is simpler than Claude Code: no session resume, no structured
 * status/event output, no trust mechanism, no hooks, and no settings
 * merging. Permissions are managed via Warp agent profiles (--profile),
 * not individual CLI flags. Detection and command building are inlined.
 *
 * Detection is custom because `oz` does not support `--version` - it
 * uses `dump-debug-info` instead. This cannot use the shared
 * AgentDetector (which hardcodes `--version` via `execVersion`).
 */
export class WarpAdapter implements AgentAdapter {
  readonly name = 'warp';
  readonly displayName = 'Oz CLI';
  readonly sessionType = 'warp_agent';
  readonly supportsCallerSessionId = false;
  // Warp manages permissions via agent profiles (--profile <ID>), not
  // individual CLI flags. These labels are informational only - no
  // permission-mode-to-flag mapping exists in buildCommand().
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan Only (Read-Only)' },
    { mode: 'default', label: 'Default' },
    { mode: 'bypassPermissions', label: 'Auto (Skip Confirmations)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  // Custom detection: oz uses `dump-debug-info` instead of `--version`.
  // Caches and deduplicates like AgentDetector but with a custom version command.
  private cached: AgentInfo | null = null;
  private inflight: Promise<AgentInfo> | null = null;

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    if (this.cached) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.performDetection(overridePath);
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  invalidateDetectionCache(): void {
    this.cached = null;
    this.inflight = null;
  }

  private async performDetection(overridePath?: string | null): Promise<AgentInfo> {
    // 1. User-configured override path
    if (overridePath) {
      const version = await execWarpVersion(overridePath);
      if (version !== null) {
        this.cached = { found: true, path: overridePath, version };
        return this.cached;
      }
      this.cached = { found: false, path: overridePath, version: null };
      return this.cached;
    }

    // 2. PATH-based discovery via which()
    try {
      const whichPath = await which('oz');
      const version = await execWarpVersion(whichPath);
      if (version !== null) {
        this.cached = { found: true, path: whichPath, version };
        return this.cached;
      }
    } catch {
      // Binary not on PATH
    }

    this.cached = { found: false, path: null, version: null };
    return this.cached;
  }

  // Warp has no trust mechanism - no-op
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;
    const parts: string[] = [quoteArg(options.agentPath, shell), 'agent', 'run'];

    // Working directory
    if (options.cwd) {
      parts.push('-C', quoteArg(options.cwd, shell));
    }

    // Name for grouping and traceability
    if (options.taskId) {
      parts.push('--name', quoteArg(options.taskId, shell));
    }

    // Warp permissions are managed via agent profiles, not individual
    // CLI flags. No permission-mode-to-flag mapping needed.

    // --prompt with shell-safe quoting (only when prompt is provided).
    // Placed after all flags with -- end-of-options guard so prompt
    // content starting with "-" isn't misinterpreted as a CLI flag.
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push('--', '--prompt', quoteArg(safePrompt, shell));
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
   *   one-shot cloud agent runner - it streams output then exits.
   *   There is no interactive idle prompt. The silence timer handles
   *   the idle transition once output stops streaming.
   * - Session ID: omitted - Warp has no CLI-level resume mechanism.
   *
   * No detectIdle callback is provided because `oz agent run` has no
   * interactive prompt to match. The PTY silence timer (default 10s)
   * is the sole idle detection mechanism.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.pty(),
  };

  // Warp does not use hooks - no-op
  removeHooks(_directory: string): void {}

  // Warp has no merged settings - no-op
  clearSettingsCache(): void {}

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
