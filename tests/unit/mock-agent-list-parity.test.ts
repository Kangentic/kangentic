/**
 * Self-maintaining guard for a gap that let 'qwen' silently go missing from
 * the UI mock's `agents.list()` fixture: `agent-registry.ts` registers an
 * adapter, but `tests/ui/mock-electron-api.js` (the headless mock every UI
 * spec runs against - `docs/developer-guide.md`'s UI tier) is a hand-authored
 * fixture with no mechanical tie to the registry, so a new adapter can ship
 * with zero UI-tier coverage and nothing fails until a real launch surfaces
 * the missing agent in the dropdown.
 *
 * The name check is a static text scan (not a `require`/`import` of the mock
 * file, which attaches itself to `window` and is meant to run inside a
 * Playwright page, not a Node/vitest process) - deterministic and
 * dependency-free, per the "Keep it a static text-scan if importing is heavy"
 * guidance. The claude field check below evaluates the mock in a `node:vm`
 * sandbox instead (the recipe mock-electron-api-parity.test.ts uses), because
 * comparing VALUES to the real adapter needs the array, not its source text.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import type { AgentDetectionInfo } from '../../src/shared/types';

const MOCK_ELECTRON_API_PATH = path.resolve(__dirname, '../ui/mock-electron-api.js');

/**
 * The adapter-declared, renderer-consumed capability fields the mock's claude
 * entry mirrors by "KEEP IN SYNC" comment. Each is a plain value the adapter
 * declares (no CLI probe behind it), so the real adapter's value is the
 * expected one. The name scan above cannot see these: a field added to the
 * adapter and forgotten in the fixture leaves every UI spec exercising a
 * capability the real app does not have, or missing one it does.
 */
const MIRRORED_CLAUDE_FIELDS = [
  'reportsRateLimits',
  'pastedImageNativeExtensions',
  'pastedImageReferenceTemplate',
  'defaultPermission',
  'permissions',
] as const satisfies readonly (keyof AgentDetectionInfo)[];

/** Evaluate the mock the way a page would (same sandbox recipe as
 *  mock-electron-api-parity.test.ts) and call its agents.list(). */
async function readMockAgentList(): Promise<AgentDetectionInfo[]> {
  const source = fs.readFileSync(MOCK_ELECTRON_API_PATH, 'utf-8');
  const windowObject: Record<string, unknown> = {};
  windowObject.window = windowObject;
  const sandbox = { window: windowObject, document: undefined, crypto: webcrypto, setTimeout, clearTimeout, console };
  vm.runInNewContext(source, sandbox, { filename: MOCK_ELECTRON_API_PATH, timeout: 5000 });
  const electronApi = windowObject.electronAPI as { agents: { list: () => Promise<AgentDetectionInfo[]> } };
  return electronApi.agents.list();
}

/**
 * Extract the agent `name` literals from the `agents.list()` default fixture
 * in mock-electron-api.js.
 *
 * Bounded between the two markers below so the scan cannot accidentally pick
 * up the SINGULAR `agent.listCommands` fixture (a different mock namespace,
 * `agent:` not `agents:`) or any other unrelated `name:` field elsewhere in
 * the file. `displayName: '...'` never matches the `name: '` pattern (capital
 * `N`, no literal lowercase `name: ` substring), so it does not need its own
 * exclusion.
 */
function readMockAgentListNames(): string[] {
  const source = fs.readFileSync(MOCK_ELECTRON_API_PATH, 'utf-8');
  const startMarker = 'list: async function (_forceRefresh) {';
  const endMarker = 'return defaults.map(function (agent) {';
  const startIndex = source.indexOf(startMarker);
  const endIndex = startIndex === -1 ? -1 : source.indexOf(endMarker, startIndex);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(
      'mock-agent-list-parity: could not locate the agents.list() defaults array in '
      + 'tests/ui/mock-electron-api.js - the extraction markers moved; update '
      + 'readMockAgentListNames() in tests/unit/mock-agent-list-parity.test.ts.',
    );
  }
  const block = source.slice(startIndex, endIndex);
  const names: string[] = [];
  for (const match of block.matchAll(/\bname: '([a-zA-Z0-9_-]+)'/g)) {
    names.push(match[1]);
  }
  return names;
}

describe('mock-electron-api agents.list() fixture stays in sync with the agent registry', () => {
  it('every registered adapter has a matching entry in the mock agents.list() fixture', () => {
    const registeredAgentNames = agentRegistry.list();
    const mockAgentNames = readMockAgentListNames();

    const missingFromMock = registeredAgentNames.filter((name) => !mockAgentNames.includes(name));

    expect(
      missingFromMock,
      `Adapter(s) ${JSON.stringify(missingFromMock)} are registered in `
      + 'src/main/agent/agent-registry.ts but have no entry in the agents.list() defaults array '
      + "in tests/ui/mock-electron-api.js. This is the gap that let 'qwen' silently disappear "
      + 'from every UI-tier test. Add a `{ name: \'<id>\', displayName: ... }` entry to the '
      + 'defaults array (see the KEEP IN SYNC comments alongside the existing entries) so the '
      + 'mock fixture stays a complete mirror of the registry.',
    ).toEqual([]);
  });

  it("the mock claude entry's declared capability fields match the real ClaudeAdapter", async () => {
    // The fixture used to mirror these by comment alone. This is what turns a
    // "KEEP IN SYNC" note into a failing test when an adapter field changes.
    const adapter = agentRegistry.getOrThrow('claude');
    const mockClaude = (await readMockAgentList()).find((entry) => entry.name === 'claude');
    expect(mockClaude, 'the mock agents.list() fixture has no claude entry').toBeDefined();

    const expected: Partial<AgentDetectionInfo> = {};
    const actual: Partial<AgentDetectionInfo> = {};
    for (const field of MIRRORED_CLAUDE_FIELDS) {
      expected[field] = adapter[field] as never;
      actual[field] = mockClaude?.[field] as never;
    }
    expected.supportsSummarize = typeof adapter.summarize === 'function';
    actual.supportsSummarize = mockClaude?.supportsSummarize;

    expect(
      actual,
      'tests/ui/mock-electron-api.js claude entry drifted from src/main/agent/adapters/claude/claude-adapter.ts; '
      + 'update the fixture field(s) that differ (see the KEEP IN SYNC comments beside each).',
    ).toEqual(expected);
  });

  it('sanity: the extraction itself finds a plausible number of mock agent entries', () => {
    // Guards the marker-bounded extraction against silent drift (e.g. the
    // fixture is refactored and the regex starts matching zero names), which
    // would make the subset assertion above vacuously pass no matter how far
    // the fixture drifts from the registry.
    const mockAgentNames = readMockAgentListNames();
    expect(mockAgentNames.length).toBeGreaterThanOrEqual(agentRegistry.list().length);
    expect(new Set(mockAgentNames).size).toBe(mockAgentNames.length);
  });
});
