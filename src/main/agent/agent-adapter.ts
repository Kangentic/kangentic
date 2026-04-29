import type {
  SessionRecord,
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  SessionContext,
  SessionAttachment,
} from '../../shared/types';

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

  /** Pre-approve a working directory so the agent does not prompt for trust. */
  ensureTrust(workingDirectory: string): Promise<void>;

  /**
   * Probe whether the agent is authenticated/logged in. Returns null
   * for agents that have no auth requirement or no cheap probe. Only
   * called by IPC after detect() returns found:true. Must never throw.
   */
  probeAuth?(): Promise<boolean | null>;

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
   * How this agent exposes runtime state (activity detection + session ID capture).
   * One location per adapter for everything about how we interact with the agent
   * at runtime. See AdapterRuntimeStrategy for details.
   */
  readonly runtime: AdapterRuntimeStrategy;

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
}
