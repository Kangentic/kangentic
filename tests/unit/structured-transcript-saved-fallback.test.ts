/**
 * `renderStructuredTranscript` (`kangentic_get_transcript`'s structured format)
 * answers from what Kangentic kept of a conversation once the agent deleted its
 * own file. When the live parse is empty and a reader is given, it renders the
 * reader's entries under a header that names where they came from: the archive
 * keeps the structure, the index keeps the text only. A reader that finds
 * nothing keeps the "not found" answer, and a live parse that has entries never
 * asks the reader at all.
 *
 * The registry is mocked so the adapter's `parseTranscript` is the test's to
 * control; everything else (filter, render, header) is the real code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { TranscriptEntry } from '../../src/shared/types';

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: vi.fn() },
}));

import { agentRegistry } from '../../src/main/agent/agent-registry';
import {
  renderStructuredTranscript,
  type SavedConversationReader,
  type StructuredTranscriptRequest,
} from '../../src/main/agent/commands/structured-transcript';

const ARCHIVE_HEADER = 'Source: Kangentic\'s saved copy (the agent deleted its own file)';
const INDEX_HEADER = 'Source: indexed text only (the agent deleted its own file; tool calls are flattened)';
const NOT_FOUND = 'No structured transcript found';

const savedEntries: TranscriptEntry[] = [
  { kind: 'user', uuid: 'saved-user', ts: 1, text: 'what did we decide about the retry budget' },
  { kind: 'assistant', uuid: 'saved-assistant', ts: 2, blocks: [{ type: 'text', text: 'we capped the retry budget at three attempts' }] },
];

function request(overrides: Partial<StructuredTranscriptRequest> = {}): StructuredTranscriptRequest {
  return {
    record: { id: 'session-12345678', sessionType: 'claude_agent', agentSessionId: 'agent-session-1', cwd: '/work/project' },
    view: 'full',
    tail: undefined,
    charBudget: 40_000,
    search: undefined,
    aroundUuid: undefined,
    contextTurns: 3,
    ...overrides,
  };
}

/** An adapter whose live parse answers `entries` (none: the agent's file is gone). */
function useAdapter(entries: TranscriptEntry[], sourcePath: string | null = null): void {
  vi.mocked(agentRegistry.getBySessionType).mockReturnValue({
    displayName: 'Claude Code',
    parseTranscript: vi.fn(async () => ({ entries, sourcePath })),
  } as unknown as AgentAdapter);
}

beforeEach(() => {
  vi.mocked(agentRegistry.getBySessionType).mockReset();
});

describe('renderStructuredTranscript saved-conversation fallback', () => {
  it('renders the archive\'s entries under a header naming Kangentic\'s saved copy', async () => {
    useAdapter([]);
    const reader = vi.fn<SavedConversationReader>(async () => ({ entries: savedEntries, source: 'archive' }));

    const response = await renderStructuredTranscript(request(), reader);

    expect(reader).toHaveBeenCalledExactlyOnceWith('agent-session-1');
    expect(response.success).toBe(true);
    expect(response.message).toContain(ARCHIVE_HEADER);
    expect(response.message).not.toContain(INDEX_HEADER);
    expect(response.message).not.toContain(NOT_FOUND);
    expect(response.message).toContain('what did we decide about the retry budget');
    expect(response.message).toContain('we capped the retry budget at three attempts');
    expect(response.message).toContain('Entries: 2/2');
    expect(response.data).toMatchObject({ format: 'structured', entryCount: 2, renderedEntryCount: 2 });
  });

  it('renders the index\'s entries under a header that says only indexed text was kept', async () => {
    useAdapter([]);
    const reader: SavedConversationReader = async () => ({ entries: savedEntries, source: 'index' });

    const response = await renderStructuredTranscript(request(), reader);

    expect(response.success).toBe(true);
    expect(response.message).toContain(INDEX_HEADER);
    expect(response.message).not.toContain(ARCHIVE_HEADER);
    expect(response.message).toContain('we capped the retry budget at three attempts');
    expect(response.data).toMatchObject({ entryCount: 2 });
  });

  it('keeps the "not found" answer when the reader finds nothing', async () => {
    useAdapter([]);
    const reader = vi.fn<SavedConversationReader>(async () => null);

    const response = await renderStructuredTranscript(request(), reader);

    // The reader was asked, so the null branch is the one under test.
    expect(reader).toHaveBeenCalledTimes(1);
    expect(response.success).toBe(true);
    expect(response.message).toContain(NOT_FOUND);
    expect(response.message).not.toContain('Source:');
    expect(response.data).toBeUndefined();
  });

  it('keeps the "not found" answer, with the file path, when no reader is given', async () => {
    useAdapter([], '/history/agent-session-1.jsonl');

    const response = await renderStructuredTranscript(request());

    expect(response.message).toContain(`${NOT_FOUND} at /history/agent-session-1.jsonl`);
    expect(response.message).not.toContain('Source:');
  });

  it('never asks the reader when the live parse has entries, and names no saved source', async () => {
    useAdapter([{ kind: 'user', uuid: 'live-user', ts: 1, text: 'a live question' }], '/history/agent-session-1.jsonl');
    const reader = vi.fn<SavedConversationReader>(async () => ({ entries: savedEntries, source: 'archive' }));

    const response = await renderStructuredTranscript(request(), reader);

    expect(reader).not.toHaveBeenCalled();
    expect(response.message).toContain('a live question');
    expect(response.message).not.toContain('Source:');
    expect(response.message).not.toContain('what did we decide about the retry budget');
  });

  it('shapes the saved entries like live ones: view and search apply to them', async () => {
    useAdapter([]);
    const reader: SavedConversationReader = async () => ({ entries: savedEntries, source: 'archive' });

    const responses = await renderStructuredTranscript(request({ view: 'responses' }), reader);
    expect(responses.message).toContain(ARCHIVE_HEADER);
    expect(responses.message).toContain('we capped the retry budget at three attempts');
    expect(responses.message).not.toContain('what did we decide about the retry budget');

    const searched = await renderStructuredTranscript(request({ search: 'zzz-no-such-term' }), reader);
    expect(searched.message).toBe('No entries match "zzz-no-such-term" in this session.');
  });
});
