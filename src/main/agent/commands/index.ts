export type { CommandContext, CommandResponse, CommandHandler } from './types';
export { resolveColumn, listActiveSwimlanes } from './column-resolver';

import { handleCreateTask, handleUpdateTask, handleDeleteTask, handleMoveTask } from './task-commands';
import { handleUpdateColumn } from './column-commands';
import { handleListColumns, handleListTasks } from './inventory-commands';
import { handleSearchTasks, handleFindTask } from './search-commands';
import { handleGetTaskStats, handleBoardSummary, handleGetSessionHistory, handleGetColumnDetail } from './analytics-commands';
import { handleListBacklog, handleCreateBacklogTask, handleSearchBacklog, handlePromoteBacklog } from './backlog-commands';
import { handleGetHandoffContext } from './handoff-commands';
import { handleGetTranscript, handleQueryDb } from './inspect-commands';
import type { CommandHandler } from './types';

/**
 * Registry mapping command method names to their handler functions.
 * Used by CommandBridge to dispatch incoming commands.
 */
export const commandHandlers: Record<string, CommandHandler> = {
  create_task: handleCreateTask,
  update_task: handleUpdateTask,
  delete_task: handleDeleteTask,
  move_task: handleMoveTask,
  update_column: handleUpdateColumn,
  list_columns: handleListColumns,
  list_tasks: handleListTasks,
  search_tasks: handleSearchTasks,
  find_task: handleFindTask,
  get_task_stats: handleGetTaskStats,
  board_summary: handleBoardSummary,
  get_session_history: handleGetSessionHistory,
  get_column_detail: handleGetColumnDetail,
  list_backlog: handleListBacklog,
  create_backlog_task: handleCreateBacklogTask,
  search_backlog: handleSearchBacklog,
  promote_backlog: handlePromoteBacklog,
  get_handoff_context: handleGetHandoffContext,
  get_transcript: handleGetTranscript,
  query_db: handleQueryDb,
};
