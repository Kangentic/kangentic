/**
 * Pins ClaudeAdapter.discoverCapabilities' own model-display-names wiring
 * (claude-adapter.ts, discoverCapabilities method). That wiring is a SEPARATE
 * copy from the standalone discoverClaudeCapabilities function in
 * capability-discovery.ts (covered by claude-capability-discovery.test.ts) -
 * nothing previously called the adapter method directly and asserted on
 * modelDisplayNames, so dropping `buildModelDisplayNames(models)` from the
 * adapter would not fail any test in CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';

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

/**
 * Pins `ClaudeAdapter.runtime.permissionPrompts` (task #640). Nothing else in
 * the suite ever references `permissionPrompts` - it could be misspelled or
 * point at the wrong function and no test would fail. Rather than a module
 * spy (which would only prove "some function was called", not "the RIGHT
 * transcript-scanning logic actually ran"), this drives the field against a
 * real-shape transcript file on disk, so a swap for a stub or a no-op would
 * fail this test's assertions rather than just its mock-call count.
 */
describe('ClaudeAdapter.runtime.permissionPrompts (task #640)', () => {
  const cwd = 'C:\\Users\\dev\\repo';
  const agentSessionId = '790dfef5-8325-48fd-bd0f-bd6789a48871';
  const toolId = 'toolu_01AnwL9uExampleToolId';

  let tempHome: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-adapter-permission-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    const dir = path.join(tempHome, '.claude', 'projects', claudeProjectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    transcriptPath = path.join(dir, `${agentSessionId}.jsonl`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('is defined on the runtime strategy and delegates to the real transcript scanner', () => {
    const timestamp = '2026-09-12T00:25:19.438Z';
    const rejectionLine = JSON.stringify({
      type: 'user',
      uuid: '11e75685-8e19-4522-9a07-af0ebe89727e',
      timestamp,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            is_error: true,
            content:
              "The user doesn't want to proceed with this tool use. The tool use was rejected " +
              '(eg. if it was a file edit, the new_string was NOT written to the file). ' +
              'STOP what you are doing and wait for the user to tell you how to proceed.',
          },
        ],
      },
    });
    fs.writeFileSync(transcriptPath, `${rejectionLine}\n`);

    const adapter = new ClaudeAdapter();
    expect(adapter.runtime.permissionPrompts).toBeDefined();

    const result = adapter.runtime.permissionPrompts!.reportRejectedPromptTools({
      cwd,
      agentSessionId,
      toolIds: [toolId],
      sinceMs: 0,
    });

    expect(result).toEqual([toolId]);
  });

  it('returns [] when the transcript records no rejection for the tracked id', () => {
    fs.writeFileSync(transcriptPath, '');

    const adapter = new ClaudeAdapter();
    const result = adapter.runtime.permissionPrompts!.reportRejectedPromptTools({
      cwd,
      agentSessionId,
      toolIds: [toolId],
      sinceMs: 0,
    });

    expect(result).toEqual([]);
  });
});
