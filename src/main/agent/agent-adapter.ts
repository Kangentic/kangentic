import type { SessionUsage, SessionEvent, SessionRecord } from '../../shared/types';
import type { ClaudeInfo } from './claude-detector';
import type { CommandOptions } from './command-builder';

/** Agent-agnostic alias for CLI detection results. */
export type AgentInfo = ClaudeInfo;

/** Agent-agnostic spawn options - renames `claudePath` to `agentPath`. */
export type SpawnCommandOptions = Omit<CommandOptions, 'claudePath'> & { agentPath: string };

/** Interface that every agent adapter must implement. */
export interface AgentAdapter {
  /** Unique identifier for this agent type (e.g. 'claude', 'codex', 'aider'). */
  readonly name: string;

  /** The session_type value stored in the sessions DB table. */
  readonly sessionType: SessionRecord['session_type'];

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
}
