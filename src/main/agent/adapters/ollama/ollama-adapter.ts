import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { discoverOllamaCapabilities } from './capability-discovery';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  PermissionMode,
  AdapterRuntimeStrategy,
  AgentCapabilities,
  SubmissionContextType,
  SubmissionVerifier,
} from '../../../../shared/types';
import { ActivityDetection } from '../../../../shared/types';

/**
 * Default model used when no per-column / per-task model override is set.
 *
 * `ollama run` REQUIRES a model argument (it has no built-in default and no
 * interactive picker), so the adapter must always supply one. Users normally
 * pick a specific installed model via the model dropdown, which is populated
 * from `ollama list` (see capability-discovery.ts). Ollama auto-pulls a
 * missing model on first run, so this fallback is always runnable.
 */
export const DEFAULT_OLLAMA_MODEL = 'llama3.2';

/**
 * Ollama CLI adapter - drives a local LLM via the `ollama` CLI
 * (https://ollama.com) behind the generic AgentAdapter interface.
 *
 * Ollama is a local-inference tool, not an agentic coder: `ollama run` opens
 * a chat with a local model and cannot edit files or call tools on its own.
 * It is modeled on the Warp adapter (a one-shot run that streams output then
 * exits), NOT on the agentic CLIs: `ollama run <model> "<prompt>"` prints the
 * answer and the process exits, so each spawn is a single turn. Free-form
 * multi-turn chat is available by running `ollama run <model>` directly in a
 * Command Terminal.
 *
 * No session resume (Ollama has no CLI-level session IDs), no hooks, no trust
 * mechanism, no MCP wiring. The one Kangentic-managed knob is the model
 * argument, which is mandatory for `ollama run` and therefore a documented
 * exception to cli-features-over-custom-layers.md.
 */
export class OllamaAdapter implements AgentAdapter {
  readonly name = 'ollama';
  readonly displayName = 'Ollama';
  readonly sessionType = 'ollama_agent';
  readonly supportsCallerSessionId = false;
  // Ollama has no autonomy / permission concept - it is a plain chat REPL.
  // Per cli-features-over-custom-layers.md, expose a single informational
  // entry and inject no permission flags in buildCommand().
  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'default', label: 'Chat' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  // Shared AgentDetector via composition (like Aider). `ollama --version`
  // prints `ollama version is X.Y.Z`.
  private readonly detector = new AgentDetector({
    binaryName: 'ollama',
    fallbackPaths: standardUnixFallbackPaths('ollama'),
    parseVersion: (raw) => raw.replace(/^ollama version is\s+/i, '').trim() || null,
  });

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  /**
   * Discover installed models via `ollama list` so the renderer can populate
   * the model picker. Never throws (returns model-override support with no
   * list on failure, which the renderer renders as a free-form text input).
   */
  async discoverCapabilities(cliPath: string): Promise<AgentCapabilities> {
    return discoverOllamaCapabilities(cliPath);
  }

  // Ollama has no trust mechanism - no-op
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;

    // `ollama run` requires a model. Use the per-column / per-task override
    // when set, else fall back to a common default (Ollama auto-pulls it if
    // it is not already installed).
    const model = options.model?.trim() || DEFAULT_OLLAMA_MODEL;
    const parts: string[] = [quoteArg(options.agentPath, shell), 'run', quoteArg(model, shell)];

    // Initial prompt delivered as a single positional argument (one-shot
    // run). When absent (a no-prompt spawn), `ollama run <model>` drops into
    // an interactive REPL the user types into.
    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      // `ollama run` is a cobra/pflag CLI with flag parsing on, so a prompt
      // beginning with a dash (a markdown bullet, a dashed list item) would be
      // misread as a flag. Push the `--` end-of-options marker first so the
      // prompt is always taken as the positional argument (matches the Warp
      // adapter).
      parts.push('--', quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  /**
   * Runtime strategy: Ollama has no hooks and no native session IDs.
   *
   * - Activity: PTY-only. A one-shot `ollama run` streams output then exits,
   *   so the PTY silence timer drives the idle transition. The detectIdle
   *   callback additionally catches the interactive REPL prompt (`>>> `) for
   *   an instant idle when a no-prompt spawn drops into the REPL.
   * - Session ID / history: omitted - Ollama has no CLI-level resume and no
   *   session history files for `ollama run`.
   */
  readonly runtime: AdapterRuntimeStrategy = {
    activity: ActivityDetection.pty((data: string) => {
      const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      return /(?:^|\n)>>>\s*$/.test(clean);
    }),
  };

  // Ollama does not use hooks - no-op
  removeHooks(_directory: string): void {}

  // Ollama has no merged settings - no-op
  clearSettingsCache(): void {}

  getExitSequence(): string[] {
    // Ctrl+C interrupts generation; /bye cleanly exits an interactive REPL.
    // Harmless when the one-shot process has already exited.
    return ['\x03', '/bye\r'];
  }

  detectFirstOutput(data: string): boolean {
    // Ollama writes immediately (no alternate screen buffer). Any non-empty
    // data means the agent is ready.
    return data.length > 0;
  }

  async locateSessionHistoryFile(_agentSessionId: string, _cwd: string): Promise<string | null> {
    // Ollama has no native session history files for `ollama run`.
    return null;
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Ollama has no hooks or structured verification signals.
    // Callers fall back to time-based settle.
    return null;
  }
}
