import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, CircleAlert, GitBranch, Palette, SlidersHorizontal, Terminal, X } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import type { PermissionMode, ThemeMode } from '../../../shared/types';
import { NAMED_THEMES } from '../../../shared/types';

type Phase = 'entering' | 'visible' | 'exiting';
type SettingsTab = 'appearance' | 'terminal' | 'agent' | 'git' | 'behavior';

const tabs: Array<{ id: SettingsTab; label: string; icon: React.ElementType }> = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal },
];

export function SettingsPanel() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const claudeInfo = useConfigStore((s) => s.claudeInfo);
  const detectClaude = useConfigStore((s) => s.detectClaude);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const [shells, setShells] = useState<Array<{ name: string; path: string }>>([]);
  const [phase, setPhase] = useState<Phase>('entering');
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    window.electronAPI.shell.getAvailable().then(setShells);
    detectClaude();
  }, []);

  const requestClose = useCallback(() => {
    if (phase !== 'exiting') setPhase('exiting');
  }, [phase]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  const handleBackdropAnimationEnd = () => {
    if (phase === 'entering') setPhase('visible');
    if (phase === 'exiting') setSettingsOpen(false);
  };

  const backdropAnimation = phase === 'entering'
    ? 'dialog-backdrop-in 200ms ease-out forwards'
    : phase === 'exiting'
      ? 'dialog-backdrop-out 150ms ease-in forwards'
      : 'none';

  const panelAnimation = phase === 'entering'
    ? 'settings-panel-in 200ms ease-out forwards'
    : phase === 'exiting'
      ? 'settings-panel-out 150ms ease-in forwards'
      : 'none';

  const inputClass = 'bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent';

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50"
      style={{ animation: backdropAnimation }}
      onAnimationEnd={handleBackdropAnimationEnd}
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div
        className="fixed top-10 right-0 bottom-0 w-[720px] bg-surface-raised border-l border-edge shadow-2xl flex flex-col"
        style={{ animation: panelAnimation }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge flex-shrink-0">
          <h2 className="text-base font-semibold text-fg">Settings</h2>
          <button
            onClick={requestClose}
            className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Two-column body */}
        <div className="flex flex-1 min-h-0">
          {/* Tab sidebar */}
          <div className="w-44 bg-surface-raised border-r border-edge p-2 flex-shrink-0">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded text-base text-left transition-colors ${
                    isActive
                      ? 'bg-surface-hover text-fg'
                      : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-hover/50'
                  }`}
                >
                  <Icon size={18} />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
            {activeTab === 'appearance' && (
              <>
                <SettingRow label="Theme" description="Color scheme for the interface">
                  <Select
                    value={config.theme}
                    onChange={(e) => updateConfig({ theme: e.target.value as ThemeMode })}
                  >
                    <optgroup label="Standard">
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </optgroup>
                    <optgroup label="Dark Palette">
                      {NAMED_THEMES.filter(t => t.base === 'dark').map(t => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Light Palette">
                      {NAMED_THEMES.filter(t => t.base === 'light').map(t => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </optgroup>
                  </Select>
                </SettingRow>
              </>
            )}

            {activeTab === 'terminal' && (
              <>
                <SettingRow label="Shell" description="Terminal shell used for agent sessions">
                  <Select
                    value={config.terminal.shell || ''}
                    onChange={(e) => updateConfig({ terminal: { ...config.terminal, shell: e.target.value || null } })}
                  >
                    <option value="">Auto-detect</option>
                    {shells.map((s) => (
                      <option key={s.path} value={s.path}>{s.name}</option>
                    ))}
                  </Select>
                </SettingRow>
                <SettingRow label="Font Size" description="Terminal text size in pixels">
                  <input
                    type="number"
                    value={config.terminal.fontSize}
                    onChange={(e) => updateConfig({ terminal: { ...config.terminal, fontSize: Number(e.target.value) } })}
                    min={8}
                    max={32}
                    className={inputClass}
                  />
                </SettingRow>
                <SettingRow label="Font Family" description="CSS font-family for the terminal">
                  <input
                    type="text"
                    value={config.terminal.fontFamily}
                    onChange={(e) => updateConfig({ terminal: { ...config.terminal, fontFamily: e.target.value } })}
                    className={inputClass}
                  />
                </SettingRow>
              </>
            )}

            {activeTab === 'agent' && (
              <>
                <SettingRow label="Permissions" description="How Claude handles tool approvals">
                  <Select
                    value={config.claude.permissionMode}
                    onChange={(e) => updateConfig({ claude: { ...config.claude, permissionMode: e.target.value as PermissionMode } })}
                  >
                    <option value="project-settings">Allowlist (default)</option>
                    <option value="dangerously-skip">Bypass Permissions</option>
                  </Select>
                </SettingRow>
                <SettingRow label="Max Concurrent Sessions" description="Limit how many agents can run at the same time">
                  <input
                    type="number"
                    value={config.claude.maxConcurrentSessions}
                    onChange={(e) => updateConfig({ claude: { ...config.claude, maxConcurrentSessions: Number(e.target.value) } })}
                    min={1}
                    max={20}
                    className={inputClass}
                  />
                </SettingRow>
                <SettingRow label="When Max Sessions Reached" description="How new agent requests are handled when all slots are in use">
                  <Select
                    value={config.claude.queueOverflow}
                    onChange={(e) => updateConfig({ claude: { ...config.claude, queueOverflow: e.target.value as 'queue' | 'reject' } })}
                  >
                    <option value="queue">Queue</option>
                    <option value="reject">Reject</option>
                  </Select>
                </SettingRow>
                <SettingRow label="CLI Path" description="Path to Claude CLI binary (auto-detected if empty)">
                  <div className="relative">
                    <input
                      type="text"
                      value={config.claude.cliPath || ''}
                      onChange={(e) => updateConfig({ claude: { ...config.claude, cliPath: e.target.value || null } })}
                      placeholder={claudeInfo?.found ? (claudeInfo.path ?? undefined) : 'Not found — enter path manually'}
                      className={`${inputClass} pr-8 ${claudeInfo?.found ? 'placeholder-fg-muted' : 'placeholder-red-400/70'}`}
                    />
                    {claudeInfo && (
                      <div className="absolute right-2.5 top-1/2 -translate-y-1/2" title={claudeInfo.found ? `Detected: ${claudeInfo.version || 'unknown version'}` : 'Claude CLI not found'}>
                        {claudeInfo.found
                          ? <Check size={16} className="text-green-400" />
                          : <CircleAlert size={16} className="text-red-400" />}
                      </div>
                    )}
                  </div>
                </SettingRow>
              </>
            )}

            {activeTab === 'git' && (
              <>
                <SettingRow label="Enable Worktrees" description="Create git worktrees for agent tasks">
                  <ToggleSwitch
                    checked={config.git.worktreesEnabled}
                    onChange={(v) => updateConfig({ git: { ...config.git, worktreesEnabled: v } })}
                  />
                </SettingRow>
                <SettingRow label="Auto-cleanup" description="Remove worktrees when tasks complete">
                  <ToggleSwitch
                    checked={config.git.autoCleanup}
                    onChange={(v) => updateConfig({ git: { ...config.git, autoCleanup: v } })}
                  />
                </SettingRow>
                <SettingRow label="Default Base Branch" description="Branch to create worktrees from">
                  <input
                    type="text"
                    value={config.git.defaultBaseBranch}
                    onChange={(e) => updateConfig({ git: { ...config.git, defaultBaseBranch: e.target.value } })}
                    className={inputClass}
                  />
                </SettingRow>
                <SettingRow label="Copy Files" description="Comma-separated files copied into each worktree">
                  <input
                    type="text"
                    value={config.git.copyFiles.join(', ')}
                    onChange={(e) => {
                      const files = e.target.value.split(',').map((f) => f.trim()).filter(Boolean);
                      updateConfig({ git: { ...config.git, copyFiles: files } });
                    }}
                    placeholder=".env, .env.local"
                    className={`${inputClass} placeholder-fg-faint`}
                  />
                </SettingRow>
                <SettingRow label="Post-Worktree Script" description="Shell script to run after worktree creation">
                  <input
                    type="text"
                    value={config.git.initScript || ''}
                    onChange={(e) => updateConfig({ git: { ...config.git, initScript: e.target.value || null } })}
                    placeholder="npm install"
                    className={`${inputClass} placeholder-fg-faint`}
                  />
                </SettingRow>
              </>
            )}

            {activeTab === 'behavior' && (
              <>
                <SettingRow label="Skip Task Delete Confirmation" description="Delete tasks immediately without a confirmation dialog">
                  <ToggleSwitch
                    checked={config.skipDeleteConfirm}
                    onChange={(v) => updateConfig({ skipDeleteConfirm: v })}
                  />
                </SettingRow>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Helper: Setting Row ── */

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <div className="text-sm font-medium text-fg-secondary">{label}</div>
        <div className="text-xs text-fg-faint">{description}</div>
      </div>
      {children}
    </div>
  );
}

/* ── Helper: Custom Select ── */

function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className="appearance-none bg-surface-hover border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent"
      >
        {children}
      </select>
      <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
    </div>
  );
}

/* ── Helper: Toggle Switch ── */

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-edge-input'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}
