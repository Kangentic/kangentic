/**
 * Pins the <colgroup> DataTable emits alongside a `columnGroups` band row
 * (src/renderer/components/DataTable.tsx). Under `table-fixed`, the table's
 * FIRST row decides every column's width; with a band row that first row is
 * the band, whose colspan cells carry none, so the per-column `width` class
 * on the label row below was silently ignored (the All columns table
 * rendered ten equal columns and clipped its longer values, the bug
 * `tests/ui/board-manager-dialog-ext.spec.ts`'s "overview gives each column
 * its declared share of the width" now proves fixed, in a real browser).
 * That test drives the one real `columnGroups` consumer, ColumnsOverview, so
 * it already proves the mechanism WORKS. What it does not cover is the two
 * structural claims the source comment makes about the <colgroup> itself:
 * that it is absent for a table with no `columnGroups` (so every OTHER
 * DataTable consumer - PerProjectTable, MonitorTable, CompletedTasksDialog,
 * BacklogView - stays byte-identical), and that a sortable grouped table's
 * drag-handle column gets its own leading `<col>` rather than shifting every
 * column's width one slot to the right. Neither needs a browser: DataTable is
 * pure function-of-props for this (no refs are read before the markup is
 * produced), so `renderToStaticMarkup` proves the same shape as a browser
 * would render, without one.
 *
 * `react-dom/server`, no jsdom: same rationale and pattern as
 * `attachment-chips.test.ts` and `worktree-placement.test.ts`. `data: []`
 * means no `SortableRow` ever mounts (the empty-state row renders instead),
 * so `useSortable` never runs and no `DndContext` is needed even with
 * `sortableEnabled: true`. `useVirtualizer` runs safely with a null
 * `scrollContainerRef.current` (tanstack/react-virtual is SSR-safe) and a
 * `count: 0` list, which both render paths exercise directly below.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataTable, type DataTableColumn, type DataTableColumnGroup } from '../../src/renderer/components/DataTable';

interface Row {
  id: string;
  name: string;
}

const nameColumn: DataTableColumn<Row> = { key: 'name', label: 'Name', width: 'w-[40%]', render: (row) => row.name };
const amountColumn: DataTableColumn<Row> = { key: 'amount', label: 'Amount', width: 'w-[60%]', render: () => '0' };
const columns: DataTableColumn<Row>[] = [nameColumn, amountColumn];
const columnGroups: DataTableColumnGroup[] = [{ label: 'Details', span: 2 }];

function renderTable(props: {
  columnGroups?: DataTableColumnGroup[];
  virtualized?: boolean;
  sortableEnabled?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(DataTable<Row>, {
      columns,
      columnGroups: props.columnGroups,
      data: [],
      rowKey: (row: Row) => row.id,
      virtualized: props.virtualized,
      sortableEnabled: props.sortableEnabled,
    }),
  );
}

/** Extracts every `<col .../>` element's `class` attribute, in document order. */
function colClasses(html: string): string[] {
  return [...html.matchAll(/<col class="([^"]*)"/g)].map((match) => match[1]);
}

describe('DataTable <colgroup>', () => {
  it('emits no <colgroup> for an ungrouped table (non-virtualized path)', () => {
    const html = renderTable({ virtualized: false });
    expect(html).not.toContain('<colgroup');
  });

  it('emits no <colgroup> for an ungrouped table (virtualized path)', () => {
    const html = renderTable({ virtualized: true });
    expect(html).not.toContain('<colgroup');
  });

  it('emits a <colgroup> before <thead> for a grouped table, with one <col> per column in order', () => {
    const html = renderTable({ columnGroups, virtualized: false });
    expect(html).toContain('<colgroup');
    expect(html.indexOf('<colgroup')).toBeLessThan(html.indexOf('<thead'));
    expect(colClasses(html)).toEqual(['w-[40%]', 'w-[60%]']);
  });

  it('gives the drag-handle its own leading <col> on a grouped, sortable table, rather than shifting column widths', () => {
    const html = renderTable({ columnGroups, virtualized: false, sortableEnabled: true });
    expect(colClasses(html)).toEqual(['w-[32px]', 'w-[40%]', 'w-[60%]']);
  });

  it('emits the same <colgroup> shape on the virtualized render path', () => {
    const html = renderTable({ columnGroups, virtualized: true, sortableEnabled: true });
    expect(colClasses(html)).toEqual(['w-[32px]', 'w-[40%]', 'w-[60%]']);
  });
});
