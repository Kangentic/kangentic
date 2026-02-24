import React, { useState } from 'react';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import type { ProjectCreateInput } from '../../../shared/types';

export function ProjectSidebar() {
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const openProject = useProjectStore((s) => s.openProject);
  const createProject = useProjectStore((s) => s.createProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');

  const handleCreate = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    const projectName = newName.trim();
    const project = await createProject({ name: projectName, path: newPath.trim() });
    useToastStore.getState().addToast({
      message: `Created project "${projectName}"`,
      variant: 'info',
    });
    await openProject(project.id);
    setShowNew(false);
    setNewName('');
    setNewPath('');
  };

  return (
    <div className="w-56 bg-zinc-800 flex flex-col flex-shrink-0">
      <div className="p-3 border-b border-zinc-700">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-300">Projects</span>
          <button
            onClick={() => setShowNew(!showNew)}
            className="text-zinc-400 hover:text-zinc-100 transition-colors text-lg leading-none"
            title="New project"
          >
            +
          </button>
        </div>
      </div>

      {showNew && (
        <div className="p-3 border-b border-zinc-700 space-y-2">
          <input
            type="text"
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
            autoFocus
          />
          <input
            type="text"
            placeholder="Project path"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded px-2 py-1 transition-colors"
            >
              Create
            </button>
            <button
              onClick={() => setShowNew(false)}
              className="flex-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-sm rounded px-2 py-1 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {projects.map((project) => (
          <button
            key={project.id}
            onClick={() => openProject(project.id)}
            className={`w-full text-left px-3 py-2 text-sm transition-colors ${
              currentProject?.id === project.id
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-750 hover:text-zinc-200'
            }`}
          >
            <div className="truncate font-medium">{project.name}</div>
            <div className="truncate text-xs text-zinc-500 mt-0.5">{project.path}</div>
          </button>
        ))}
        {projects.length === 0 && (
          <div className="p-3 text-sm text-zinc-500 text-center">
            No projects yet
          </div>
        )}
      </div>
    </div>
  );
}
