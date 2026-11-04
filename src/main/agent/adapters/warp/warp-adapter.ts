import { WarpDetector } from './version-detector';
import { writeWarpMcpConfig } from './mcp-config';
import { cliPathForTarget } from '../../shared/cli-target';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type {
  AgentCapabilities,
  AgentLiveTelemetryUnsupported,
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SubmissionContextType,
  SubmissionVerifier,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Warp CLI adapter - integrates the Warp AI agent CLI (`oz`)
 * (https://docs.warp.dev/reference/cli/cli) behind the generic
 * AgentAdapter interface.
 *
 * Warp is simpler than Claude Code: no session resume, no structured
 * status/event output, no trust mechanism, no hooks, and no settings
 * merging. Permissions are managed via Warp agent profiles (--profile),
 * not individual CLI flags. Beyond the prompt, a launch passes the working
 * directory, the task id as `--name`, and when set, `--model` and `--mcp`.
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
  // Warp keeps autonomy in agent profiles (`--profile <ID>`, an id from the
  // user's own Warp account; https://docs.warp.dev/reference/cli/cli), not in
  // per-mode flags. So Oz exposes the one entry its profile decides, as the
  // cli-features-over-custom-layers rule asks. The three labels it showed
  // before mapped to no flag, and "Plan Only (Read-Only)" was not read-only.
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'default', label: 'Default (set by your Warp agent profile)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';
  // An oz installed in a WSL distro runs there. Its own path, `-C` and the
  // `--mcp` file path reach it in the distro's form, and Kangentic's MCP
  // server reaches a distro on NAT networking through the hook transport's
  // bridge (`kangenticMcpServer`). Oz wires no hooks and reads no transcript.
  readonly supportsWslCli = true;
  /**
   * Each run gets its own `mcp.json` in its session directory, named by
   * `--mcp` (`writeWarpMcpConfig`). Built from Warp's docs, not yet run
   * against a real oz.
   */
  readonly kangenticMcp = 'per-session' as const;
  /**
   * `oz agent run` reports no model, context, tokens or cost to Kangentic: no
   * status file, hook or stream format is documented
   * (https://docs.warp.dev/reference/cli/cli).
   */
  readonly liveTelemetryUnsupported: AgentLiveTelemetryUnsupported = {
    unavailableLabel: 'Telemetry: none',
    unavailableTitle:
      'Oz CLI does not report live telemetry to Kangentic.\n'
      + 'Its own output in the terminal shows what the run did.',
  };

  private readonly detector = new WarpDetector();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Warp has no trust mechanism - no-op
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  /**
   * `oz agent run --model <MODEL_ID>` overrides the run's model
   * (https://docs.warp.dev/reference/cli/cli; `oz agent run --help` on
   * v0.2026.04.08.08.36.stable_02). Declared without running the CLI: the ids
   * come from `oz model list`, whose output format Warp does not document, so
   * the model field stays free-form.
   */
  async discoverCapabilities(_cliPath: string): Promise<AgentCapabilities> {
    return { supportsModelOverride: true };
  }

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

    // Per-column model override (see discoverCapabilities for the source).
    const model = options.model?.trim();
    if (model) {
      parts.push('--model', quoteArg(model, shell));
    }

    // Kangentic's MCP server, from a file in the session directory.
    const mcpConfigPath = writeWarpMcpConfig(options);
    if (mcpConfigPath) {
      parts.push('--mcp', quoteArg(mcpConfigPath, shell));
    }

    // The permission mode adds no flag: the Warp agent profile decides (see `permissions`).

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

  /**
   * The model `buildCommand` passed with `--model`, read only from the flags
   * ahead of the end-of-options guard (bare, or quoted as PowerShell and cmd
   * need it), so a prompt that mentions `--model` seeds nothing. The guard is
   * found by the `--prompt` that follows it, so a quoted folder or task name
   * holding ` -- ` does not end the flags early. The label is the id itself:
   * Warp documents no naming scheme to derive one from.
   */
  configuredModelFromCommand(command: string): { id: string; displayName: string } | null {
    const endOfOptions = command.search(/\s(?:--|'--'|"--")\s+--prompt(?:\s|$)/);
    const flagRegion = endOfOptions === -1 ? command : command.slice(0, endOfOptions);
    const match = flagRegion.match(/\s--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const id = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    if (!id) return null;
    return { id, displayName: id };
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

  // No hooks to remove, and the mcp.json lives in the session directory,
  // never in the working folder.
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
