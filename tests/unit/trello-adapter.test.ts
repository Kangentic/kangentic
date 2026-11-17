/**
 * The Trello adapter's fetch and connection check, over a stubbed client, plus the board URL
 * parser a saved source goes through.
 *
 * The Import dialog trusts fetch for the Open, Closed and All split, its totals and its paging, and
 * the error banner trusts checkPrerequisites for "not connected" and Trello's refusal text. A
 * miss shows archived cards as Open or a dead token as a working one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A passthrough spy, so a test can count how often the adapter maps a snapshot.
vi.mock('../../src/main/boards/adapters/trello/mapper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/boards/adapters/trello/mapper')>();
  return { ...actual, mapTrelloCards: vi.fn(actual.mapTrelloCards) };
});

import { ImportSourceStore } from '../../src/main/boards/shared/source-store';
import { TrelloAdapter } from '../../src/main/boards/adapters/trello/adapter';
import { TrelloClient, TrelloError, type TrelloBoardSnapshot } from '../../src/main/boards/adapters/trello/client';
import { parseTrelloUrl } from '../../src/main/boards/adapters/trello/url-parser';
import { mapTrelloCards, type TrelloCardRaw, type TrelloListRaw } from '../../src/main/boards/adapters/trello/mapper';
import type { ImportFetchInput } from '../../src/shared/types';

const fixturePath = path.join(__dirname, '..', 'fixtures', 'trello-board.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { lists: TrelloListRaw[]; cards: TrelloCardRaw[] };

class FakeTrelloClient extends TrelloClient {
  connected = true;
  listBoardsError: Error | null = null;
  boardNameResult: string | Error | null = null;
  readonly loads: Array<{ boardRef: string; refresh: boolean }> = [];

  constructor(public snapshot: TrelloBoardSnapshot) {
    super(null);
  }

  override async getBoardName(): Promise<string | null> {
    if (this.boardNameResult instanceof Error) throw this.boardNameResult;
    return this.boardNameResult;
  }

  override async hasCredential(): Promise<boolean> {
    return this.connected;
  }

  override async listBoards(): Promise<[]> {
    if (this.listBoardsError) throw this.listBoardsError;
    return [];
  }

  override async loadBoard(boardRef: string, refresh: boolean): Promise<TrelloBoardSnapshot> {
    this.loads.push({ boardRef, refresh });
    return this.snapshot;
  }
}

function fetchInput(overrides: Partial<ImportFetchInput> = {}): ImportFetchInput {
  return { source: 'trello', repository: 'AbC123xy', page: 1, perPage: 50, state: 'all', ...overrides };
}

const noneImported = () => new Set<string>();

describe('TrelloAdapter.fetch', () => {
  it('splits Open and Closed by archived card or archived list', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const open = await adapter.fetch(fetchInput({ state: 'open' }), noneImported);
    const closed = await adapter.fetch(fetchInput({ state: 'closed' }), noneImported);
    const all = await adapter.fetch(fetchInput({ state: 'all' }), noneImported);

    expect(open.issues.map((issue) => issue.title)).toEqual([
      'Card with a pasted screenshot',
      'Invite emails land in spam for Outlook users',
      'Shipped on a Done list',
    ]);
    expect(closed.issues.map((issue) => issue.title).sort()).toEqual([
      'Archived card on an open list',
      'Card on an archived list',
    ]);
    expect(all.totalCount).toBe(5);
  });

  it('pages the matching cards and reloads the board only on page 1', async () => {
    const client = new FakeTrelloClient(fixture);
    const adapter = new TrelloAdapter(client);
    const first = await adapter.fetch(fetchInput({ perPage: 2 }), noneImported);
    const second = await adapter.fetch(fetchInput({ perPage: 2, page: 2 }), noneImported);
    const third = await adapter.fetch(fetchInput({ perPage: 2, page: 3 }), noneImported);

    expect([first.hasNextPage, second.hasNextPage, third.hasNextPage]).toEqual([true, true, false]);
    expect([...first.issues, ...second.issues, ...third.issues]).toHaveLength(5);
    expect(client.loads.map((load) => load.refresh)).toEqual([true, false, false]);
  });

  it('searches the title, card number, list and labels', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const byNumber = await adapter.fetch(fetchInput({ searchQuery: '#138' }), noneImported);
    const byColorLabel = await adapter.fetch(fetchInput({ searchQuery: 'green' }), noneImported);

    expect(byNumber.issues.map((issue) => issue.title)).toEqual(['Invite emails land in spam for Outlook users']);
    expect(byColorLabel.issues.map((issue) => issue.title)).toEqual(['Invite emails land in spam for Outlook users']);
  });

  it('marks cards already imported', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const result = await adapter.fetch(fetchInput(), () => new Set(['6731f2a00000000000000104']));
    expect(result.issues.filter((issue) => issue.alreadyImported).map((issue) => issue.title)).toEqual(['Shipped on a Done list']);
  });
});

describe('TrelloAdapter.fetch - defaults and edges', () => {
  it('returns every card on one page when perPage is 0', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const result = await adapter.fetch(fetchInput({ perPage: 0 }), noneImported);
    expect(result.issues).toHaveLength(5);
    expect(result.hasNextPage).toBe(false);
  });

  it('treats a missing state as all', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const { state: omittedState, ...inputWithoutState } = fetchInput();
    expect(omittedState).toBe('all');
    const result = await adapter.fetch(inputWithoutState, noneImported);
    expect(result.totalCount).toBe(5);
  });

  it('treats page 0 as page 1 and refreshes the board', async () => {
    const client = new FakeTrelloClient(fixture);
    const adapter = new TrelloAdapter(client);
    const pageOne = await adapter.fetch(fetchInput({ perPage: 2, page: 1 }), noneImported);
    const pageZero = await adapter.fetch(fetchInput({ perPage: 2, page: 0 }), noneImported);
    expect(pageZero.issues.map((issue) => issue.externalId)).toEqual(pageOne.issues.map((issue) => issue.externalId));
    expect(client.loads[1].refresh).toBe(true);
  });

  it('searches the list name and the assignee username', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const byList = await adapter.fetch(fetchInput({ searchQuery: 'Backlog' }), noneImported);
    const byAssignee = await adapter.fetch(fetchInput({ searchQuery: 'sam' }), noneImported);
    expect(byList.issues.map((issue) => issue.title)).toEqual(['Card with a pasted screenshot']);
    expect(byAssignee.issues.map((issue) => issue.title)).toEqual(['Invite emails land in spam for Outlook users']);
  });

  it('looks up already-imported ids only for the cards on the returned page', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const findAlreadyImported = vi.fn((_source: string, _ids: string[]) => new Set<string>());
    const result = await adapter.fetch(fetchInput({ perPage: 2 }), findAlreadyImported);
    const pageIds = result.issues.map((issue) => issue.externalId);
    expect(pageIds).toHaveLength(2);
    expect(findAlreadyImported).toHaveBeenCalledTimes(1);
    expect(findAlreadyImported).toHaveBeenCalledWith('trello', pageIds);
  });

  it('does not report an id outside the page as imported on that page', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const allIds = (await adapter.fetch(fetchInput(), noneImported)).issues.map((issue) => issue.externalId);
    const pageOne = await adapter.fetch(fetchInput({ perPage: 2 }), noneImported);
    const outsideId = allIds.find((id) => !pageOne.issues.some((issue) => issue.externalId === id))!;
    const result = await adapter.fetch(fetchInput({ perPage: 2 }), () => new Set([outsideId]));
    expect(result.issues.some((issue) => issue.alreadyImported)).toBe(false);
  });

  it('re-maps a fresh snapshot instead of serving a stale cache', async () => {
    const client = new FakeTrelloClient(fixture);
    const adapter = new TrelloAdapter(client);
    const before = await adapter.fetch(fetchInput(), noneImported);
    client.snapshot = {
      ...fixture,
      cards: fixture.cards.map((card) => (card.id === '6731f2a00000000000000104' ? { ...card, name: 'Renamed card' } : card)),
    };
    const after = await adapter.fetch(fetchInput(), noneImported);
    expect(before.issues.map((issue) => issue.title)).toContain('Shipped on a Done list');
    expect(after.issues.map((issue) => issue.title)).toContain('Renamed card');
    expect(after.issues.map((issue) => issue.title)).not.toContain('Shipped on a Done list');
  });
});

describe('TrelloAdapter.fetch - order, search and mapping reuse', () => {
  it('orders by list position, then most recent activity first, falling back to the creation time', async () => {
    const snapshot: TrelloBoardSnapshot = {
      lists: [
        { id: 'list-right', name: 'Right', pos: 2 },
        { id: 'list-left', name: 'Left', pos: 1 },
      ],
      cards: [
        { id: '6731f2a00000000000000401', name: 'Right older', idList: 'list-right', dateLastActivity: '2026-11-10T00:00:00.000Z' },
        { id: '6731f2a00000000000000402', name: 'Right newer', idList: 'list-right', dateLastActivity: '2026-11-15T00:00:00.000Z' },
        { id: '6731f2a00000000000000403', name: 'Left only', idList: 'list-left', dateLastActivity: '2026-01-01T00:00:00.000Z' },
        // No activity date: updatedAt is the creation time in the id (2024), older than both above.
        { id: '6731f2a00000000000000404', name: 'Right no activity', idList: 'list-right' },
      ],
    };
    const result = await new TrelloAdapter(new FakeTrelloClient(snapshot)).fetch(fetchInput({ state: 'all' }), noneImported);
    expect(result.issues.map((issue) => issue.title)).toEqual([
      'Left only',
      'Right newer',
      'Right older',
      'Right no activity',
    ]);
  });

  it('searches case-insensitively with the query trimmed', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const result = await adapter.fetch(fetchInput({ searchQuery: '  OUTLOOK ' }), noneImported);
    expect(result.issues.map((issue) => issue.title)).toEqual(['Invite emails land in spam for Outlook users']);
  });

  it('returns nothing for a query that matches no card', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const result = await adapter.fetch(fetchInput({ searchQuery: 'zzz-no-such-card' }), noneImported);
    expect(result.issues).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.hasNextPage).toBe(false);
  });

  it('treats an all-whitespace query as no query', async () => {
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    const result = await adapter.fetch(fetchInput({ searchQuery: '   ' }), noneImported);
    expect(result.issues).toHaveLength(5);
  });

  it('maps a snapshot once and reuses it across pages', async () => {
    vi.mocked(mapTrelloCards).mockClear();
    const adapter = new TrelloAdapter(new FakeTrelloClient(fixture));
    await adapter.fetch(fetchInput({ perPage: 2 }), noneImported);
    await adapter.fetch(fetchInput({ perPage: 2, page: 2 }), noneImported);
    expect(mapTrelloCards).toHaveBeenCalledTimes(1);
  });
});

describe('TrelloAdapter.resolveLabel', () => {
  it('resolves to null when the board name lookup throws', async () => {
    const client = new FakeTrelloClient(fixture);
    client.boardNameResult = new Error('boom');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await new TrelloAdapter(client).resolveLabel('AbC123xy')).toBeNull();
    warn.mockRestore();
  });

  it('resolves to the board name', async () => {
    const client = new FakeTrelloClient(fixture);
    client.boardNameResult = 'Sprint board';
    expect(await new TrelloAdapter(client).resolveLabel('AbC123xy')).toBe('Sprint board');
  });
});

describe('Trello source URL parser registration', () => {
  let projectDir = '';

  afterEach(() => {
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = '';
  });

  it('registers a trello parser that a saved source goes through', () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-source-'));
    const saved = new ImportSourceStore(projectDir).add('trello', 'https://trello.com/b/AbC123xy/sprint-board');
    expect(saved.repository).toBe('AbC123xy');
    expect(saved.label).toBe('Trello board AbC123xy');
  });
});

describe('TrelloAdapter.checkPrerequisites', () => {
  it('reports not connected when no token is stored', async () => {
    const client = new FakeTrelloClient(fixture);
    client.connected = false;
    const result = await new TrelloAdapter(client).checkPrerequisites();
    expect(result.authOk).toBe(false);
    expect(result.message).toContain('Connect Trello');
  });

  it('passes Trello\'s refusal text through when the stored token stops working', async () => {
    const client = new FakeTrelloClient(fixture);
    client.listBoardsError = new TrelloError('invalid token', 401, 'token');
    const result = await new TrelloAdapter(client).checkPrerequisites();
    expect(result).toEqual({ cliOk: true, authOk: false, message: 'invalid token' });
  });

  it('reports connected when Trello accepts the token', async () => {
    const result = await new TrelloAdapter(new FakeTrelloClient(fixture)).checkPrerequisites();
    expect(result).toEqual({ cliOk: true, authOk: true });
  });
});

describe('parseTrelloUrl', () => {
  it.each([
    ['https://trello.com/b/AbC123xy', 'AbC123xy'],
    ['https://trello.com/b/AbC123xy/sprint-board', 'AbC123xy'],
    ['https://trello.com/b/AbC123xy/sprint-board?filter=member:dana', 'AbC123xy'],
    ['https://www.trello.com/b/AbC123xy/', 'AbC123xy'],
  ])('reads the board short link from %s', (url, shortLink) => {
    expect(parseTrelloUrl(url)).toEqual({ repository: shortLink });
  });

  it.each([
    '  https://trello.com/b/AbC123xy/sprint-board\n',
    'http://trello.com/b/AbC123xy',
    'https://trello.com/b/AbC123xy#comments',
  ])('reads the short link from %j', (url) => {
    expect(parseTrelloUrl(url)).toEqual({ repository: 'AbC123xy' });
  });

  it.each([
    'https://trello.com/c/Xk92LmQa/138-invite-emails',
    'https://trello.com/w/acme-product',
    'https://example.com/b/AbC123xy',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => parseTrelloUrl(url)).toThrow('Invalid Trello board URL');
  });
});
