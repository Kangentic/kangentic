import React, { useState, useRef, useEffect } from 'react';
import { LayersPlus } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useToastStore } from '../../stores/toast-store';

export function AddColumnButton() {
  const createSwimlane = useBoardStore((s) => s.createSwimlane);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setEditing(false);
      return;
    }
    const colName = name.trim();
    await createSwimlane({ name: colName });
    useToastStore.getState().addToast({
      message: `Created column "${colName}"`,
      variant: 'info',
    });
    setName('');
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') {
      setName('');
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="flex-shrink-0 w-72 bg-surface-raised/50 rounded-lg p-3">
        <input
          ref={inputRef}
          type="text"
          placeholder="Column name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSubmit}
          className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="flex-shrink-0 w-72 h-fit bg-surface-raised/30 hover:bg-surface-raised/50 border border-dashed border-edge/40 hover:border-edge/60 rounded-lg p-4 flex items-center justify-center gap-2 text-fg-faint hover:text-fg-tertiary transition-colors cursor-pointer"
    >
      <LayersPlus size={16} />
      <span className="text-sm">Add column</span>
    </button>
  );
}
