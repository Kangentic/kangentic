import React, { useState, useEffect } from 'react';
import { useConfigStore } from '../../stores/config-store';
import type { AppConfig, PermissionMode } from '../../../shared/types';

type SettingsTab = 'general' | 'terminal' | 'claude' | 'git';

export function SettingsPage() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const claudeInfo = useConfigStore((s) => s.claudeInfo);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [shells, setShells] = useState<Array<{ name: string; path: string }>>([]);

  useEffect(() => {
    window.electronAPI.shell.getAvailable().then(setShells);
  }, []);

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'claude', label: 'Claude Code' },
    { id: 'git', label: 'Git' },
  ];

  return (
    <div className="flex-1 flex min-h-0">
      {/* Sidebar */}
      <div className="w-48 bg-zinc-800 border-r border-zinc-700 p-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`w-full text-left px-3 py-2 text-sm rounded transition-colors ${
              activeTab === tab.id
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <div className="mt-4 pt-4 border-t border-zinc-700">
          <button
            onClick={() => setSettingsOpen(false)}
            className="w-full text-left px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            &larr; Back
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-xl">
          {activeTab === 'general' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-zinc-100">General</h2>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Theme</label>
                <select
                  value={config.theme}
                  onChange={(e) => updateConfig({ theme: e.target.value as any })}
                  className="bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">System</option>
                </select>
              </div>
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-zinc-100">Terminal</h2>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Shell</label>
                <select
                  value={config.terminal.shell || ''}
                  onChange={(e) => updateConfig({ terminal: { ...config.terminal, shell: e.target.value || null } })}
                  className="bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 w-full focus:outline-none focus:border-blue-500"
                >
                  <option value="">Auto-detect</option>
                  {shells.map((s) => (
                    <option key={s.path} value={s.path}>{s.name} ({s.path})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Font Size</label>
                <input
                  type="number"
                  value={config.terminal.fontSize}
                  onChange={(e) => updateConfig({ terminal: { ...config.terminal, fontSize: Number(e.target.value) } })}
                  min={8}
                  max={32}
                  className="bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 w-24 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Font Family</label>
                <input
                  type="text"
                  value={config.terminal.fontFamily}
                  onChange={(e) => updateConfig({ terminal: { ...config.terminal, fontFamily: e.target.value } })}
                  className="bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 w-full focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          )}

          {activeTab === 'claude' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-zinc-100">Claude Code</h2>

              {claudeInfo && (
                <div className={`p-3 rounded text-sm ${claudeInfo.found ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
                  {claudeInfo.found
                    ? `Claude detected: ${claudeInfo.path} (${claudeInfo.version || 'unknown version'})`
                    : 'Claude CLI not found on PATH. Install it or set a custom path below.'}
                </div>
              )}

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Permission Mode</label>
                <select
                  value={config.claude.permissionMode}
                  onChange={(e) => updateConfig({ claude: { ...config.claude, permissionMode: e.target.value as PermissionMode } })}
                  className="bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 w-full focus:outline-none focus:border-blue-500"
                >
                  <option value="project-settings">Project Settings (default)</option>
                  <option value="plan-mode">Plan Mode (--permission-mode plan)</option>
                  <option value="dangerously-skip">Autonomous (--dangerously-skip-permissions)</option>
                  <option value="manual">Manual (interactive)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Max Concurrent Sessions</label>
                <input
                  type="number"
                  value={config.claude.maxConcurrentSessions}
                  onChange={(e) => updateConfig({ claude: { ...config.claude, maxConcurrentSessions: Number(e.target.value) } })}
                  min={1}
                  max={20}
                  className="bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 w-24 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">CLI Path Override</label>
                <input
                  type="text"
                  value={config.claude.cliPath || ''}
                  onChange={(e) => updateConfig({ claude: { ...config.claude, cliPath: e.target.value || null } })}
                  placeholder="Auto-detect from PATH"
                  className="bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 w-full placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          )}

          {activeTab === 'git' && (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-zinc-100">Git & Worktrees</h2>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="worktrees"
                  checked={config.git.worktreesEnabled}
                  onChange={(e) => updateConfig({ git: { ...config.git, worktreesEnabled: e.target.checked } })}
                  className="accent-blue-500"
                />
                <label htmlFor="worktrees" className="text-sm text-zinc-300">Enable worktrees</label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="autoCleanup"
                  checked={config.git.autoCleanup}
                  onChange={(e) => updateConfig({ git: { ...config.git, autoCleanup: e.target.checked } })}
                  className="accent-blue-500"
                />
                <label htmlFor="autoCleanup" className="text-sm text-zinc-300">Auto-cleanup worktrees on task completion</label>
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">Default Base Branch</label>
                <input
                  type="text"
                  value={config.git.defaultBaseBranch}
                  onChange={(e) => updateConfig({ git: { ...config.git, defaultBaseBranch: e.target.value } })}
                  className="bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 w-48 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
