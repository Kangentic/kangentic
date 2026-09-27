import { ExternalLink, Plug } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import { MCP_TOOL_CATEGORIES, MCP_TOOL_MANIFEST, mcpToolDocsUrl } from '../../../../shared/mcp-tool-manifest';
import { useScopedUpdate } from '../shared';
import { SettingsCard } from '../settings-card';
import { settingProps } from '../settings-registry';

/** What turning the server on does, behind the card's info icon. */
const HOW_IT_WORKS = 'Each agent session gets a local MCP server and discovers these tools on its own. '
  + 'Tasks an agent creates appear on the board with a toast.';

/**
 * One card: the server's switch, then the tools it gives agents, shown only
 * while it is on. The list renders from `MCP_TOOL_MANIFEST`, so a registered
 * tool appears here with no edit to this file (mcp-tool-list-parity.md).
 */
export function McpServerTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mcpServer?.enabled ?? true;
  return (
    <SettingsCard
      icon={<Plug size={16} />}
      {...settingProps('mcpServer.enabled')}
      info={HOW_IT_WORKS}
      checked={enabled}
      onChange={(value) => updateGlobal({ mcpServer: { enabled: value } })}
      wideBody
    >
      {enabled ? (
        <div data-testid="mcp-tool-list">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-faint">Available tools</h4>
          {MCP_TOOL_CATEGORIES.map((category) => {
            const tools = MCP_TOOL_MANIFEST.filter((tool) => tool.category === category.id);
            if (tools.length === 0) return null;
            return (
              <div key={category.id} className="mt-3">
                <h5 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint mb-1">{category.label}</h5>
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1.5">
                  {tools.map((tool) => (
                    <li key={tool.name}>
                      <button
                        type="button"
                        data-testid="mcp-tool-pill"
                        title={`${tool.label} - ${tool.blurb}. Opens the docs page.`}
                        onClick={() => void window.electronAPI.shell.openExternal(mcpToolDocsUrl(tool.name))}
                        className="w-full flex items-center gap-1 rounded-md border border-edge/50 bg-surface-hover/30 px-2.5 py-1 text-xs text-fg-secondary hover:bg-surface-hover hover:text-fg hover:border-edge transition-colors cursor-pointer"
                      >
                        <span className="truncate">{tool.label}</span>
                        <ExternalLink size={11} className="ml-auto shrink-0 opacity-60" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </SettingsCard>
  );
}
