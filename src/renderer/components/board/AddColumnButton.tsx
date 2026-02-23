import React, { useState, useRef, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';

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
    await createSwimlane({ name: name.trim() });
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
      <div className="flex-shrink-0 w-72 bg-zinc-800/50 rounded-lg p-3">
        <input
          ref={inputRef}
          type="text"
          placeholder="Column name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSubmit}
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="flex-shrink-0 w-72 h-fit bg-zinc-800/30 hover:bg-zinc-800/50 border border-dashed border-zinc-700 hover:border-zinc-600 rounded-lg p-4 flex items-center justify-center gap-2 text-zinc-500 hover:text-zinc-300 transition-colors"
    >
      <Plus size={16} />
      <span className="text-sm">Add column</span>
    </button>
  );
}
