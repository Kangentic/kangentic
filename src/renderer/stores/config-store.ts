import { create } from 'zustand';
import type { AppConfig } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/types';

/** Format the raw version string (e.g. "2.1.50 (Claude Code)") into a display label. */
function formatClaudeVersion(version: string | null): string {
  const ver = version?.replace(/\s*\(.*\)/, '');
  return ver ? `Claude Code (v${ver})` : 'Claude Code';
}

interface ConfigStore {
  config: AppConfig;
  claudeInfo: { found: boolean; path: string | null; version: string | null } | null;
  /** Pre-formatted display label, e.g. "Claude Code (v2.1.50)" */
  claudeVersionLabel: string;
  loading: boolean;
  settingsOpen: boolean;

  loadConfig: () => Promise<void>;
  updateConfig: (partial: Partial<AppConfig>) => Promise<void>;
  detectClaude: () => Promise<void>;
  setSettingsOpen: (open: boolean) => void;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  config: DEFAULT_CONFIG,
  claudeInfo: null,
  claudeVersionLabel: 'Claude Code',
  loading: false,
  settingsOpen: false,

  loadConfig: async () => {
    set({ loading: true });
    const config = await window.electronAPI.config.get();
    set({ config, loading: false });
  },

  updateConfig: async (partial) => {
    await window.electronAPI.config.set(partial);
    const config = await window.electronAPI.config.get();
    set({ config });
  },

  detectClaude: async () => {
    const claudeInfo = await window.electronAPI.claude.detect();
    set({ claudeInfo, claudeVersionLabel: formatClaudeVersion(claudeInfo?.version ?? null) });
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));
