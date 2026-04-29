import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeDetector } from './detector';
import { OpenCodeCommandBuilder } from './command-builder';
import { OpenCodeSessionHistoryParser } from './session-history-parser';
import { removeHooks as removeOpenCodeHooks } from './hook-manager';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { AgentPermissionEntry, PermissionMode, AdapterRuntimeStrategy, SessionEvent } from '../../../../shared/types';
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
 * OpenCode CLI adapter (https://github.com/sst/opencode). OpenCode is a
 * TUI-based AI coding agent installed via `npm i -g opencode-ai`, the
 * curl|sh installer, or platform package managers (brew, scoop, choco,
 * pacman).
 *
 * Capabilities relative to other adapters (verified against the official
 * OpenCode plugin docs at https://opencode.ai/docs/plugins/, April 2026):
 *  - Plugin system fires in TUI mode. Activity detection is hook-driven
 *    (`tool.execute.before/after`, `event` for `session.created` /
 *    `session.idle` / `session.error`), with PTY silence timer as a
 *    belt-and-braces fallback for the gap between idle events.
 *  - Generates its own session IDs. The plugin captures the ID via
 *    `event.properties.info.id` on `session.created`; we also keep the
 *    PTY output regex and filesystem scan as fallbacks for legacy
 *    OpenCode versions that may not deliver the plugin event.
 *  - No merged settings file and no `--mcp-config` CLI flag. OpenCode
 *    reads MCP and provider config from `opencode.json` (project) or
 *    `~/.config/opencode/opencode.json` (global), plus the
 *    `OPENCODE_CONFIG_CONTENT` env var for inline overrides. The
 *    Kangentic MCP entry is injected via `buildEnv()` so the user's
 *    checked-in `opencode.json` is never touched. The activity-stream
 *    plugin is a separate file, copied into the project-shared
 *    `.opencode/plugins/` directory at spawn (refcounted via
 *    `hookHolders` since concurrent sessions share the file).
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
  // Per-project taskId set tracking which spawns currently hold the
  // activity plugin. OpenCode auto-loads plugins from a project-shared
  // `.opencode/plugins/` directory, so concurrent sessions in the same
  // project share one plugin file. Refcount prevents premature deletion
  // when the first task ends while a second is still active. Mirrors
  // CodexAdapter.hookHolders.
  private readonly hookHolders = new Map<string, Set<string>>();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // OpenCode has no trust dialog - no pre-approval needed. See
    // `probeAuth` for the login-state check, which reads
    // ~/.local/share/opencode/auth.json.
  }

  async probeAuth(): Promise<boolean | null> {
    // `opencode auth login` writes provider credentials to
    // ~/.local/share/opencode/auth.json on every platform (the OpenCode
    // troubleshooting docs spell out the same `.local/share/opencode/`
    // layout for Windows, under %USERPROFILE%, not %APPDATA%). The file
    // is a JSON object keyed by provider id; an empty `{}` or a missing
    // file means no providers are configured and a fresh spawn would
    // die with an auth error. The renderer surfaces this as an amber
    // warning so the user can run `opencode auth login` before moving
    // a task.
    //
    // The human-facing read of the same file is `opencode auth list`
    // (alias `opencode auth ls`); see tests/fixtures/opencode-auth.json
    // for the documented shape used in the regression test.
    try {
      const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
      const raw = fs.readFileSync(authPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.keys(parsed as Record<string, unknown>).length > 0;
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return null;
    }
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    const command = this.commandBuilder.buildOpenCodeCommand({ opencodePath: agentPath, ...rest });
    // buildOpenCodeCommand copies the activity plugin into
    // `<projectRoot>/.opencode/plugins/` whenever eventsOutputPath is set.
    // Retain a reference keyed by the project root so concurrent sessions
    // serialize their cleanup in `removeHooks`.
    if (options.eventsOutputPath) {
      const projectRoot = options.projectRoot || options.cwd;
      this.retainHooks(projectRoot, options.taskId);
    }
    return command;
  }

  private retainHooks(directory: string, taskId: string): void {
    let holders = this.hookHolders.get(directory);
    if (!holders) {
      holders = new Set<string>();
      this.hookHolders.set(directory, holders);
    }
    holders.add(taskId);
  }

  buildEnv(options: SpawnCommandOptions): Record<string, string> | null {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildOpenCodeEnv({ opencodePath: agentPath, ...rest });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: OpenCode exposes activity via its plugin system
   * (`tool.execute.before/after`, `event` with `session.*` types) with
   * a PTY silence-timer fallback for the gap between hook deliveries.
   * Session IDs come from the plugin's `session.created` payload first,
   * with PTY-output regex and a filesystem scan as belt-and-braces
   * fallbacks for legacy OpenCode versions.
   *
   * - Activity: hooks_and_pty. Hooks are authoritative when they fire;
   *   the PTY tracker is suppressed on the first hook event and
   *   re-engages only as a fallback if the plugin stops emitting.
   * - statusFile.parseEvent: decodes the plugin's JSONL output, which
   *   matches the event-bridge schema verbatim (the plugin produces
   *   the same `{ ts, type, tool?, detail?, hookContext? }` shape
   *   that all other adapters use).
   * - sessionId.fromHook: extracts `sessionID` from the
   *   `event.properties.info.id` field captured by the plugin on
   *   `session.created` and stored in `hookContext`.
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
    activity: ActivityDetection.hooksAndPty(),
    statusFile: {
      parseStatus: () => null,
      parseEvent: (line: string): SessionEvent | null => {
        try {
          return JSON.parse(line) as SessionEvent;
        } catch {
          return null;
        }
      },
      isFullRewrite: false,
    },
    sessionId: {
      fromHook(hookContext: string): string | null {
        try {
          const context = JSON.parse(hookContext);
          const sessionID = context.sessionID ?? context.session_id ?? null;
          if (typeof sessionID === 'string' && sessionID.length > 0) {
            return sessionID;
          }
          return null;
        } catch {
          return null;
        }
      },
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
      fromFilesystem: (options: { spawnedAt: Date; cwd: string }) =>
        OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
          ...options,
          getAgentVersion: () => this.detector.getCachedVersion(),
        }),
    },
  };

  /**
   * Remove the activity plugin from a project's `.opencode/plugins/`.
   *
   * `taskId` is required when concurrent OpenCode sessions on the same
   * project are possible (it identifies which spawn is releasing). When
   * supplied, the call decrements the refcount and only deletes the
   * plugin file once the last holder releases. When omitted, the call
   * skips the refcount path and unconditionally deletes the file -
   * intended only for shutdown / forced cleanup paths where every
   * pending session is being torn down anyway.
   */
  removeHooks(directory: string, taskId?: string): void {
    const holders = this.hookHolders.get(directory);
    if (holders && taskId) {
      holders.delete(taskId);
      if (holders.size > 0) {
        // Another concurrent session in this project still needs the plugin.
        return;
      }
      this.hookHolders.delete(directory);
    }
    removeOpenCodeHooks(directory);
  }

  clearSettingsCache(): void {
    // No merged settings cache to clear.
  }

  getExitSequence(): string[] {
    // Verified 2026-04-28 via scripts/probe-opencode-exit.ts: Ctrl+C alone
    // closes OpenCode (PTY exits in ~1s with STATUS_CONTROL_C_EXIT). Neither
    // /exit nor /quit is a recognized slash command - sending them at the
    // input prompt just types the characters into a dying buffer.
    return ['\x03'];
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
