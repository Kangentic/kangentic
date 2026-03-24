/**
 * CommandBridge watches a commands.jsonl file written by the MCP server process
 * and processes commands using the existing repositories. Responses are written
 * as individual JSON files that the MCP server polls for.
 *
 * This bridges the gap between the external MCP server process (spawned by
 * Claude Code) and the Electron main process (which has DB access).
 */

import fs from 'node:fs';
import path from 'node:path';
import { FileWatcher } from '../pty/file-watcher';
import { commandHandlers } from './commands';
import type Database from 'better-sqlite3';
import type { Task } from '../../shared/types';
import type { CommandContext, CommandResponse } from './commands';

interface CommandBridgeOptions {
  commandsPath: string;
  responsesDir: string;
  projectId: string;
  getProjectDb: () => Database.Database;
  onTaskCreated: (task: Task, columnName: string, swimlaneId: string) => void;
  onTaskUpdated: (task: Task) => void;
}

interface Command {
  id: string;
  method: string;
  params: Record<string, unknown>;
  ts: number;
}

export class CommandBridge {
  private fileWatcher: FileWatcher | null = null;
  private fileOffset = 0;
  private readonly commandsPath: string;
  private readonly responsesDir: string;
  private readonly projectId: string;
  private readonly context: CommandContext;
  private stopped = false;

  constructor(options: CommandBridgeOptions) {
    this.commandsPath = options.commandsPath;
    this.responsesDir = options.responsesDir;
    this.projectId = options.projectId;
    this.context = {
      getProjectDb: options.getProjectDb,
      onTaskCreated: options.onTaskCreated,
      onTaskUpdated: options.onTaskUpdated,
    };
  }

  start(): void {
    // Ensure directories exist
    fs.mkdirSync(path.dirname(this.commandsPath), { recursive: true });
    fs.mkdirSync(this.responsesDir, { recursive: true });

    // Truncate commands file on start (no stale commands from previous sessions)
    try {
      fs.writeFileSync(this.commandsPath, '');
    } catch {
      // File may not exist yet
    }

    this.fileWatcher = new FileWatcher({
      filePath: this.commandsPath,
      onChange: () => this.processNewCommands(),
      label: `MCP-Cmd`,
      debounceMs: 50,
      initialGracePeriodMs: 30_000,
      isStale: () => {
        try {
          const stat = fs.statSync(this.commandsPath);
          return stat.size > this.fileOffset;
        } catch {
          return false;
        }
      },
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  private processNewCommands(): void {
    if (this.stopped) return;

    try {
      const stat = fs.statSync(this.commandsPath);
      if (stat.size <= this.fileOffset) return;

      const fd = fs.openSync(this.commandsPath, 'r');
      const buffer = Buffer.alloc(stat.size - this.fileOffset);
      fs.readSync(fd, buffer, 0, buffer.length, this.fileOffset);
      fs.closeSync(fd);
      this.fileOffset = stat.size;

      const chunk = buffer.toString('utf-8');
      const lines = chunk.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const command: Command = JSON.parse(line);
          this.handleCommand(command);
        } catch (parseError) {
          console.error('[CommandBridge] Failed to parse command line:', parseError);
        }
      }
    } catch {
      // File may not exist yet or be partially written
    }
  }

  private handleCommand(command: Command): void {
    let response: CommandResponse;

    try {
      const handler = commandHandlers[command.method];
      if (handler) {
        response = handler(command.params, this.context);
      } else {
        response = { success: false, error: `Unknown command: ${command.method}` };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CommandBridge] Error handling ${command.method}:`, errorMessage);
      response = { success: false, error: errorMessage };
    }

    this.writeResponse(command.id, response);
  }

  private writeResponse(requestId: string, response: CommandResponse): void {
    try {
      const responsePath = path.join(this.responsesDir, `${requestId}.json`);
      fs.writeFileSync(responsePath, JSON.stringify(response));
    } catch (error) {
      console.error(`[CommandBridge] Failed to write response for ${requestId}:`, error);
    }
  }
}
