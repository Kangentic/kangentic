import { useCallback, useEffect, useState } from 'react';
import { Check, CircleAlert, Loader2, Plug, Signal } from 'lucide-react';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppConfig, McpConnectionCheck } from '../../../../shared/types';
import {
  MCP_TOOL_CATEGORIES,
  MCP_TOOL_MANIFEST,
  mcpToolDocsUrl,
  type McpToolCategoryId,
} from '../../../../shared/mcp-tool-manifest';
import { ReportedError, useScopedUpdate } from '../shared';
import { SettingsCard, CardTile, CardGroupTile } from '../settings-card';
import { settingProps } from '../settings-registry';
import { useSettingVisible } from '../settings-search';
import { SETTING_LABEL_CLASS } from '../../SettingText';
import { Tooltip } from '../../Tooltip';

/** What turning the server on does, behind the card's info icon. */
const HOW_IT_WORKS = msg`Each agent session gets a local MCP server and discovers these tools on its own. Tasks an agent creates appear on the board with a toast.`;

/** The groups every visit opens with closed: the ones the manifest marks `startsClosed`. */
const GROUPS_CLOSED_ON_ARRIVAL: ReadonlySet<McpToolCategoryId> = new Set(
  MCP_TOOL_CATEGORIES.filter((category) => category.startsClosed).map((category) => category.id),
);

/** The connection check, answering a call that could not be made as a failure with its error. */
function checkConnection(explicit: boolean): Promise<McpConnectionCheck> {
  return window.electronAPI.mcpServer.checkConnection({ explicit })
    .catch((error: unknown): McpConnectionCheck => ({ connected: false, error: error instanceof Error ? error.message : String(error) }));
}

/**
 * Whether agents can reach the server: Connected, or Failed with the error the
 * check hit, as selectable text and nothing more. Checked each time the row
 * shows (a visit, or a settings search that brings it back); Test
 * connection checks again, starting a stopped WSL distro a CLI path points
 * into, which the check on arrival skips. While a check runs only the button
 * changes. Replaces the Documentation tile: every tool cell already opens its
 * own docs entry.
 */
function McpConnectionRow() {
  const { searchId, label } = settingProps('mcpServer.connection');
  const visible = useSettingVisible(searchId);
  const [result, setResult] = useState<McpConnectionCheck | null>(null);
  // The check on arrival starts once the row shows: not while settings search
  // hides it, since a check can start a `wsl.exe` and a bridge round trip.
  const [checking, setChecking] = useState(visible);
  // The row showing again starts a check (the effect below), so the button
  // reads as checking from that render on.
  const [shownLastRender, setShownLastRender] = useState(visible);
  if (visible !== shownLastRender) {
    setShownLastRender(visible);
    setChecking(visible);
  }
  useEffect(() => {
    if (!visible) return undefined;
    let mounted = true;
    void checkConnection(false).then((answer) => {
      if (!mounted) return;
      setResult(answer);
      setChecking(false);
    });
    return () => {
      mounted = false;
    };
  }, [visible]);
  const testConnection = useCallback(async () => {
    setChecking(true);
    setResult(await checkConnection(true));
    setChecking(false);
  }, []);
  if (!visible) return null;
  return (
    <CardTile className="flex flex-col gap-1.5" testId={`setting-row-${searchId}`}>
      <div className="flex items-center gap-3">
        <span className={SETTING_LABEL_CLASS}>{label}</span>
        <div className="ml-auto flex flex-shrink-0 items-center gap-3">
          {result ? (
            result.connected ? (
              <span className="flex items-center gap-1 text-xs text-active" data-testid="mcp-connection-status">
                <Check size={13} aria-hidden="true" /><Trans context="connection state">Connected</Trans>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-attention" data-testid="mcp-connection-status">
                <CircleAlert size={13} aria-hidden="true" /><Trans context="connection state">Failed</Trans>
              </span>
            )
          ) : null}
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={checking}
            className="flex flex-shrink-0 items-center gap-1.5 rounded border border-edge-input bg-surface-hover px-3 py-1.5 text-xs text-fg-secondary hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="mcp-connection-test"
          >
            {/* Signal, as every Test connection button in Settings draws it. */}
            {checking ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Signal size={13} aria-hidden="true" />}
            <Trans>Test connection</Trans>
          </button>
        </div>
      </div>
      {result && !result.connected ? <ReportedError error={result.error} testId="mcp-connection-error" /> : null}
    </CardTile>
  );
}

/**
 * One card: the server's switch, then its connection and the tools it gives
 * agents, shown only while it is on. The connection row comes first, as a row
 * of its own. Each tool group is a tile that collapses. A collapse is not remembered: every visit opens with every
 * group open except the dev-leaning Diagnostics, so the everyday tools are
 * what a reader meets. Each tool is a cell that opens its docs entry; the
 * tooltip says what the tool does.
 *
 * The list renders from `MCP_TOOL_MANIFEST`, so a registered tool appears here
 * with no edit to this file (mcp-tool-list-parity.md).
 */
export function McpServerTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t, i18n } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  const enabled = globalConfig.mcpServer?.enabled ?? true;
  // For this visit only: the tab remounts on every open, which restores these defaults.
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<McpToolCategoryId>>(GROUPS_CLOSED_ON_ARRIVAL);
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
      searchIds={['mcpServer.connection']}
      info={i18n._(HOW_IT_WORKS)}
      checked={enabled}
      onChange={(value) => updateGlobal({ mcpServer: { enabled: value } })}
    >
      {enabled ? (
        <>
          <McpConnectionRow />
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
                  {tools.map((tool) => {
                    // The manifest's blurb stays English. Only the sentence
                    // around it is translated.
                    const blurb = tool.blurb;
                    return (
                      <li key={tool.name} className="min-w-0">
                        <Tooltip label={tool.label} detail={t`${blurb}. Opens the docs page.`}>
                          <button
                            type="button"
                            data-testid="mcp-tool-cell"
                            onClick={() => void window.electronAPI.shell.openExternal(mcpToolDocsUrl(tool.name))}
                            className="block w-full cursor-pointer truncate rounded bg-edge-input/35 px-1.5 py-1 text-left text-xs text-fg-secondary transition-colors hover:bg-edge-input/70 hover:text-fg"
                          >
                            {tool.label}
                          </button>
                        </Tooltip>
                      </li>
                    );
                  })}
                </ul>
              </CardGroupTile>
            );
          })}
        </>
      ) : null}
    </SettingsCard>
  );
}
