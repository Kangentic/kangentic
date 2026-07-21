import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeDetector } from './detector';
import { OpenCodeCommandBuilder } from './command-builder';
import { OpenCodeSessionHistoryParser } from './session-history-parser';
import { parseOpenCodeTranscript, openCodeTranscriptSourcePath, mapOpenCodeRemoteEntries } from './transcript-parser';
import { migrateOpenCodeProjectData } from './project-relocation';
import { removeHooks as removeOpenCodeHooks } from './hook-manager';
import { discoverOpenCodeCapabilities } from './capability-discovery';
import { probeOpenCodeServer, fetchOpenCodeSessionMessages } from './remote-client';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions, SettingsChangeSpec, ParsedTranscript } from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SessionEvent,
  SubmissionContextType,
  SubmissionVerifier,
  AgentCapabilities,
  ResolvedExecutionTarget,
} from '../../../../shared/types';
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
// Match only OpenCode's *announced* session banner: a label (`session id`,
// `session`, `sid`) followed by a REQUIRED `:` or `=` separator and the id.
//
// The separator is the load-bearing part. The PTY scrollback also contains the
// shell command line, which carries the id behind a `--session <id>` / `--resume
// <id>` FLAG: our own resume invocation, and - critically on Windows - a
// PSReadLine command-history autosuggestion echoing a stale `--session <uuid>`
// from a prior run. A flag form is `session` + whitespace + id with NO `:`/`=`,
// so requiring the separator excludes it while still matching the real banner
// `session id: ses_...`. Without this the scanner captured the stale flag id and
// resumed the wrong session (the flaky-capture bug this regex fixes). There is
// deliberately no separate `--session` flag-form matcher: a bare flag in PTY
// output is always a command echo, never the agent announcing its id.
const LABELED_SESSION_ID_REGEX = new RegExp(
  `(?:session(?:[ _-]?id)?|sid)["']?\\s*[:=]\\s*["']?${ID_ALTERNATION}["']?`,
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
 *  - Remote execution: declares `remoteExecution` so a project can attach
 *    to a user-run `opencode serve` instead of spawning locally
 *    (`opencode attach <url> --dir <serverPath>`). See command-builder.ts
 *    (`buildOpenCodeAttachCommand`) and remote-client.ts for the HTTP side.
 *    Local behavior above is completely unchanged when no project has
 *    opted an OpenCode session into remote mode.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly sessionType = 'opencode_agent';
  readonly supportsCallerSessionId = false;
  // OpenCode's autonomy is expressed through "agents" (Build, Plan,
  // and any custom agents the user defines in opencode.json), cycled
  // at runtime via Tab. We expose those native concepts directly
  // rather than the Claude-shaped 4-mode union, mapping to OpenCode's
  // built-in primary agents:
  //   Plan  -> --agent plan  (built-in: read-only, no edits/bash)
  //   Build -> --agent build (built-in: full tool access)
  // The `mode` field reuses existing PermissionMode enum values for
  // storage compatibility (a swimlane setting set under Claude as
  // 'acceptEdits' continues to mean "Build" under OpenCode), but the
  // user-facing label is OpenCode's vocabulary. Historical values
  // outside this list (`default`, `bypassPermissions`, `dontAsk`,
  // `auto`) are still handled by mapPermissionModeToAgent for
  // backward compat with mixed-agent projects.
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Plan' },
    { mode: 'acceptEdits', label: 'Build' },
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

  // Keyed by spawn cwd, populated in buildCommand whenever a spawn resolves
  // to remote mode. Lets parseTranscript / locateSessionHistoryFile /
  // sessionId.fromFilesystem branch to the remote server without any
  // AgentAdapter interface change - adapters have no other way to reach
  // Kangentic's AppConfig (see agent-adapters-boundary.md). Known limitation:
  // empty after an app restart, so a remote session's transcript falls back
  // to the (empty) local SQLite lookup until the task is resumed again.
  private readonly remoteTargetsByCwd = new Map<string, ResolvedExecutionTarget>();

  /** Declares OpenCode's own dialect of the generic remote-execution capability. */
  readonly remoteExecution = {
    info: {
      urlPlaceholder: 'http://10.0.0.5:4096',
      authKind: 'basic' as const,
      workingDirectoryScope: 'per-invocation' as const,
      remoteModeCaveat:
        'The server is the authority for providers, models, and MCP tools in remote mode. '
        + 'The Kangentic MCP server and the activity-tracking plugin are not available for remote OpenCode sessions.',
    },
    probeServer: probeOpenCodeServer,
  };

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
    const { agentPath, model, effort, ...rest } = options;
    const command = this.commandBuilder.buildOpenCodeCommand({
      opencodePath: agentPath,
      model,
      effort,
      ...rest,
    });

    if (options.executionTarget) {
      // Remember the resolved server for this cwd so parseTranscript /
      // locateSessionHistoryFile / sessionId.fromFilesystem can branch to it
      // later without needing config access of their own.
      this.remoteTargetsByCwd.set(options.cwd, options.executionTarget);
      return command;
    }

    // Local spawn: clear any remote target a previous remote spawn recorded
    // for this cwd. Without this the entry outlives the mode flip, and
    // `sessionId.fromFilesystem` / `locateSessionHistoryFile` / `parseTranscript`
    // keep branching to a server that no longer backs this session - which
    // disables local session-id capture and can leave `agent_session_id` null,
    // silently breaking resume. The same key also collides when worktrees are
    // disabled (remote and local both use projectPath as cwd).
    this.remoteTargetsByCwd.delete(options.cwd);

    // buildOpenCodeCommand copies the activity plugin into
    // `<projectRoot>/.opencode/plugins/` whenever eventsOutputPath is set.
    // Retain a reference keyed by the project root so concurrent sessions
    // serialize their cleanup in `removeHooks`. Local mode only - remote
    // mode never installs the plugin (see command-builder.ts).
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
   * - sessionId.fromOutput: scans every PTY chunk for OpenCode's
   *   announced session banner - a label (`session id`, `session`,
   *   `sid`) plus a REQUIRED `:`/`=` separator plus the id. The native
   *   ID format (verified empirically on v1.14.25) is
   *   `ses_<26 alphanumeric>`, e.g. `ses_2349b5c91ffeKd6qajuUTR4clq`;
   *   canonical UUIDs are also accepted defensively. The separator
   *   requirement deliberately excludes a bare `--session <id>` flag in
   *   the scrollback (our own resume command echo, or a PSReadLine
   *   history autosuggestion on Windows), which would otherwise poison
   *   the capture with a stale id.
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

        return null;
      },
      fromFilesystem: (options: { spawnedAt: Date; cwd: string }) => {
        // The local SQLite DB lives on the Kangentic host; a remote spawn's
        // session row lives on the server instead, so this poll would only
        // ever time out. Skip it - fromOutput (the PTY scan above) is the
        // sole capture path for remote sessions.
        if (this.remoteTargetsByCwd.has(options.cwd)) return Promise.resolve(null);
        return OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
          ...options,
          getAgentVersion: () => this.detector.getCachedVersion(),
        });
      },
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

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // OpenCode plugin fires hooks and emits JSONL events, but coordinating
    // hook-based paste confirmation with command-injection JSONL parsing
    // is complex. Callers fall back to time-based settle (paste) or
    // time-settle (command-injection).
    return null;
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
    // Cross-agent handoff degrades for a remote session: there is no local
    // history file to hand off. The PTY-scrollback cleanup path
    // (handoff/transcript-cleanup.ts) is the fallback for these sessions.
    if (this.remoteTargetsByCwd.has(cwd)) return null;
    return OpenCodeSessionHistoryParser.locate({ agentSessionId, cwd });
  }

  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    const target = this.remoteTargetsByCwd.get(cwd);
    if (target) {
      const messages = await fetchOpenCodeSessionMessages(target, agentSessionId);
      return {
        entries: mapOpenCodeRemoteEntries(messages),
        sourcePath: `${target.url}/session/${agentSessionId}/message`,
      };
    }
    const entries = await parseOpenCodeTranscript(agentSessionId);
    // The shared DB path is always known, so report it even when no entries
    // were found (empty session vs missing DB) - consistent with the
    // file-based adapters and gives the "not found" message a location to cite.
    return { entries, sourcePath: openCodeTranscriptSourcePath() };
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverOpenCodeCapabilities(cliPath);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // OpenCode does not support live `/model` or `/effort` slash commands.
    // Model changes require respawn (handled by task-move.ts fallback).
    return [];
  }

  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    // `opencode run` runs non-interactively. The `-q` flag suppresses the spinner so
    // stdout contains only the assistant's response.
    return runCliPrintSummarize({
      cliPath,
      args: ['run', '-q'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
    });
  }

  /**
   * OpenCode stores sessions in a global SQLite DB
   * (~/.local/share/opencode/opencode.db) with absolute directory columns.
   * Rewrite the path prefix in those columns so the per-directory session
   * filter keeps matching after a relocation. Best-effort and non-destructive;
   * see migrateOpenCodeProjectData.
   */
  async onProjectRelocated(oldPath: string, newPath: string): Promise<void> {
    await migrateOpenCodeProjectData(oldPath, newPath);
  }
}
