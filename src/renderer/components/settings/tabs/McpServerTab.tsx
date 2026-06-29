import { Plug } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { DEFAULT_CONFIG } from '../../../../shared/types';
import { MCP_TOOL_CATEGORIES, MCP_TOOL_MANIFEST } from '../../../../shared/mcp-tool-manifest';
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
        <SectionHeader label="Safeguards" searchIds={['mcpServer.maxTaskCreatePerLaunch']} />
        <SettingRow {...settingProps('mcpServer.maxTaskCreatePerLaunch')}>
          <input
            type="number"
            value={globalConfig.mcpServer?.maxTaskCreatePerLaunch ?? DEFAULT_CONFIG.mcpServer.maxTaskCreatePerLaunch}
            onChange={(event) => {
              if (event.target.value === '') return;
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 1) updateGlobal({ mcpServer: { maxTaskCreatePerLaunch: value } });
            }}
            min={1}
            step={1}
            className={INPUT_CLASS}
          />
        </SettingRow>

        <SectionHeader label="Available Tools" searchIds={['mcpServer.enabled']} />
        {MCP_TOOL_CATEGORIES.map((category) => {
          const tools = MCP_TOOL_MANIFEST.filter((tool) => tool.category === category.id);
          if (tools.length === 0) return null;
          return (
            <div key={category.id} className="mt-3 first:mt-1">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint mb-1">{category.label}</h4>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1.5 ml-1">
                {tools.map((tool) => (
                  <li
                    key={tool.name}
                    data-testid="mcp-tool-pill"
                    title={`${tool.label} - ${tool.blurb}`}
                    className="truncate rounded-md border border-edge/50 bg-surface-hover/30 px-2.5 py-1 text-xs text-fg-secondary"
                  >
                    {tool.label}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

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
