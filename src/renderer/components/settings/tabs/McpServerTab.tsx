import { Plug } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { SectionHeader, ToggleSwitch, useScopedUpdate } from '../shared';

export function McpServerTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mcpServer?.enabled ?? true;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg bg-surface-hover px-4 py-3">
        <Plug className="size-5 text-fg-muted shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-fg-primary">Kangentic MCP Server</div>
          <div className="text-xs text-fg-muted">Give agents tools to interact with your board</div>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={(value) => updateGlobal({ mcpServer: { enabled: value } })}
        />
      </div>

      <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
        <SectionHeader label="Available Tools" searchIds={['mcpServer.enabled']} />
        <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
          <li><strong className="text-fg-secondary">Create Task</strong> - add tasks to any column from within an agent session</li>
          <li><strong className="text-fg-secondary">Update Task</strong> - edit title and description of existing tasks</li>
          <li><strong className="text-fg-secondary">List Columns</strong> - see all board columns with task counts</li>
          <li><strong className="text-fg-secondary">List Tasks</strong> - browse tasks, optionally filtered by column</li>
          <li><strong className="text-fg-secondary">Search Tasks</strong> - find tasks by keyword across titles and descriptions</li>
          <li><strong className="text-fg-secondary">Find Task</strong> - look up tasks by branch name, title, or PR number</li>
          <li><strong className="text-fg-secondary">Board Summary</strong> - overview of task counts, active sessions, and costs</li>
          <li><strong className="text-fg-secondary">Task Stats</strong> - token usage, cost, and duration for individual or all tasks</li>
          <li><strong className="text-fg-secondary">Session History</strong> - timeline of sessions for a task</li>
          <li><strong className="text-fg-secondary">Column Detail</strong> - automation settings, permission mode, and configuration</li>
        </ul>

        <SectionHeader label="How It Works" searchIds={['mcpServer.enabled']} />
        <p className="text-sm text-fg-muted leading-relaxed">
          When enabled, Kangentic injects a local MCP server into each agent session.
          The agent discovers the tools automatically and can call them at any time during its work.
          Tasks created by agents appear on the board with a toast notification.
          If a task is created in a column with auto-spawn enabled, a new agent session starts for it automatically.
        </p>
      </div>
    </div>
  );
}
