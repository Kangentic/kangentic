/**
 * Coverage for the config-store's Command Terminal rail setting
 * (`AppConfig.commandTerminalRail`): the rail's width and fold are one GLOBAL
 * setting that the panel and the detached Command Terminal window both write.
 *
 * Three properties carry it, and each fails SILENTLY if broken:
 *
 *  - `saveCommandTerminalRail` applies the value at once and persists it through
 *    `config.set`, so a drag or a fold survives a restart.
 *  - `adoptCommandTerminalRail` applies a value WITHOUT writing it. A window that
 *    reads the rail back from disk must not write what it just read, or two windows
 *    would ping-pong the setting.
 *  - The refetch merge (`withSeededWorkspace`) does NOT preserve the rail, unlike
 *    `commandTerminalPanel`. The other window writes the rail, so a refetch has to
 *    read that write back. Preserving this window's copy would keep its own stale
 *    value and hide the other window's drag.
 *
 * The store reads `window.electronAPI.config.*` at call time, stubbed here (the
 * unit tier has no jsdom); touching only the layout blobs never trips the store's
 * theme / animations subscriptions, so no DOM access occurs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import {
  DEFAULT_CONFIG,
  type CommandTerminalPanelGeometry,
} from '../../src/shared/types';
import type { CommandTerminalRailState } from '../../src/shared/command-terminal-rail';

const PANEL: CommandTerminalPanelGeometry = { x: 0.1, y: 0.1, w: 0.6, h: 0.7, maximized: false };
const OTHER_PANEL: CommandTerminalPanelGeometry = { x: 0.3, y: 0.2, w: 0.5, h: 0.5, maximized: true };

describe('config-store command terminal rail', () => {
  let configSet: ReturnType<typeof vi.fn>;
  let configGet: ReturnType<typeof vi.fn>;
  let configGetGlobal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    configSet = vi.fn();
    configGet = vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG });
    configGetGlobal = vi.fn().mockResolvedValue({ ...DEFAULT_CONFIG });
    vi.stubGlobal('window', {
      electronAPI: {
        config: { set: configSet, setSync: vi.fn(), get: configGet, getGlobal: configGetGlobal },
      },
    });
    useConfigStore.setState({
      config: { ...DEFAULT_CONFIG },
      globalConfig: { ...DEFAULT_CONFIG },
      workspaceSeeded: false,
      configLoaded: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saveCommandTerminalRail shows the value in both configs and persists it through config.set', () => {
    const rail: CommandTerminalRailState = { width: 360, collapsed: false };

    useConfigStore.getState().saveCommandTerminalRail(rail);

    expect(useConfigStore.getState().config.commandTerminalRail).toEqual(rail);
    expect(useConfigStore.getState().globalConfig.commandTerminalRail).toEqual(rail);
    expect(configSet).toHaveBeenCalledTimes(1);
    expect(configSet).toHaveBeenCalledWith({ commandTerminalRail: rail });
  });

  it('adoptCommandTerminalRail shows the value in both configs and writes nothing', () => {
    const rail: CommandTerminalRailState = { width: 250, collapsed: true };

    useConfigStore.getState().adoptCommandTerminalRail(rail);

    expect(useConfigStore.getState().config.commandTerminalRail).toEqual(rail);
    expect(useConfigStore.getState().globalConfig.commandTerminalRail).toEqual(rail);
    expect(configSet).not.toHaveBeenCalled();
  });

  it('a refetch reads the rail back from disk, so another window\'s write is not hidden by this window\'s copy', async () => {
    // Seeded: the first fetch has landed, so the merge preserves the renderer-authoritative blobs.
    useConfigStore.setState({ workspaceSeeded: true });
    useConfigStore.getState().saveCommandTerminalRail({ width: 360, collapsed: false });

    // Meanwhile the detached window folded the rail and narrowed it; disk holds that.
    const fetchedRail: CommandTerminalRailState = { width: 250, collapsed: true };
    configGet.mockResolvedValue({ ...DEFAULT_CONFIG, commandTerminalRail: fetchedRail });
    configGetGlobal.mockResolvedValue({ ...DEFAULT_CONFIG, commandTerminalRail: fetchedRail });
    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config.commandTerminalRail).toEqual(fetchedRail);
    expect(useConfigStore.getState().globalConfig.commandTerminalRail).toEqual(fetchedRail);
  });

  it('the same refetch DOES keep this window\'s panel geometry, which is what makes the rail case a deliberate difference', async () => {
    useConfigStore.setState({ workspaceSeeded: true });
    useConfigStore.getState().saveCommandTerminalPanel(PANEL);

    configGet.mockResolvedValue({ ...DEFAULT_CONFIG, commandTerminalPanel: OTHER_PANEL });
    configGetGlobal.mockResolvedValue({ ...DEFAULT_CONFIG, commandTerminalPanel: OTHER_PANEL });
    await useConfigStore.getState().loadConfig();

    // The panel is written by this renderer alone, so a stale disk read must not revert it.
    expect(useConfigStore.getState().config.commandTerminalPanel).toEqual(PANEL);
    expect(useConfigStore.getState().globalConfig.commandTerminalPanel).toEqual(PANEL);
  });

  it('the first fetch seeds the rail from disk like every other field', async () => {
    const fetchedRail: CommandTerminalRailState = { width: 320, collapsed: false };
    configGet.mockResolvedValue({ ...DEFAULT_CONFIG, commandTerminalRail: fetchedRail });
    configGetGlobal.mockResolvedValue({ ...DEFAULT_CONFIG, commandTerminalRail: fetchedRail });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().workspaceSeeded).toBe(true);
    expect(useConfigStore.getState().globalConfig.commandTerminalRail).toEqual(fetchedRail);
  });
});
