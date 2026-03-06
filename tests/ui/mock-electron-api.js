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
  let attachments = [];
  let activityCache = {};
  let eventCache = {};
  let currentProjectId = null;

  let config = {
    theme: 'dark',
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
      permissionMode: 'default',
      cliPath: null,
      maxConcurrentSessions: 8,
      queueOverflow: 'queue',
    },
    git: {
      worktreesEnabled: true,
      autoCleanup: true,
      defaultBaseBranch: 'main',
      copyFiles: [],
      initScript: null,
    },
    skipDeleteConfirm: false,
    autoFocusIdleSession: true,
    notifyIdleOnInactiveProject: true,
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
    { name: 'Backlog', role: 'backlog', color: '#6b7280', icon: 'layers', is_archived: false, permission_strategy: null, auto_spawn: false, auto_command: null, plan_exit_target_id: null },
    { name: 'Planning', role: null, color: '#8b5cf6', icon: 'map', is_archived: false, permission_strategy: 'plan', auto_spawn: true, auto_command: null, plan_exit_target_id: '__executing__' },
    { name: 'Executing', role: null, color: '#3b82f6', icon: 'square-terminal', is_archived: false, permission_strategy: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null },
    { name: 'Code Review', role: null, color: '#f59e0b', icon: 'code', is_archived: false, permission_strategy: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null },
    { name: 'Tests', role: null, color: '#06b6d4', icon: 'flask-conical', is_archived: false, permission_strategy: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null },
    { name: 'Ship It', role: null, color: '#F97316', icon: 'sailboat', is_archived: false, permission_strategy: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null },
    { name: 'Done', role: 'done', color: '#10b981', icon: 'circle-check-big', is_archived: true, permission_strategy: null, auto_spawn: false, auto_command: null, plan_exit_target_id: null },
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
          attachments = [];
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
          // Resolve plan_exit_target_id placeholder: Planning → Executing
          var planningLane = swimlanes.find(function (s) { return s.name === 'Planning'; });
          var executingLane = swimlanes.find(function (s) { return s.name === 'Executing'; });
          if (planningLane && executingLane) {
            planningLane.plan_exit_target_id = executingLane.id;
          }
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
          // Resolve plan_exit_target_id placeholder: Planning → Executing
          var planLane = swimlanes.find(function (s) { return s.name === 'Planning'; });
          var execLane = swimlanes.find(function (s) { return s.name === 'Executing'; });
          if (planLane && execLane) {
            planLane.plan_exit_target_id = execLane.id;
          }
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
        var taskId = uuid();
        var task = {
          id: taskId,
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
          use_worktree: input.useWorktree != null ? (input.useWorktree ? 1 : 0) : null,
          archived_at: null,
          created_at: now(),
          updated_at: now(),
        };
        tasks.push(task);
        // Process pending attachments
        if (input.pendingAttachments) {
          input.pendingAttachments.forEach(function (att) {
            attachments.push({
              id: uuid(),
              task_id: taskId,
              filename: att.filename,
              file_path: '/mock/attachments/' + att.filename,
              media_type: att.media_type,
              size_bytes: att.data ? att.data.length : 0,
              created_at: now(),
            });
          });
        }
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
        attachments = attachments.filter(function (a) {
          return a.task_id !== id;
        });
      },
      move: async function (input) {
        var idx = tasks.findIndex(function (t) {
          return t.id === input.taskId;
        });
        if (idx < 0) return;

        var task = tasks[idx];
        var oldSwimlaneId = task.swimlane_id;
        var oldPosition = task.position;
        var newSwimlaneId = input.targetSwimlaneId;
        var newPosition = input.targetPosition;

        if (oldSwimlaneId === newSwimlaneId) {
          // Same-column reorder: shift positions between old and new
          var laneTasks = tasks.filter(function (t) {
            return t.swimlane_id === oldSwimlaneId;
          });
          // Remove from old position
          laneTasks.forEach(function (t) {
            if (t.id !== input.taskId && t.position > oldPosition) {
              t.position = t.position - 1;
            }
          });
          // Insert at new position
          laneTasks.forEach(function (t) {
            if (t.id !== input.taskId && t.position >= newPosition) {
              t.position = t.position + 1;
            }
          });
        } else {
          // Cross-column: close gap in source, make room in target
          tasks.forEach(function (t) {
            if (t.id !== input.taskId && t.swimlane_id === oldSwimlaneId && t.position > oldPosition) {
              t.position = t.position - 1;
            }
          });
          tasks.forEach(function (t) {
            if (t.swimlane_id === newSwimlaneId && t.position >= newPosition) {
              t.position = t.position + 1;
            }
          });
        }

        tasks[idx] = Object.assign({}, task, {
          swimlane_id: newSwimlaneId,
          position: newPosition,
          updated_at: now(),
        });
      },
      listArchived: async function () {
        return archivedTasks;
      },
      onAutoMoved: function () {
        return noop;
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

    attachments: {
      list: async function (taskId) {
        return attachments.filter(function (a) {
          return a.task_id === taskId;
        });
      },
      add: async function (input) {
        var attachment = {
          id: uuid(),
          task_id: input.task_id,
          filename: input.filename,
          file_path: '/mock/attachments/' + input.filename,
          media_type: input.media_type,
          size_bytes: input.data ? input.data.length : 0,
          created_at: now(),
        };
        attachments.push(attachment);
        return attachment;
      },
      remove: async function (id) {
        attachments = attachments.filter(function (a) {
          return a.id !== id;
        });
      },
      getDataUrl: async function (id) {
        var att = attachments.find(function (a) { return a.id === id; });
        if (!att) throw new Error('Attachment not found: ' + id);
        // Return a 1x1 transparent PNG as a data URL for testing
        return 'data:' + att.media_type + ';base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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
          is_archived: input.is_archived || false,
          permission_strategy: input.permission_strategy || null,
          auto_spawn: (input.auto_spawn !== undefined && input.auto_spawn !== null) ? input.auto_spawn : true,
          auto_command: input.auto_command || null,
          plan_exit_target_id: input.plan_exit_target_id || null,
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
          projectId: currentProjectId || '',
          pid: Math.floor(Math.random() * 10000),
          status: 'running',
          shell: 'bash',
          cwd: '/mock/path',
          startedAt: now(),
          exitCode: null,
        };
        sessions.push(newSession);
        // Default activity to 'idle' on spawn (matches real backend behavior)
        activityCache[newSession.id] = 'idle';
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
      getUsage: async function (/* projectId */) {
        return {};
      },
      onData: function () {
        return noop;
      },
      onExit: function () {
        return noop;
      },
      onStatus: function () {
        return noop;
      },
      onUsage: function () {
        return noop;
      },
      getActivity: async function (/* projectId */) {
        return Object.assign({}, activityCache);
      },
      onActivity: function () {
        return noop;
      },
      getEvents: async function (sessionId) {
        return eventCache[sessionId] || [];
      },
      getEventsCache: async function (/* projectId */) {
        return Object.assign({}, eventCache);
      },
      onEvent: function () {
        return noop;
      },
    },

    config: {
      get: async function () {
        return config;
      },
      getGlobal: async function () {
        return config;
      },
      set: async function (partial) {
        config = deepMerge(config, partial);
      },
      getProjectOverrides: async function () {
        return null;
      },
      setProjectOverrides: async function () {},
      getProjectOverridesByPath: async function () {
        return null;
      },
      setProjectOverridesByPath: async function () {},
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
      openExternal: async function () {
        return;
      },
    },

    git: {
      listBranches: async function () {
        return ['main', 'develop', 'feature/auth', 'feature/dashboard', 'fix/login-bug'];
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

    notifications: {
      show: noop,
      onClicked: function () {
        return noop;
      },
    },

    window: {
      minimize: noop,
      maximize: noop,
      close: noop,
      flashFrame: noop,
    },
  };

  /**
   * Expose mock internals for test state pre-configuration.
   * Called from addInitScript before React mounts to set up complex scenarios
   * (e.g. tasks with sessions, activity state, usage data).
   */
  window.__mockPreConfigure = function (fn) {
    var result = fn({
      projects: projects,
      tasks: tasks,
      swimlanes: swimlanes,
      sessions: sessions,
      activityCache: activityCache,
      eventCache: eventCache,
      uuid: uuid,
      now: now,
      DEFAULT_SWIMLANES: DEFAULT_SWIMLANES,
    });
    if (result && result.currentProjectId !== undefined) {
      currentProjectId = result.currentProjectId;
    }
  };
})();
