/**
 * Unit coverage for `buildAgentList` copying an adapter's pasted-image
 * capability fields (`pastedImageNativeExtensions`, `pastedImageReferenceTemplate`)
 * into the `AgentDetectionInfo` entry `listAgents()` returns.
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
  });
});
