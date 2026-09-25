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

/**
 * Pins that `ClaudeAdapter.parseTranscriptWindow` FORWARDS the caller's
 * usage-attribution carry to the parser.
 *
 * The seam dedupe is tested against `parseClaudeTranscriptWindow` directly in
 * claude-transcript-parser-incremental.test.ts, and the indexer's threading is
 * tested in conversation-indexer-decisions.test.ts - but the adapter sits
 * between them, and it is one dropped argument away from breaking the chain
 * with both of those still green. Silently, too: the indexer would keep passing
 * a Set that never reaches the parser, and the ledger would go back to counting
 * a seam-straddling message twice.
 *
 * Driven against a real transcript rather than a spy, so a swap for a stub
 * fails on the attribution rather than on a call count.
 */
describe('ClaudeAdapter.parseTranscriptWindow carry forwarding', () => {
  const cwd = 'C:\\Users\\dev\\repo';
  const agentSessionId = 'c0ffee11-2233-4455-6677-8899aabbccdd';
  const usage = {
    input_tokens: 4,
    output_tokens: 1249,
    cache_creation_input_tokens: 11882,
    cache_read_input_tokens: 136206,
  };

  let tempHome: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-adapter-window-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    const dir = path.join(tempHome, '.claude', 'projects', claudeProjectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    transcriptPath = path.join(dir, `${agentSessionId}.jsonl`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** One API message written as Claude writes it when it spans several lines:
   *  a thinking line, then a tool_use line, each repeating the whole usage. */
  function writeStraddlingTranscript(): number {
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u0',
        timestamp: '2026-06-01T01:00:00.000Z',
        message: { role: 'user', content: `edit it ${'x'.repeat(2000)}` },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-thinking',
        timestamp: '2026-06-01T01:18:09.516Z',
        message: {
          id: 'msg_seam',
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'thinking', thinking: 'weighing the edit', signature: 'sig' }],
          usage,
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-tool-use',
        timestamp: '2026-06-01T01:20:28.780Z',
        message: {
          id: 'msg_seam',
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 'a.ts' } }],
          usage,
        },
      }),
    ].map((record) => `${record}\n`);
    fs.writeFileSync(transcriptPath, lines.join(''));
    // Cut the first window a few bytes into the tool_use line so it trims back
    // to the thinking line, putting the seam inside the message.
    return Buffer.byteLength(lines[0] + lines[1]) + 5;
  }

  it('attributes a seam-straddling message once when the caller threads one carry', async () => {
    const seamBudget = writeStraddlingTranscript();
    const adapter = new ClaudeAdapter();
    const carry = new Set<string>();

    const first = await adapter.parseTranscriptWindow(agentSessionId, cwd, 0, seamBudget, carry);
    const second = await adapter.parseTranscriptWindow(
      agentSessionId, cwd, first.nextByteOffset, 100_000, carry,
    );

    // The seam really is between the message's two lines.
    expect(first.entries.map((entry) => entry.uuid)).toEqual(['u0', 'a-thinking']);
    expect(second.entries.map((entry) => entry.uuid)).toEqual(['a-tool-use']);

    const attributed = [...first.entries, ...second.entries].filter(
      (entry) => 'usage' in entry && entry.usage,
    );
    expect(attributed).toHaveLength(1);
    expect(attributed[0].uuid).toBe('a-thinking');
  });

  it('still attributes per window when the caller threads no carry', async () => {
    // The pre-fix behavior, kept as the control: it is what proves the case
    // above is exercising the carry rather than a fixture that stopped
    // straddling. A one-shot caller is entitled to this.
    const seamBudget = writeStraddlingTranscript();
    const adapter = new ClaudeAdapter();

    const first = await adapter.parseTranscriptWindow(agentSessionId, cwd, 0, seamBudget);
    const second = await adapter.parseTranscriptWindow(
      agentSessionId, cwd, first.nextByteOffset, 100_000,
    );

    const attributed = [...first.entries, ...second.entries].filter(
      (entry) => 'usage' in entry && entry.usage,
    );
    expect(attributed).toHaveLength(2);
  });
});
