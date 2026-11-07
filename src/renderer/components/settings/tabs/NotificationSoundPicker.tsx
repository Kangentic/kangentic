import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { ChevronDown, Play } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { OverlayPopover } from '../../OverlayPopover';
import { Tooltip } from '../../Tooltip';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { previewEventSound } from '../../../utils/event-sound-player';
import { BUILT_IN_SOUNDS } from '../../../../shared/notification-settings';
import type { NotificationConfig, NotificationEventKey, NotificationSound } from '../../../../shared/types';
import { useScopedUpdate } from '../shared';

const OPTION_CLASS = 'flex h-[30px] min-w-0 flex-1 cursor-pointer select-none items-center rounded px-2.5 text-left text-[13px] text-fg-secondary hover:bg-surface-hover';

/**
 * The Sound cell of an event's row. Not the shared `Select`, which cannot hold a
 * Play button: picking a sound is mostly listening to them. The menu portals out of
 * the settings body's clip, per `popover-escapes-clipping.md`.
 */
export function NotificationSoundPicker({ eventKey, eventName, config, disabled, onRefused }: {
  eventKey: NotificationEventKey;
  /** The row's label, for the control's accessible name. */
  eventName: string;
  config: NotificationConfig;
  /** Toast and Desktop are both off, so no sound would play. The choice is kept. */
  disabled: boolean;
  /** A chosen file was refused, or null when a later pick clears that. */
  onRefused: (reason: string | null) => void;
}) {
  const { t } = useLingui();
  const updateGlobal = useScopedUpdate('global');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { style, placement } = usePopoverPosition(triggerRef, menuRef, open, { mode: 'dropdown', strategy: 'fixed' });

  const sound = config.sounds[eventKey];
  const customName = config.customSounds[eventKey];
  const builtInNames: Record<(typeof BUILT_IN_SOUNDS)[number], string> = {
    chime: t({ message: 'Chime', context: 'notification sound' }),
    rise: t({ message: 'Rise', context: 'notification sound' }),
    fall: t({ message: 'Fall', context: 'notification sound' }),
    tick: t({ message: 'Tick', context: 'notification sound' }),
  };
  const offName = t({ message: 'Off', context: 'notification sound' });
  const systemName = t({ message: 'System', context: 'notification sound' });
  const namedSounds: Record<Exclude<NotificationSound, 'custom'>, string> = { ...builtInNames, off: offName, system: systemName };
  const valueName = sound === 'custom' ? (customName ?? offName) : namedSounds[sound];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    // An open menu takes Escape first, or the settings panel closes under it.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsideClick, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selected = menuRef.current?.querySelector<HTMLButtonElement>('[data-sound-selected="true"]');
    (selected ?? menuRef.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [open]);

  const choose = (next: NotificationSound) => {
    onRefused(null);
    setOpen(false);
    updateGlobal({ notifications: { sounds: { [eventKey]: next } } });
    if (next !== 'off' && next !== 'system') previewEventSound(eventKey, next);
  };

  const chooseFile = async () => {
    setOpen(false);
    onRefused(null);
    try {
      const result = await window.electronAPI.notifications.pickSound(eventKey);
      if (result.status === 'refused') onRefused(result.reason);
      if (result.status !== 'picked') return;
      updateGlobal({ notifications: { sounds: { [eventKey]: 'custom' }, customSounds: { [eventKey]: result.fileName } } });
      previewEventSound(eventKey, 'custom');
    } catch (error) {
      onRefused(error instanceof Error ? error.message : String(error));
    }
  };

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const options = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    options[(current + step + options.length) % options.length]?.focus();
  };

  const optionRow = (value: NotificationSound, name: string, playable: boolean) => (
    <div key={value} className={`flex items-center gap-1 rounded pr-1.5 ${value === sound ? 'bg-surface-hover' : ''}`}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={value === sound}
        data-sound-selected={value === sound}
        data-testid={`notify-sound-option-${value}`}
        className={OPTION_CLASS}
        onClick={() => choose(value)}
      >
        {name}
      </button>
      {playable ? (
        <button
          type="button"
          aria-label={t`Play ${name}`}
          data-testid={`notify-sound-play-${value}`}
          className="flex h-[22px] w-[22px] flex-shrink-0 cursor-pointer items-center justify-center rounded text-fg-muted hover:text-fg-secondary"
          onClick={() => previewEventSound(eventKey, value)}
        >
          <Play size={12} />
        </button>
      ) : null}
    </div>
  );

  const cutShortTip = sound === 'custom' ? (customName ?? '') : '';
  return (
    <>
      <Tooltip label={disabled ? t`Turn on Toast or Desktop to hear a sound` : cutShortTip}>
        <span className="inline-flex">
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            aria-label={t`${eventName} sound: ${valueName}`}
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid={`notify-sound-${eventKey}`}
            onClick={() => setOpen((wasOpen) => !wasOpen)}
            className={`flex h-7 w-32 cursor-pointer select-none items-center justify-between gap-1 rounded border bg-surface-control pl-2 pr-1.5 text-xs disabled:cursor-default disabled:opacity-50 ${open ? 'border-accent' : 'border-edge-input'} ${sound === 'off' ? 'text-fg-muted' : 'text-fg-secondary'}`}
          >
            <span className="min-w-0 truncate">{valueName}</span>
            <ChevronDown size={12} className="flex-shrink-0" />
          </button>
        </span>
      </Tooltip>
      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
        role="menu"
        className="fixed z-[2147483646] max-h-[min(320px,var(--popover-available-height,320px))] w-[230px] overflow-y-auto rounded-md border border-edge-input bg-surface-raised p-1 shadow-xl"
        data-testid={`notify-sound-menu-${eventKey}`}
      >
        <div onKeyDown={moveFocus}>
          {optionRow('off', offName, false)}
          <div className="my-1 border-t border-edge" />
          {BUILT_IN_SOUNDS.map((builtIn) => optionRow(builtIn, builtInNames[builtIn], true))}
          <div className="my-1 border-t border-edge" />
          {optionRow('system', systemName, false)}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={sound === 'custom'}
            data-sound-selected={sound === 'custom'}
            data-testid="notify-sound-option-custom"
            className={`${OPTION_CLASS} w-full ${sound === 'custom' ? 'bg-surface-hover' : ''}`}
            onClick={() => { void chooseFile(); }}
          >
            {t`Custom file...`}
          </button>
        </div>
      </OverlayPopover>
    </>
  );
}
