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
// be the adapter's own capabilities together, through the real build: Kangentic's
// MCP server per session, and a conversation it can resume. Read-only launch is
// not part of it.
describe('listAgents - supportsWorkflowAgent and kangenticMcp', () => {
  it('flags an agent that reaches the MCP server per session and can resume, and no other', async () => {
    const adaptersByName: Record<string, object> = {
      'chosen-id': { ...buildFakeAdapter(), kangenticMcp: 'per-session', supportsCallerSessionId: true },
      'captured-id': { ...buildFakeAdapter(), kangenticMcp: 'per-session', supportsCallerSessionId: false, capturesInteractiveSessionId: true },
      'not-read-only': { ...buildFakeAdapter(), kangenticMcp: 'per-session', supportsCallerSessionId: true, supportsReadOnlyLaunch: false },
      'no-session-id': { ...buildFakeAdapter(), kangenticMcp: 'per-session', supportsCallerSessionId: false },
      'shared-folder': { ...buildFakeAdapter(), kangenticMcp: 'shared-folder', supportsCallerSessionId: true },
      'no-mcp': { ...buildFakeAdapter(), supportsCallerSessionId: true, supportsReadOnlyLaunch: true },
    };
    mockRegistryList.mockReturnValue(Object.keys(adaptersByName));
    mockGetOrThrow.mockImplementation((name: string) => adaptersByName[name]);

    const agents = await listAgents({});

    const flagByName = Object.fromEntries(agents.map((entry) => [entry.name, entry.supportsWorkflowAgent]));
    expect(flagByName).toEqual({
      'chosen-id': true,
      'captured-id': true,
      'not-read-only': true,
      'no-session-id': false,
      'shared-folder': false,
      'no-mcp': false,
    });
    // The MCP delivery rides the entry as the adapter declares it.
    const mcpByName = Object.fromEntries(agents.map((entry) => [entry.name, entry.kangenticMcp]));
    expect(mcpByName['shared-folder']).toBe('shared-folder');
    expect(mcpByName['no-mcp']).toBeUndefined();
  });
});

// A plan column's Plan approval offers Automatic only for an agent the entry
// flags. The flag is the adapter's own declaration as a strict boolean, so an
// adapter that does not declare it reads false rather than a missing key.
describe('listAgents - supportsPlanAutoApproval', () => {
  it('carries true for an adapter that declares it and false, not undefined, for one that does not', async () => {
    const adaptersByName: Record<string, object> = {
      'declares-it': { ...buildFakeAdapter(), supportsPlanAutoApproval: true },
      'declares-false': { ...buildFakeAdapter(), supportsPlanAutoApproval: false },
      'silent': buildFakeAdapter(),
    };
    mockRegistryList.mockReturnValue(Object.keys(adaptersByName));
    mockGetOrThrow.mockImplementation((name: string) => adaptersByName[name]);

    const agents = await listAgents({});

    const flagByName = Object.fromEntries(agents.map((entry) => [entry.name, entry.supportsPlanAutoApproval]));
    expect(flagByName['declares-it']).toBe(true);
    expect(flagByName['declares-false']).toBe(false);
    // `toBe(false)` rejects undefined: the stamp is `=== true`, not a pass-through.
    expect(flagByName['silent']).toBe(false);
  });
});
