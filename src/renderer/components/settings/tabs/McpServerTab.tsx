import { useState } from 'react';
import { Plug } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import {
  MCP_SERVER_DOCS_URL,
  MCP_TOOL_CATEGORIES,
  MCP_TOOL_MANIFEST,
  mcpToolDocsUrl,
  type McpToolCategoryId,
} from '../../../../shared/mcp-tool-manifest';
import { useScopedUpdate } from '../shared';
import { SettingsCard, CardTile, CardGroupTile } from '../settings-card';
import { settingProps } from '../settings-registry';
import { SETTING_LABEL_CLASS, SETTING_DESCRIPTION_CLASS } from '../../SettingText';
import { ExternalLinkButton } from '../../ExternalLinkButton';

/** What turning the server on does, behind the card's info icon. */
const HOW_IT_WORKS = 'Each agent session gets a local MCP server and discovers these tools on its own. '
  + 'Tasks an agent creates appear on the board with a toast.';

/**
 * One card: the server's switch, then the docs and the tools it gives agents,
 * shown only while it is on. The docs row comes first, as a row of its own:
 * at the end of the list it read as one more tool. Each tool group is a tile
 * that collapses, and every group opens again on the next visit, so the full
 * list is what a reader meets. Each tool is a cell that opens its docs entry;
 * the tooltip says what the tool does.
 *
 * The list renders from `MCP_TOOL_MANIFEST`, so a registered tool appears here
 * with no edit to this file (mcp-tool-list-parity.md).
 */
export function McpServerTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mcpServer?.enabled ?? true;
  // For this visit only: the tab remounts on every open, which opens every group again.
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<McpToolCategoryId>>(() => new Set());
  const toggleGroup = (categoryId: McpToolCategoryId) => {
    setClosedGroups((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };
  return (
    <SettingsCard
      icon={<Plug size={16} />}
      {...settingProps('mcpServer.enabled')}
      info={HOW_IT_WORKS}
      checked={enabled}
      onChange={(value) => updateGlobal({ mcpServer: { enabled: value } })}
    >
      {enabled ? (
        <>
          <CardTile className="flex items-center justify-between gap-3" testId="mcp-docs-row">
            <div className="min-w-0">
              <div className={SETTING_LABEL_CLASS}>Documentation</div>
              <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}>How the server works and what each tool takes.</p>
            </div>
            {/* A wrapper, because the link sizes itself with `self-start`,
                which would lift it off this row's centre line. */}
            <div className="flex-shrink-0">
              <ExternalLinkButton label="Open docs" url={MCP_SERVER_DOCS_URL} testId="mcp-docs-link" />
            </div>
          </CardTile>
          {MCP_TOOL_CATEGORIES.map((category) => {
            const tools = MCP_TOOL_MANIFEST.filter((tool) => tool.category === category.id);
            if (tools.length === 0) return null;
            return (
              <CardGroupTile
                key={category.id}
                label={category.label}
                count={tools.length}
                open={!closedGroups.has(category.id)}
                onToggle={() => toggleGroup(category.id)}
                testId={`mcp-tool-group-${category.id}`}
              >
                <ul className="grid grid-cols-3 gap-1">
                  {tools.map((tool) => (
                    <li key={tool.name} className="min-w-0">
                      <button
                        type="button"
                        data-testid="mcp-tool-cell"
                        title={`${tool.label} - ${tool.blurb}. Opens the docs page.`}
                        onClick={() => void window.electronAPI.shell.openExternal(mcpToolDocsUrl(tool.name))}
                        className="block w-full cursor-pointer truncate rounded bg-edge-input/35 px-1.5 py-1 text-left text-xs text-fg-secondary transition-colors hover:bg-edge-input/70 hover:text-fg"
                      >
                        {tool.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </CardGroupTile>
            );
          })}
        </>
      ) : null}
    </SettingsCard>
  );
}
