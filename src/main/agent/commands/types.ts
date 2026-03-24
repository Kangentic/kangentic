import type Database from 'better-sqlite3';
import type { Task } from '../../../shared/types';

export interface CommandContext {
  getProjectDb: () => Database.Database;
  onTaskCreated: (task: Task, columnName: string, swimlaneId: string) => void;
  onTaskUpdated: (task: Task) => void;
}

export interface CommandResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export type CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
) => CommandResponse;
