import React, { useState, useRef, useEffect } from 'react';
import { Lock } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import type { Swimlane } from '../../../shared/types';

const PRESET_COLORS = [
  '#6b7280', '#ef4444', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
];

interface EditColumnDialogProps {
  swimlane: Swimlane;
  onClose: () => void;
}

export function EditColumnDialog({ swimlane, onClose }: EditColumnDialogProps) {
  const updateSwimlane = useBoardStore((s) => s.updateSwimlane);
  const deleteSwimlane = useBoardStore((s) => s.deleteSwimlane);
  const tasks = useBoardStore((s) => s.tasks);

  const [name, setName] = useState(swimlane.name);
  const [color, setColor] = useState(swimlane.color);
  const [isTerminal, setIsTerminal] = useState(swimlane.is_terminal);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const taskCount = tasks.filter((t) => t.swimlane_id === swimlane.id).length;
  const isLocked = swimlane.position <= 2; // Backlog (0), Planning (1), Running (2) are system columns

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await updateSwimlane({ id: swimlane.id, name: name.trim(), color, is_terminal: isTerminal });
    onClose();
  };

  const handleDelete = async () => {
    if (taskCount > 0) {
      setError(`Move or delete all ${taskCount} task${taskCount > 1 ? 's' : ''} first.`);
      setConfirmDelete(false);
      return;
    }
    try {
      await deleteSwimlane(swimlane.id);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to delete column.');
      setConfirmDelete(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 w-80 shadow-xl"
      >
        <h3 className="text-sm font-medium text-zinc-200 mb-3">Edit Column</h3>

        <input
          ref={inputRef}
          type="text"
          placeholder="Column name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500 mb-3"
        />

        {/* Color picker */}
        <div className="mb-3">
          <label className="text-xs text-zinc-400 mb-1.5 block">Color</label>
          <div className="flex gap-2 flex-wrap">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded-full border-2 transition-all ${
                  color === c ? 'border-white scale-110' : 'border-transparent hover:border-zinc-500'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {/* Terminal toggle */}
        <label className="flex items-center gap-2 mb-3 cursor-pointer">
          <input
            type="checkbox"
            checked={isTerminal}
            onChange={(e) => setIsTerminal(e.target.checked)}
            className="rounded border-zinc-600 bg-zinc-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
          />
          <span className="text-sm text-zinc-300">Terminal column</span>
          <span className="text-xs text-zinc-500">(tasks here are "done")</span>
        </label>

        {error && (
          <p className="text-xs text-red-400 mb-3">{error}</p>
        )}

        <div className="flex justify-between">
          {/* Delete button (hidden for system columns) */}
          <div>
            {isLocked ? (
              <span className="text-xs text-zinc-600 py-1.5 flex items-center gap-1">
                <Lock size={12} />
                System column
              </span>
            ) : confirmDelete ? (
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={handleDelete}
                  className="px-2 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="px-2 py-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
              >
                Delete
              </button>
            )}
          </div>

          {/* Save / Cancel */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
