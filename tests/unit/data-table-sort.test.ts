/**
 * Pure sort-cycle logic extracted from the shared `DataTable` primitive
 * (`src/renderer/components/DataTable.tsx`), used by the usage dashboard's
 * PerProjectTable as well as the backlog and completed-tasks tables. The
 * table itself changed from a single sort key/direction to an ORDERED array
 * of sort levels (index 0 primary, later entries break ties via
 * Shift+Click).
 *
 * `tests/ui/usage-dashboard.spec.ts` covers the direction-anchored
 * asc/desc/clear cycle and that Shift+Click surfaces a second priority
 * badge, but with only two fixture rows it cannot exercise real tie
 * breaking, and no test anywhere clicks Shift+Click on a column that is
 * ALREADY an active sort level (which must flip that level's direction in
 * place rather than adding a duplicate or clearing). Both are covered here
 * at the comparator/reducer level, which is faster and exhaustive over the
 * full state-transition table.
 */
import { describe, it, expect } from 'vitest';
import { computeNextSorts, sortRows, type SortLevel } from '../../src/renderer/components/DataTable';

interface Row {
  id: string;
  name: string;
  amount: number;
}

const nameColumn = { key: 'name', sortValue: (row: Row) => row.name };
const amountColumn = { key: 'amount', align: 'right' as const, sortValue: (row: Row) => row.amount };
const unsortableColumn = { key: 'id' };
const columns = [nameColumn, amountColumn, unsortableColumn];

describe('computeNextSorts (header click cycle)', () => {
  it('plain click on an unsorted text column starts ascending', () => {
    const next = computeNextSorts<Row, string>([], nameColumn, false);
    expect(next).toEqual([{ key: 'name', direction: 'asc' }]);
  });

  it('plain click on an unsorted right-aligned (numeric) column starts descending', () => {
    const next = computeNextSorts<Row, string>([], amountColumn, false);
    expect(next).toEqual([{ key: 'amount', direction: 'desc' }]);
  });

  it('a second plain click on the sole active column flips its direction', () => {
    const sorted: Array<SortLevel<string>> = [{ key: 'amount', direction: 'desc' }];
    const next = computeNextSorts(sorted, amountColumn, false);
    expect(next).toEqual([{ key: 'amount', direction: 'asc' }]);
  });

  it('a third plain click on the sole active column clears back to manual order', () => {
    const sorted: Array<SortLevel<string>> = [{ key: 'amount', direction: 'asc' }];
    const next = computeNextSorts(sorted, amountColumn, false);
    expect(next).toEqual([]);
  });

  it('a plain click on a DIFFERENT column collapses to a single sort at its own initial direction', () => {
    const sorted: Array<SortLevel<string>> = [{ key: 'amount', direction: 'desc' }];
    const next = computeNextSorts(sorted, nameColumn, false);
    expect(next).toEqual([{ key: 'name', direction: 'asc' }]);
  });

  it('a plain click while multiple levels are active collapses to a single sort on the clicked column', () => {
    const sorted: Array<SortLevel<string>> = [
      { key: 'amount', direction: 'desc' },
      { key: 'name', direction: 'asc' },
    ];
    const next = computeNextSorts(sorted, nameColumn, false);
    expect(next).toEqual([{ key: 'name', direction: 'asc' }]);
  });

  it('Shift+Click with no active sort behaves like a plain click (never adds an orphan level)', () => {
    const next = computeNextSorts<Row, string>([], amountColumn, true);
    expect(next).toEqual([{ key: 'amount', direction: 'desc' }]);
  });

  it('Shift+Click on a new column appends it as a secondary tie-break level, preserving the primary', () => {
    const sorted: Array<SortLevel<string>> = [{ key: 'amount', direction: 'desc' }];
    const next = computeNextSorts(sorted, nameColumn, true);
    expect(next).toEqual([
      { key: 'amount', direction: 'desc' },
      { key: 'name', direction: 'asc' },
    ]);
  });

  it('Shift+Click on the PRIMARY level flips its direction in place and keeps the secondary level untouched', () => {
    // This is the gap: no existing test (UI or unit) ever shift-clicks a
    // column that is already an active sort level.
    const sorted: Array<SortLevel<string>> = [
      { key: 'amount', direction: 'desc' },
      { key: 'name', direction: 'asc' },
    ];
    const next = computeNextSorts(sorted, amountColumn, true);
    expect(next).toEqual([
      { key: 'amount', direction: 'asc' },
      { key: 'name', direction: 'asc' },
    ]);
  });

  it('Shift+Click on the SECONDARY level flips only that level and never clears (multi-sort never clears)', () => {
    const sorted: Array<SortLevel<string>> = [
      { key: 'amount', direction: 'desc' },
      { key: 'name', direction: 'asc' },
    ];
    const next = computeNextSorts(sorted, nameColumn, true);
    expect(next).toEqual([
      { key: 'amount', direction: 'desc' },
      { key: 'name', direction: 'desc' },
    ]);
  });

  it('clicking a non-sortable column (no sortValue) is a caller concern, not asserted here', () => {
    // computeNextSorts assumes the caller already gated on column.sortValue
    // (handleHeaderClick returns early); this documents that the helper
    // itself does not special-case `unsortableColumn` and would treat it
    // like any other key. Included so a future refactor that inlines the
    // gate does not silently drop it.
    const next = computeNextSorts<Row, string>([], unsortableColumn, false);
    expect(next).toEqual([{ key: 'id', direction: 'asc' }]);
  });
});

describe('sortRows (comparator application)', () => {
  const rows: Row[] = [
    { id: 'a', name: 'Bravo', amount: 10 },
    { id: 'b', name: 'Alpha', amount: 10 },
    { id: 'c', name: 'Charlie', amount: 5 },
  ];

  it('returns the original array unchanged when there are no sort levels', () => {
    expect(sortRows(rows, [], columns)).toBe(rows);
  });

  it('sorts ascending by a text column via localeCompare', () => {
    const sorted = sortRows(rows, [{ key: 'name', direction: 'asc' }], columns);
    expect(sorted.map((row) => row.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('sorts descending by a numeric column', () => {
    const sorted = sortRows(rows, [{ key: 'amount', direction: 'desc' }], columns);
    expect(sorted.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts ascending by a numeric column', () => {
    const sorted = sortRows(rows, [{ key: 'amount', direction: 'asc' }], columns);
    expect(sorted[0].id).toBe('c');
  });

  it('a secondary level breaks ties left unresolved by the primary level (the actual multi-sort contract)', () => {
    // amount ties a/b at 10; the primary (amount desc) alone leaves their
    // relative order undefined by intent, so the secondary (name asc) must
    // resolve it deterministically: Alpha (b) before Bravo (a).
    const sorted = sortRows(
      rows,
      [
        { key: 'amount', direction: 'desc' },
        { key: 'name', direction: 'asc' },
      ],
      columns,
    );
    expect(sorted.map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('reversing the secondary level direction reverses only the tie-broken pair, not the whole result', () => {
    const sorted = sortRows(
      rows,
      [
        { key: 'amount', direction: 'desc' },
        { key: 'name', direction: 'desc' },
      ],
      columns,
    );
    expect(sorted.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('a sort level referencing a column with no sortValue (or no matching column) is dropped, not thrown', () => {
    const sorted = sortRows(
      rows,
      [{ key: 'id', direction: 'asc' } as SortLevel<string>, { key: 'name', direction: 'asc' }],
      columns,
    );
    expect(sorted.map((row) => row.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('returns the original array when every level is unresolvable', () => {
    const sorted = sortRows(rows, [{ key: 'id', direction: 'asc' } as SortLevel<string>], columns);
    expect(sorted).toBe(rows);
  });
});
