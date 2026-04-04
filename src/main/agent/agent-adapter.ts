import type { SessionUsage, SessionEvent, SessionRecord, AgentPermissionEntry, PermissionMode } from '../../shared/types';

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
  mcpServerEnabled?: boolean; // whether to enable kangentic MCP server via --mcp-config
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

  /** Build the shell command string to spawn the agent. */
  buildCommand(options: SpawnCommandOptions): string;

  /** Interpolate {{key}} placeholders in a template string. */
  interpolateTemplate(template: string, variables: Record<string, string>): string;

  /** Parse raw status data (agent-specific format) into a SessionUsage. */
  parseStatus(raw: string): SessionUsage | null;

  /** Parse a single event line (agent-specific format) into a SessionEvent. */
  parseEvent(line: string): SessionEvent | null;

  /** Remove any monitoring hooks injected by this adapter (cleanup). */
  stripHooks(directory: string): void;

  /** Clear any cached settings (e.g. after project settings change). */
  clearSettingsCache(): void;

  /**
   * Return the sequence of strings to write to the PTY for a graceful exit.
   * Called by SessionManager.suspend() before force-killing the PTY.
   * Ctrl+C (\x03) interrupts in-progress work; the exit command triggers
   * a clean shutdown that flushes conversation state (e.g. JSONL transcript).
   *
   * Default (if not implemented): ['\x03'] (Ctrl+C only).
   */
  getExitSequence?(): string[];
}
