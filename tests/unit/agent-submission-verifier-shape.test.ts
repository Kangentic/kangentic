/**
 * Verifies each agent adapter implements getSubmissionVerifier method
 * correctly for both 'paste' and 'command-injection' contexts.
 *
 * Strategy:
 *   claude        - command-injection returns verifier, paste returns null
 *   All others    - both contexts return null (time-based fallback)
 */
import { describe, it, expect } from 'vitest';

const ADAPTER_CLASSES = [
  { name: 'claude',    importPath: '../../src/main/agent/adapters/claude/claude-adapter',       className: 'ClaudeAdapter' },
  { name: 'codex',     importPath: '../../src/main/agent/adapters/codex/codex-adapter',        className: 'CodexAdapter' },
  { name: 'gemini',    importPath: '../../src/main/agent/adapters/gemini/gemini-adapter',      className: 'GeminiAdapter' },
  { name: 'qwen',      importPath: '../../src/main/agent/adapters/qwen-code/qwen-adapter',     className: 'QwenAdapter' },
  { name: 'opencode',  importPath: '../../src/main/agent/adapters/opencode/opencode-adapter',  className: 'OpenCodeAdapter' },
  { name: 'copilot',   importPath: '../../src/main/agent/adapters/copilot/copilot-adapter',    className: 'CopilotAdapter' },
  { name: 'aider',     importPath: '../../src/main/agent/adapters/aider/aider-adapter',        className: 'AiderAdapter' },
  { name: 'cursor',    importPath: '../../src/main/agent/adapters/cursor/cursor-adapter',      className: 'CursorAdapter' },
  { name: 'droid',     importPath: '../../src/main/agent/adapters/droid/droid-adapter',        className: 'DroidAdapter' },
  { name: 'kimi',      importPath: '../../src/main/agent/adapters/kimi/kimi-adapter',          className: 'KimiAdapter' },
  { name: 'warp',      importPath: '../../src/main/agent/adapters/warp/warp-adapter',          className: 'WarpAdapter' },
  { name: 'ollama',    importPath: '../../src/main/agent/adapters/ollama/ollama-adapter',      className: 'OllamaAdapter' },
] as const;

describe('Adapter getSubmissionVerifier implementation', () => {
  it.each(ADAPTER_CLASSES)(
    '$name adapter implements getSubmissionVerifier method',
    async ({ importPath, className }) => {
      const module = await import(importPath);
      const AdapterClass = module[className] as new () => { getSubmissionVerifier: (contextType: string) => unknown };
      const adapter = new AdapterClass();

      expect(typeof adapter.getSubmissionVerifier).toBe('function');
    },
  );

  it.each(ADAPTER_CLASSES)(
    '$name adapter getSubmissionVerifier returns appropriate values for contexts',
    async ({ importPath, className, name }) => {
      const module = await import(importPath);
      const AdapterClass = module[className] as new () => { getSubmissionVerifier: (contextType: string) => unknown };
      const adapter = new AdapterClass();

      // All adapters should handle both contexts
      const pasteVerifier = adapter.getSubmissionVerifier('paste');
      const commandVerifier = adapter.getSubmissionVerifier('command-injection');

      // Currently:
      // - Claude may return a verifier for command-injection
      // - All others return null for both (use fallback)
      if (name === 'claude') {
        // Claude ALWAYS returns a non-null function for command-injection.
        // Any regression that makes it return null silently degrades to
        // time-based settle for all slash-command injection and must fail here.
        expect(commandVerifier).not.toBeNull();
        expect(typeof commandVerifier).toBe('function');
      }

      // All adapters should return null or function (not undefined or other types)
      expect([null, 'function']).toContain(
        pasteVerifier === null ? null : typeof pasteVerifier,
        `${name} paste verifier should be null or function`
      );
      expect([null, 'function']).toContain(
        commandVerifier === null ? null : typeof commandVerifier,
        `${name} command-injection verifier should be null or function`
      );
    },
  );

  it('every registered adapter implements getSubmissionVerifier', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    for (const adapterName of agentRegistry.list()) {
      const adapter = agentRegistry.get(adapterName);
      expect(typeof adapter?.getSubmissionVerifier).toBe(
        'function',
        `${adapterName} adapter missing getSubmissionVerifier method`
      );
    }
  });
});
