import { AlertTriangle, Lock, RotateCcw } from 'lucide-react';
import type { KeybindingDefinition } from '../../../../shared/keybindings';
import { Pill } from '../../Pill';
import { KeyCombo } from './KeyCombo';
import { KeyCaptureInput } from './KeyCaptureInput';

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
 * One hotkey row: label + description, the current combo, a state pill, and
 * (for rebindable hotkeys) the capture widget plus a reset-to-default button.
 * Non-rebindable hotkeys render read-only with a lock. All controls are always
 * visible (no hover-only affordances).
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
  const readOnly = !definition.rebindable;

  return (
    <div
      className="flex items-center gap-3 py-1.5 px-1 rounded hover:bg-surface-hover/30"
      data-testid={`hotkey-row-${definition.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-fg-secondary truncate">{definition.label}</span>
          {conflict && (
            <Pill size="sm" className="bg-red-500/15 text-red-400" data-testid={`hotkey-conflict-${definition.id}`}>
              <AlertTriangle size={11} /> Conflict
            </Pill>
          )}
          {!conflict && taken && (
            <Pill size="sm" className="bg-red-500/15 text-red-400" data-testid={`hotkey-taken-${definition.id}`}>
              <AlertTriangle size={11} /> In use by another app
            </Pill>
          )}
          {!conflict && !taken && terminalWarn && (
            <Pill size="sm" className="bg-yellow-500/15 text-yellow-400">
              Terminal may intercept
            </Pill>
          )}
          {!conflict && !taken && !terminalWarn && isCustom && (
            <Pill size="sm" className="bg-accent/15 text-accent">
              Custom
            </Pill>
          )}
        </div>
        {definition.description && (
          <div className="text-xs text-fg-faint">{definition.description}</div>
        )}
      </div>

      {readOnly ? (
        <div
          className="flex items-center gap-2 flex-shrink-0"
          title="This hotkey is fixed and cannot be rebound"
        >
          <KeyCombo combo={effective} />
          {/* Spacer matching the Rebind button so the lock aligns with the reset column. */}
          <span className="w-16" aria-hidden="true" />
          <span className="w-7 h-7 flex items-center justify-center">
            <Lock size={13} className="text-fg-disabled" />
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-shrink-0">
          <KeyCaptureInput combo={effective} onCommit={onCommit} />
          <button
            onClick={onReset}
            disabled={!isCustom}
            title={isCustom ? 'Reset to default' : 'Already default'}
            data-testid={`hotkey-reset-${definition.id}`}
            className="w-7 h-7 flex items-center justify-center rounded text-fg-faint hover:text-fg-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            <RotateCcw size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
