import React, { useState, useRef, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useToastStore } from '../../stores/toast-store';
import { BaseDialog } from './BaseDialog';

interface NewTaskDialogProps {
  swimlaneId: string;
  onClose: () => void;
}

export function NewTaskDialog({ swimlaneId, onClose }: NewTaskDialogProps) {
  const createTask = useBoardStore((s) => s.createTask);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const taskTitle = title.trim();
    await createTask({ title: taskTitle, description: description.trim(), swimlane_id: swimlaneId });
    useToastStore.getState().addToast({
      message: `Created task "${taskTitle}"`,
      variant: 'info',
    });
    onClose();
  };

  return (
    <form onSubmit={handleSubmit}>
      <BaseDialog
        onClose={onClose}
        title="New Task"
        icon={<Plus size={14} className="text-zinc-400" />}
        className="w-96"
        footer={
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-600 hover:border-zinc-500 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
            >
              Create
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <input
            ref={inputRef}
            type="text"
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          />
          <textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500 resize-none"
          />
        </div>
      </BaseDialog>
    </form>
  );
}
