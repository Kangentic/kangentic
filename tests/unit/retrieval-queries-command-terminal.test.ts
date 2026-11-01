/**
 * `searchCommandTerminalConversationsIn`, main's side of the Earlier list's
 * text search: it asks the worker, and answers no hits (never throws) when the
 * worker is down or the search failed inside it, so the rail shows its name
 * matches alone.
 *
 * Tier: Unit, with the retrieval client as a spy.
 *
 * Red-green: remove the `try`/`catch` and the rejection test goes red (the
 * promise rejects); change the method name and the success test goes red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const callMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  RetrievalUnavailableError: class extends Error {},
  retrievalClient: { call: callMock },
}));

import { searchCommandTerminalConversationsIn } from '../../src/main/retrieval/retrieval-queries';

afterEach(() => {
  vi.restoreAllMocks();
  callMock.mockReset();
});

describe('searchCommandTerminalConversationsIn', () => {
  it('returns the worker\'s hits for the project and query', async () => {
    const hits = [{ agentSessionId: 'conversation-a', snippet: 'the rail fix landed', matchStart: 4, matchEnd: 8 }];
    callMock.mockResolvedValueOnce(hits);

    await expect(searchCommandTerminalConversationsIn('project-1', 'rail')).resolves.toEqual(hits);

    expect(callMock).toHaveBeenCalledWith('search.commandTerminalConversations', { projectId: 'project-1', query: 'rail' });
  });

  it('answers no hits when the client rejects, and says why in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    callMock.mockRejectedValueOnce(new Error('index worker is restarting'));

    await expect(searchCommandTerminalConversationsIn('project-1', 'rail')).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith('[retrieval] Command Terminal search unavailable:', 'index worker is restarting');
  });

  it('answers no hits for a rejection that is not an Error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    callMock.mockRejectedValueOnce('gone');

    await expect(searchCommandTerminalConversationsIn('project-1', 'rail')).resolves.toEqual([]);
  });
});
