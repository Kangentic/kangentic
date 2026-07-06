/**
 * Pins ClaudeAdapter.discoverCapabilities' own model-display-names wiring
 * (claude-adapter.ts, discoverCapabilities method). That wiring is a SEPARATE
 * copy from the standalone discoverClaudeCapabilities function in
 * capability-discovery.ts (covered by claude-capability-discovery.test.ts) -
 * nothing previously called the adapter method directly and asserted on
 * modelDisplayNames, so dropping `buildModelDisplayNames(models)` from the
 * adapter would not fail any test in CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above top-level const declarations, so the
// mock fns must be created via vi.hoisted to be visible inside the factory.
const { staticCapabilitiesMock, rescanModelsMock } = vi.hoisted(() => ({
  staticCapabilitiesMock: vi.fn(),
  rescanModelsMock: vi.fn(),
}));

// Mock only the two capability-discovery entry points the adapter calls; the
// adapter's `buildModelDisplayNames` import comes from a different module
// (./model-display-name) and runs for real, so the assertions below exercise
// the adapter's actual humanization wiring, not a stubbed shortcut.
vi.mock('../../src/main/agent/adapters/claude/capability-discovery', () => ({
  discoverClaudeStaticCapabilities: staticCapabilitiesMock,
  rescanClaudeModels: rescanModelsMock,
}));

import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

describe('ClaudeAdapter.discoverCapabilities', () => {
  beforeEach(() => {
    staticCapabilitiesMock.mockReset();
    rescanModelsMock.mockReset();
  });

  it('builds modelDisplayNames alongside a rescanned model list', async () => {
    staticCapabilitiesMock.mockResolvedValue({ supportsModelOverride: true });
    rescanModelsMock.mockResolvedValue(['claude-opus-4-8', 'claude-sonnet-4-6']);

    const adapter = new ClaudeAdapter();
    const capabilities = await adapter.discoverCapabilities('/usr/bin/claude');

    expect(capabilities.models).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(capabilities.modelDisplayNames).toEqual({
      'claude-opus-4-8': 'Opus 4.8',
      'claude-sonnet-4-6': 'Sonnet 4.6',
    });
  });

  it('omits modelDisplayNames when the rescan finds no models', async () => {
    staticCapabilitiesMock.mockResolvedValue({ supportsModelOverride: true });
    rescanModelsMock.mockResolvedValue(undefined);

    const adapter = new ClaudeAdapter();
    const capabilities = await adapter.discoverCapabilities('/usr/bin/claude');

    expect(capabilities.models).toBeUndefined();
    expect(capabilities.modelDisplayNames).toBeUndefined();
  });

  it('skips the rescan entirely when static capabilities lack --model support', async () => {
    staticCapabilitiesMock.mockResolvedValue({});

    const adapter = new ClaudeAdapter();
    const capabilities = await adapter.discoverCapabilities('/usr/bin/claude');

    expect(rescanModelsMock).not.toHaveBeenCalled();
    expect(capabilities.modelDisplayNames).toBeUndefined();
  });
});
