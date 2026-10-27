import { AlertTriangle, Lock, RotateCcw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { KeybindingDefinition } from '../../../../shared/keybindings';
import { Pill } from '../../Pill';
import { Tooltip } from '../../Tooltip';
import { tipLabel } from '../../../utils/tooltip';
import { CardTile, InfoTip } from '../settings-card';
import { SETTING_LABEL_CLASS } from '../../SettingText';
import { KeyCombo } from './KeyCombo';
import { KeyCaptureInput } from './KeyCaptureInput';
import { translateText } from '../../../i18n/translate';

interface HotkeyRowProps {
  definition: KeybindingDefinition;
  /** Effective combo (override or default). */
  effective: string;
  /** True when an override is set for this action. */
  isCustom: boolean;
  /** True when this binding conflicts with another in an overlapping scope. */
  conflict: boolean;
  /** True when this binding sits on a combo the embedded terminal consumes. */
  terminalWarn: boolean;
  /** True when the probe found this combo already owned by the OS / another app. */
  taken: boolean;
  onCommit: (combo: string) => void;
  onReset: () => void;
}

/**
 * One hotkey row, in its own settings-card tile: the label (its description
 * behind an info icon, so the row stays one line beside the combo), the
 * current combo, a state pill, and (for rebindable hotkeys) the capture widget
 * plus a reset-to-default button. Non-rebindable hotkeys render read-only with
 * a lock. All controls are always visible (no hover-only affordances).
 */
export function HotkeyRow({
  definition,
  effective,
  isCustom,
  conflict,
  terminalWarn,
  taken,
  onCommit,
  onReset,
}: HotkeyRowProps) {
  const { t } = useLingui();
  const readOnly = !definition.rebindable;
  const label = translateText(definition.label);

  return (
    <CardTile className="flex items-center gap-3" testId={`hotkey-row-${definition.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          {/* The label and its info icon never split across lines: the label
              truncates instead. Only the state pills after them wrap. */}
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <span className={`${SETTING_LABEL_CLASS} truncate`}>{label}</span>
            {definition.description ? <InfoTip label={label} text={translateText(definition.description)} /> : null}
          </span>
          {conflict && (
            <Pill size="sm" className="bg-red-500/15 text-red-400" data-testid={`hotkey-conflict-${definition.id}`}>
              <AlertTriangle size={11} /> <Trans context="hotkey state">Conflict</Trans>
            </Pill>
          )}
          {!conflict && taken && (
            <Pill size="sm" className="bg-red-500/15 text-red-400" data-testid={`hotkey-taken-${definition.id}`}>
              <AlertTriangle size={11} /> <Trans>In use by another app</Trans>
            </Pill>
          )}
          {!conflict && !taken && terminalWarn && (
            <Pill size="sm" className="bg-yellow-500/15 text-yellow-400">
              <Trans>Terminal may intercept</Trans>
            </Pill>
          )}
          {!conflict && !taken && !terminalWarn && isCustom && (
            <Pill size="sm" className="bg-accent/15 text-accent">
              <Trans context="hotkey state">Custom</Trans>
            </Pill>
          )}
        </div>
      </div>

      {readOnly ? (
        <Tooltip label={t`This hotkey is fixed and cannot be rebound`}>
          <div className="flex items-center gap-2 flex-shrink-0">
            <KeyCombo combo={effective} />
            {/* Spacer matching the Rebind button so the lock aligns with the reset column. */}
            <span className="w-16" aria-hidden="true" />
            <span className="w-7 h-7 flex items-center justify-center">
              <Lock size={13} className="text-fg-disabled" />
            </span>
          </div>
        </Tooltip>
      ) : (
        <div className="flex items-center gap-2 flex-shrink-0">
          <KeyCaptureInput combo={effective} onCommit={onCommit} />
          <Tooltip label={tipLabel({ disabled: !isCustom, disabledReason: t`Already default`, tip: t`Reset to default` })}>
            <button
              onClick={onReset}
              disabled={!isCustom}
              aria-label={t`Reset to default`}
              data-testid={`hotkey-reset-${definition.id}`}
              className="w-7 h-7 flex items-center justify-center rounded text-fg-faint hover:text-fg-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-default transition-colors"
            >
              <RotateCcw size={14} />
            </button>
          </Tooltip>
        </div>
      )}
    </CardTile>
  );
}
