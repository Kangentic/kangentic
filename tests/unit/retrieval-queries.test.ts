import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Embedder } from '../../src/main/retrieval/types';

/**
 * Main's side of the worker's searches: the query is embedded here, the
 * vectors go with the call, the adoption signal is sent only for a search that
 * embedded, and an absent worker answers with nothing rather than an error.
 */

const { mockCall, mockTrackFeatureUsed } = vi.hoisted(() => ({
  mockCall: vi.fn(),
  mockTrackFeatureUsed: vi.fn(),
}));

vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class RetrievalUnavailableError extends Error {},
  retrievalClient: { call: mockCall },
}));
vi.mock('../../src/main/analytics/usage', () => ({ trackFeatureUsed: mockTrackFeatureUsed }));

import { rankRelatedWork, searchConversations } from '../../src/main/retrieval/retrieval-queries';
import { RetrievalUnavailableError } from '../../src/main/retrieval/retrieval-client';

function embedderAnswering(answer: 'vectors' | 'timeout'): Embedder {
  return {
    dimensions: 2,
    modelTag: 'fake@2',
    noiseFloor: 0.5,
    embed: vi.fn(async (texts: string[]) => (answer === 'vectors' ? texts.map(() => new Float32Array([1, 0])) : null)),
  };
}

const PROJECT = { id: 'project-1', name: 'Kangentic' };

describe('retrieval queries on main', () => {
  beforeEach(() => {
    mockCall.mockReset();
    mockTrackFeatureUsed.mockReset();
  });

  it('embeds the trimmed query, sends its vector, and counts a use of semantic memory', async () => {
    mockCall.mockResolvedValue([]);
    await searchConversations({ query: '  pty resize  ', projects: [PROJECT], embedder: embedderAnswering('vectors'), k: 5 });
    expect(mockCall).toHaveBeenCalledWith('search.conversations', expect.objectContaining({
      query: 'pty resize',
      projects: [PROJECT],
      k: 5,
      queryVectors: expect.objectContaining({ modelTag: 'fake@2', vectors: [['pty resize', new Float32Array([1, 0])]] }),
    }));
    expect(mockTrackFeatureUsed).toHaveBeenCalledWith('semantic_memory');
  });

  it('counts no use when the search ran on keywords: no embedder, or an embed that timed out', async () => {
    mockCall.mockResolvedValue([]);
    await searchConversations({ query: 'pty', projects: [PROJECT], embedder: null });
    await searchConversations({ query: 'pty', projects: [PROJECT], embedder: embedderAnswering('timeout') });
    expect(mockCall.mock.calls[0][1]).toMatchObject({ queryVectors: null });
    expect(mockCall.mock.calls[1][1]).toMatchObject({ queryVectors: { vectors: [] } });
    expect(mockTrackFeatureUsed).not.toHaveBeenCalled();
  });

  it('answers a conversation search with nothing while the worker is down', async () => {
    mockCall.mockRejectedValue(new RetrievalUnavailableError('restarting'));
    await expect(searchConversations({ query: 'pty', projects: [PROJECT], embedder: null })).resolves.toEqual([]);
  });

  it('sends a ranking its vectors in the order given, and is null only while the worker is down', async () => {
    mockCall.mockResolvedValue({ related: { handed: [] } });
    await rankRelatedWork({
      projectId: 'project-1',
      question: 'How many adapters did we add?',
      embedder: embedderAnswering('vectors'),
      vectorTexts: ['How many adapters did we add?', 'adapters add'],
      withExtras: true,
    });
    const params = mockCall.mock.calls[0][1] as { queryVectors: { vectors: Array<[string, Float32Array]> } };
    expect(params.queryVectors.vectors.map(([text]) => text)).toEqual(['How many adapters did we add?', 'adapters add']);

    mockCall.mockRejectedValueOnce(new RetrievalUnavailableError('restarting'));
    await expect(rankRelatedWork({ projectId: 'project-1', question: 'q', embedder: null, vectorTexts: [], withExtras: false })).resolves.toBeNull();

    // A failure inside the worker is a real one, and the caller sees it.
    mockCall.mockRejectedValueOnce(new Error('no such table: memory_chunks'));
    await expect(rankRelatedWork({ projectId: 'project-1', question: 'q', embedder: null, vectorTexts: [], withExtras: false }))
      .rejects.toThrow('no such table');
  });
});
