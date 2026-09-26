/**
 * The tasks an answer is about, as ONE kind of row: `#561` and the title.
 *
 * The same row everywhere, whatever was asked. Rows used to carry a
 * right-hand fact chosen per question (a cost, a date), which made two answers
 * look like two different interfaces; the number that answers the question
 * lives in the prose instead. A row opens that task's most relevant
 * conversation over the map, at the passage the answer used.
 *
 * Five rows, then "Show all N". An earlier turn collapses to one "Show N tasks"
 * line, so the thread stays readable as it grows. Opening a turn's rows puts
 * that turn's tasks back on the map.
 */

import { useState } from 'react';
import type { MemoryRelatedTask } from '../../../shared/types';

/** Rows shown before "Show all N". */
export const SOURCE_ROWS_SHOWN = 5;

export function MemorySourceRows({
  rows,
  collapsed,
  onOpenTask,
  canOpenTask,
  onReveal,
}: {
  rows: ReadonlyArray<MemoryRelatedTask>;
  /** An earlier turn: one line until the reader opens it. */
  collapsed: boolean;
  onOpenTask: (task: MemoryRelatedTask) => void;
  /** False for a task with no conversation, in a window with no board to open it on. */
  canOpenTask: (task: MemoryRelatedTask) => boolean;
  /** The reader opened these rows, so the map should show this turn. */
  onReveal: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const expand = (): void => {
    setExpanded(true);
    onReveal();
  };

  if (collapsed && !expanded) {
    return (
      <button
        type="button"
        onClick={expand}
        className="self-start py-0.5 text-[11.5px] text-fg-muted hover:text-fg cursor-pointer"
        data-testid="memory-chat-rows-collapsed"
      >
        Show {rows.length} {rows.length === 1 ? 'task' : 'tasks'}
      </button>
    );
  }

  const visible = expanded || collapsed ? rows : rows.slice(0, SOURCE_ROWS_SHOWN);
  return (
    <div className="flex flex-col gap-1" data-testid="memory-chat-rows">
      {visible.map((task) => (
        <button
          key={task.key}
          type="button"
          onClick={() => onOpenTask(task)}
          disabled={!canOpenTask(task)}
          title={canOpenTask(task) ? task.title : `${task.title} (no recorded conversation to open here)`}
          className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface px-2.5 py-[7px] text-left text-xs text-fg hover:bg-surface-hover cursor-pointer disabled:cursor-default disabled:text-fg-muted disabled:hover:bg-surface"
          data-testid="memory-chat-row"
          data-task-key={task.key}
        >
          {task.displayId != null ? (
            <span className="flex-shrink-0 font-semibold text-fg">#{task.displayId}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
        </button>
      ))}
      {!expanded && !collapsed && rows.length > SOURCE_ROWS_SHOWN ? (
        <button
          type="button"
          onClick={expand}
          className="self-start py-0.5 text-[11.5px] text-fg-muted hover:text-fg cursor-pointer"
          data-testid="memory-chat-rows-more"
        >
          Show all {rows.length}
        </button>
      ) : null}
    </div>
  );
}
