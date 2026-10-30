import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { AppWindow, Bug, FileDiff, Globe, Keyboard, Mic, PanelTop, RotateCcw, SquareTerminal } from 'lucide-react';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { AppConfig } from '../../../../shared/types';
import {
  KEYBINDINGS,
  KEY_GROUP_ORDER,
  detectConflicts,
  effectiveCombo,
  type KeyGroup,
} from '../../../../shared/keybindings';
import { IS_MAC } from '../../../utils/keybindings';
import { useScopedUpdate } from '../shared';
import { SettingsCard } from '../settings-card';
import { CountBadge } from '../../CountBadge';
import { Pill } from '../../Pill';
import { Tooltip } from '../../Tooltip';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { HotkeyRow } from '../keybindings/HotkeyRow';
import { OsHotkeyBanner } from '../keybindings/OsHotkeyBanner';

type ProbeStatus = 'available' | 'taken' | 'unsupported';

/**
 * Each hotkey group's card. Keyed by the group id, so a new `KeyGroup` fails to
 * compile until it has a card; the ids stay as they are, since the registry
 * groups by them. The label and description are descriptors, translated where
 * the card renders.
 */
const HOTKEY_GROUP_CARDS = {
  'General': { label: msg`General`, description: msg`Hotkeys that work anywhere in the app.`, icon: <Keyboard size={16} /> },
  'Dictation': { label: msg`Dictation`, description: msg`Push-to-talk and the other dictation keys.`, icon: <Mic size={16} /> },
  'Task Detail': { label: msg`Task detail`, description: msg`Keys for an open task window.`, icon: <PanelTop size={16} /> },
  'Git Changes': { label: msg`Git changes`, description: msg`Keys for the Changes panel and its diff.`, icon: <FileDiff size={16} /> },
  'Windows': { label: msg({ message: 'Windows', context: 'task windows' }), description: msg`Moving between task windows and arranging them.`, icon: <AppWindow size={16} /> },
  'Browser': { label: msg`Browser`, description: msg`Keys for a task's Browser pane.`, icon: <Globe size={16} /> },
  'Terminal': { label: msg`Terminal`, description: msg`Copy, paste and interrupt inside a terminal.`, icon: <SquareTerminal size={16} /> },
  'Developer': { label: msg`Developer`, description: msg`Debug tools in development builds.`, icon: <Bug size={16} /> },
} satisfies Record<KeyGroup, { label: MessageDescriptor; description: MessageDescriptor; icon: React.ReactNode }>;

/**
 * Hotkeys settings tab: lists every keyboard hotkey grouped by area, lets the
 * user rebind each rebindable one, flags conflicts and combos already owned by
 * the OS/another app, and resets to defaults. Overrides persist to the global
 * config (`hotkeyOverrides`). devOnly bindings appear only in dev builds.
 */
export function HotkeysTab({ globalConfig }: { globalConfig: AppConfig }) {
  const { t, i18n } = useLingui();
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
    // Off macOS, Mod and literal Ctrl are one key, so a rebind captured as Mod+Tab
    // must clash with the Ctrl+Tab default.
    () => detectConflicts(overrides, { includeDevOnly: isDev, modIsCtrl: !IS_MAC }),
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
          .map((definition) => effectiveCombo(definition.id, overrides))
          // An unbound action has nothing to probe.
          .filter((combo) => combo !== ''),
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
      <SettingsCard
        icon={<Keyboard size={16} />}
        label={t`Hotkeys`}
        description={t`Rebind any hotkey. Conflicts and taken combos are flagged.`}
        searchIds={['hotkeys']}
      >
        {/* One tile: the notice, Reset to default on its right edge, and the conflict
            count under the notice while there are conflicts. A disabled Reset
            says every hotkey is at its default, so no line repeats that. */}
        <OsHotkeyBanner
          status={conflictComboCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-red-400" data-testid="hotkey-conflict-summary">
              <Plural value={conflictComboCount} one="Conflict detected" other="Conflicts detected" />
              <CountBadge count={conflictComboCount} variant="tinted" size="pill" testId="hotkey-conflict-count" />
            </span>
          ) : undefined}
          action={(
            <Tooltip label={customCount === 0 ? t`Every hotkey is at its default` : t`Restore every hotkey to its default`}>
              <Pill
                size="md"
                onClick={() => setShowResetAll(true)}
                disabled={customCount === 0}
                className="text-fg-muted bg-surface-hover/50 enabled:hover:bg-surface-hover enabled:hover:text-fg-secondary disabled:opacity-40 disabled:cursor-default transition-colors"
                data-testid="hotkeys-reset-all"
              >
                <RotateCcw size={14} /> <Trans>Reset to default</Trans>
              </Pill>
            </Tooltip>
          )}
        />
      </SettingsCard>

      {groups.map(([group, definitions]) => (
        <SettingsCard
          key={group}
          icon={HOTKEY_GROUP_CARDS[group].icon}
          label={i18n._(HOTKEY_GROUP_CARDS[group].label)}
          description={i18n._(HOTKEY_GROUP_CARDS[group].description)}
          searchIds={['hotkeys']}
          testId={`hotkey-group-${group}`}
        >
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
        </SettingsCard>
      ))}

      {showResetAll && (
        <ConfirmDialog
          title={t`Reset all hotkeys?`}
          variant="warning"
          message={t`This restores every hotkey to its default. Your custom bindings will be removed.`}
          confirmLabel={t`Reset all`}
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
