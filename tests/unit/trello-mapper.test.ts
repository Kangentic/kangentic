/**
 * What one Trello card becomes in the backlog.
 *
 * A miss here imports the wrong thing silently: an archived card offered as Open, a color-only
 * label lost, a checklist dropped, or a credential-bearing download counted twice. The fixture is
 * written from Trello's REST reference for `/boards/{id}/lists` and `/boards/{id}/cards/all` with
 * the client's query parameters, not captured from a live board: no Trello account was connected
 * where it was written. Replace it with a sanitized capture once one is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createdAtFromId,
  labelNames,
  mapTrelloCards,
  type TrelloCardRaw,
  type TrelloListRaw,
  type TrelloMappedIssue,
} from '../../src/main/boards/adapters/trello/mapper';

const fixturePath = path.join(__dirname, '..', 'fixtures', 'trello-board.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { lists: TrelloListRaw[]; cards: TrelloCardRaw[] };

function mapFixture(alreadyImported: string[] = []): Map<string, TrelloMappedIssue> {
  const issues = mapTrelloCards(fixture.cards, fixture.lists, new Set(alreadyImported));
  return new Map(issues.map((issue) => [issue.title, issue]));
}

describe('mapTrelloCards - an archived card or a card on an archived list is closed', () => {
  const issues = mapFixture();

  it('treats an unarchived card on an open list as open', () => {
    expect(issues.get('Invite emails land in spam for Outlook users')?.stateCategory).toBe('open');
  });

  it('treats an archived card as closed', () => {
    expect(issues.get('Archived card on an open list')?.stateCategory).toBe('closed');
  });

  it('treats a card on an archived list as closed, though the card says it is not archived', () => {
    expect(issues.get('Card on an archived list')?.stateCategory).toBe('closed');
  });

  it('keeps a card on a list named Done open, due date ticked or not', () => {
    expect(issues.get('Shipped on a Done list')?.stateCategory).toBe('open');
  });
});

describe('mapTrelloCards - identity and position', () => {
  const issues = mapFixture(['6731f2a00000000000000101']);
  const card = issues.get('Invite emails land in spam for Outlook users')!;

  it('keys the import by card id and shows the card number', () => {
    expect(card.externalId).toBe('6731f2a00000000000000101');
    expect(card.displayId).toBe('#138');
    expect(card.externalUrl).toBe('https://trello.com/c/Xk92LmQa');
    expect(card.externalSource).toBe('trello');
    expect(card.alreadyImported).toBe(true);
  });

  it('uses the list name as the status and the list position on the board as its order', () => {
    expect(card.state).toBe('To Do');
    // Archived "Old ideas" (pos 500) sits first, then Backlog, then To Do.
    expect(card.stateOrder).toBe(2);
    expect(issues.get('Card with a pasted screenshot')?.stateOrder).toBe(1);
    expect(issues.get('Shipped on a Done list')?.stateOrder).toBe(4);
  });

  it('takes the first member as assignee and the creation time from the card id', () => {
    expect(card.assignee).toBe('sam');
    expect(card.createdAt).toBe(createdAtFromId('6731f2a00000000000000101'));
    expect(card.updatedAt).toBe('2026-11-16T12:00:00.000Z');
  });
});

describe('labelNames - a color-only label imports by its color', () => {
  it('imports a named label by name, a color-only label by color, and drops a bare one', () => {
    expect(labelNames([
      { id: 'a', name: 'bug', color: 'red' },
      { id: 'b', name: '', color: 'green' },
      { id: 'c', name: '', color: null },
      { id: 'd', name: 'email', color: null },
    ])).toEqual(['bug', 'green', 'email']);
  });

  it('does not repeat a name two labels share', () => {
    expect(labelNames([
      { id: 'a', name: '', color: 'green' },
      { id: 'b', name: 'green', color: 'blue' },
    ])).toEqual(['green']);
  });
});

describe('mapTrelloCards - the body: description, checklists, then the Trello section', () => {
  const issues = mapFixture();

  it('puts the description, then checklists as task lists, then the Trello section', () => {
    expect(issues.get('Invite emails land in spam for Outlook users')?.body).toBe([
      'Outlook sends our invite emails to Junk. Add SPF and DKIM records for the sending domain.',
      '',
      '### Done when',
      '',
      '- [x] SPF record added',
      '- [ ] DKIM key published',
      '',
      '## Trello',
      '',
      '- **List**: To Do',
      '- **Members**: Sam Lee, Dana Ruiz',
      '- **Start**: 2026-11-18',
      '- **Due**: 2026-11-28',
      '- **Links**: https://github.com/acme/web/pull/412',
    ].join('\n'));
  });

  it('leaves out every Trello line with no value', () => {
    expect(issues.get('Shipped on a Done list')?.body).toBe('## Trello\n\n- **List**: Done');
  });
});

describe('mapTrelloCards - attachments', () => {
  const issues = mapFixture();

  it('offers an uploaded file as a file attachment, and a saved link only as a Links line', () => {
    const card = issues.get('Invite emails land in spam for Outlook users')!;
    expect(card.fileAttachments).toEqual([{
      url: 'https://trello.com/1/cards/6731f2a00000000000000101/attachments/6730f0000000000000000001/download/headers.txt',
      filename: 'headers.txt',
      sizeBytes: 1200,
      externalRef: '6730f0000000000000000001',
    }]);
    expect(card.attachmentCount).toBe(1);
  });

  it('downloads an upload the description shows inline once, with the description', () => {
    const card = issues.get('Card with a pasted screenshot')!;
    expect(card.fileAttachments).toBeUndefined();
    expect(card.attachmentCount).toBe(1);
  });

  it('names an uploaded file by its id when the attachment has a blank name', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000201',
      attachments: [{ id: '6730f0000000000000000009', name: '   ', url: 'https://trello.com/download/blank', bytes: 10, isUpload: true }],
    }], [], new Set());
    expect(issue.fileAttachments?.[0].filename).toBe('6730f0000000000000000009');
  });
});

describe('mapTrelloCards - fallbacks for a bare card', () => {
  it('fills every missing field with its documented fallback', () => {
    const [issue] = mapTrelloCards([{ id: '6731f2a00000000000000999' }], [], new Set());
    expect(issue.state).toBe('No list');
    expect(issue.stateOrder).toBe(Number.MAX_SAFE_INTEGER);
    expect(issue.title).toBe('(untitled)');
    expect(issue.externalUrl).toBe('https://trello.com/c/6731f2a00000000000000999');
    expect(issue.displayId).toBe('');
    expect(issue.updatedAt).toBe(issue.createdAt);
    expect(issue.body).toBe('## Trello\n\n- **List**: No list');
    expect(issue.labels).toEqual([]);
    expect(issue.assignee).toBeNull();
  });
});

describe('createdAtFromId - an id that is not an ObjectId', () => {
  it('falls back to the epoch for a non-hex id', () => {
    expect(createdAtFromId('zzzzzzzzzz')).toBe('1970-01-01T00:00:00.000Z');
  });

  it('falls back to the epoch for an id shorter than 8 characters', () => {
    expect(createdAtFromId('6731f2')).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('mapTrelloCards - attachment counting and links', () => {
  const inlineUploadUrl = 'https://trello.com/1/cards/6731f2a00000000000000301/attachments/6730f0000000000000000011/download/shot.png';
  const secondUploadUrl = 'https://trello.com/1/cards/6731f2a00000000000000301/attachments/6730f0000000000000000012/download/log.txt';

  it('counts a repeated inline image once, plus an upload not shown inline', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000301',
      desc: `![a](${inlineUploadUrl}) and again ![b](${inlineUploadUrl})`,
      attachments: [
        { id: '6730f0000000000000000011', name: 'shot.png', url: inlineUploadUrl, bytes: 5, isUpload: true },
        { id: '6730f0000000000000000012', name: 'log.txt', url: secondUploadUrl, bytes: 7, isUpload: true },
      ],
    }], [], new Set());
    expect(issue.attachmentCount).toBe(2);
    expect(issue.fileAttachments?.map((attachment) => attachment.filename)).toEqual(['log.txt']);
  });

  it('counts an inline image hosted outside Trello', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000302',
      desc: '![chart](https://images.example.com/chart.png)',
    }], [], new Set());
    expect(issue.attachmentCount).toBe(1);
    expect(issue.fileAttachments).toBeUndefined();
  });

  it('drops an upload with an empty url', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000303',
      attachments: [{ id: '6730f0000000000000000013', name: 'gone.txt', url: '', bytes: 3, isUpload: true }],
    }], [], new Set());
    expect(issue.fileAttachments).toBeUndefined();
    expect(issue.attachmentCount).toBe(0);
  });

  it('leaves a link with a blank url out of the Links line', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000304',
      attachments: [
        { id: 'l1', name: 'blank', url: '   ', isUpload: false },
        { id: 'l2', name: 'real', url: 'https://example.com/spec', isUpload: false },
      ],
    }], [], new Set());
    expect(issue.body).toContain('- **Links**: https://example.com/spec');
    expect(issue.body).not.toContain('https://example.com/spec,');
  });

  it('leaves the Links line out when every link is blank', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000305',
      attachments: [{ id: 'l3', name: 'blank', url: '', isUpload: false }],
    }], [], new Set());
    expect(issue.body).not.toContain('Links');
  });

  it('shows a member with no full name by username', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000306',
      members: [{ id: 'm1', fullName: '', username: 'sam' }, { id: 'm2', fullName: 'Dana Ruiz', username: 'dana' }],
    }], [], new Set());
    expect(issue.body).toContain('- **Members**: sam, Dana Ruiz');
  });
});

describe('mapTrelloCards - checklists', () => {
  it('titles an unnamed checklist "Checklist"', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000202',
      checklists: [{ id: 'c1', name: '', checkItems: [{ id: 'i1', name: 'Write it', state: 'incomplete' }] }],
    }], [], new Set());
    expect(issue.body).toContain('### Checklist\n\n- [ ] Write it');
  });

  it('leaves out a checklist whose items are all blank', () => {
    const [issue] = mapTrelloCards([{
      id: '6731f2a00000000000000203',
      checklists: [{ id: 'c2', name: 'Empty one', checkItems: [{ id: 'i2', name: '  ' }, { id: 'i3', name: null }] }],
    }], [], new Set());
    expect(issue.body).not.toContain('Empty one');
    expect(issue.body).not.toContain('###');
  });
});
