/**
 * The conversation window's Route tabs (`route-slice.ts`): which turns a column
 * tab shows, and the dividers All and a column tab draw.
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_CONVERSATION_TAB,
  firstEntryOfStay,
  isolatedSwimlaneIdsFromKey,
  isolatedSwimlaneIdsKey,
  sliceConversationByRoute,
  visitDividerUuid,
} from '../../src/renderer/components/conversation/route-slice';
import { formatMonthDayTime } from '../../src/renderer/lib/datetime';
import type { TaskReportRouteColumn, TranscriptEntry } from '../../src/shared/types';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-20T17:51:00.000Z');
const at = (minutes: number) => T0 + minutes * MINUTE;
const iso = (minutes: number) => new Date(at(minutes)).toISOString();

function column(swimlaneId: string, name: string, visitStarts: number[]): TaskReportRouteColumn {
  return {
    swimlaneId,
    name,
    color: '#3b82f6',
    icon: null,
    role: null,
    totalMs: 0,
    visits: visitStarts.map((minutes) => ({ startedAt: iso(minutes), durationMs: 0 })),
  };
}

/** Executing twice (back after review), Code Review once between. */
const ROUTE: TaskReportRouteColumn[] = [
  column('executing', 'Executing', [0, 30]),
  column('review', 'Code Review', [20]),
  column('merge', 'Merge', [50]),
];

const say = (uuid: string, minutes: number): TranscriptEntry => ({
  kind: 'assistant', uuid, ts: at(minutes), blocks: [{ type: 'text', text: uuid }],
});
const boundary = (uuid: string, minutes: number): TranscriptEntry => ({
  kind: 'system', uuid, ts: at(minutes), subtype: 'session_boundary', text: 'New session',
});

const ENTRIES: TranscriptEntry[] = [
  { kind: 'user', uuid: 'before-the-log', ts: at(-5), text: 'from before the first logged move' },
  say('exec-1', 1),
  say('exec-2', 10),
  boundary('review-boundary', 21),
  say('review-1', 21),
  boundary('mid-review-boundary', 25),
  say('review-2', 26),
  say('exec-again', 31),
  { kind: 'system', uuid: 'untimed', ts: 0, subtype: 'compaction', text: '' },
];

const uuids = (entries: TranscriptEntry[]) => entries.map((entry) => entry.uuid);

describe('sliceConversationByRoute', () => {
  it('All keeps every turn and draws the column name where each stay\'s turns begin', () => {
    const slice = sliceConversationByRoute(ENTRIES, ROUTE, ALL_CONVERSATION_TAB);
    const dividers = slice.entries.filter((entry) => slice.dividerColumns.has(entry.uuid));

    expect(dividers.map((entry) => entry.kind === 'system' && entry.text)).toEqual(['Executing', 'Code Review', 'Executing']);
    // Turns from before the first logged move lead with no divider.
    expect(slice.entries[0].uuid).toBe('before-the-log');
  });

  it('folds a new session that starts at a move into the move\'s divider, and keeps one that starts mid-stay', () => {
    const slice = sliceConversationByRoute(ENTRIES, ROUTE, ALL_CONVERSATION_TAB);

    expect(uuids(slice.entries)).not.toContain('review-boundary');
    expect(uuids(slice.entries)).toContain('mid-review-boundary');
  });

  it('a column tab keeps only its own stays, each opened by its date', () => {
    const slice = sliceConversationByRoute(ENTRIES, ROUTE, 'executing');
    const turns = uuids(slice.entries).filter((uuid) => !slice.dividerColumns.has(uuid));

    expect(turns).toEqual(['exec-1', 'exec-2', 'exec-again']);
    expect(slice.entries[0].uuid).toBe(visitDividerUuid('executing', iso(0)));
    expect(slice.entries[0].kind === 'system' && slice.entries[0].text).toBe(formatMonthDayTime(iso(0)));
    expect(uuids(slice.entries)).toContain(visitDividerUuid('executing', iso(30)));
  });

  it('opens even a column\'s only stay with its dated divider', () => {
    const slice = sliceConversationByRoute(ENTRIES, ROUTE, 'review');

    expect(uuids(slice.entries)).toEqual([visitDividerUuid('review', iso(20)), 'review-1', 'mid-review-boundary', 'review-2']);
  });

  it('a column the agent never worked in has an empty tab', () => {
    expect(sliceConversationByRoute(ENTRIES, ROUTE, 'merge').entries).toEqual([]);
  });

  it('an entry with no timestamp, or from before the log, belongs to no column tab', () => {
    for (const tab of ['executing', 'review', 'merge']) {
      const slice = sliceConversationByRoute(ENTRIES, ROUTE, tab);
      expect(uuids(slice.entries)).not.toContain('untimed');
      expect(uuids(slice.entries)).not.toContain('before-the-log');
    }
    expect(uuids(sliceConversationByRoute(ENTRIES, ROUTE, ALL_CONVERSATION_TAB).entries)).toContain('untimed');
  });

  it('keeps a tool result with its tool call when the result lands after the next move', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'assistant', uuid: 'call', ts: at(19), blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] },
      { kind: 'tool_result', uuid: 'result', ts: at(21), toolUseId: 'tool-1', content: 'ok' },
    ];

    expect(uuids(sliceConversationByRoute(entries, ROUTE, 'executing').entries)).toContain('result');
    expect(uuids(sliceConversationByRoute(entries, ROUTE, 'review').entries)).not.toContain('result');
  });

  it('names each divider\'s column, for its icon', () => {
    const slice = sliceConversationByRoute(ENTRIES, ROUTE, ALL_CONVERSATION_TAB);
    const named = [...slice.dividerColumns.values()].map((entry) => entry.swimlaneId);

    expect(named).toEqual(['executing', 'review', 'executing']);
  });

  it('leaves the entries as they are when the route has no stay', () => {
    const slice = sliceConversationByRoute(ENTRIES, [], ALL_CONVERSATION_TAB);

    expect(uuids(slice.entries)).toEqual(uuids(ENTRIES));
    expect(slice.dividerColumns.size).toBe(0);
    expect(slice.isolatedDividers.size).toBe(0);
  });
});

describe('sliceConversationByRoute: dividers into an isolated column', () => {
  const ISOLATED = new Set(['review']);
  const markedColumns = (slice: ReturnType<typeof sliceConversationByRoute>) =>
    [...slice.isolatedDividers].map((uuid) => slice.dividerColumns.get(uuid)?.swimlaneId);

  it('All marks the move into the isolated column and no other', () => {
    const slice = sliceConversationByRoute(ENTRIES, ROUTE, ALL_CONVERSATION_TAB, ISOLATED);

    expect(markedColumns(slice)).toEqual(['review']);
  });

  it('a column tab marks none of its dated dividers, since its tab carries the icon', () => {
    for (const tab of ['review', 'executing']) {
      expect(sliceConversationByRoute(ENTRIES, ROUTE, tab, ISOLATED).isolatedDividers.size).toBe(0);
    }
  });

  it('marks nothing when no isolated session ran', () => {
    expect(sliceConversationByRoute(ENTRIES, ROUTE, ALL_CONVERSATION_TAB).isolatedDividers.size).toBe(0);
  });
});

describe('isolatedSwimlaneIdsKey and isolatedSwimlaneIdsFromKey', () => {
  const sessionsIn = (...swimlaneIds: Array<string | null>) =>
    swimlaneIds.map((isolatedSwimlaneId) => ({ isolatedSwimlaneId }));

  it('gives one key for the same columns whatever order their sessions come in', () => {
    // A live poll that finds the same columns must give the same key, so the set built from it keeps its identity.
    expect(isolatedSwimlaneIdsKey(sessionsIn('review', 'merge'))).toBe(isolatedSwimlaneIdsKey(sessionsIn('merge', 'review')));
  });

  it('skips a session that ran in no isolated column', () => {
    expect(isolatedSwimlaneIdsKey(sessionsIn(null, 'review', null))).toBe(isolatedSwimlaneIdsKey(sessionsIn('review')));
    expect(isolatedSwimlaneIdsKey(sessionsIn(null, null))).toBe('');
  });

  it('names a column once however many isolated sessions ran in it', () => {
    expect(isolatedSwimlaneIdsKey(sessionsIn('review', 'review'))).toBe(isolatedSwimlaneIdsKey(sessionsIn('review')));
    expect(isolatedSwimlaneIdsFromKey(isolatedSwimlaneIdsKey(sessionsIn('review', 'merge', 'review'))).size).toBe(2);
  });

  it('gives a different key for a different set of columns', () => {
    const reviewOnly = isolatedSwimlaneIdsKey(sessionsIn('review'));
    expect(isolatedSwimlaneIdsKey(sessionsIn('review', 'merge'))).not.toBe(reviewOnly);
    expect(isolatedSwimlaneIdsKey(sessionsIn('merge'))).not.toBe(reviewOnly);
  });

  it('gives the empty key, and an empty set, when no session was isolated', () => {
    expect(isolatedSwimlaneIdsKey([])).toBe('');
    expect(isolatedSwimlaneIdsKey(sessionsIn(null))).toBe('');
    // Splitting '' would give [''], a set holding a column with no name.
    expect(isolatedSwimlaneIdsFromKey('').size).toBe(0);
  });

  it('reads a key back as exactly the columns it was built from', () => {
    const columns = ['review', 'executing', 'merge'];
    expect(isolatedSwimlaneIdsFromKey(isolatedSwimlaneIdsKey(sessionsIn(...columns)))).toEqual(new Set(columns));
    expect(isolatedSwimlaneIdsFromKey(isolatedSwimlaneIdsKey(sessionsIn('review')))).toEqual(new Set(['review']));
    expect(isolatedSwimlaneIdsFromKey(isolatedSwimlaneIdsKey(sessionsIn(null, 'merge', 'merge')))).toEqual(new Set(['merge']));
  });
});

describe('firstEntryOfStay', () => {
  it('finds the first turn of one stay, where a repeat-stay row opens', () => {
    const slice = sliceConversationByRoute(ENTRIES, ROUTE, 'executing');

    expect(firstEntryOfStay(slice, 'executing', iso(30))).toBe('exec-again');
    expect(firstEntryOfStay(slice, 'executing', iso(0))).toBe('exec-1');
  });

  it('is null for a stay with no turns', () => {
    const slice = sliceConversationByRoute(ENTRIES, ROUTE, 'merge');

    expect(firstEntryOfStay(slice, 'merge', iso(50))).toBeNull();
  });
});

/** Each entry as its uuid, or `divider:<text>` for a synthetic divider, in order. */
function describeEntries(slice: ReturnType<typeof sliceConversationByRoute>): string[] {
  return slice.entries.map((entry) =>
    slice.dividerColumns.has(entry.uuid) && entry.kind === 'system' ? `divider:${entry.text}` : entry.uuid,
  );
}

describe('sliceConversationByRoute: where a stay begins', () => {
  it('puts an entry stamped exactly at a stay\'s start in that stay, and one a millisecond earlier in the one before', () => {
    // ROUTE: Executing from minute 0 and again from 30, Code Review from 20.
    const entries: TranscriptEntry[] = [
      { ...say('at-first-start', 0), ts: at(0) },
      { ...say('just-before-review', 0), ts: at(20) - 1 },
      { ...say('at-review-start', 0), ts: at(20) },
      { ...say('just-before-exec-again', 0), ts: at(30) - 1 },
      { ...say('at-exec-again-start', 0), ts: at(30) },
    ];
    const turnsOf = (tab: string) => {
      const slice = sliceConversationByRoute(entries, ROUTE, tab);
      return uuids(slice.entries).filter((uuid) => !slice.dividerColumns.has(uuid));
    };

    // Equal to a start counts as inside it, for the review stay and for both Executing stays.
    expect(turnsOf('review')).toEqual(['at-review-start', 'just-before-exec-again']);
    expect(turnsOf('executing')).toEqual(['at-first-start', 'just-before-review', 'at-exec-again-start']);
  });
});

describe('sliceConversationByRoute: unparseable and unmatched input', () => {
  const unparseableVisit = (): TaskReportRouteColumn => ({
    ...column('broken', 'Broken', []),
    visits: [{ startedAt: 'not a date', durationMs: 0 }],
  });
  const turnsIn = (slice: ReturnType<typeof sliceConversationByRoute>) =>
    uuids(slice.entries).filter((uuid) => !slice.dividerColumns.has(uuid));

  it('ignores a visit whose start does not parse, without throwing', () => {
    const route = [column('executing', 'Executing', [0]), unparseableVisit()];
    const entries = [say('exec-1', 1), say('exec-2', 2)];

    expect(() => sliceConversationByRoute(entries, route, ALL_CONVERSATION_TAB)).not.toThrow();
    const all = sliceConversationByRoute(entries, route, ALL_CONVERSATION_TAB);

    // One divider, for the stay that does parse; every turn stays in it.
    expect(describeEntries(all)).toEqual(['divider:Executing', 'exec-1', 'exec-2']);
    expect(sliceConversationByRoute(entries, route, 'broken').entries).toEqual([]);
  });

  it('keeps a column\'s other visits when one of them does not parse', () => {
    const mixed: TaskReportRouteColumn = {
      ...column('executing', 'Executing', []),
      // The broken visit is LAST, where a start that sorts as NaN would take over every later entry.
      visits: [
        { startedAt: iso(0), durationMs: 0 },
        { startedAt: 'garbage', durationMs: 0 },
      ],
    };
    const slice = sliceConversationByRoute([say('exec-1', 1)], [mixed], 'executing');

    expect(uuids(slice.entries)).toEqual([visitDividerUuid('executing', iso(0)), 'exec-1']);
  });

  it('leaves the entries as they are when no visit parses', () => {
    const slice = sliceConversationByRoute(ENTRIES, [unparseableVisit()], ALL_CONVERSATION_TAB);

    expect(uuids(slice.entries)).toEqual(uuids(ENTRIES));
    expect(slice.dividerColumns.size).toBe(0);
  });

  it('places a tool result with no matching tool call by its own timestamp', () => {
    const entries: TranscriptEntry[] = [
      say('exec-1', 1),
      { kind: 'tool_result', uuid: 'orphan-result', ts: at(21), toolUseId: 'call-that-never-appeared', content: 'ok' },
    ];

    // At minute 21 the task is in Code Review, so that is where the result belongs.
    expect(turnsIn(sliceConversationByRoute(entries, ROUTE, 'review'))).toEqual(['orphan-result']);
    expect(turnsIn(sliceConversationByRoute(entries, ROUTE, 'executing'))).toEqual(['exec-1']);
  });

  it('does not borrow the stay of a tool call that only appears after the result', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'tool_result', uuid: 'early-result', ts: at(21), toolUseId: 'tool-late', content: 'ok' },
      { kind: 'assistant', uuid: 'late-call', ts: at(19), blocks: [{ type: 'tool_use', id: 'tool-late', name: 'Bash', input: {} }] },
    ];

    expect(turnsIn(sliceConversationByRoute(entries, ROUTE, 'review'))).toEqual(['early-result']);
    expect(turnsIn(sliceConversationByRoute(entries, ROUTE, 'executing'))).toEqual(['late-call']);
  });
});

describe('sliceConversationByRoute: a stay whose only entry is a folded session boundary', () => {
  // Code Review is entered twice. The first stay (minute 20) holds nothing but the
  // new-session boundary the move itself started, which the stay's divider already
  // marks and so is folded away. Drawing that stay's divider anyway would leave a
  // lone line with no turns under it.
  const LONE_ROUTE: TaskReportRouteColumn[] = [
    column('executing', 'Executing', [0]),
    column('review', 'Code Review', [20, 40]),
  ];
  const LONE_ENTRIES: TranscriptEntry[] = [
    say('exec-1', 1),
    boundary('lone-boundary', 21),
    say('review-late', 41),
  ];

  it('draws no divider for that stay in All', () => {
    const slice = sliceConversationByRoute(LONE_ENTRIES, LONE_ROUTE, ALL_CONVERSATION_TAB);

    // The empty first stay adds nothing; the second still opens with its own divider.
    expect(describeEntries(slice)).toEqual(['divider:Executing', 'exec-1', 'divider:Code Review', 'review-late']);
    expect(uuids(slice.entries)).not.toContain('lone-boundary');
    expect([...slice.dividerColumns.values()].map((dividerColumn) => dividerColumn.swimlaneId)).toEqual(['executing', 'review']);
  });

  it('draws no divider for that stay in its column tab, and has no first entry for it', () => {
    const slice = sliceConversationByRoute(LONE_ENTRIES, LONE_ROUTE, 'review');

    expect(describeEntries(slice)).toEqual([`divider:${formatMonthDayTime(iso(40))}`, 'review-late']);
    expect(uuids(slice.entries)).not.toContain(visitDividerUuid('review', iso(20)));
    // Null for the empty stay, and not the next stay's divider that follows it in the tab.
    expect(firstEntryOfStay(slice, 'review', iso(20))).toBeNull();
    expect(firstEntryOfStay(slice, 'review', iso(40))).toBe('review-late');
  });

  it('draws nothing for a lone folded boundary that ends the conversation', () => {
    const route = [column('executing', 'Executing', [0]), column('review', 'Code Review', [20])];
    const entries = [say('exec-1', 1), boundary('trailing-boundary', 21)];

    expect(describeEntries(sliceConversationByRoute(entries, route, ALL_CONVERSATION_TAB))).toEqual(['divider:Executing', 'exec-1']);
    expect(sliceConversationByRoute(entries, route, 'review').entries).toEqual([]);
  });

  it('still gives a stay exactly one divider when a turn follows its folded boundary', () => {
    // In ENTRIES the review stay opens with a boundary and then a turn.
    const all = sliceConversationByRoute(ENTRIES, ROUTE, ALL_CONVERSATION_TAB);
    const reviewTab = sliceConversationByRoute(ENTRIES, ROUTE, 'review');

    expect([...all.dividerColumns.values()].filter((dividerColumn) => dividerColumn.swimlaneId === 'review')).toHaveLength(1);
    expect(uuids(reviewTab.entries).filter((uuid) => uuid === visitDividerUuid('review', iso(20)))).toHaveLength(1);
    expect(uuids(reviewTab.entries)).not.toContain('review-boundary');
    expect(firstEntryOfStay(reviewTab, 'review', iso(20))).toBe('review-1');
  });
});
