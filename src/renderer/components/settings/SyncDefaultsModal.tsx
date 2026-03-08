import React, { useEffect, useState } from 'react';

interface SyncDefaultsModalProps {
  onConfirm: (syncToProjects: boolean, dontAskAgain: boolean) => void;
  onCancel: () => void;
}

export function SyncDefaultsModal({ onConfirm, onCancel }: SyncDefaultsModalProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center" onClick={onCancel}>
      <div
        className="bg-surface-raised border border-edge rounded-lg shadow-xl w-[420px] p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-fg mb-2">Apply to existing projects?</h3>
        <p className="text-xs text-fg-muted mb-4">
          Projects with custom overrides for this setting will also be updated.
        </p>
        <label className="flex items-center gap-2 text-xs text-fg-muted mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
            className="rounded"
          />
          Don't ask again for future changes
        </label>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => onConfirm(false, dontAskAgain)}
            className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg-secondary rounded border border-edge hover:bg-surface-hover transition-colors"
          >
            New Projects Only
          </button>
          <button
            onClick={() => onConfirm(true, dontAskAgain)}
            className="px-3 py-1.5 text-xs text-white bg-accent hover:bg-accent/80 rounded transition-colors"
            data-testid="sync-apply-all"
          >
            Apply to All
          </button>
        </div>
      </div>
    </div>
  );
}
