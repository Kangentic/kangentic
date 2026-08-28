/**
 * Unit tests for validateSpawnOverrides in
 * src/main/agent/mcp-http/spawn-override-validation.ts.
 *
 * The behaviour under test is a trade: reject a typo at the call that made it
 * (instead of hours later at spawn, in an executing column, far from the
 * caller), WITHOUT ever rejecting a value we cannot actually verify. The second
 * half is the fragile one - an agent can legitimately enumerate nothing, three
 * different ways - so most of these cases pin acceptance, not rejection.
 *
 * `listAgents` and `agentRegistry` are mocked so nothing probes a real CLI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDetectionInfo, AgentCapabilities } from '../../src/shared/types';

const mockListAgents = vi.fn();
const mockRegistryList = vi.fn(() => ['claude', 'codex', 'gemini']);
const mockRegistryHas = vi.fn((name: string) => ['claude', 'codex', 'gemini'].includes(name));

vi.mock('../../src/main/agent/agent-list', () => ({
  listAgents: (...args: unknown[]) => mockListAgents(...args),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => mockRegistryList(),
    has: (name: string) => mockRegistryHas(name),
  },
}));

import { validateSpawnOverrides, CAPABILITY_PROBE_TIMEOUT_MS } from '../../src/main/agent/mcp-http/spawn-override-validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentInfo(name: string, capabilities: AgentCapabilities | undefined): AgentDetectionInfo {
  // Only `name` and `capabilities` are read by the module under test; the rest
  // of AgentDetectionInfo is irrelevant here.
  return { name, capabilities } as AgentDetectionInfo;
}

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  supportsModelOverride: true,
  models: ['claude-opus-4-8', 'claude-sonnet-4-5'],
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** Baseline input: nothing pinned, no learned models. */
const BASE = { cliPathOverrides: {}, discoveredModelsByAgent: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mockRegistryList.mockReturnValue(['claude', 'codex', 'gemini']);
  mockRegistryHas.mockImplementation((name: string) => ['claude', 'codex', 'gemini'].includes(name));
  mockListAgents.mockResolvedValue([agentInfo('claude', CLAUDE_CAPABILITIES)]);
});

// ---------------------------------------------------------------------------
// agentOverride - decidable with no capability probe at all
// ---------------------------------------------------------------------------

describe('validateSpawnOverrides - agentOverride', () => {
  it('rejects an unregistered agent and lists the valid names', async () => {
    const rejection = await validateSpawnOverrides({ ...BASE, agentOverride: 'clod' });
    expect(rejection).toContain('"clod"');
    expect(rejection).toContain('claude, codex, gemini');
    // Terminal: a retry of the same call cannot succeed, and the caller must
    // be told that rather than looping.
    expect(rejection).toContain('Retrying this call unchanged will fail identically.');
  });

  it('accepts a registered agent', async () => {
    expect(await validateSpawnOverrides({ ...BASE, agentOverride: 'codex' })).toBeNull();
  });

  it('decides an unknown agent without probing capabilities', async () => {
    await validateSpawnOverrides({ ...BASE, agentOverride: 'clod' });
    expect(mockListAgents).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The short-circuit: no pins means no probe. This is the common create_task
// call, and it must cost nothing.
// ---------------------------------------------------------------------------

describe('validateSpawnOverrides - no model or effort pinned', () => {
  it('returns null without calling listAgents', async () => {
    expect(await validateSpawnOverrides({ ...BASE })).toBeNull();
    expect(mockListAgents).not.toHaveBeenCalled();
  });

  it('treats empty and whitespace-only pins as unset', async () => {
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: '   ', effortOverride: '' })).toBeNull();
    expect(mockListAgents).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// modelOverride
// ---------------------------------------------------------------------------

describe('validateSpawnOverrides - modelOverride', () => {
  it('accepts a model the agent enumerates', async () => {
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-4-8' })).toBeNull();
  });

  it('matches case-insensitively', async () => {
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: 'CLAUDE-OPUS-4-8' })).toBeNull();
  });

  it('rejects an unknown model and lists the valid ones', async () => {
    const rejection = await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-9-9' });
    expect(rejection).toContain('"claude-opus-9-9"');
    expect(rejection).toContain('claude-opus-4-8, claude-sonnet-4-5');
  });

  it('accepts a floating alias that no discovered list can contain', async () => {
    // `--model opus` is valid and is the first example in the tool's own
    // schema, but a discovered list is built from concrete ids (transcript
    // `usage.model.id` and the CLI's `/model` picker), so an alias is never in
    // it. Rejecting on absence would refuse a value the CLI accepts.
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: 'opus' })).toBeNull();
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: 'sonnet' })).toBeNull();
  });

  it('still rejects a mistyped CONCRETE id, which is what the list can decide', async () => {
    const rejection = await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-4-9' });
    expect(rejection).toContain('"claude-opus-4-9"');
  });

  it('accepts an undated caller id against a discovered list holding only the dated form', async () => {
    // Claude's capability discovery deliberately records whichever spelling
    // the transcript used, so the discovered list can hold ONLY the dated
    // pin even though the caller passed the bare id. Comparing on baseId
    // (which strips the trailing -YYYYMMDD) is what makes these the same
    // model.
    mockListAgents.mockResolvedValue([
      agentInfo('claude', { supportsModelOverride: true, models: ['claude-opus-4-8-20260101'], effortLevels: [] }),
    ]);
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-4-8' })).toBeNull();
  });

  it('accepts a dated caller id against a discovered list holding only the undated form', async () => {
    mockListAgents.mockResolvedValue([
      agentInfo('claude', { supportsModelOverride: true, models: ['claude-opus-4-8'], effortLevels: [] }),
    ]);
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-4-8-20260101' })).toBeNull();
  });

  it('accepts the [1m] variant against a discovered list holding only the plain form', async () => {
    // Note on this one's red/green shape: a naive revert to a raw string
    // compare stays GREEN here too, not red - `isFloatingAlias` on the raw,
    // unstripped model still misreads the `[1m]`-suffixed segment as
    // non-numeric and waves it through as a floating alias, same net result
    // (accept) as the fixed code's genuine baseId membership match. This
    // case pins the CORRECT behavior and the correct REASON (real membership,
    // not an alias-loophole accident); the wrong-family sibling right below
    // is what pins the actual behavior change.
    mockListAgents.mockResolvedValue([
      agentInfo('claude', { supportsModelOverride: true, models: ['claude-opus-4-8'], effortLevels: [] }),
    ]);
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-4-8[1m]' })).toBeNull();
  });

  it('still rejects a genuinely wrong concrete id, undated and dated, under baseId normalization', async () => {
    const undatedRejection = await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-4-9' });
    expect(undatedRejection).toContain('"claude-opus-4-9"');

    const datedRejection = await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-4-9-20260101' });
    expect(datedRejection).toContain('"claude-opus-4-9-20260101"');
  });

  it('rejects a [1m]-suffixed wrong id - the [1m] suffix no longer hides a trailing version as a floating alias', async () => {
    // Before the fix, isFloatingAlias ran on the raw model string, so the
    // `[1m]` suffix broke parseModelFamily's trailing-digit detection and the
    // value was waved through unconditionally as a "floating alias". Now the
    // alias test runs on the baseId (with `[1m]` already stripped), so
    // claude-opus-4-9's real trailing version is visible and the value is
    // properly checked against the known list, where it does not appear.
    const rejection = await validateSpawnOverrides({ ...BASE, modelOverride: 'claude-opus-4-9[1m]' });
    expect(rejection).toContain('"claude-opus-4-9[1m]"');
  });

  it('accepts a model that is only in the learned discoveredModelsByAgent cache', async () => {
    // The renderer's own picker unions this in, so rejecting it would refuse a
    // model the UI itself offers.
    const rejection = await validateSpawnOverrides({
      ...BASE,
      modelOverride: 'claude-opus-5',
      discoveredModelsByAgent: { claude: ['claude-opus-5'] },
    });
    expect(rejection).toBeNull();
  });

  it('accepts any model when the agent enumerates none', async () => {
    mockListAgents.mockResolvedValue([agentInfo('claude', { supportsModelOverride: true, effortLevels: [] })]);
    expect(await validateSpawnOverrides({ ...BASE, modelOverride: 'anything-at-all' })).toBeNull();
  });

  it('rejects a model for an agent whose CLI takes no model flag', async () => {
    mockListAgents.mockResolvedValue([agentInfo('claude', { supportsModelOverride: false, effortLevels: [] })]);
    const rejection = await validateSpawnOverrides({ ...BASE, modelOverride: 'opus' });
    expect(rejection).toContain('no model override flag');
  });
});

// ---------------------------------------------------------------------------
// effortOverride
// ---------------------------------------------------------------------------

describe('validateSpawnOverrides - effortOverride', () => {
  it('accepts an enumerated level', async () => {
    expect(await validateSpawnOverrides({ ...BASE, effortOverride: 'xhigh' })).toBeNull();
  });

  it('rejects an unknown level and lists the valid ones', async () => {
    const rejection = await validateSpawnOverrides({ ...BASE, effortOverride: 'xtreme' });
    expect(rejection).toContain('"xtreme"');
    expect(rejection).toContain('low, medium, high, xhigh, max');
  });

  it('accepts any level when the agent enumerates none', async () => {
    // codex / gemini / droid all report `effortLevels: []` because they have
    // no effort flag at all. Empty means "cannot validate", never "invalid".
    mockListAgents.mockResolvedValue([agentInfo('codex', { supportsModelOverride: true, effortLevels: [] })]);
    const rejection = await validateSpawnOverrides({ ...BASE, agentOverride: 'codex', effortOverride: 'whatever' });
    expect(rejection).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Agent resolution ladder, and naming the resolved agent in the rejection
// ---------------------------------------------------------------------------

describe('validateSpawnOverrides - agent resolution ladder', () => {
  it('prefers agentOverride over the column and project default', async () => {
    mockListAgents.mockResolvedValue([
      agentInfo('claude', CLAUDE_CAPABILITIES),
      agentInfo('codex', { supportsModelOverride: true, models: ['gpt-5'], effortLevels: [] }),
    ]);
    const rejection = await validateSpawnOverrides({
      ...BASE,
      agentOverride: 'codex',
      laneAgentOverride: 'claude',
      projectDefaultAgent: 'claude',
      modelOverride: 'claude-opus-4-8',
    });
    // Resolved to codex, so a Claude model is wrong here.
    expect(rejection).toContain('agent "codex"');
    expect(rejection).toContain('the agent set by this call');
    expect(rejection).toContain('gpt-5');
  });

  it('prefers the task\'s own stored pin over the column and project default', async () => {
    // lockAdvancedOverridesOnFirstSpawn writes the pins onto the task at first
    // spawn, so most tasks that have ever run carry their own agent. Skipping
    // this rung validated an update against the wrong agent in both
    // directions: accepting a bad value, and rejecting a good one.
    mockListAgents.mockResolvedValue([
      agentInfo('claude', CLAUDE_CAPABILITIES),
      agentInfo('codex', { supportsModelOverride: true, models: ['gpt-5'], effortLevels: [] }),
    ]);
    const rejection = await validateSpawnOverrides({
      ...BASE,
      taskAgentOverride: 'codex',
      laneAgentOverride: 'claude',
      projectDefaultAgent: 'claude',
      modelOverride: 'claude-opus-4-8',
    });
    expect(rejection).toContain('agent "codex"');
    expect(rejection).toContain('the agent pinned on this task');
  });

  it('lets this call\'s agent argument outrank the task\'s stored pin', async () => {
    // Setting `agent` IS rewriting rung 1, so it must win over the old value.
    mockListAgents.mockResolvedValue([
      agentInfo('claude', CLAUDE_CAPABILITIES),
      agentInfo('codex', { supportsModelOverride: true, models: ['gpt-5'], effortLevels: [] }),
    ]);
    const rejection = await validateSpawnOverrides({
      ...BASE,
      agentOverride: 'claude',
      taskAgentOverride: 'codex',
      modelOverride: 'claude-opus-4-8',
    });
    expect(rejection).toBeNull();
  });

  it('falls to the column override when no agentOverride is given', async () => {
    mockListAgents.mockResolvedValue([agentInfo('codex', { supportsModelOverride: true, models: ['gpt-5'], effortLevels: [] })]);
    const rejection = await validateSpawnOverrides({
      ...BASE,
      laneAgentOverride: 'codex',
      projectDefaultAgent: 'claude',
      modelOverride: 'claude-opus-4-8',
    });
    expect(rejection).toContain('the destination column');
  });

  it('falls to the project default when neither is set', async () => {
    mockListAgents.mockResolvedValue([agentInfo('codex', { supportsModelOverride: true, models: ['gpt-5'], effortLevels: [] })]);
    const rejection = await validateSpawnOverrides({
      ...BASE,
      projectDefaultAgent: 'codex',
      modelOverride: 'claude-opus-4-8',
    });
    expect(rejection).toContain('the project default');
  });

  it('falls to the app default last', async () => {
    const rejection = await validateSpawnOverrides({ ...BASE, effortOverride: 'xtreme' });
    expect(rejection).toContain('agent "claude"');
    expect(rejection).toContain('the app default');
  });
});

// ---------------------------------------------------------------------------
// Cannot-verify paths. Every one of these must ACCEPT: refusing a value we were
// unable to check would block legitimate work for an infrastructure reason.
// ---------------------------------------------------------------------------

describe('validateSpawnOverrides - accepts whatever it cannot verify', () => {
  it('accepts when the resolved agent is absent from the detection list', async () => {
    mockListAgents.mockResolvedValue([agentInfo('codex', CLAUDE_CAPABILITIES)]);
    expect(await validateSpawnOverrides({ ...BASE, effortOverride: 'xtreme' })).toBeNull();
  });

  it('accepts when the agent reports no capabilities at all (CLI not installed)', async () => {
    mockListAgents.mockResolvedValue([agentInfo('claude', undefined)]);
    expect(await validateSpawnOverrides({ ...BASE, effortOverride: 'xtreme' })).toBeNull();
  });

  it('accepts when the capability probe throws', async () => {
    mockListAgents.mockRejectedValue(new Error('probe blew up'));
    expect(await validateSpawnOverrides({ ...BASE, effortOverride: 'xtreme' })).toBeNull();
  });

  it('accepts when the capability probe outruns its timeout', async () => {
    vi.useFakeTimers();
    try {
      mockListAgents.mockReturnValue(new Promise(() => { /* never settles */ }));
      const pending = validateSpawnOverrides({ ...BASE, effortOverride: 'xtreme' });
      await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MS + 1);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Probe options
// ---------------------------------------------------------------------------

describe('validateSpawnOverrides - probe options', () => {
  it('never forces a refresh, so a create cannot trigger a full re-probe', async () => {
    await validateSpawnOverrides({ ...BASE, effortOverride: 'high', cliPathOverrides: { claude: '/usr/bin/claude' } });
    expect(mockListAgents).toHaveBeenCalledWith({ claude: '/usr/bin/claude' }, false);
  });
});
