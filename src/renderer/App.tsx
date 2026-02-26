import React, { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { useProjectStore } from './stores/project-store';
import { useBoardStore } from './stores/board-store';
import { useConfigStore } from './stores/config-store';
import { useSessionStore } from './stores/session-store';
import { useToastStore } from './stores/toast-store';

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadCurrent = useProjectStore((s) => s.loadCurrent);
  const currentProject = useProjectStore((s) => s.currentProject);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const detectClaude = useConfigStore((s) => s.detectClaude);
  const updateSessionStatus = useSessionStore((s) => s.updateSessionStatus);
  const updateUsage = useSessionStore((s) => s.updateUsage);
  const updateActivity = useSessionStore((s) => s.updateActivity);
  const addEvent = useSessionStore((s) => s.addEvent);

  useEffect(() => {
    loadConfig();
    detectClaude();
    loadProjects();
    // Restore the current project after a page reload (e.g. Vite HMR).
    // The main process retains currentProjectId across renderer reloads.
    loadCurrent();

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
    } else {
      useBoardStore.setState({ tasks: [], swimlanes: [], archivedTasks: [] });
      useSessionStore.setState({ sessions: [], activeSessionId: null, sessionUsage: {}, sessionActivity: {}, sessionEvents: {} });
    }
  }, [currentProject]);

  // Listen for session exit events
  useEffect(() => {
    const cleanup = window.electronAPI.sessions.onExit((sessionId, exitCode) => {
      // If the session was already suspended, skip — the async PTY exit
      // event would overwrite the 'suspended' status set by suspendSession()
      const currentSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
      if (currentSession?.status === 'suspended') return;

      updateSessionStatus(sessionId, { status: 'exited', exitCode });
      // Find task associated with this session for the toast message
      const task = useBoardStore.getState().tasks.find((t) => t.session_id === sessionId);
      const label = task ? `"${task.title}"` : sessionId.slice(0, 8);
      useToastStore.getState().addToast({
        message: `Session ended for ${label} (exit ${exitCode})`,
        variant: exitCode === 0 ? 'info' : 'warning',
      });
    });
    return cleanup;
  }, []);

  // Listen for session usage data updates
  useEffect(() => {
    const cleanup = window.electronAPI.sessions.onUsage((sessionId, data) => {
      updateUsage(sessionId, data);
    });
    return cleanup;
  }, []);

  // Listen for session activity state changes (thinking/idle)
  useEffect(() => {
    const cleanup = window.electronAPI.sessions.onActivity((sessionId, state) => {
      updateActivity(sessionId, state);
    });
    return cleanup;
  }, []);

  // Listen for session events (tool calls, idle, prompt — activity log)
  useEffect(() => {
    const cleanup = window.electronAPI.sessions.onEvent((sessionId, event) => {
      addEvent(sessionId, event);
    });
    return cleanup;
  }, []);

  return <AppLayout />;
}
