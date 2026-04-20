export type { CommandContext, CommandResponse, CommandHandler } from './types';
export { resolveColumn, listActiveSwimlanes } from './column-resolver';

import { handleCreateTask, handleUpdateTask, handleDeleteTask, handleMoveTask } from './task-commands';
import { handleUpdateColumn } from './column-commands';
import { handleListColumns, handleListTasks } from './inventory-commands';
import { handleSearchTasks, handleFindTask, handleGetCurrentTask } from './search-commands';
import { handleGetTaskStats, handleBoardSummary, handleListSessions, handleGetSessionHistory, handleGetColumnDetail } from './analytics-commands';
import { handleListBacklog, handleCreateBacklogTask, handleSearchBacklog, handlePromoteBacklog, handleUpdateBacklogItem, handleDeleteBacklogItem } from './backlog-commands';
import { handleGetHandoffContext } from './handoff-commands';
import { handleGetTranscript, handleQueryDb } from './inspect-commands';
import { handleGetSessionFiles, handleGetSessionEvents } from './session-files-commands';
import type { CommandHandler } from './types';

/**
 * Registry mapping command method names to their handler functions.
 * Used by the in-process MCP HTTP server (mcp-http-server.ts) to
 * dispatch tool calls into the right handler.
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
  get_current_task: handleGetCurrentTask,
  get_task_stats: handleGetTaskStats,
  board_summary: handleBoardSummary,
  list_sessions: handleListSessions,
  get_session_history: handleGetSessionHistory,
  get_column_detail: handleGetColumnDetail,
  list_backlog: handleListBacklog,
  create_backlog_task: handleCreateBacklogTask,
  search_backlog: handleSearchBacklog,
  promote_backlog: handlePromoteBacklog,
  update_backlog_item: handleUpdateBacklogItem,
  delete_backlog_item: handleDeleteBacklogItem,
  get_handoff_context: handleGetHandoffContext,
  get_transcript: handleGetTranscript,
  query_db: handleQueryDb,
  get_session_files: handleGetSessionFiles,
  get_session_events: handleGetSessionEvents,
};
