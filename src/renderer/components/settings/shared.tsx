import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, RotateCcw, X } from 'lucide-react';

type Phase = 'entering' | 'visible' | 'exiting';

/* ── Panel Shell ── */

interface SettingsPanelShellProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}

export function SettingsPanelShell({ title, subtitle, onClose, children }: SettingsPanelShellProps) {
  const [phase, setPhase] = useState<Phase>('entering');
  const backdropMouseDown = useRef(false);

  const requestClose = useCallback(() => {
    if (phase !== 'exiting') setPhase('exiting');
  }, [phase]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  const handleBackdropAnimationEnd = () => {
    if (phase === 'entering') setPhase('visible');
    if (phase === 'exiting') onClose();
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

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50"
      style={{ animation: backdropAnimation }}
      onAnimationEnd={handleBackdropAnimationEnd}
      onMouseDown={(event) => { backdropMouseDown.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        if (event.target === event.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div
        className="fixed top-10 right-0 bottom-0 w-[720px] bg-surface-raised border-l border-edge shadow-2xl flex flex-col"
        style={{ animation: panelAnimation }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge flex-shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-fg">{title}</h2>
            {subtitle && (
              <>
                <span className="text-fg-faint select-none">--</span>
                <span className="text-sm text-fg-muted">{subtitle}</span>
              </>
            )}
          </div>
          <button
            onClick={requestClose}
            className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── Section Header ── */

interface SectionHeaderProps {
  label: string;
  description?: string;
  /** Adds a stronger top border for visual separation (e.g. Project Defaults). */
  prominent?: boolean;
}

export function SectionHeader({ label, description, prominent }: SectionHeaderProps) {
  return (
    <div className={prominent ? 'pt-4 mt-4 border-t-2 border-edge' : 'pt-3 mt-2'}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-faint">{label}</h3>
      {description && <p className="text-xs text-fg-disabled mt-0.5">{description}</p>}
    </div>
  );
}

/* ── Setting Row ── */

interface SettingRowProps {
  label: string;
  description: string;
  children: React.ReactNode;
  isOverridden?: boolean;
  onReset?: () => void;
  /** Muted placeholder text for the inherited default value. */
  inheritedHint?: string;
}

export function SettingRow({ label, description, children, isOverridden, onReset, inheritedHint }: SettingRowProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-fg-secondary">{label}</div>
          <div className="text-xs text-fg-faint">{description}</div>
          {inheritedHint && !isOverridden && (
            <div className="text-xs text-fg-disabled mt-0.5">Default: {inheritedHint}</div>
          )}
        </div>
        {isOverridden && onReset && (
          <button
            onClick={onReset}
            title="Reset to default"
            className="p-1 text-fg-faint hover:text-accent rounded transition-colors flex-shrink-0 mt-0.5"
            data-testid="setting-reset"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/* ── Select ── */

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
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

/* ── Toggle Switch ── */

export function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
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

/* ── Reset Overrides Footer ── */

export function ResetOverridesFooter({ onReset }: { onReset: () => void }) {
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <div className="pt-4 border-t border-edge">
      {showConfirm ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-fg-muted">Reset all project overrides to defaults?</span>
          <button
            onClick={() => { onReset(); setShowConfirm(false); }}
            className="text-xs text-red-400 hover:text-red-300 font-medium"
          >
            Confirm
          </button>
          <button
            onClick={() => setShowConfirm(false)}
            className="text-xs text-fg-muted hover:text-fg-secondary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowConfirm(true)}
          className="text-xs text-fg-muted hover:text-fg-secondary transition-colors"
        >
          Reset all project overrides
        </button>
      )}
    </div>
  );
}

/** Standard input class for text/number inputs. */
export const INPUT_CLASS = 'bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent';
