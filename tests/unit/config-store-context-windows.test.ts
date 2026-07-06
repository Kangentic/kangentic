/**
 * Coverage for the config-store `rememberModelContextWindow` action: the write path
 * for the empirically-learned context-window badge (never hardcoded - discovered
 * from a live session's status.json `context_window.context_window_size`). Proves
 * the no-op guards (falsy agent/model, non-positive sentinel, unchanged value),
 * the base-id collapse (`[1m]` / dated pins share one window with the plain id),
 * last-observation-wins overwrite semantics, and per-agent isolation.
 *
 * The store reads `window.electronAPI.config.set` at call time, stubbed here (the
 * unit tier has no jsdom), following the same harness as
 * `config-store-workspace.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConfigStore } from '../../src/renderer/stores/config-store';
import { DEFAULT_CONFIG } from '../../src/shared/types';

describe('config-store rememberModelContextWindow', () => {
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
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists a positive context-window size under the base model id, keyed by agent', () => {
    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8', 1_000_000);

    expect(configSet).toHaveBeenCalledTimes(1);
    expect(configSet).toHaveBeenCalledWith({
      discoveredContextWindowsByAgent: { claude: { 'claude-opus-4-8': 1_000_000 } },
    });
  });

  it('collapses a [1m] variant to the same base key as the plain model id', () => {
    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8[1m]', 1_000_000);

    expect(configSet).toHaveBeenCalledWith({
      discoveredContextWindowsByAgent: { claude: { 'claude-opus-4-8': 1_000_000 } },
    });
  });

  it('collapses a dated pinned build to the same base key as the plain model id', () => {
    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8-20260101', 200_000);

    expect(configSet).toHaveBeenCalledWith({
      discoveredContextWindowsByAgent: { claude: { 'claude-opus-4-8': 200_000 } },
    });
  });

  it('is a no-op when contextWindowSize is zero (the unknown-window sentinel)', () => {
    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8', 0);
    expect(configSet).not.toHaveBeenCalled();
  });

  it('is a no-op when contextWindowSize is negative', () => {
    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8', -1);
    expect(configSet).not.toHaveBeenCalled();
  });

  it('is a no-op when agent is falsy', () => {
    useConfigStore.getState().rememberModelContextWindow('', 'claude-opus-4-8', 1_000_000);
    expect(configSet).not.toHaveBeenCalled();
  });

  it('is a no-op when model is falsy', () => {
    useConfigStore.getState().rememberModelContextWindow('claude', '', 1_000_000);
    expect(configSet).not.toHaveBeenCalled();
  });

  it('is a no-op when the stored value is already equal (idempotent)', () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        discoveredContextWindowsByAgent: { claude: { 'claude-opus-4-8': 1_000_000 } },
      },
    }));

    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8', 1_000_000);
    // Also unchanged via the [1m] spelling, which collapses to the same base key.
    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8[1m]', 1_000_000);

    expect(configSet).not.toHaveBeenCalled();
  });

  it('overwrites a changed value (last-observation-wins)', () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        discoveredContextWindowsByAgent: { claude: { 'claude-opus-4-8': 200_000 } },
      },
    }));

    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8', 1_000_000);

    expect(configSet).toHaveBeenCalledTimes(1);
    expect(configSet).toHaveBeenCalledWith({
      discoveredContextWindowsByAgent: { claude: { 'claude-opus-4-8': 1_000_000 } },
    });
  });

  it('keeps distinct agents from colliding under separate keys', () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        discoveredContextWindowsByAgent: { claude: { 'claude-opus-4-8': 200_000 } },
      },
    }));

    useConfigStore.getState().rememberModelContextWindow('codex', 'gpt-5', 400_000);

    expect(configSet).toHaveBeenCalledTimes(1);
    expect(configSet).toHaveBeenCalledWith({
      discoveredContextWindowsByAgent: {
        claude: { 'claude-opus-4-8': 200_000 },
        codex: { 'gpt-5': 400_000 },
      },
    });
  });

  it('preserves other models already recorded for the same agent when adding a new one', () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        discoveredContextWindowsByAgent: { claude: { 'claude-haiku-4-5': 200_000 } },
      },
    }));

    useConfigStore.getState().rememberModelContextWindow('claude', 'claude-opus-4-8', 1_000_000);

    expect(configSet).toHaveBeenCalledWith({
      discoveredContextWindowsByAgent: {
        claude: { 'claude-haiku-4-5': 200_000, 'claude-opus-4-8': 1_000_000 },
      },
    });
  });
});
