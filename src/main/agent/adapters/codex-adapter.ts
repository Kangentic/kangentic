import { CodexDetector } from '../codex-detector';
import { CodexCommandBuilder } from '../codex-command-builder';
import { stripCodexHooks } from '../codex-hook-manager';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../agent-adapter';
import type { SessionUsage, SessionEvent, AgentPermissionEntry, PermissionMode } from '../../../shared/types';

/**
 * Codex CLI adapter - wraps CodexDetector, CodexCommandBuilder, and
 * codex-hook-manager behind the generic AgentAdapter interface.
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly displayName = 'Codex CLI';
  readonly sessionType = 'codex_agent';
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Suggest (Read-Only)' },
    { mode: 'acceptEdits', label: 'Auto-Edit' },
    { mode: 'bypassPermissions', label: 'Full Auto (Sandboxed)' },
  ];
  readonly defaultPermission: PermissionMode = 'acceptEdits';

  private readonly detector = new CodexDetector();
  private readonly commandBuilder = new CodexCommandBuilder();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // Codex does not have a trust dialog - no pre-approval needed.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, ...rest } = options;
    return this.commandBuilder.buildCodexCommand({ codexPath: agentPath, ...rest });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  parseStatus(_raw: string): SessionUsage | null {
    // Codex CLI does not expose real-time token usage or cost data
    // via a statusLine mechanism. Return null until a future version
    // adds equivalent support.
    return null;
  }

  parseEvent(line: string): SessionEvent | null {
    try {
      return JSON.parse(line) as SessionEvent;
    } catch {
      return null;
    }
  }

  stripHooks(directory: string): void {
    stripCodexHooks(directory);
  }

  clearSettingsCache(): void {
    // No settings cache to clear - Codex uses config.toml, not merged
    // settings files.
  }
}
