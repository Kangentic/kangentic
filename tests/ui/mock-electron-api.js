/**
 * In-memory mock of window.electronAPI for headless UI testing.
 * Injected via page.addInitScript() before the React app mounts.
 * Provides full CRUD for projects, tasks, swimlanes, actions, and config
 * without any real backend.
 */
(function () {
  let projects = [];
  let projectGroups = [];
  let tasks = [];
  let swimlanes = [];
  let archivedTasks = [];
  let actions = [];
  let sessions = [];
  let attachments = [];
  let backlogItems = [];
  let activityCache = {};
  let eventCache = {};
  let summaryCache = {};
  let currentProjectId = null;
  let projectConfigs = {};

  let config = Object.assign({
    theme: 'dark',
    sidebarVisible: true,
    boardLayout: 'horizontal',
    terminal: {
      shell: null,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      showPreview: false,
      panelHeight: 250,
      scrollbackLines: 5000,
      cursorStyle: 'block',
    },
    sidebar: {
      width: 224,
    },
    claude: {
      permissionMode: 'default',
      cliPath: null,
      maxConcurrentSessions: 8,
      queueOverflow: 'queue',
      idleTimeoutMinutes: 0,
    },
    git: {
      worktreesEnabled: true,
      autoCleanup: true,
      defaultBaseBranch: 'main',
      copyFiles: [],
      initScript: null,
    },
    mcpServer: {
      enabled: true,
    },
    contextBar: {
      showShell: true,
      showVersion: true,
      showModel: true,
      showCost: true,
      showTokens: true,
      showContextFraction: true,
      showProgressBar: true,
    },
    notifications: {
      desktop: {
        onAgentIdle: true,
        onAgentCrash: true,
        onPlanComplete: true,
      },
      toasts: {
        onAgentIdle: true,
        onAgentCrash: true,
        onPlanComplete: true,
        durationSeconds: 4,
        maxCount: 5,
      },
      cooldownSeconds: 10,
    },
    hasCompletedFirstRun: true,
    showBoardSearch: true,
    skipDeleteConfirm: false,
    skipBoardConfigConfirm: false,
    autoFocusIdleSession: true,
    activateAllProjectsOnStartup: true,
    restoreWindowPosition: true,
    windowBounds: null,
  }, window.__mockConfigOverrides || {});

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

  function getAttachmentCount(taskId) {
    return attachments.filter(function (a) { return a.task_id === taskId; }).length;
  }

  function withAttachmentCount(task) {
    return Object.assign({}, task, { attachment_count: getAttachmentCount(task.id) });
  }

  function withAttachmentCounts(taskList) {
    return taskList.map(withAttachmentCount);
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

  /** Snapshot the project-overridable subset of global config.
   *  KEEP IN SYNC with ConfigManager.getProjectOverridableDefaults() in src/main/config/config-manager.ts */
  function snapshotOverridableDefaults() {
    return {
      theme: config.theme,
      terminal: {
        shell: config.terminal.shell,
        fontSize: config.terminal.fontSize,
        fontFamily: config.terminal.fontFamily,
        scrollbackLines: config.terminal.scrollbackLines,
        cursorStyle: config.terminal.cursorStyle,
      },
      claude: {
        permissionMode: config.claude.permissionMode,
      },
      git: {
        worktreesEnabled: config.git.worktreesEnabled,
        autoCleanup: config.git.autoCleanup,
        defaultBaseBranch: config.git.defaultBaseBranch,
        copyFiles: config.git.copyFiles.slice(),
        initScript: config.git.initScript,
      },
    };
  }

  /** Clone settings from the most recently opened project that has overrides.
   *  Falls back to snapshotOverridableDefaults() if no projects have overrides.
   *  KEEP IN SYNC with getLastProjectOverrides() in src/main/ipc/handlers/projects.ts */
  function getLastProjectDefaults(excludePath) {
    var sorted = projects.slice().sort(function (a, b) {
      return (b.last_opened || '').localeCompare(a.last_opened || '');
    });
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].path === excludePath) continue;
      var overrides = projectConfigs[sorted[i].path];
      if (overrides && Object.keys(overrides).length > 0) return overrides;
    }
    return snapshotOverridableDefaults();
  }

  var DEFAULT_SWIMLANES = [
    { name: 'To Do', role: 'todo', color: '#6b7280', icon: 'layers', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: false, auto_command: null, plan_exit_target_id: null },
    { name: 'Planning', role: null, color: '#8b5cf6', icon: 'map', is_archived: false, is_ghost: false, permission_mode: 'plan', auto_spawn: true, auto_command: null, plan_exit_target_id: '__executing__' },
    { name: 'Executing', role: null, color: '#3b82f6', icon: 'square-terminal', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null },
    { name: 'Code Review', role: null, color: '#f59e0b', icon: 'code', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null },
    { name: 'Tests', role: null, color: '#06b6d4', icon: 'flask-conical', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null },
    { name: 'Ship It', role: null, color: '#F97316', icon: 'sailboat', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null },
    { name: 'Done', role: 'done', color: '#10b981', icon: 'circle-check-big', is_archived: true, is_ghost: false, permission_mode: null, auto_spawn: false, auto_command: null, plan_exit_target_id: null },
  ];

  function noop() {}

  window.electronAPI = {
    projects: {
      list: async function () {
        return projects.slice().sort(function (a, b) { return a.position - b.position; });
      },
      create: async function (input) {
        // Shift existing projects down
        projects.forEach(function (p) { p.position = p.position + 1; });
        var project = {
          id: uuid(),
          name: input.name,
          path: input.path,
          github_url: input.github_url || null,
          default_agent: 'claude',
          group_id: null,
          position: 0,
          last_opened: now(),
          created_at: now(),
        };
        projects.push(project);
        // Clone settings from the last modified project (or global defaults)
        projectConfigs[project.path] = getLastProjectDefaults(project.path);
        return project;
      },
      delete: async function (id) {
        var deletedProject = projects.find(function (p) { return p.id === id; });
        projects = projects.filter(function (p) {
          return p.id !== id;
        });
        // Reindex positions to keep contiguous
        projects.sort(function (a, b) { return a.position - b.position; });
        projects.forEach(function (p, i) { p.position = i; });
        if (deletedProject) {
          delete projectConfigs[deletedProject.path];
        }
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
        // Shift existing projects down
        projects.forEach(function (p) { p.position = p.position + 1; });
        var project = {
          id: uuid(),
          name: name,
          path: projectPath,
          github_url: null,
          default_agent: 'claude',
          group_id: null,
          position: 0,
          last_opened: now(),
          created_at: now(),
        };
        projects.push(project);
        // Clone settings from the last modified project (or global defaults)
        projectConfigs[project.path] = getLastProjectDefaults(project.path);
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
      reorder: async function (ids) {
        ids.forEach(function (id, i) {
          var idx = projects.findIndex(function (p) {
            return p.id === id;
          });
          if (idx >= 0) projects[idx].position = i;
        });
      },
      rename: async function (id, name) {
        var idx = projects.findIndex(function (p) { return p.id === id; });
        if (idx >= 0) {
          projects[idx].name = name;
          return Object.assign({}, projects[idx]);
        }
        throw new Error('Project not found: ' + id);
      },
      setGroup: async function (projectId, groupId) {
        var idx = projects.findIndex(function (p) { return p.id === projectId; });
        if (idx >= 0) projects[idx].group_id = groupId;
      },
      onAutoOpened: function () {
        return noop;
      },
    },

    projectGroups: {
      list: async function () {
        return projectGroups.slice().sort(function (a, b) { return a.position - b.position; });
      },
      create: async function (input) {
        var maxPos = projectGroups.reduce(function (max, g) { return Math.max(max, g.position); }, -1);
        var group = {
          id: uuid(),
          name: input.name,
          position: maxPos + 1,
          is_collapsed: false,
        };
        projectGroups.push(group);
        return group;
      },
      update: async function (id, name) {
        var idx = projectGroups.findIndex(function (g) { return g.id === id; });
        if (idx < 0) throw new Error('Project group not found: ' + id);
        projectGroups[idx] = Object.assign({}, projectGroups[idx], { name: name });
        return projectGroups[idx];
      },
      delete: async function (id) {
        // Ungroup projects
        projects.forEach(function (p) {
          if (p.group_id === id) p.group_id = null;
        });
        projectGroups = projectGroups.filter(function (g) { return g.id !== id; });
        // Reindex positions
        projectGroups.sort(function (a, b) { return a.position - b.position; });
        projectGroups.forEach(function (g, i) { g.position = i; });
      },
      reorder: async function (ids) {
        ids.forEach(function (id, i) {
          var idx = projectGroups.findIndex(function (g) { return g.id === id; });
          if (idx >= 0) projectGroups[idx].position = i;
        });
      },
      setCollapsed: async function (id, collapsed) {
        var idx = projectGroups.findIndex(function (g) { return g.id === id; });
        if (idx >= 0) projectGroups[idx].is_collapsed = collapsed;
      },
    },

    tasks: {
      list: async function () {
        return withAttachmentCounts(tasks);
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
          branch_name: input.customBranchName || null,
          pr_number: null,
          pr_url: null,
          base_branch: input.baseBranch || null,
          use_worktree: input.useWorktree != null ? (input.useWorktree ? 1 : 0) : null,
          attachment_count: 0,
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
        return withAttachmentCount(task);
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
        return withAttachmentCounts(archivedTasks);
      },
      onAutoMoved: function () {
        return noop;
      },
      onCreatedByAgent: function () {
        return noop;
      },
      onUpdatedByAgent: function () {
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
      bulkDelete: async function (ids) {
        for (var i = 0; i < ids.length; i++) {
          var idx = archivedTasks.findIndex(function (t) { return t.id === ids[i]; });
          if (idx >= 0) archivedTasks.splice(idx, 1);
          var tIdx = tasks.findIndex(function (t) { return t.id === ids[i]; });
          if (tIdx >= 0) tasks.splice(tIdx, 1);
        }
      },
      switchBranch: async function (input) {
        var idx = tasks.findIndex(function (t) { return t.id === input.taskId; });
        if (idx < 0) throw new Error('Task not found: ' + input.taskId);
        var task = tasks[idx];
        var updates = { base_branch: input.newBaseBranch || null, updated_at: now() };
        if (input.enableWorktree && !task.worktree_path) {
          updates.worktree_path = '/mock/worktrees/' + task.id.slice(0, 8);
          updates.branch_name = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + task.id.slice(0, 8);
          updates.use_worktree = 1;
        }
        tasks[idx] = Object.assign({}, task, updates);
        return withAttachmentCount(tasks[idx]);
      },
      bulkUnarchive: async function (ids, targetSwimlaneId) {
        for (var i = 0; i < ids.length; i++) {
          var idx = archivedTasks.findIndex(function (t) { return t.id === ids[i]; });
          if (idx >= 0) {
            var task = Object.assign({}, archivedTasks[idx], {
              swimlane_id: targetSwimlaneId,
              archived_at: null,
              position: 0,
              updated_at: now(),
            });
            archivedTasks.splice(idx, 1);
            tasks.push(task);
          }
        }
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
          is_ghost: input.is_ghost || false,
          permission_mode: input.permission_mode || null,
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
      resume: async function (taskId, resumePrompt) {
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
          resuming: true,
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
      onFirstOutput: function () {
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
      onIdleTimeout: function () {
        return noop;
      },
      getSummary: async function (taskId) {
        return summaryCache[taskId] || null;
      },
      listSummaries: async function () {
        return Object.assign({}, summaryCache);
      },
      spawnTransient: async function (input) {
        var id = crypto.randomUUID();
        var session = {
          id: id,
          taskId: id,
          projectId: input.projectId,
          pid: null,
          status: 'running',
          shell: '/bin/bash',
          cwd: '/mock/project',
          startedAt: new Date().toISOString(),
          exitCode: null,
          resuming: false,
          transient: true,
        };
        sessions.push(session);
        return { session: session, branch: input.branch || 'main' };
      },
      killTransient: async function (sessionId) {
        var index = sessions.findIndex(function (s) { return s.id === sessionId; });
        if (index !== -1) sessions.splice(index, 1);
      },
    },

    config: {
      get: async function () {
        // Return effective config: global merged with current project's overrides
        var currentProject = projects.find(function (p) { return p.id === currentProjectId; });
        if (currentProject && projectConfigs[currentProject.path]) {
          return deepMerge(config, projectConfigs[currentProject.path]);
        }
        return config;
      },
      getGlobal: async function () {
        return config;
      },
      set: async function (partial) {
        config = deepMerge(config, partial);
      },
      getProjectOverrides: async function () {
        var currentProject = projects.find(function (p) { return p.id === currentProjectId; });
        if (currentProject && projectConfigs[currentProject.path]) {
          return projectConfigs[currentProject.path];
        }
        return null;
      },
      setProjectOverrides: async function (overrides) {
        var currentProject = projects.find(function (p) { return p.id === currentProjectId; });
        if (currentProject) {
          projectConfigs[currentProject.path] = overrides;
        }
      },
      getProjectOverridesByPath: async function (projectPath) {
        return projectConfigs[projectPath] || null;
      },
      setProjectOverridesByPath: async function (projectPath, overrides) {
        projectConfigs[projectPath] = overrides;
      },
      syncDefaultToProjects: async function () {
        return 0;
      },
    },

    claude: {
      detect: async function () {
        return { found: true, path: '/usr/bin/claude', version: '2.1.72 (Claude Code)' };
      },
      listCommands: async function (/* cwd */) {
        return [
          { name: 'code-review', displayName: '/code-review', description: 'Review code for quality and conventions', argumentHint: '', source: 'command' },
          { name: 'test', displayName: '/test', description: 'Run tests and audit coverage', argumentHint: '', source: 'command' },
          { name: 'ci:build', displayName: '/ci:build', description: 'Run CI build pipeline', argumentHint: '[fast|full]', source: 'command' },
        ];
      },
    },

    analytics: {
      trackRendererError: function () {},
    },

    app: {
      getVersion: async function () {
        return '0.1.0';
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
      exec: async function (/* command, cwd */) {
        return { pid: 12345 };
      },
    },

    git: {
      detect: async function () {
        return { found: true, path: '/usr/bin/git', version: '2.43.0', meetsMinimum: true };
      },
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

    backlog: {
      list: async function () {
        return backlogItems.slice().sort(function (a, b) { return a.position - b.position; });
      },
      create: async function (input) {
        var maxPos = backlogItems.reduce(function (max, item) { return Math.max(max, item.position); }, -1);
        var item = {
          id: 'backlog-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          title: input.title,
          description: input.description || '',
          priority: input.priority || 0,
          labels: input.labels || [],
          position: maxPos + 1,
          external_id: null,
          external_source: null,
          external_url: null,
          sync_status: null,
          attachment_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        backlogItems.push(item);
        return item;
      },
      update: async function (input) {
        var item = backlogItems.find(function (i) { return i.id === input.id; });
        if (!item) throw new Error('Backlog item not found');
        if (input.title !== undefined) item.title = input.title;
        if (input.description !== undefined) item.description = input.description;
        if (input.priority !== undefined) item.priority = input.priority;
        if (input.labels !== undefined) item.labels = input.labels;
        item.updated_at = new Date().toISOString();
        return Object.assign({}, item);
      },
      delete: async function (id) {
        backlogItems = backlogItems.filter(function (i) { return i.id !== id; });
      },
      reorder: async function (ids) {
        ids.forEach(function (id, index) {
          var item = backlogItems.find(function (i) { return i.id === id; });
          if (item) item.position = index;
        });
      },
      bulkDelete: async function (ids) {
        backlogItems = backlogItems.filter(function (i) { return ids.indexOf(i.id) === -1; });
      },
      promote: async function (input) {
        var createdTasks = [];
        input.backlogItemIds.forEach(function (itemId) {
          var item = backlogItems.find(function (i) { return i.id === itemId; });
          if (!item) return;
          var maxPos = tasks.reduce(function (max, t) { return t.swimlane_id === input.targetSwimlaneId ? Math.max(max, t.position) : max; }, -1);
          var task = {
            id: 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            title: item.title,
            description: item.description,
            swimlane_id: input.targetSwimlaneId,
            position: maxPos + 1,
            agent: null,
            session_id: null,
            worktree_path: null,
            branch_name: null,
            pr_number: null,
            pr_url: null,
            base_branch: null,
            use_worktree: null,
            attachment_count: 0,
            archived_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          tasks.push(task);
          createdTasks.push(task);
          backlogItems = backlogItems.filter(function (i) { return i.id !== itemId; });
        });
        return createdTasks;
      },
      demote: async function (input) {
        var task = tasks.find(function (t) { return t.id === input.taskId; });
        if (!task) throw new Error('Task not found');
        var maxPos = backlogItems.reduce(function (max, item) { return Math.max(max, item.position); }, -1);
        var item = {
          id: 'backlog-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          title: task.title,
          description: task.description,
          priority: input.priority || 0,
          labels: input.labels || [],
          position: maxPos + 1,
          external_id: null,
          external_source: null,
          external_url: null,
          sync_status: null,
          attachment_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        backlogItems.push(item);
        tasks = tasks.filter(function (t) { return t.id !== input.taskId; });
        return item;
      },
      renameLabel: async function (oldName, newName) {
        var count = 0;
        backlogItems.forEach(function (item) {
          var index = item.labels.indexOf(oldName);
          if (index !== -1) {
            item.labels[index] = newName;
            // Deduplicate
            item.labels = item.labels.filter(function (label, labelIndex, array) { return array.indexOf(label) === labelIndex; });
            count++;
          }
        });
        return count;
      },
      deleteLabel: async function (name) {
        var count = 0;
        backlogItems.forEach(function (item) {
          var before = item.labels.length;
          item.labels = item.labels.filter(function (label) { return label !== name; });
          if (item.labels.length !== before) count++;
        });
        return count;
      },
      remapPriorities: async function (mapping) {
        var count = 0;
        backlogItems.forEach(function (item) {
          var newPriority = mapping[item.priority];
          if (newPriority !== undefined && newPriority !== item.priority) {
            item.priority = newPriority;
            count++;
          }
        });
        return count;
      },
    },

    boardConfig: {
      exists: async function () { return false; },
      export: async function () {},
      apply: async function (/* projectId */) { return []; },
      onChanged: function (/* callback(projectId) */) { return noop; },
      onShortcutsChanged: function (/* callback(projectId) */) { return noop; },
      getShortcuts: async function () { return []; },
      setShortcuts: async function (/* actions, target */) {},
      setDefaultBaseBranch: async function (/* branch */) {},
    },

    updater: {
      checkForUpdate: async function () {},
      installUpdate: async function () {},
      onUpdateDownloaded: function () { return noop; },
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
      isFocused: function () { return Promise.resolve(true); },
    },

    platform: 'win32',
  };

  /**
   * Expose mock internals for test state pre-configuration.
   * Called from addInitScript before React mounts to set up complex scenarios
   * (e.g. tasks with sessions, activity state, usage data).
   */
  window.__mockPreConfigure = function (fn) {
    var result = fn({
      projects: projects,
      projectGroups: projectGroups,
      tasks: tasks,
      archivedTasks: archivedTasks,
      swimlanes: swimlanes,
      sessions: sessions,
      activityCache: activityCache,
      eventCache: eventCache,
      summaryCache: summaryCache,
      projectConfigs: projectConfigs,
      uuid: uuid,
      now: now,
      DEFAULT_SWIMLANES: DEFAULT_SWIMLANES,
    });
    if (result && result.currentProjectId !== undefined) {
      currentProjectId = result.currentProjectId;
    }
  };
})();
