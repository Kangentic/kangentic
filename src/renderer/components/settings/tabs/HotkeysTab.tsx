import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { AppConfig } from '../../../../shared/types';
import {
  KEYBINDINGS,
  KEY_GROUP_ORDER,
  detectConflicts,
  effectiveCombo,
  type KeyGroup,
} from '../../../../shared/keybindings';
import { SectionHeader, useScopedUpdate } from '../shared';
import { CountBadge } from '../../CountBadge';
import { Pill } from '../../Pill';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { HotkeyRow } from '../keybindings/HotkeyRow';
import { OsHotkeyBanner } from '../keybindings/OsHotkeyBanner';

type ProbeStatus = 'available' | 'taken' | 'unsupported';

/**
 * Hotkeys settings tab: lists every keyboard shortcut grouped by area, lets the
 * user rebind each rebindable one, flags conflicts and combos already owned by
 * the OS/another app, and resets to defaults. Overrides persist to the global
 * config (`hotkeyOverrides`). devOnly bindings appear only in dev builds.
 */
export function HotkeysTab({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  // useMemo so the empty-object fallback is stable; otherwise `?? {}` makes a
  // fresh object each render and destabilizes the hooks that depend on it.
  const overrides = useMemo(() => globalConfig.hotkeyOverrides ?? {}, [globalConfig.hotkeyOverrides]);
  // devOnly bindings (the activity debug overlay) appear only in dev builds, in
  // line with the project's __KANGENTIC_DEV__ build-exclusion convention.
  const isDev = __KANGENTIC_DEV__;
  const [showResetAll, setShowResetAll] = useState(false);
  const [probeStatus, setProbeStatus] = useState<Record<string, ProbeStatus>>({});

  const visibleDefinitions = useMemo(
    () => KEYBINDINGS.filter((definition) => !definition.hidden && (!definition.devOnly || isDev)),
    [isDev],
  );

  const conflicts = useMemo(
    () => detectConflicts(overrides, { includeDevOnly: isDev }),
    // Re-derive when the override map reference changes (after any update).
    [overrides, isDev],
  );

  const conflictIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of conflicts) {
      if (entry.severity === 'conflict') entry.ids.forEach((id) => ids.add(id));
    }
    return ids;
  }, [conflicts]);

  const terminalWarnIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of conflicts) {
      if (entry.severity === 'terminal-warn') entry.ids.forEach((id) => ids.add(id));
    }
    return ids;
  }, [conflicts]);

  const conflictComboCount = useMemo(
    () => new Set(conflicts.filter((entry) => entry.severity === 'conflict').map((entry) => entry.combo)).size,
    [conflicts],
  );

  const customCount = Object.keys(overrides).length;

  // Probe whether the current effective combos are already owned by the OS or
  // another app. Runs when the tab mounts (so a binding that silently stopped
  // working shows up here) and again after any rebind.
  useEffect(() => {
    const combos = Array.from(
      new Set(
        visibleDefinitions
          .filter((definition) => definition.rebindable)
          .map((definition) => effectiveCombo(definition.id, overrides)),
      ),
    );
    if (combos.length === 0) return;
    let cancelled = false;
    window.electronAPI.keybindings
      .probeGlobal(combos)
      .then((result) => {
        if (!cancelled) setProbeStatus(result);
      })
      .catch(() => {
        /* probe is best-effort; ignore failures */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalConfig.hotkeyOverrides, visibleDefinitions]);

  const setOverride = (id: string, combo: string) =>
    updateGlobal({ hotkeyOverrides: { ...overrides, [id]: combo } });

  const resetOne = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    updateGlobal({ hotkeyOverrides: next });
  };

  const groups = useMemo(() => {
    return KEY_GROUP_ORDER.map((group): [KeyGroup, typeof visibleDefinitions] => [
      group,
      visibleDefinitions.filter((definition) => definition.group === group),
    ]).filter(([, definitions]) => definitions.length > 0);
  }, [visibleDefinitions]);

  return (
    <div className="space-y-4" data-testid="hotkeys-tab">
      <OsHotkeyBanner />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs">
          {conflictComboCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-red-400" data-testid="hotkey-conflict-summary">
              <CountBadge count={conflictComboCount} variant="solid" size="sm" className="bg-red-500/80 text-white" />
              {conflictComboCount === 1 ? 'conflict' : 'conflicts'} detected
            </span>
          ) : customCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-fg-muted">
              <CountBadge count={customCount} variant="accent" size="sm" /> custom
            </span>
          ) : (
            <span className="text-fg-faint">All shortcuts at their defaults</span>
          )}
        </div>
        <Pill
          size="md"
          onClick={() => setShowResetAll(true)}
          className="text-fg-muted bg-surface-hover/50 hover:bg-surface-hover hover:text-fg-secondary transition-colors"
          data-testid="hotkeys-reset-all"
        >
          <RotateCcw size={14} /> Reset all to defaults
        </Pill>
      </div>

      {groups.map(([group, definitions]) => (
        <div key={group}>
          <SectionHeader label={group} />
          <div className="space-y-1">
            {definitions.map((definition) => {
              const effective = effectiveCombo(definition.id, overrides);
              return (
                <HotkeyRow
                  key={definition.id}
                  definition={definition}
                  effective={effective}
                  isCustom={definition.id in overrides}
                  conflict={conflictIds.has(definition.id)}
                  terminalWarn={terminalWarnIds.has(definition.id)}
                  taken={definition.rebindable && probeStatus[effective] === 'taken'}
                  onCommit={(combo) => setOverride(definition.id, combo)}
                  onReset={() => resetOne(definition.id)}
                />
              );
            })}
          </div>
        </div>
      ))}

      {showResetAll && (
        <ConfirmDialog
          title="Reset all shortcuts?"
          variant="warning"
          message="This restores every keyboard shortcut to its default. Your custom bindings will be removed."
          confirmLabel="Reset all"
          onConfirm={() => {
            updateGlobal({ hotkeyOverrides: {} });
            setShowResetAll(false);
          }}
          onCancel={() => setShowResetAll(false)}
        />
      )}
    </div>
  );
}
