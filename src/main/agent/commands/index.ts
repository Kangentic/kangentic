export type { CommandContext, CommandResponse, CommandHandler } from './types';
export { resolveColumn, listActiveSwimlanes } from './column-resolver';

import { handleCreateTask, handleUpdateTask, handleDeleteTask, handleMoveTask, handleReorderTasks, handleLinkPr, handleRemoveAttachment } from './task-commands';
import { handleUpdateColumn, handleCreateColumn, handleDeleteColumn } from './column-commands';
import { handleListColumns, handleListTasks } from './inventory-commands';
import {
  handleListBoardProfiles,
  handleCreateBoardProfile,
  handleUpdateBoardProfile,
  handleDeleteBoardProfile,
} from './profile-commands';
import { handleSearchTasks, handleFindTask, handleGetCurrentTask } from './search-commands';
import { handleGetTaskStats, handleBoardSummary, handleListSessions, handleGetSessionHistory, handleGetColumnDetail } from './analytics-commands';
import { handleGetUsageStats } from './usage-commands';
import { handleListBacklog, handleCreateBacklogTask, handlePromoteBacklog, handleUpdateBacklogItem, handleDeleteBacklogItem } from './backlog-commands';
import { handleGetHandoffContext } from './handoff-commands';
import { handleGetTranscript, handleQueryDb } from './inspect-commands';
import { handleGetSessionFiles, handleGetSessionEvents } from './session-files-commands';
import { handleGetActivityIntervals } from './activity-interval-commands';
import { handleReserveDevPorts, handleCheckDevPorts } from './dev-port-commands';
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
  reorder_tasks: handleReorderTasks,
  link_pr: handleLinkPr,
  remove_attachment: handleRemoveAttachment,
  update_column: handleUpdateColumn,
  create_column: handleCreateColumn,
  delete_column: handleDeleteColumn,
  list_columns: handleListColumns,
  list_board_profiles: handleListBoardProfiles,
  create_board_profile: handleCreateBoardProfile,
  update_board_profile: handleUpdateBoardProfile,
  delete_board_profile: handleDeleteBoardProfile,
  list_tasks: handleListTasks,
  search_tasks: handleSearchTasks,
  find_task: handleFindTask,
  get_current_task: handleGetCurrentTask,
  get_task_stats: handleGetTaskStats,
  get_usage_stats: handleGetUsageStats,
  board_summary: handleBoardSummary,
  list_sessions: handleListSessions,
  get_session_history: handleGetSessionHistory,
  get_column_detail: handleGetColumnDetail,
  list_backlog: handleListBacklog,
  create_backlog_task: handleCreateBacklogTask,
  promote_backlog: handlePromoteBacklog,
  update_backlog_item: handleUpdateBacklogItem,
  delete_backlog_item: handleDeleteBacklogItem,
  get_handoff_context: handleGetHandoffContext,
  get_transcript: handleGetTranscript,
  query_db: handleQueryDb,
  get_session_files: handleGetSessionFiles,
  get_session_events: handleGetSessionEvents,
  get_activity_intervals: handleGetActivityIntervals,
  reserve_dev_ports: handleReserveDevPorts,
  check_dev_ports: handleCheckDevPorts,
};
