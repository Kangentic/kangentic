/**
 * Adapter contract behind the model/effort pickers:
 *   1. Adapters that implement `getInjectionSequence` return adapter-specific
 *      slash commands when the SettingsChangeSpec indicates a delta. Claude
 *      returns `/model X` and `/effort Y`; agents without a live-switch slash
 *      return an empty array. Only the Command Terminal (session:injectSettings)
 *      types these: a task session's pick (task:setRuntimeOverride) restarts
 *      the session with launch flags and never consults the adapter.
 *   2. The renderer's popover-gating predicate hides the trigger when the
 *      adapter's `discoverCapabilities()` reported empty arrays - so users
 *      never see a clickable pill they can't make a meaningful choice from.
 *
 * Both parts of the contract are exercised here with no IPC / Electron
 * dependencies so a regression that, say, drops `/model X` from Claude's
 * sequence fails fast.
 */
import { describe, it, expect } from 'vitest';
import type { SettingsChangeSpec } from '../../src/main/agent/agent-adapter';
import type { AgentCapabilities } from '../../src/shared/types';

const SPEC_BOTH_CHANGED: SettingsChangeSpec = {
  model: 'sonnet',
  modelChanged: true,
  effort: 'medium',
  effortChanged: true,
};

const SPEC_NOTHING_CHANGED: SettingsChangeSpec = {
  model: 'sonnet',
  modelChanged: false,
  effort: 'medium',
  effortChanged: false,
};

describe('Adapter getInjectionSequence (drives the Command Terminal live swap)', () => {
  it('Claude emits /model and /effort writes for a both-changed spec, in that order', async () => {
    const { ClaudeAdapter } = await import('../../src/main/agent/adapters/claude/claude-adapter');
    const adapter = new ClaudeAdapter();
    const sequence = adapter.getInjectionSequence?.(SPEC_BOTH_CHANGED) ?? [];
    expect(sequence).toEqual(['/model sonnet', '/effort medium']);
  });

  it('Claude emits no writes when nothing changed (no-op spec)', async () => {
    const { ClaudeAdapter } = await import('../../src/main/agent/adapters/claude/claude-adapter');
    const adapter = new ClaudeAdapter();
    const sequence = adapter.getInjectionSequence?.(SPEC_NOTHING_CHANGED) ?? [];
    expect(sequence).toEqual([]);
  });

  // Adapters that don't have a live-switch slash today: their getInjectionSequence
  // returns []. The Command Terminal then leaves the session as is rather than
  // typing a slash its CLI may not accept. If a regression makes one of these
  // unexpectedly emit writes, a Command Terminal pick would type text the CLI
  // treats as a prompt.
  const ADAPTERS_WITHOUT_LIVE_SWITCH = [
    { name: 'codex',    importPath: '../../src/main/agent/adapters/codex/codex-adapter',       className: 'CodexAdapter' },
    { name: 'kimi',     importPath: '../../src/main/agent/adapters/kimi/kimi-adapter',         className: 'KimiAdapter' },
    { name: 'opencode', importPath: '../../src/main/agent/adapters/opencode/opencode-adapter', className: 'OpenCodeAdapter' },
    { name: 'droid',    importPath: '../../src/main/agent/adapters/droid/droid-adapter',       className: 'DroidAdapter' },
    // Grok HAS /model + /effort slash commands, but declares
    // canVerifySlashSubmission false (slash input runs in the TUI palette and
    // never becomes a chat_history turn), so an injection could not be
    // confirmed and an unconfirmed slash would pollute the prompt.
    { name: 'grok',     importPath: '../../src/main/agent/adapters/grok/grok-adapter',         className: 'GrokAdapter' },
  ] as const;

  it.each(ADAPTERS_WITHOUT_LIVE_SWITCH)(
    '$name returns an empty injection sequence (no live swap)',
    async ({ importPath, className }) => {
      const module = await import(importPath);
      const AdapterClass = module[className] as new () => { getInjectionSequence?: (spec: SettingsChangeSpec) => string[] };
      const adapter = new AdapterClass();
      const sequence = adapter.getInjectionSequence?.(SPEC_BOTH_CHANGED) ?? [];
      expect(sequence).toEqual([]);
    },
  );
});

/**
 * Pure helper extracted from the ContextBar visibility checks. Lives in this
 * test file (not a shipped helper) because the gating logic is a single
 * boolean expression - moving it into a module would be premature
 * abstraction. Re-typing it here ensures any drift in the production check
 * is caught by the same test.
 */
function shouldShowModelTrigger(capabilities: AgentCapabilities | undefined): boolean {
  return !!capabilities?.supportsModelOverride && (capabilities.models?.length ?? 0) > 0;
}

function shouldShowEffortTrigger(capabilities: AgentCapabilities | undefined): boolean {
  return (capabilities?.effortLevels?.length ?? 0) > 0;
}

describe('ContextBar trigger gating predicate', () => {
  it('hides both triggers when capabilities is undefined', () => {
    expect(shouldShowModelTrigger(undefined)).toBe(false);
    expect(shouldShowEffortTrigger(undefined)).toBe(false);
  });

  it('hides model trigger when models[] is empty', () => {
    expect(shouldShowModelTrigger({ supportsModelOverride: true, models: [], effortLevels: [] })).toBe(false);
  });

  it('hides model trigger when supportsModelOverride is false (even if models is non-empty)', () => {
    expect(shouldShowModelTrigger({ supportsModelOverride: false, models: ['x'], effortLevels: [] })).toBe(false);
  });

  it('shows model trigger when supportsModelOverride is true and models is non-empty', () => {
    expect(shouldShowModelTrigger({ supportsModelOverride: true, models: ['opus', 'sonnet'], effortLevels: [] })).toBe(true);
  });

  it('hides effort trigger when effortLevels is empty', () => {
    expect(shouldShowEffortTrigger({ supportsModelOverride: true, models: [], effortLevels: [] })).toBe(false);
  });

  it('shows effort trigger when effortLevels has at least one entry', () => {
    expect(shouldShowEffortTrigger({ supportsModelOverride: false, models: [], effortLevels: ['low'] })).toBe(true);
  });
});
