import { describe, it, expect } from 'vitest';
import { resolveLaunchOptions } from '../../src/main/agent/shared/launch-options';
import type { AgentLaunchOptionInfo } from '../../src/shared/types';

const DISABLE_APPS: AgentLaunchOptionInfo = {
  id: 'disableApps',
  label: 'Disable ChatGPT Apps',
  description: 'Skip the optional cloud ChatGPT Apps MCP connector.',
  default: false,
};

describe('resolveLaunchOptions', () => {
  it('returns undefined when the adapter declares no launch options', () => {
    expect(resolveLaunchOptions({ name: 'claude', launchOptions: undefined }, {})).toBeUndefined();
    expect(resolveLaunchOptions({ name: 'claude', launchOptions: [] }, {})).toBeUndefined();
  });

  it('falls back to the descriptor default when nothing is stored', () => {
    const resolved = resolveLaunchOptions({ name: 'codex', launchOptions: [DISABLE_APPS] }, {});
    expect(resolved).toEqual({ disableApps: false });
  });

  it('uses the stored value when present', () => {
    const resolved = resolveLaunchOptions(
      { name: 'codex', launchOptions: [DISABLE_APPS] },
      { codex: { disableApps: true } },
    );
    expect(resolved).toEqual({ disableApps: true });
  });

  it('uses a stored false override even though the descriptor default is false', () => {
    const resolved = resolveLaunchOptions(
      { name: 'codex', launchOptions: [{ ...DISABLE_APPS, default: true }] },
      { codex: { disableApps: false } },
    );
    expect(resolved).toEqual({ disableApps: false });
  });

  it('does not throw and applies defaults when configured is entirely undefined', () => {
    const resolved = resolveLaunchOptions({ name: 'codex', launchOptions: [DISABLE_APPS] }, undefined);
    expect(resolved).toEqual({ disableApps: false });
  });

  it('ignores stored values for a different agent', () => {
    const resolved = resolveLaunchOptions(
      { name: 'codex', launchOptions: [DISABLE_APPS] },
      { gemini: { disableApps: true } },
    );
    expect(resolved).toEqual({ disableApps: false });
  });
});
