/**
 * In-memory mock of window.electronAPI for headless UI testing.
 * Injected via page.addInitScript() before the React app mounts.
 * Provides full CRUD for projects, tasks, swimlanes, actions, and config
 * without any real backend.
 */
(function () {
  let projects = [];
  let tasks = [];
  let swimlanes = [];
  let archivedTasks = [];
  let actions = [];
  let sessions = [];
  let currentProjectId = null;

  let config = {
    theme: 'dark',
    accentColor: '#3b82f6',
    sidebarVisible: true,
    boardLayout: 'horizontal',
    terminal: {
      shell: null,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      showPreview: false,
      panelHeight: 250,
    },
    sidebar: {
      width: 224,
    },
    claude: {
      permissionMode: 'project-settings',
      cliPath: null,
      maxConcurrentSessions: 5,
      queueOverflow: 'queue',
    },
    git: {
      worktreesEnabled: true,
      autoCleanup: true,
      defaultBaseBranch: 'main',
      copyFiles: ['.env', '.env.local', '.claude/settings.local.json'],
      initScript: null,
    },
    skipDeleteConfirm: false,
  };

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function now() {
    return new Date().toISOString();
  }

  function deepMerge(base, overrides) {
    var result = Object.assign({}, base);
    for (var key in overrides) {
      if (!overrides.hasOwnProperty(key)) continue;
      var value = overrides[key];
      if (
        value !== undefined &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        result[key] !== null
      ) {
        result[key] = deepMerge(result[key], value);
      } else if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  var DEFAULT_SWIMLANES = [
    { name: 'Backlog', role: 'backlog', color: '#71717a', icon: null, is_terminal: false },
    { name: 'Planning', role: 'planning', color: '#f59e0b', icon: 'map', is_terminal: false },
    { name: 'Running', role: 'running', color: '#3b82f6', icon: 'play', is_terminal: false },
    { name: 'Review', role: null, color: '#8b5cf6', icon: null, is_terminal: false },
    { name: 'Done', role: 'done', color: '#22c55e', icon: 'check', is_terminal: true },
  ];

  function noop() {}

  window.electronAPI = {
    projects: {
      list: async function () {
        return projects;
      },
      create: async function (input) {
        var project = {
          id: uuid(),
          name: input.name,
          path: input.path,
          github_url: input.github_url || null,
          default_agent: 'claude',
          last_opened: now(),
          created_at: now(),
        };
        projects.push(project);
        return project;
      },
      delete: async function (id) {
        projects = projects.filter(function (p) {
          return p.id !== id;
        });
        if (currentProjectId === id) {
          currentProjectId = null;
          tasks = [];
          swimlanes = [];
          archivedTasks = [];
          actions = [];
          sessions = [];
        }
      },
      open: async function (id) {
        currentProjectId = id;
        // Create default swimlanes for this project if none exist
        if (swimlanes.length === 0) {
          swimlanes = DEFAULT_SWIMLANES.map(function (s, i) {
            return Object.assign({}, s, {
              id: uuid(),
              position: i,
              created_at: now(),
            });
          });
        }
        tasks = tasks; // keep existing tasks
        archivedTasks = archivedTasks;
      },
      getCurrent: async function () {
        if (!currentProjectId) return null;
        return (
          projects.find(function (p) {
            return p.id === currentProjectId;
          }) || null
        );
      },
      openByPath: async function (projectPath) {
        var name = projectPath.split('/').pop() || projectPath.split('\\').pop() || 'project';
        var existing = projects.find(function (p) { return p.path === projectPath; });
        if (existing) {
          currentProjectId = existing.id;
          return existing;
        }
        var project = {
          id: uuid(),
          name: name,
          path: projectPath,
          github_url: null,
          default_agent: 'claude',
          last_opened: now(),
          created_at: now(),
        };
        projects.push(project);
        currentProjectId = project.id;
        if (swimlanes.length === 0) {
          swimlanes = DEFAULT_SWIMLANES.map(function (s, i) {
            return Object.assign({}, s, { id: uuid(), position: i, created_at: now() });
          });
        }
        return project;
      },
      onAutoOpened: function () {
        return noop;
      },
    },

    tasks: {
      list: async function () {
        return tasks;
      },
      create: async function (input) {
        var sameColumn = tasks.filter(function (t) {
          return t.swimlane_id === input.swimlane_id;
        });
        var task = {
          id: uuid(),
          title: input.title,
          description: input.description || '',
          swimlane_id: input.swimlane_id,
          position: sameColumn.length,
          agent: null,
          session_id: null,
          worktree_path: null,
          branch_name: null,
          pr_number: null,
          pr_url: null,
          base_branch: input.baseBranch || null,
          archived_at: null,
          created_at: now(),
          updated_at: now(),
        };
        tasks.push(task);
        return task;
      },
      update: async function (input) {
        var idx = tasks.findIndex(function (t) {
          return t.id === input.id;
        });
        if (idx >= 0) {
          tasks[idx] = Object.assign({}, tasks[idx], input, { updated_at: now() });
          return tasks[idx];
        }
        var aidx = archivedTasks.findIndex(function (t) {
          return t.id === input.id;
        });
        if (aidx >= 0) {
          archivedTasks[aidx] = Object.assign({}, archivedTasks[aidx], input, {
            updated_at: now(),
          });
          return archivedTasks[aidx];
        }
        throw new Error('Task not found: ' + input.id);
      },
      delete: async function (id) {
        tasks = tasks.filter(function (t) {
          return t.id !== id;
        });
        archivedTasks = archivedTasks.filter(function (t) {
          return t.id !== id;
        });
      },
      move: async function (input) {
        var idx = tasks.findIndex(function (t) {
          return t.id === input.taskId;
        });
        if (idx >= 0) {
          tasks[idx] = Object.assign({}, tasks[idx], {
            swimlane_id: input.targetSwimlaneId,
            position: input.targetPosition,
            updated_at: now(),
          });
        }
      },
      listArchived: async function () {
        return archivedTasks;
      },
      unarchive: async function (input) {
        var idx = archivedTasks.findIndex(function (t) {
          return t.id === input.id;
        });
        if (idx < 0) throw new Error('Archived task not found: ' + input.id);
        var task = Object.assign({}, archivedTasks[idx], {
          swimlane_id: input.targetSwimlaneId,
          archived_at: null,
          position: 0,
          updated_at: now(),
        });
        archivedTasks.splice(idx, 1);
        tasks.push(task);
        return task;
      },
    },

    swimlanes: {
      list: async function () {
        return swimlanes.slice().sort(function (a, b) {
          return a.position - b.position;
        });
      },
      create: async function (input) {
        var swimlane = {
          id: uuid(),
          name: input.name,
          role: null,
          color: input.color || '#71717a',
          icon: input.icon || null,
          is_terminal: input.is_terminal || false,
          position: swimlanes.length,
          created_at: now(),
        };
        swimlanes.push(swimlane);
        return swimlane;
      },
      update: async function (input) {
        var idx = swimlanes.findIndex(function (s) {
          return s.id === input.id;
        });
        if (idx >= 0) {
          swimlanes[idx] = Object.assign({}, swimlanes[idx], input);
          return swimlanes[idx];
        }
        throw new Error('Swimlane not found: ' + input.id);
      },
      delete: async function (id) {
        swimlanes = swimlanes.filter(function (s) {
          return s.id !== id;
        });
      },
      reorder: async function (ids) {
        ids.forEach(function (id, i) {
          var idx = swimlanes.findIndex(function (s) {
            return s.id === id;
          });
          if (idx >= 0) swimlanes[idx].position = i;
        });
      },
    },

    actions: {
      list: async function () {
        return actions;
      },
      create: async function (input) {
        var action = Object.assign({ id: uuid(), created_at: now() }, input);
        actions.push(action);
        return action;
      },
      update: async function (input) {
        var idx = actions.findIndex(function (a) {
          return a.id === input.id;
        });
        if (idx >= 0) {
          actions[idx] = Object.assign({}, actions[idx], input);
          return actions[idx];
        }
        throw new Error('Action not found: ' + input.id);
      },
      delete: async function (id) {
        actions = actions.filter(function (a) {
          return a.id !== id;
        });
      },
    },

    transitions: {
      list: async function () {
        return [];
      },
      set: async function () {},
      getForTransition: async function () {
        return [];
      },
    },

    sessions: {
      spawn: async function () {
        throw new Error('Mock: session spawn not available in UI tests');
      },
      kill: async function () {},
      suspend: async function (taskId) {
        var session = sessions.find(function (s) { return s.taskId === taskId; });
        if (session) {
          session.status = 'suspended';
        }
        var task = tasks.find(function (t) { return t.id === taskId; });
        if (task) {
          task.session_id = null;
          task.updated_at = now();
        }
      },
      resume: async function (taskId) {
        var newSession = {
          id: uuid(),
          taskId: taskId,
          pid: Math.floor(Math.random() * 10000),
          status: 'running',
          shell: 'bash',
          cwd: '/mock/path',
          startedAt: now(),
          exitCode: null,
        };
        sessions.push(newSession);
        var task = tasks.find(function (t) { return t.id === taskId; });
        if (task) {
          task.session_id = newSession.id;
          task.updated_at = now();
        }
        return newSession;
      },
      write: async function () {},
      resize: async function () {},
      list: async function () {
        return sessions;
      },
      getScrollback: async function () {
        return '';
      },
      getUsage: async function () {
        return {};
      },
      onData: function () {
        return noop;
      },
      onExit: function () {
        return noop;
      },
      onUsage: function () {
        return noop;
      },
      getActivity: async function () {
        return {};
      },
      onActivity: function () {
        return noop;
      },
      getEvents: async function () {
        return [];
      },
      onEvent: function () {
        return noop;
      },
    },

    config: {
      get: async function () {
        return config;
      },
      set: async function (partial) {
        config = deepMerge(config, partial);
      },
      getProjectOverrides: async function () {
        return null;
      },
      setProjectOverrides: async function () {},
    },

    claude: {
      detect: async function () {
        return { found: false, path: null, version: null };
      },
    },

    shell: {
      getAvailable: async function () {
        return [];
      },
      getDefault: async function () {
        return 'bash';
      },
      openPath: async function () {
        return '';
      },
    },

    dialog: {
      selectFolder: async function () {
        var override = window.__mockFolderPath;
        if (override) {
          window.__mockFolderPath = null;
          return override;
        }
        return '/mock/path/test-project';
      },
    },

    window: {
      minimize: noop,
      maximize: noop,
      close: noop,
    },
  };
})();
