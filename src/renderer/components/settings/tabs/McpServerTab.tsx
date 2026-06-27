import { Plug } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { DEFAULT_CONFIG } from '../../../../shared/types';
import { INPUT_CLASS, SectionHeader, SettingRow, SettingToggleRow, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function McpServerTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mcpServer?.enabled ?? true;
  return (
    <div className="space-y-4">
      <SettingToggleRow
        {...settingProps('mcpServer.enabled')}
        icon={<Plug className="size-5" />}
        checked={enabled}
        onChange={(value) => updateGlobal({ mcpServer: { enabled: value } })}
      />

      <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
        <SettingRow {...settingProps('mcpServer.maxTaskCreateCount')}>
          <input
            type="number"
            value={globalConfig.mcpServer?.maxTaskCreateCount ?? DEFAULT_CONFIG.mcpServer.maxTaskCreateCount}
            onChange={(event) => {
              if (event.target.value === '') return;
              const value = Number(event.target.value);
              if (Number.isNaN(value)) return;
              updateGlobal({ mcpServer: { maxTaskCreateCount: Math.max(1, Math.min(500, Math.floor(value))) } });
            }}
            min={1}
            max={500}
            className={INPUT_CLASS}
          />
        </SettingRow>

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
