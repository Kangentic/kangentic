import fs from 'node:fs';
import which from 'which';
import { execVersion } from '../../shared/exec-version';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type { SessionUsage, SessionEvent, AgentPermissionEntry, PermissionMode } from '../../../../shared/types';

/**
 * Aider CLI adapter - integrates the Aider AI pair programming tool
 * (https://aider.chat) behind the generic AgentAdapter interface.
 *
 * Aider is simpler than Claude Code: no session resume, no structured
 * status/event output, no trust mechanism, no hooks, and no settings
 * merging. Detection and command building are inlined.
 */
export class AiderAdapter implements AgentAdapter {
  readonly name = 'aider';
  readonly displayName = 'Aider';
  readonly sessionType = 'aider_agent';
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'default', label: 'Interactive (Confirm)' },
    { mode: 'bypassPermissions', label: 'Auto-Approve (--yes)' },
  ];
  readonly defaultPermission: PermissionMode = 'bypassPermissions';

  private cachedDetection: AgentInfo | null = null;
  private inflightDetection: Promise<AgentInfo> | null = null;

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    if (this.cachedDetection) return this.cachedDetection;
    if (this.inflightDetection) return this.inflightDetection;

    this.inflightDetection = this.performDetection(overridePath);
    try {
      return await this.inflightDetection;
    } finally {
      this.inflightDetection = null;
    }
  }

  private async performDetection(overridePath?: string | null): Promise<AgentInfo> {
    try {
      const aiderPath = overridePath || await which('aider');
      const version = await this.extractVersion(aiderPath);
      this.cachedDetection = { found: true, path: aiderPath, version };
      return this.cachedDetection;
    } catch { /* not on PATH */ }

    this.cachedDetection = { found: false, path: null, version: null };
    return this.cachedDetection;
  }

  /** Run --version and return the version string, or null on failure. */
  private async extractVersion(candidatePath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(candidatePath)) return null;
      const { stdout, stderr } = await execVersion(candidatePath);
      const raw = stdout.trim() || stderr.trim() || null;
      // `aider --version` outputs e.g. "aider 86.2" - strip the product name prefix
      return raw?.replace(/^aider\s+/i, '') ?? null;
    } catch {
      return null;
    }
  }

  invalidateDetectionCache(): void {
    this.cachedDetection = null;
    this.inflightDetection = null;
  }

  // Aider has no trust mechanism - no-op
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;
    const parts: string[] = [quoteArg(options.agentPath, shell)];

    // --message with shell-safe quoting (only when prompt is provided)
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push('--message', quoteArg(safePrompt, shell));
    }

    // Permission mode: bypassPermissions/dontAsk/acceptEdits/auto map to --yes;
    // plan/default leave Aider interactive for user confirmation
    if (
      options.permissionMode === 'bypassPermissions' ||
      options.permissionMode === 'dontAsk' ||
      options.permissionMode === 'acceptEdits' ||
      options.permissionMode === 'auto'
    ) {
      parts.push('--yes');
    }

    // Prevent Aider from auto-committing (Kangentic manages git)
    parts.push('--no-auto-commits');

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  // Aider has no structured status output
  parseStatus(_raw: string): SessionUsage | null {
    return null;
  }

  // Aider has no JSONL event stream
  parseEvent(_line: string): SessionEvent | null {
    return null;
  }

  // Aider does not use hooks - no-op
  stripHooks(_directory: string): void {}

  // Aider has no merged settings - no-op
  clearSettingsCache(): void {}
}
