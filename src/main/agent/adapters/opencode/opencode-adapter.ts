import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeDetector } from './detector';
import { OpenCodeCommandBuilder } from './command-builder';
import { OpenCodeSessionHistoryParser } from './session-history-parser';
import { createOpenCodeCommandInjectionVerifier } from './command-injection-verifier';
import {
  capOpenCodeRemoteEntries,
  mapOpenCodeRemoteEntries,
  openCodeTranscriptSourcePath,
  parseOpenCodeTranscript,
  readOpenCodeTranscriptPage,
} from './transcript-parser';
import { migrateOpenCodeProjectData } from './project-relocation';
import { removeHooks as removeOpenCodeHooks } from './hook-manager';
import { discoverOpenCodeCapabilities } from './capability-discovery';
import { probeOpenCodeServer, fetchOpenCodeSessionMessages } from './remote-client';
import { buildSummarizePrompt, titleFromAnswer } from '../../shared/auto-name';
import { outsideChatRuns, spawnCli } from '../../shared/cli-print';
import { runCliPrintAnswer, forwardStreamLines, ANSWER_STREAM_OUTPUT_BUDGET } from '../../shared/cli-answer';
import { SharedFolderHolds } from '../../shared/shared-folder-holds';
import { extractOpenCodeAnswer, openCodeAnswerEvents, openCodeSessionId } from './answer-stream';
import { openCodeKangenticMcpEntry } from './command-builder';
import { captureDistroOpenCodeSessionId, exportDistroOpenCodeSession } from './distro-sessions';
import { hostPathForTarget, parseWslCliPath, placeFromStored, resolveCliTarget, targetOfPlace, type CliPlace } from '../../shared/cli-target';
import { kangenticMcpServer, startRunMcpRelay } from '../../shared/kangentic-mcp-server';
import { withAnswerRunDirectory } from '../../shared/answer-run-directory';
import type {
  AgentAdapter,
  AgentInfo,
  AnswerFromContextOptions,
  SpawnCommandOptions,
  SettingsChangeSpec,
  ParsedTranscript,
  SummarizeOptions,
  TranscriptPageReadRequest,
  TranscriptPageReadResult,
} from '../../agent-adapter';
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
 *    `.opencode/plugins/` directory at spawn (held per session via
 *    `hookHolds` since concurrent sessions share the file).
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
  /**
   * Typed. The TUI lists `--session` and `--prompt` side by side, but neither
   * `opencode --help` nor its docs say the prompt runs on a session it
   * continues, so a message is typed in once the resume is ready.
   */
  readonly resumePromptDelivery = 'typed' as const;
  // Its plugin hook and labelled banner (`runtime.sessionId`).
  readonly capturesInteractiveSessionId = true;
  // The whole config in `OPENCODE_CONFIG_CONTENT`, the session's own env.
  readonly kangenticMcp = 'per-session' as const;
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
  /** An OpenCode installed in a WSL distro runs there (#286). */
  readonly supportsWslCli = true;
  // OpenCode's TUI scans a bracketed paste for image paths and attaches a
  // match as an `[Image N]` chip, quoted or not, spaces in the path included.
  // Verified against 1.18.30 with png, jpg and gif; a bmp arrives as
  // `[Pasted ~1 lines]` text instead, which the drop path's PNG normalization
  // covers (webp was not probed and takes the same normalization).
  readonly pastedImageNativeExtensions = ['png', 'jpg', 'jpeg', 'gif'];

  private readonly detector = new OpenCodeDetector();
  private readonly commandBuilder = new OpenCodeCommandBuilder();
  // Sessions holding the activity plugin, per project root. OpenCode
  // auto-loads plugins from a project-shared `.opencode/plugins/` directory,
  // so concurrent sessions in the same project share one plugin file, and
  // it is deleted only when the root's last session releases. A hold records
  // the project root, so a worktree session's release (which arrives with
  // the worktree path) removes the plugin the build installed. See
  // SharedFolderHolds.
  private readonly hookHolds = new SharedFolderHolds();

  // Keyed by spawn cwd, populated in buildCommand whenever a spawn resolves
  // to remote mode. Lets parseTranscript / locateSessionHistoryFile /
  // sessionId.fromFilesystem branch to the remote server without any
  // AgentAdapter interface change - adapters have no other way to reach
  // Kangentic's AppConfig (see agent-adapters-boundary.md). Known limitation:
  // empty after an app restart, so a remote session's transcript falls back
  // to the (empty) local SQLite lookup until the task is resumed again. The
  // retrieval worker's copy of this adapter is handed main's entries with each
  // index job (`knownTargets` / `adoptTargets`).
  private readonly remoteTargetsByCwd = new Map<string, ResolvedExecutionTarget>();

  /** Declares OpenCode's own dialect of the generic remote-execution capability. */
  readonly remoteExecution = {
    info: {
      urlPlaceholder: 'http://10.0.0.5:4096',
      authKind: 'basic' as const,
      workingDirectoryScope: 'per-invocation' as const,
      remoteModeCaveat:
        'The server is the authority for providers, models, and MCP tools in remote mode. '
        + 'The Kangentic MCP server and the activity-tracking plugin are not available for remote '
        + 'OpenCode sessions - attach has no way to push local config into an already-running server.',
    },
    probeServer: probeOpenCodeServer,
    knownTargets: (): Array<[string, ResolvedExecutionTarget]> => [...this.remoteTargetsByCwd],
    adoptTargets: (targets: ReadonlyArray<[string, ResolvedExecutionTarget]>): void => {
      // Main's entries are the whole truth: a cwd main cleared (a local
      // respawn) is cleared here too.
      this.remoteTargetsByCwd.clear();
      for (const [cwd, target] of targets) this.remoteTargetsByCwd.set(cwd, target);
    },
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

  async probeAuth(cliPath: string): Promise<boolean | null> {
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
    //
    // An OpenCode installed in a WSL distro signs in there: its file is under
    // the distro's own `XDG_DATA_HOME`, else the distro's `~/.local/share`.
    const place = await resolveCliTarget(cliPath, true).catch(() => undefined);
    if (place === undefined) return null;
    try {
      const distroDataHome = place?.facts.env.XDG_DATA_HOME?.trim();
      const dataHome = !place
        ? path.join(os.homedir(), '.local', 'share')
        : distroDataHome?.startsWith('/') ? hostPathForTarget(distroDataHome, place) : path.join(place.facts.homeUnc, '.local', 'share');
      const authPath = path.join(dataHome, 'opencode', 'auth.json');
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
    // Hold the project root until this session releases, so concurrent
    // sessions serialize their cleanup in `removeHooks`. Local mode only -
    // remote mode never installs the plugin (see command-builder.ts).
    if (options.eventsOutputPath) {
      this.hookHolds.retain(options.ptySessionId, options.projectRoot || options.cwd);
    }
    return command;
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
    // Its plugin reports the end of a turn as an Idle event.
    reportsTurnEnd: true,
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
      fromFilesystem: (options) => {
        // The local SQLite DB lives on the Kangentic host; a remote spawn's
        // session row lives on the server instead, so this poll would only
        // ever time out. Skip it - fromOutput (the PTY scan above) is the
        // sole capture path for remote sessions.
        if (this.remoteTargetsByCwd.has(options.cwd)) return Promise.resolve(null);
        // A distro OpenCode's row is in the distro's database, which its own
        // `session list` reads (distro-sessions.ts).
        if (options.cliTarget) {
          const target = targetOfPlace(placeFromStored(options.cliTarget));
          return target ? captureDistroOpenCodeSessionId({ spawnedAt: options.spawnedAt, cwd: options.cwd, target }) : Promise.resolve(null);
        }
        return OpenCodeSessionHistoryParser.captureSessionIdFromFilesystem({
          spawnedAt: options.spawnedAt,
          cwd: options.cwd,
          getAgentVersion: () => this.detector.getCachedVersion(),
        });
      },
    },
  };

  /**
   * Remove the activity plugin from a project's `.opencode/plugins/`.
   *
   * `sessionId` identifies which session is releasing its hold. When
   * supplied, the plugin file is deleted from the project root that session
   * held, once the root's last holder releases. When omitted, the call
   * drops every hold on `directory` and deletes the file - intended only
   * for forced cleanup paths (project delete) where every session is being
   * torn down anyway.
   */
  removeHooks(directory: string, sessionId?: string): void {
    const folder = this.hookHolds.release(sessionId, directory);
    // Null while another session in this project still needs the plugin.
    if (folder) removeOpenCodeHooks(folder);
  }

  getSubmissionVerifier(contextType: SubmissionContextType): SubmissionVerifier | null {
    if (contextType === 'command-injection') {
      // MEASURED (64-95ms, flat against a 7.3s turn). The only adapter that
      // queries SQL rather than reading a history file. A REMOTE session has no
      // local row and is therefore reported `failed` however well it was
      // delivered - a known limitation, contained by keeping escalation off.
      // See `canEscalateOnVerificationFailure` below.
      return createOpenCodeCommandInjectionVerifier();
    }
    // 'paste': the OpenCode plugin fires hooks and emits JSONL events, but
    // coordinating hook-based paste confirmation with this is complex; the
    // paste engine's activity and data-floor backstops cover it.
    return null;
  }

  /**
   * Like Codex, OpenCode handles slash input in the TUI and never writes it to
   * the database. Measured: with the leading `/` intact, a `/...` probe produced
   * no user message at all. Absence therefore cannot distinguish "rejected"
   * from "ran client-side", so slash auto_commands are left unverified rather
   * than risking an escalation that restarts a working session.
   */
  canVerifySlashSubmission(): boolean {
    return false;
  }

  /**
   * CONFIRM-ONLY, and this one has a KNOWN wrong answer rather than merely an
   * unproven one. A REMOTE session keeps no local row, so the query finds
   * nothing and the verifier returns false for the whole burst - reporting
   * `failed` on an auto_command that was delivered perfectly well.
   *
   * `locateSessionHistoryFile` guards that case by checking `remoteTargetsByCwd`;
   * `getSubmissionVerifier` cannot, because it receives only a context type -
   * no `cwd` to check the map with. Nor can the verifier signal the difference
   * once it runs: its contract is a boolean, and "cannot observe" and "observed
   * absence" both have to come back false so the caller keeps polling.
   *
   * So escalation stays off here regardless of the 95ms measurement. With it
   * off, a remote session costs one spurious notice; with it on, it would
   * restart a healthy session on every single delivery.
   */
  canEscalateOnVerificationFailure(): boolean {
    return false;
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

  async locateSessionHistoryFile(agentSessionId: string, cwd: string, place?: CliPlace | null): Promise<string | null> {
    // Cross-agent handoff degrades for a remote session: there is no local
    // history file to hand off. The PTY-scrollback cleanup path
    // (handoff/transcript-cleanup.ts) is the fallback for these sessions. A
    // distro session's database is the distro's, read only by its own CLI.
    if (this.remoteTargetsByCwd.has(cwd) || place) return null;
    return OpenCodeSessionHistoryParser.locate({ agentSessionId, cwd });
  }

  async parseTranscript(agentSessionId: string, cwd: string, place?: CliPlace | null): Promise<ParsedTranscript> {
    const target = this.remoteTargetsByCwd.get(cwd);
    if (target) {
      const messages = await fetchOpenCodeSessionMessages(target, agentSessionId);
      return {
        entries: capOpenCodeRemoteEntries(mapOpenCodeRemoteEntries(messages)),
        sourcePath: `${target.url}/session/${agentSessionId}/message`,
      };
    }
    // A distro session is exported by the distro's own CLI, which gives the
    // same entries the server's message API does. A row from before the CLI's
    // path was kept has nothing to run, and reads as no transcript yet.
    if (place) {
      const distroTarget = targetOfPlace(place);
      if (!distroTarget) return { entries: [], sourcePath: null };
      const messages = await exportDistroOpenCodeSession(distroTarget, agentSessionId, cwd).catch(() => []);
      return {
        entries: capOpenCodeRemoteEntries(mapOpenCodeRemoteEntries(messages)),
        sourcePath: `${distroTarget.linuxCliPath} export ${agentSessionId} (WSL: ${place.distro})`,
      };
    }
    const { entries, totalPosition } = await parseOpenCodeTranscript(agentSessionId);
    // The shared DB path is always known, so report it even when no entries
    // were found (empty session vs missing DB) - consistent with the
    // file-based adapters and gives the "not found" message a location to cite.
    // The DB is shared by every session, so its file size is not this one's.
    return { entries, sourcePath: openCodeTranscriptSourcePath(), totalPosition };
  }

  /** One page of a local session's history for the Conversation viewer; a remote one does not page. */
  async readTranscriptPage(agentSessionId: string, cwd: string, request: TranscriptPageReadRequest, place?: CliPlace | null): Promise<TranscriptPageReadResult> {
    // An export is the whole session, so a distro one does not page either.
    if (this.remoteTargetsByCwd.has(cwd) || place) return { status: 'unavailable', reason: 'unsupported_agent' };
    return readOpenCodeTranscriptPage(openCodeTranscriptSourcePath(), agentSessionId, request);
  }

  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverOpenCodeCapabilities(cliPath);
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // OpenCode does not support live `/model` or `/effort` slash commands.
    // Model changes require respawn (handled by task-move.ts fallback).
    return [];
  }

  /**
   * A title on the answer run: the read-only `plan` agent, no external
   * plugins, and the session deleted after. The plain `opencode run` this
   * replaced could edit and run commands, and kept every title in the global
   * session list. Measured on the title prompt in an empty folder: a clean
   * title in 7.1 s.
   */
  async summarize(prompt: string, cliPath: string, cwd: string, options?: SummarizeOptions): Promise<string> {
    return titleFromAnswer(await this.answerFromContext(buildSummarizePrompt(prompt), cliPath, cwd, options?.model, {
      runDirectory: options?.runDirectory,
      onUsage: options?.onUsage,
    }));
  }

  readonly answerCapabilities = { streaming: true, search: true, model: true, effort: false };

  /**
   * Answer a question from retrieved conversation passages (Knowledge Graph Ask).
   *
   * OpenCode's built-in `plan` agent is read-only: no edits, no bash (the
   * probe's file write and shell command were both refused). The prompt is
   * piped, and a 61,584-character prompt answered from its middle row.
   *
   * No `-q`: with it the shipped call returned nothing at all. The spinner it
   * was meant to hide goes to stderr, so stdout is the answer either way.
   *
   * STREAMING is `--format json`, whose events carry each text part whole as
   * its step ends (`answer-stream.ts`): by step, not by token, but the
   * narration, the search and the answer each land as they happen.
   *
   * SEARCH is our server added through `OPENCODE_CONFIG_CONTENT`, which
   * OpenCode merges over the user's config for this process only, so nothing
   * is written anywhere. The plan agent called it without asking (measured on
   * 1.18.31: 12 hits). `--pure` keeps external plugins out of an answer and
   * still loads MCP servers.
   *
   * The session each run leaves in OpenCode's database is deleted afterwards
   * (`opencode session delete`): the answer home is not a git repository, so
   * its sessions would otherwise pile up in the user's global session list.
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
    const retrieval = options?.retrieval;
    const onEvent = options?.onEvent;
    // An OpenCode installed in a WSL distro answers there, and its session is
    // deleted there. Only a WSL path waits for its distro's facts: any other
    // starts its run in this tick, as before.
    const cliTarget = parseWslCliPath(cliPath) ? await resolveCliTarget(cliPath, true) : null;
    // Its search bridge writes into the run's directory, which must be the
    // run's own: in the shared answer home two runs would share one relay folder.
    if (retrieval && cliTarget && !options?.runDirectory) {
      return withAnswerRunDirectory((runDirectory) => this.answerFromContext(prompt, cliPath, cwd, model, { ...options, runDirectory }));
    }
    const server = retrieval
      ? kangenticMcpServer({ url: retrieval.url, token: retrieval.token, place: cliTarget, directory: options?.runDirectory ?? cwd })
      : null;
    const stopRelay = startRunMcpRelay(options?.runDirectory ?? cwd, server);
    let sessionId: string | null = null;
    try {
      return await runCliPrintAnswer({
        cliPath,
        cliTarget,
        // The model flag is OMITTED when none is chosen: passing an
        // empty value is an error.
        args: ['run', '--agent', 'plan', '--format', 'json', '--pure', ...(model ? ['--model', model] : [])],
        prompt,
        cwd,
        extractRaw: extractOpenCodeAnswer,
        outputBudget: ANSWER_STREAM_OUTPUT_BUDGET,
        onChunk: forwardStreamLines((line) => {
          sessionId ??= openCodeSessionId(line);
          if (onEvent) for (const event of openCodeAnswerEvents(line)) onEvent(event);
        }),
        ...(server
          ? { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { kangentic: openCodeKangenticMcpEntry(server) } }) } }
          : {}),
      });
    } finally {
      stopRelay();
      // After the answer, not before it: the delete is its own process, and
      // the reader is not kept waiting on it. The id is read from the CLI's
      // output, so it goes on the command line only in the shape an id has.
      // Its output is drained so a full pipe cannot stall it. It is not the
      // chat's run, so the chat ending right after the answer cannot stop it.
      if (sessionId && /^[\w-]+$/.test(sessionId)) {
        const deleteArgs = ['session', 'delete', sessionId];
        const deletion = outsideChatRuns(() => spawnCli(cliPath, deleteArgs, cwd, undefined, cliTarget));
        deletion.on('error', () => undefined);
        // A delete that exits at once (the session already gone) can close the
        // pipe under the `end` below, as `runResolvedCliPrint` guards its own.
        deletion.stdin.on('error', () => undefined);
        deletion.stdout.resume();
        deletion.stderr.resume();
        deletion.stdin.end();
      }
    }
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
