import { OpenCodeDetector } from './detector';
import { OpenCodeCommandBuilder } from './command-builder';
import { OpenCodeSessionHistoryParser } from './session-history-parser';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy } from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

// Session-ID regexes hoisted to module scope so they compile once.
// `fromOutput` is invoked on every PTY chunk during the pre-capture
// window (potentially many times per second of TUI startup), so
// keeping these out of the function body avoids per-call regex
// construction.
//
// OpenCode's native session ID format (verified empirically on
// v1.14.25): `ses_<26 alphanumeric>`. The {16,64} bound is
// intentionally loose on the lower end so a future release that
// picks a longer suffix continues to capture, and bounded on the
// upper end so adversarial input cannot exhibit pathological
// backtracking against the alternation.
const NATIVE_SESSION_ID = '(ses_[A-Za-z0-9_-]{16,64})';
const UUID_SESSION_ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const ID_ALTERNATION = `(?:${NATIVE_SESSION_ID}|${UUID_SESSION_ID})`;
const LABELED_SESSION_ID_REGEX = new RegExp(
  `(?:session(?:[ _-]?id)?|sid)["']?\\s*[:=]?\\s*["']?${ID_ALTERNATION}["']?`,
  'i',
);
const FLAG_FORM_SESSION_ID_REGEX = new RegExp(
  `--session[\\s=]+['"]?${ID_ALTERNATION}['"]?`,
  'i',
);
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/**
 * OpenCode CLI adapter (https://github.com/anomalyco/opencode, formerly
 * sst/opencode). OpenCode is a TUI-based AI coding agent installed via
 * `npm i -g opencode-ai`, the curl|sh installer, or platform package
 * managers (brew, scoop, choco, pacman).
 *
 * Capabilities relative to other adapters (verified against
 * /anomalyco/opencode docs):
 *  - No documented hook system, so activity detection is PTY-only
 *    (silence timer, same as Codex).
 *  - Generates its own session IDs - we capture them via PTY output
 *    regex and a filesystem scan, then pass them back as `--session
 *    <id>` to resume.
 *  - No merged settings file; OpenCode reads MCP and provider config
 *    from `opencode.json` (project) or `~/.config/opencode/opencode.json`
 *    (global). Wiring the Kangentic MCP server into that config is a
 *    follow-up.
 *  - No trust dialog and no per-mode permission flags. The
 *    `--dangerously-skip-permissions` flag exists only for the
 *    non-interactive `opencode run` subcommand. In TUI mode, users
 *    must enable auto-approval via `opencode.json` config. The
 *    `permissions` list below is therefore informational - all modes
 *    produce the same CLI invocation today.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly sessionType = 'opencode_agent';
  readonly supportsCallerSessionId = false;
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan (Read-Only)' },
    { mode: 'default', label: 'Default' },
    { mode: 'acceptEdits', label: 'Accept Edits' },
    { mode: 'bypassPermissions', label: 'Dangerous Full Access' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new OpenCodeDetector();
  private readonly commandBuilder = new OpenCodeCommandBuilder();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // OpenCode has no trust dialog - no pre-approval needed.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildOpenCodeCommand({ opencodePath: agentPath, ...rest });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: OpenCode exposes activity via PTY only (no hooks)
   * and generates its own session IDs. Capture is best-effort and tries
   * PTY output first, then falls back to a filesystem scan of the
   * documented config-dir candidates.
   *
   * - Activity: silence timer. The Codex experience showed that idle
   *   detection via prompt regex on TUI agents is brittle (false
   *   thinking <-> idle oscillations); the 10s silence default is
   *   reliable when the TUI stops redrawing.
   * - sessionId.fromOutput: scans every PTY chunk for an OpenCode
   *   session ID adjacent to common labels. The native ID format
   *   (verified empirically on v1.14.25) is `ses_<26 alphanumeric>`,
   *   e.g. `ses_2349b5c91ffeKd6qajuUTR4clq`. We also accept canonical
   *   UUID format defensively in case a future release changes shape
   *   or another OpenCode-derived tool adopts the runtime.
   * - sessionId.fromFilesystem: reads the `~/.local/share/opencode/opencode.db`
   *   SQLite database (WAL-friendly readonly handle) and matches a
   *   `session` row whose `directory` equals our cwd and whose
   *   `time_created` falls in the spawn window.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.pty(),
    sessionId: {
      fromOutput(data: string): string | null {
        // Strip ANSI before pattern matching - the TUI peppers escape
        // codes between visible characters and would otherwise break
        // a literal match against "session id: <id>".
        const clean = data.replace(ANSI_ESCAPE_REGEX, '');

        const labeled = clean.match(LABELED_SESSION_ID_REGEX);
        if (labeled) return labeled[1] ?? labeled[2] ?? null;

        const flagForm = clean.match(FLAG_FORM_SESSION_ID_REGEX);
        if (flagForm) return flagForm[1] ?? flagForm[2] ?? null;

        return null;
      },
      fromFilesystem: OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem,
    },
  };

  removeHooks(_directory: string, _taskId?: string): void {
    // OpenCode does not use hooks - no-op.
  }

  clearSettingsCache(): void {
    // No merged settings cache to clear.
  }

  getExitSequence(): string[] {
    // Ctrl+C interrupts in-progress work; /exit triggers OpenCode's
    // graceful shutdown so any session-state flush completes before
    // the PTY is killed. If empirical testing shows OpenCode does not
    // recognize /exit, this can be reduced to ['\x03'].
    return ['\x03', '/exit\r'];
  }

  detectFirstOutput(data: string): boolean {
    // OpenCode is a full-screen TUI like Codex/Claude. The first
    // meaningful frame begins with the cursor-hide ESC sequence as the
    // alternate screen buffer is initialized. This keeps the shell
    // command echo hidden behind the shimmer overlay.
    return data.includes('\x1b[?25l');
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return OpenCodeSessionHistoryParser.locate({ agentSessionId, cwd });
  }
}
