import type {
  SessionRecord,
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SessionContext,
  SessionAttachment,
  AgentLiveTelemetryUnsupported,
  SubmissionContextType,
  SubmissionVerifier,
  AgentCapabilities,
  TranscriptEntry,
  TranscriptUsage,
  TranscriptToolCounts,
  AgentRemoteExecutionInfo,
  AgentExecutionServer,
  ResolvedExecutionTarget,
  RemoteServerStatus,
  AgentLaunchOptionInfo,
} from '../../shared/types';

/**
 * Result of `AgentAdapter.parseTranscript`. `entries` is the parsed
 * conversation (empty when no history was found or it could not be parsed);
 * `sourcePath` is the located native file or database, or null, for the
 * response header.
 */
export interface ParsedTranscript {
  entries: TranscriptEntry[];
  sourcePath: string | null;
}

/**
 * Description of a column-level settings change (model and/or effort)
 * passed to `AgentAdapter.getInjectionSequence` so the adapter can produce
 * the correct CLI-specific writes to apply the change to a live session.
 *
 * `*Changed` fields exist separately from the values because some adapters
 * may want to clear-then-set vs. only-set vs. ignore unchanged fields.
 * `null` values mean the destination column does not override that setting
 * (i.e. inherit / keep current).
 */
export interface SettingsChangeSpec {
  model: string | null;
  modelChanged: boolean;
  effort: string | null;
  effortChanged: boolean;
}


/** CLI detection result returned by all agent detectors. */
export interface AgentInfo {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** Options for building a CLI command to spawn an agent. */
export interface CommandOptions {
  cliPath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string; // main repo root (for worktree settings resolution)
  sessionId?: string;
  resume?: boolean; // true = --resume (existing session), false = --session-id (new session)
  nonInteractive?: boolean;
  statusOutputPath?: string; // path where the status bridge writes JSON
  eventsOutputPath?: string; // path where the event bridge appends JSONL
  shell?: string; // target shell name - controls quoting style (single vs double quotes)
  mcpServerEnabled?: boolean; // whether to enable Kangentic MCP server (delivery is adapter-specific: --mcp-config flag, settings file, or env var)
  /** In-process MCP HTTP server URL for this project. Required when mcpServerEnabled is true. */
  mcpServerUrl?: string;
  /** Per-launch MCP server token. Sent as the X-Kangentic-Token header. */
  mcpServerToken?: string;
  /** Adapter-specific model identifier (e.g. Claude `--model opus`). Empty/undefined leaves the agent default in place. */
  model?: string;
  /** Adapter-specific effort/reasoning level (e.g. Claude `--effort xhigh`). Empty/undefined leaves the agent default in place. */
  effort?: string;
  /**
   * Fully-defaulted launch-option values for THIS agent, keyed by
   * `AgentLaunchOptionInfo.id`. Populated by the spawn chokepoints via
   * `resolveLaunchOptions`. Undefined for adapters that declare no launch options.
   */
  launchOptions?: Record<string, boolean>;
  /**
   * Present only when this project's execution mode for this agent is
   * 'remote' (resolved by the spawn chokepoint from `agent.executionServers`
   * + `agent.execution`). Adapters that declare `remoteExecution` read this
   * instead of spawning the CLI locally; `cwd` still holds a locally-valid
   * path for node-pty; the actual working directory the agent runs in is
   * `executionTarget.workingDirectory`, which lives on the remote server.
   */
  executionTarget?: ResolvedExecutionTarget;
}

/** Agent-agnostic spawn options - renames `cliPath` to `agentPath`. */
export type SpawnCommandOptions = Omit<CommandOptions, 'cliPath'> & { agentPath: string };

/** Interface that every agent adapter must implement. */
export interface AgentAdapter {
  /** Unique identifier for this agent type (e.g. 'claude', 'codex', 'aider'). */
  readonly name: string;

  /** Human-readable product name (e.g. 'Claude Code', 'Codex CLI', 'Aider'). */
  readonly displayName: string;

  /** The session_type value stored in the sessions DB table. */
  readonly sessionType: SessionRecord['session_type'];

  /**
   * Whether the agent CLI accepts a caller-specified session ID on creation
   * (e.g. Claude's `--session-id <uuid>`). When true, the stored agent_session_id
   * matches the CLI's actual session ID, enabling `--resume <id>`. When false,
   * the CLI generates its own ID internally and resume is not possible via the
   * stored ID.
   */
  readonly supportsCallerSessionId: boolean;

  /** Supported permission modes with agent-specific labels. */
  readonly permissions: AgentPermissionEntry[];

  /** Recommended default permission mode for this agent. */
  readonly defaultPermission: PermissionMode;

  /** Detect whether the agent CLI is installed and return path + version. */
  detect(overridePath?: string | null): Promise<AgentInfo>;

  /** Invalidate any cached detection result (e.g. after user changes CLI path). */
  invalidateDetectionCache(): void;

  /**
   * Discover adapter-specific capabilities at runtime by probing the live CLI
   * (e.g. parsing `--help` for valid effort levels and the presence of a
   * `--model` flag). Returns nothing for adapters that do not expose any
   * discoverable knobs. The result is attached to `AgentDetectionInfo` and
   * read by the renderer to gate optional UI controls. Implementations must
   * never throw - return an empty object on parse failure so the rest of
   * detection still succeeds.
   *
   * `forceRefresh` (set when a model dropdown opens) bypasses any
   * adapter-internal capability caches - notably Claude's 12h /model picker
   * probe - so a newly shipped model appears without a Kangentic restart.
   * Adapters with no cache to bypass may ignore it.
   */
  discoverCapabilities?(cliPath: string, forceRefresh?: boolean): Promise<AgentCapabilities>;

  /** Pre-approve a working directory so the agent does not prompt for trust. */
  ensureTrust(workingDirectory: string): Promise<void>;

  /**
   * Probe whether the agent is authenticated/logged in. Returns null
   * for agents that have no auth requirement or no cheap probe. Only
   * called by IPC after detect() returns found:true. Must never throw.
   */
  probeAuth?(): Promise<boolean | null>;

  /**
   * Declared by adapters whose CLI can attach to an already-running server
   * the user operates, instead of always spawning a local process (e.g.
   * OpenCode's `opencode attach <url> --dir <serverPath>`). Absent for every
   * other adapter - the Agent settings tab renders no remote-mode rows
   * for an agent that omits this, per `agent-adapters-boundary.md` (no
   * agent-name branching outside this folder; the renderer gates on the
   * presence of this capability instead).
   *
   * `probeServer` replaces `probeAuth` as the reachability/auth check when a
   * project's execution mode for this agent is 'remote': it must hit the
   * server directly (e.g. a health endpoint) rather than reading local
   * on-disk credentials, and must never throw.
   */
  readonly remoteExecution?: {
    readonly info: AgentRemoteExecutionInfo;
    probeServer(server: AgentExecutionServer): Promise<RemoteServerStatus>;
  };

  /**
   * Optional boolean startup toggles this agent CLI exposes (e.g. Codex's "Disable ChatGPT
   * Apps", which maps to `--disable apps`). Absent for every other adapter - the Agent settings
   * tab renders no launch-option rows for an agent that omits this, per
   * `agent-adapters-boundary.md`. Values are resolved by `resolveLaunchOptions`
   * (`src/main/agent/shared/launch-options.ts`) and threaded through as
   * `CommandOptions.launchOptions`; only this adapter's command builder interprets `id` into a
   * concrete CLI flag.
   */
  readonly launchOptions?: readonly AgentLaunchOptionInfo[];

  /** Build the shell command string to spawn the agent. */
  buildCommand(options: SpawnCommandOptions): string;

  /**
   * Build adapter-specific environment variables to inject into the PTY
   * spawn. Returns `null` (or omits the method entirely) when the adapter
   * needs no env injection. Used by adapters whose CLI has no flag-based
   * MCP wiring and must deliver the Kangentic MCP server config via env
   * (e.g. OpenCode's `OPENCODE_CONFIG_CONTENT`). Adapters that wire MCP
   * via a CLI flag (Claude `--mcp-config`) or settings file (Codex hooks)
   * do not implement this.
   */
  buildEnv?(options: SpawnCommandOptions): Record<string, string> | null;

  /** Interpolate {{key}} placeholders in a template string. */
  interpolateTemplate(template: string, variables: Record<string, string>): string;

  /**
   * Remove any monitoring hooks injected by this adapter (cleanup).
   *
   * `taskId` identifies which spawn is releasing its hold on shared hook
   * state. Adapters that write to a project-shared settings file (Codex,
   * Gemini) use it for per-task reference counting so concurrent sessions
   * do not clobber each other's hooks. Double-releases for the same taskId
   * are idempotent. Adapters that use per-session settings files (Claude)
   * ignore the parameter.
   */
  removeHooks(directory: string, taskId?: string): void;

  /** Clear any cached settings (e.g. after project settings change). */
  clearSettingsCache(): void;

  /**
   * Detect whether the agent has produced its first meaningful output.
   * Called on each PTY data flush. Return true to emit the 'first-output'
   * event that lifts the shimmer overlay in the renderer.
   */
  detectFirstOutput(data: string): boolean;

  /**
   * Optional: extract the configured model from a spawned command so the
   * board card can show a friendly model name IMMEDIATELY, before the agent
   * reports its own via status.json / stream telemetry. Returns the model id
   * and a human display name (e.g. `claude-opus-4-8` -> "Opus 4.8"), or null
   * when the command encodes no explicit model (the agent will use its own
   * default, which only its live telemetry can reveal).
   *
   * The seeded value is a placeholder: once the agent reports real usage it
   * overrides this, so a later in-session `/model` change is reflected
   * accurately. Each adapter owns its own command syntax and model-naming
   * scheme, so this stays out of the shared spawn/renderer code.
   */
  configuredModelFromCommand?(command: string): { id: string; displayName: string } | null;

  /**
   * Return the sequence of strings to write to the PTY for a graceful exit.
   * Called by SessionManager.suspend() before force-killing the PTY.
   * Ctrl+C (\x03) interrupts in-progress work; the exit command triggers
   * a clean shutdown that flushes conversation state (e.g. JSONL transcript).
   *
   * Default (if not implemented): ['\x03'] (Ctrl+C only).
   */
  getExitSequence?(): string[];

  /**
   * Locate the agent's native session history file on disk for a given
   * session ID and working directory. Returns an absolute path to the
   * file (e.g. Claude's JSONL, Codex's rollout JSONL, Gemini's chat JSON),
   * or null if the agent has no session history files (Aider) or the file
   * cannot be found.
   */
  locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null>;

  /**
   * Optional: parse the agent's native session history into agent-agnostic
   * `TranscriptEntry[]` for the MCP `get_transcript` structured format. The
   * adapter owns ALL format and location knowledge (which JSONL/JSON/SQLite
   * file or database, how its blocks map onto user/assistant/tool_result/
   * system entries), so `handleGetTranscript` never branches on agent name.
   *
   * Must NOT throw on a missing, partial, or corrupt history: return
   * `{ entries: [], sourcePath }` so the caller can report "no structured
   * transcript yet" cleanly. `sourcePath` is informational (the located file
   * or database, or null when nothing was found) and feeds the response
   * header.
   *
   * A single parse method (rather than a locate+parse pair) is used because
   * some agents (OpenCode) read from a shared SQLite database keyed by
   * session id, not a per-session file. Adapters whose native history cannot
   * be parsed into a conversation (Aider's cumulative markdown, agents whose
   * history location is unknown) omit this; `get_transcript` then reports that
   * the structured format is unsupported and points at `format: "raw"`.
   */
  parseTranscript?(agentSessionId: string, cwd: string): Promise<ParsedTranscript>;

  /**
   * Optional: parse CUMULATIVE lifetime token usage for a session from the
   * agent's own transcript. This is the authoritative source for the per-task
   * lifetime-stats rollup, because the live statusLine token counts are a
   * current-context snapshot, not a cumulative total (Claude Code 2.1.132+).
   *
   * The adapter owns all location + format knowledge: prefer the explicit
   * `transcriptPath` the CLI reported (Claude's status.json `transcript_path`),
   * else locate the file from `agentSessionId` + `cwd`. Must NOT throw on a
   * missing/partial transcript: return null so the caller falls back to the
   * live snapshot. Implemented only by adapters whose CLI writes a parseable,
   * append-across-resume transcript (Claude today).
   */
  transcriptUsage?(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
  }): Promise<TranscriptUsage | null>;

  /**
   * Optional: cumulative tool-call count + per-tool breakdown parsed from the
   * agent's own transcript. Backfills the live UsageAccumulator count for
   * sessions whose ToolStart/ToolEnd hook events never reached it (a
   * parked/suspended session reports 0 despite real cost/tokens).
   *
   * Same location/format contract as `transcriptUsage`: prefer the explicit
   * `transcriptPath`, else locate from `agentSessionId` + `cwd`. Must NOT
   * throw on a missing/tool-less transcript: return null so the caller keeps
   * the live count. Counts DISTINCT `tool_use` ids (parallel tool calls in one
   * message count separately; a streamed re-emission of the same message does
   * not double-count). The returned breakdown is callCount-only
   * (`totalDurationMs`/`interruptedCount` are 0 - the transcript has no
   * ToolStart/ToolEnd pairing to derive them from). Implemented only by
   * adapters whose CLI writes a parseable transcript (Claude today); other
   * adapters are a no-op.
   */
  transcriptToolCounts?(input: {
    transcriptPath?: string | null;
    agentSessionId?: string | null;
    cwd?: string | null;
  }): Promise<TranscriptToolCounts | null>;

  /**
   * Optional: return a callback that confirms a submission was processed.
   * The callback receives a `SubmissionContext` and resolves `Promise<boolean>`.
   *
   * For 'paste' context: confirms a pasted prompt was accepted by the agent.
   * The paste-engine RACES this callback against its own activity-event and
   * post-`\r` data fallbacks - a `false` resolution does NOT short-circuit
   * those, so a verifier may legitimately return false on a single scan.
   *
   * For 'command-injection' context: confirms an injected slash command was
   * parsed correctly (defending against Enter-key races that concatenate
   * commands). `TerminalSubmit.submitKeystrokes` polls this callback in a
   * tight loop and re-fires `\r` when it stays false past the retry
   * interval. Verifiers should bound their scan window using
   * `context.sentAt`.
   *
   * Return null for unsupported contexts; the caller uses fallback signals
   * (activity event + 50-byte data floor for paste, time-based settle for
   * command-injection).
   *
   * Example (Claude):
   *   - 'paste': returns null - the activity backstop covers Claude's hook
   *     transition; re-implementing event subscription inside a one-shot
   *     Promise would be redundant.
   *   - 'command-injection': returns a JSONL-polling verifier that exact-matches
   *     the slash command in the session transcript.
   *
   * Example (Aider, Codex, Gemini, Qwen, etc.):
   *   - Both contexts: returns null. Activity / data / time-settle fallbacks
   *     are sufficient given current CLI capabilities.
   */
  getSubmissionVerifier?(contextType: SubmissionContextType): SubmissionVerifier | null;

  /**
   * Optional: translate a column-level settings change (model / effort)
   * into the sequence of writes the TerminalSubmitScheduler should push onto
   * the live PTY to apply it. Pairs with
   * `getSubmissionVerifier('command-injection')` for confirmation.
   *
   * Sibling of `getExitSequence` - both return `string[]` of writes the
   * PTY layer consumes, just for different lifecycle events.
   *
   * - Claude returns `['/model X', '/effort Y']` for changed fields.
   * - Adapters whose CLI has no live-swap slash command should return an
   *   empty array; the caller will fall back to suspend+respawn (handled
   *   elsewhere by the prepare-spawn flow which reads the swimlane
   *   overrides directly).
   * - Adapters that don't override settings at all should not implement
   *   this method.
   *
   * Only fields with `*Changed = true` should produce a write. The
   * adapter owns ordering (e.g. /model before /effort if one depends on
   * the other) and any quoting/escaping.
   */
  getInjectionSequence?(spec: SettingsChangeSpec): string[];

  /**
   * How this agent exposes runtime state (activity detection + session ID capture).
   * One location per adapter for everything about how we interact with the agent
   * at runtime. See AdapterRuntimeStrategy for details.
   */
  readonly runtime: AdapterRuntimeStrategy;

  /**
   * Set by adapters whose CLI has no per-session telemetry channel (no
   * statusFile / sessionHistory / streamOutput integration is possible).
   * Carries the renderer-facing label and tooltip so all agent-specific
   * copy lives with the adapter. Omit for adapters that populate
   * SessionUsage normally via `runtime`.
   */
  readonly liveTelemetryUnsupported?: AgentLiveTelemetryUnsupported;

  /**
   * Set by adapters whose CLI streams ACCOUNT-WIDE rate-limit windows (e.g.
   * Claude). The ContextBar shows its rate-limit pill for any session of such an
   * agent using the shared global snapshot, so a freshly spawned terminal shows
   * the same limits as its siblings instead of a blank until it reports its own.
   * Omit (falsy) for adapters with no rate-limit telemetry, so they never show
   * another agent's account limits.
   */
  readonly reportsRateLimits?: boolean;

  /**
   * Set by adapters whose CLI does not reliably auto-attach an image from a
   * bare file path (i.e. most CLIs - a typed/pasted path is read as plain
   * text, never auto-recognized as an image attachment). Kangentic saves a
   * pasted-clipboard or dropped image to a temp PNG (this capture is reliable
   * even where the CLI's own native clipboard reader silently fails, e.g.
   * Claude Code on Windows with Snipping Tool images) and injects this
   * template instead of the bare path, so the agent reliably reads the file
   * as an image rather than treating the path as inert text.
   *
   * `{path}` is replaced with the shell-quoted absolute path to the saved
   * PNG. A template without `{path}` has the quoted path appended after a
   * space. Omit (falsy) to inject the bare quoted path (legacy behavior).
   */
  readonly pastedImageReferenceTemplate?: string;

  /**
   * Optional session lifecycle hook called once per PTY spawn, after
   * the session is live. Adapters that need to do per-session work
   * outside the declarative `runtime` hooks (e.g. fire an out-of-band
   * CLI query to resolve the active model, subscribe to an external
   * event stream, set up a file watcher this adapter uniquely needs)
   * implement this method. The returned `SessionAttachment.dispose`
   * is called when the session ends so adapters can cancel pending
   * work cleanly.
   *
   * SessionManager passes a narrow `SessionContext` that exposes only
   * generic primitives (`applyUsage`, the session ID). It does not
   * know what the adapter does inside this method - all adapter
   * specifics stay in the adapter module.
   *
   * Adapters that do not need per-session work can omit this.
   */
  attachSession?(context: SessionContext): SessionAttachment | void;

  /**
   * Optional one-shot summarization. Spawns the agent CLI in its non-interactive
   * `--print` (or equivalent) mode to turn a free-form description into a short
   * task title. Used by the auto-name-tasks-from-prompt feature. Adapters that
   * lack a non-interactive print mode (Aider) omit this; the renderer hides the
   * "Name from prompt" affordances when the active adapter has no capability.
   *
   * Implementations should:
   * - Use the adapter's read-only / no-edit equivalent of plan mode where possible
   *   (the prompt is pure summarization, no file edits required).
   * - Apply a strict timeout (the helper `runCliPrintSummarize` defaults to 15s).
   * - Throw on failure rather than returning placeholder text. The IPC handler
   *   converts thrown errors to `{ ok: false, reason }`.
   */
  summarize?(prompt: string, cliPath: string, cwd: string): Promise<string>;

  /**
   * Optional: notify the adapter that per-cwd data must move from `oldPath` to
   * `newPath`. Agents that keep per-cwd data OUTSIDE the working directory, keyed
   * by the absolute cwd path, must migrate it here so sessions stay resumable
   * after the path changes (Claude renames its `~/.claude/projects/<slug>/`
   * transcript directories and rewrites the matching `~/.claude.json` keys).
   *
   * Invoked for two relocations, both with the same (oldPath, newPath) contract:
   * 1. A whole-project move - called best-effort by `relocateProject` after the
   *    stored DB paths are rewritten and `git worktree repair` has run, while the
   *    project's sessions are suspended and before the renderer reopens it. Here
   *    the paths are project roots, and the implementation also migrates every
   *    worktree found under them.
   * 2. A single worktree-cwd rename - called best-effort on the first resume after
   *    a task's worktree directory was recreated at a new path (see
   *    `transition-engine/resume-cwd-migration.ts`). Here the paths are one
   *    task's old and new worktree directories, so only that cwd's data moves.
   *
   * Implementations must be internally fault-tolerant: a failure must never block
   * the caller, and must degrade to leaving data in place (never destructive).
   * Because `replacePathPrefix` confines every rewrite to keys under `oldPath`,
   * passing a single worktree path migrates only that worktree. Adapters whose
   * per-cwd data lives inside the working directory (so it moves with it) omit
   * this method.
   */
  onProjectRelocated?(oldPath: string, newPath: string): Promise<void>;

}
