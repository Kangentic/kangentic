import { GooseDetector } from './detector';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SubmissionContextType, SubmissionVerifier } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Goose CLI adapter - integrates Block's Goose agent CLI (`goose`)
 * (https://github.com/block/goose) behind the generic AgentAdapter interface.
 *
 * Goose is a thin integration, close to Warp/Oz: no hooks, no structured
 * status/event output, no trust mechanism, and no settings merging. It differs
 * from Warp in two ways this adapter uses:
 *
 * - Session resume. Goose accepts a caller-supplied session name (`--name`),
 *   so we hand it the engine-generated id (`supportsCallerSessionId = true`)
 *   and resume with `-r -n <id>`. No transcript parsing is needed to capture
 *   an id after the fact.
 * - Autonomy. Goose sets its approval mode through the `GOOSE_MODE` env var,
 *   not a spawn flag, so the permission dropdown maps to it via `buildEnv`.
 *
 * Model/provider selection is left to Goose's own `--model`/`--provider` flags
 * and `~/.config/goose/config.yaml`; per cli-features-over-custom-layers this
 * adapter keeps no model list and does not shadow the CLI's model control.
 */

/**
 * Kangentic permission mode -> Goose `GOOSE_MODE` value. A `Record` over the
 * full `PermissionMode` union makes a newly added mode a compile error here
 * rather than a silent wrong-mode spawn. Goose's own default is `smart_approve`.
 * - `chat`: no tools or file modification (read-only conversation).
 * - `smart_approve`: auto-approves low-risk actions, asks on the rest.
 * - `auto`: modify/create/delete and run tools without approval.
 */
const GOOSE_MODE_BY_PERMISSION: Record<PermissionMode, string> = {
  plan: 'chat',
  dontAsk: 'chat',
  default: 'smart_approve',
  acceptEdits: 'auto',
  auto: 'auto',
  bypassPermissions: 'auto',
};

export class GooseAdapter implements AgentAdapter {
  readonly name = 'goose';
  readonly displayName = 'Goose CLI';
  readonly sessionType = 'goose_agent';
  // Goose accepts a caller-supplied session name (`--name`), which we resume
  // with `-r -n <id>`. The engine stores the id it generates and passes it back
  // on resume (transition-engine.ts).
  readonly supportsCallerSessionId = true;
  // Goose maps each entry to a `GOOSE_MODE` value in buildEnv (not a CLI flag),
  // via GOOSE_MODE_BY_PERMISSION above.
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Chat Only, Read-Only)' },
    { mode: 'default', label: 'Default (Smart Approve)' },
    { mode: 'acceptEdits', label: 'Auto Edit (Approve Edits)' },
    { mode: 'bypassPermissions', label: 'Auto (Skip All Approvals)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  private readonly detector = new GooseDetector();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Goose has no trust mechanism - no-op.
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;

    // Goose runs in the process cwd; there is no start-in-dir flag, so the
    // PTY's cwd (set by the spawn chokepoint) is authoritative and no -C-style
    // flag is passed. A prompt uses `goose run -t <prompt> -s`: process the
    // prompt, then stay interactive so the user can continue the session. A
    // promptless spawn (an ordinary resume, or a plain terminal) opens a bare
    // interactive `goose session`.
    const parts: string[] = [quoteArg(options.agentPath, shell)];
    parts.push(options.prompt ? 'run' : 'session');

    // Resume a prior session by its caller-supplied name. The id is the same
    // value passed as --name on the fresh spawn.
    if (options.resume && options.sessionId) {
      parts.push('-r');
    }
    if (options.sessionId) {
      parts.push('-n', quoteArg(options.sessionId, shell));
    }

    if (options.prompt) {
      // Non-unix shells (PowerShell, cmd) quote with double quotes, so an
      // embedded double quote in the prompt would close the argument early.
      // Swap them for single quotes, matching the Warp adapter.
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push('-t', quoteArg(safePrompt, shell, { multiline: true }));
      // -s / --interactive: drop into an interactive session after the prompt.
      parts.push('-s');
    }

    return parts.join(' ');
  }

  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    // Goose reads its approval mode from GOOSE_MODE (env or config), not a CLI
    // flag, so the permission dropdown is delivered here.
    return { GOOSE_MODE: GOOSE_MODE_BY_PERMISSION[options.permissionMode] };
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: Goose has no hooks and no structured status output, so
   * activity is PTY-only with the silence timer, like Warp. The session id is
   * caller-supplied (see supportsCallerSessionId), so no capture strategy is
   * needed.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.pty(),
  };

  // Goose does not use hooks - no-op.
  removeHooks(_directory: string): void {}

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Goose has no hooks or structured verification signals. Callers fall back
    // to time-based settle (paste) or time-settle (command-injection).
    return null;
  }

  // Goose has no merged settings - no-op.
  clearSettingsCache(): void {}

  getExitSequence(): string[] {
    // Ctrl+C interrupts and exits an interactive Goose session cleanly.
    return ['\x03'];
  }

  detectFirstOutput(data: string): boolean {
    // Goose streams output immediately; any non-empty data means it is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(_agentSessionId: string, _cwd: string): Promise<string | null> {
    // No transcript parsing in this adapter: resume rides on the caller-supplied
    // --name, and the resume-conversation guard degrades safely to "cannot prove
    // empty" when this returns null.
    return null;
  }
}
