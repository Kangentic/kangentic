/**
 * Unit coverage for `buildAgentList` copying an adapter's pasted-image
 * capability fields (`pastedImageNativeExtensions`, `pastedImageReferenceTemplate`)
 * into the `AgentDetectionInfo` entry `listAgents()` returns, and deriving its
 * `supportsWorkflowAgent` flag from the adapter's read-only and session-id
 * capabilities.
 *
 * `agent-registry` is mocked with a single fake adapter whose `detect()`
 * resolves `found: false` so nothing spawns a real CLI, and no `probeAuth` /
 * `discoverCapabilities` are declared so those branches short-circuit too.
 * The mock shape mirrors `tests/unit/mcp-spawn-override-validation.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRegistryList = vi.fn(() => ['claude']);
const mockGetOrThrow = vi.fn();

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: () => mockRegistryList(),
    getOrThrow: (name: string) => mockGetOrThrow(name),
  },
}));

import { listAgents, resetAgentListForTests } from '../../src/main/agent/agent-list';

const PASTED_IMAGE_NATIVE_EXTENSIONS = ['png', 'jpg'];
const PASTED_IMAGE_REFERENCE_TEMPLATE = 'Read this image: {path} ';

function buildFakeAdapter() {
  return {
    displayName: 'Fake Claude',
    permissions: [],
    defaultPermission: 'default',
    pastedImageNativeExtensions: PASTED_IMAGE_NATIVE_EXTENSIONS,
    pastedImageReferenceTemplate: PASTED_IMAGE_REFERENCE_TEMPLATE,
    invalidateDetectionCache: () => {},
    detect: async () => ({ found: false, path: null, version: null }),
    runtime: { reportsTurnEnd: true },
  };
}

beforeEach(() => {
  resetAgentListForTests();
  mockRegistryList.mockReturnValue(['claude']);
  mockGetOrThrow.mockReturnValue(buildFakeAdapter());
});

describe('listAgents - pasted-image capability fields', () => {
  it('carries the adapter\'s pastedImageNativeExtensions and pastedImageReferenceTemplate onto the entry', async () => {
    const agents = await listAgents({});
    expect(agents).toHaveLength(1);
    const entry = agents[0];
    expect(entry.name).toBe('claude');
    expect(entry.pastedImageNativeExtensions).toEqual(PASTED_IMAGE_NATIVE_EXTENSIONS);
    expect(entry.pastedImageReferenceTemplate).toBe(PASTED_IMAGE_REFERENCE_TEMPLATE);
    expect(entry.supportsSummarize).toBe(false);
    // The runtime's turn-end capability rides the entry, for the column dialogs.
    expect(entry.reportsTurnEnd).toBe(true);
  });
});

// Settings > Workflows offers only the agents the entry flags, so the flag has to
// be the adapter's own two capabilities together, through the real build.
describe('listAgents - supportsWorkflowAgent', () => {
  it('flags an agent that launches read-only on a session id Kangentic chose, and no other', async () => {
    const adaptersByName: Record<string, object> = {
      capable: { ...buildFakeAdapter(), supportsReadOnlyLaunch: true, supportsCallerSessionId: true },
      'no-session-id': { ...buildFakeAdapter(), supportsReadOnlyLaunch: true, supportsCallerSessionId: false },
      'not-read-only': { ...buildFakeAdapter(), supportsReadOnlyLaunch: false, supportsCallerSessionId: true },
      'read-only-undeclared': { ...buildFakeAdapter(), supportsCallerSessionId: true },
    };
    mockRegistryList.mockReturnValue(Object.keys(adaptersByName));
    mockGetOrThrow.mockImplementation((name: string) => adaptersByName[name]);

    const agents = await listAgents({});

    const flagByName = Object.fromEntries(agents.map((entry) => [entry.name, entry.supportsWorkflowAgent]));
    expect(flagByName).toEqual({
      capable: true,
      'no-session-id': false,
      'not-read-only': false,
      'read-only-undeclared': false,
    });
  });
});
