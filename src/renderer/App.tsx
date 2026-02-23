import React, { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { useProjectStore } from './stores/project-store';
import { useBoardStore } from './stores/board-store';
import { useConfigStore } from './stores/config-store';
import { useSessionStore } from './stores/session-store';

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const detectClaude = useConfigStore((s) => s.detectClaude);
  const updateSessionStatus = useSessionStore((s) => s.updateSessionStatus);

  useEffect(() => {
    loadConfig();
    detectClaude();
    loadProjects();

    // Listen for auto-opened project (from --cwd CLI arg)
    const cleanup = window.electronAPI.projects.onAutoOpened((project) => {
      useProjectStore.setState({ currentProject: project });
      // Refresh the project list to include the auto-opened project
      loadProjects();
    });
    return cleanup;
  }, []);

  useEffect(() => {
    if (currentProject) {
      loadBoard();
      useSessionStore.getState().loadSessions();
    }
  }, [currentProject]);

  // Listen for session exit events
  useEffect(() => {
    const cleanup = window.electronAPI.sessions.onExit((sessionId, exitCode) => {
      updateSessionStatus(sessionId, { status: 'exited', exitCode });
    });
    return cleanup;
  }, []);

  return <AppLayout />;
}
