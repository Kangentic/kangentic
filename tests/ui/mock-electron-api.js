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
  let backlogTasks = [];
  let activityCache = {};
  let eventCache = {};
  let summaryCache = {};
  let currentProjectId = null;
  let projectConfigs = {};
  let nextDisplayId = 1;
  let bulkDeleteProgressCallbacks = [];
  let searchHits = [];
  // Conversation memory (Phase 2/3). `memoryStatus` feeds the palette's
  // Smart-mode degraded notice and the Privacy tab status line. Seeded via
  // __mockPreConfigure (mirrors searchHits).
  let memoryStatus = {
    indexingEnabled: true,
    semantic: 'disabled',
    model: { id: 'bge-base', displayName: 'bge base', tier: 'accurate', approxSizeMb: 110, dimensions: 768, state: 'absent' },
  };
  // Conversation viewer fixtures. `transcriptSeeds` maps a sessionId to a
  // TranscriptGetResponse; `transcriptSessionsByTask` maps a taskId to the
  // ConversationSessionMeta[] the session picker offers. Both seeded via
  // __mockPreConfigure (mirrors searchHits).
  let transcriptSeeds = {};
  let transcriptSessionsByTask = {};
  // Browser pane state. Per-task URL overrides live here; project default is
  // resolved through projectConfigs.<path>.browser.defaultUrl. captureCalls is
  // a call log so tests can assert the prompt payload that would have been
  // shipped to the agent.
  let browserUrls = {};
  let browserCaptureCalls = [];
  let browserPaneCalls = [];
  // Pop-out engine call log: open/close/focus invocations, so a test can
  // assert the title-bar / surface-header trigger called the right verb
  // (e.g. focus() instead of toggling the in-app overlay) without a real
  // OS window. See window.__mockPopOut below.
  let popOutCalls = [];

  // Resolve the git diff fixture for a request. A test can seed a single fixture
  // via window.__mockGitDiff, per-scope fixtures via window.__mockGitDiffByScope
  // = { working: {...}, staged: {...}, branch: {...} }, or per-commit fixtures
  // via window.__mockGitDiffByCommit = { '<oid>': {...} } (checked first, since a
  // commit selection overrides scope).
  function resolveGitDiffFixture(request) {
    var commitOid = request && request.commitOid;
    var byCommit = (typeof window !== 'undefined' && window.__mockGitDiffByCommit) || null;
    if (commitOid && byCommit && byCommit[commitOid]) return byCommit[commitOid];
    var scope = (request && request.scope) || 'branch';
    var byScope = (typeof window !== 'undefined' && window.__mockGitDiffByScope) || null;
    if (byScope && byScope[scope]) return byScope[scope];
    return (typeof window !== 'undefined' && window.__mockGitDiff) || null;
  }

  let config = Object.assign({
    theme: 'dark',
    sidebarVisible: true,
    boardLayout: 'horizontal',
    cardDensity: 'default',
    columnWidth: 'default',
    showTaskNumbers: false,
    terminalPanelVisible: true,
    animationsEnabled: true,
    statusBarVisible: true,
    diffViewMode: 'split',
    diffDefaultScope: 'working',
    diffIgnoreWhitespace: false,
    diffCollapseUnchanged: false,
    diffFileSort: 'name',
    diffFlatList: false,
    terminal: {
      shell: null,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      showPreview: false,
      panelHeight: 250,
      cursorStyle: 'block',
      colors: {},
      backspaceSendsCtrlH: false,
    },
    sidebar: {
      width: 224,
    },
    agent: {
      permissionMode: 'acceptEdits',
      cliPaths: {},
      maxConcurrentSessions: 8,
      queueOverflow: 'queue',
      idleTimeoutMinutes: 0,
      autoResumeSessionsOnRestart: false,
      executionServers: {},
      execution: {},
      launchOptions: {},
    },
    git: {
      worktreesEnabled: true,
      autoCleanup: true,
      defaultBaseBranch: 'main',
      copyFiles: [],
      initScript: null,
      linkNodeModules: true,
      prRefreshIntervalMinutes: 5,
    },
    mcpServer: {
      enabled: true,
      bindAddress: '127.0.0.1',
    },
    contextBar: {
      showShell: true,
      showVersion: true,
      showElapsed: true,
      showCost: true,
      showToolCalls: true,
      showAgentActive: false,
      showTokens: true,
      showContextFraction: true,
      showProgressBar: true,
      showRateLimits: true,
    },
    notifications: {
      desktop: {
        onAgentIdle: true,
        onAgentCrash: true,
        onPlanComplete: true,
        onSpawnStalled: true,
      },
      toasts: {
        onAgentIdle: true,
        onAgentCrash: true,
        onPlanComplete: true,
        onSpawnStalled: true,
        durationSeconds: 4,
        maxCount: 5,
      },
      cooldownSeconds: 10,
    },
    backlog: {
      priorities: [
        { label: 'None', color: '#6b7280' },
        { label: 'Low', color: '#3b82f6' },
        { label: 'Medium', color: '#eab308' },
        { label: 'High', color: '#f97316' },
        { label: 'Urgent', color: '#ef4444' },
      ],
      labelColors: {},
    },
    hotkeyOverrides: {},
    workspaceByProject: {},
    commandTerminalWorkspace: null,
    monitorWorkspace: null,
    // Mirrors DEFAULT_CONFIG.monitor. Required on AppConfig, and this file is .js
    // so tsc cannot catch its absence; without it a UI test has no way to seed a
    // persisted Agent Monitor view the way it can for every other config field.
    monitor: {
      layout: 'cards',
      groupBy: 'project',
      sort: 'longest-running',
      liveOnly: false,
      projectFilter: [],
      stateFilter: [],
      textFilter: '',
    },
    hasCompletedFirstRun: true,
    lastSeenReleaseNotesVersion: '',
    skipDeleteConfirm: false,
    skipBoardConfigConfirm: false,
    autoFocusIdleSession: false,
    windowLightDismiss: 'single',
    autoNameAskedTaskIds: [],
    autoNameRateLimitPerHour: 60,
    restoreWindowPosition: true,
    windowBounds: null,
    windowMaximized: false,
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

  /**
   * Last path segment, either separator. The chained
   * `split('/').pop() || split('\\').pop()` this replaces silently never reached its backslash
   * branch: splitting a pure-Windows path on '/' yields a one-element array whose only member is
   * the whole path, which is truthy. So a spec seeding a `C:\Users\dev\...` fixture path - the
   * form cross-platform-parity.md tells tests to use - got the entire path back as the project
   * name instead of the folder.
   */
  function basenameOf(inputPath) {
    return String(inputPath).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
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

  // Intentionally simpler than src/shared/object-utils.ts deepMerge: this mock
  // always recurses key-by-key and never replaces flat maps. That means typed
  // struct merge bugs (e.g. the contextBar showRateLimits regression) cannot be
  // caught here -- guard them with a unit test on the real deepMerge instead.
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

  /** Drop keys whose value is undefined; return undefined when nothing remains. */
  function pruneUndefined(obj) {
    var out = {};
    var has = false;
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
        out[key] = obj[key];
        has = true;
      }
    }
    return has ? out : undefined;
  }

  /** Pick only the project-overridable keys from a config-like object. Non-setting
   *  keys that also live in config.json (importSources, browser, ...) are dropped,
   *  so they never seed into a new project.
   *  KEEP IN SYNC with pickOverridableSubset() in src/main/config/config-manager.ts */
  function pickOverridableSubset(source) {
    source = source || {};
    var agent = source.agent || {};
    var git = source.git || {};
    var result = {};
    if (source.theme !== undefined) result.theme = source.theme;
    // terminal.* (shell, fontSize, fontFamily, cursorStyle,
    // backspaceSendsCtrlH) is global-only now - see the comment on
    // pickOverridableSubset() in src/main/config/config-manager.ts.
    // agent.execution is deliberately excluded - see the comment on
    // pickOverridableSubset() in src/main/config/config-manager.ts.
    if (agent.permissionMode !== undefined) result.agent = { permissionMode: agent.permissionMode };
    var pickedGit = pruneUndefined({
      worktreesEnabled: git.worktreesEnabled,
      autoCleanup: git.autoCleanup,
      defaultBaseBranch: git.defaultBaseBranch,
      copyFiles: git.copyFiles ? git.copyFiles.slice() : undefined,
      initScript: git.initScript,
      linkNodeModules: git.linkNodeModules,
      prRefreshIntervalMinutes: git.prRefreshIntervalMinutes,
    });
    if (pickedGit) result.git = pickedGit;
    return result;
  }

  /** Snapshot the project-overridable subset of global config.
   *  KEEP IN SYNC with ConfigManager.getProjectOverridableDefaults() in src/main/config/config-manager.ts */
  function snapshotOverridableDefaults() {
    return pickOverridableSubset(config);
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
      if (!overrides) continue;
      var subset = pickOverridableSubset(overrides);
      if (Object.keys(subset).length > 0) return subset;
    }
    return snapshotOverridableDefaults();
  }

  var DEFAULT_SWIMLANES = [
    { name: 'To Do', description: null, role: 'todo', color: '#6b7280', icon: 'layers', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: false, auto_command: null, plan_exit_target_id: null, agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Planning', description: null, role: null, color: '#8b5cf6', icon: 'map', is_archived: false, is_ghost: false, permission_mode: 'plan', auto_spawn: true, auto_command: null, plan_exit_target_id: '__executing__', agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Executing', description: null, role: null, color: '#3b82f6', icon: 'square-terminal', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null, agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Code Review', description: null, role: null, color: '#f59e0b', icon: 'code', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null, agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Tests', description: null, role: null, color: '#06b6d4', icon: 'flask-conical', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null, agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Ship It', description: null, role: null, color: '#F97316', icon: 'sailboat', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null, agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Done', description: null, role: 'done', color: '#10b981', icon: 'circle-check-big', is_archived: true, is_ghost: false, permission_mode: null, auto_spawn: false, auto_command: null, plan_exit_target_id: null, agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
  ];

  var MOCK_PROJECT_ENTRIES = [
    { path: 'src', kind: 'directory', parentPath: undefined },
    { path: 'src/main', kind: 'directory', parentPath: 'src' },
    { path: 'src/main/index.ts', kind: 'file', parentPath: 'src/main' },
    { path: 'src/renderer', kind: 'directory', parentPath: 'src' },
    { path: 'src/renderer/components', kind: 'directory', parentPath: 'src/renderer' },
    { path: 'src/renderer/components/DescriptionEditor.tsx', kind: 'file', parentPath: 'src/renderer/components' },
    { path: 'README.md', kind: 'file', parentPath: undefined },
    { path: 'docs/worktree-strategy.md', kind: 'file', parentPath: 'docs' },
  ];

  function normalizeEntryQuery(query) {
    return (query || '').trim().replace(/^[@./]+/, '').toLowerCase();
  }

  function scoreMockProjectEntry(entry, query) {
    if (!query) return entry.kind === 'directory' ? 0 : 1;
    var normalizedPath = entry.path.toLowerCase();
    if (normalizedPath.indexOf(query) !== -1) return 0;
    return null;
  }

  function noop() {}

  // Board Profiles live in kangentic.json, not the DB, so the mock keeps them
  // in a plain module-scope array. Declared here (alongside noop) rather than
  // beside the boardConfig object, whose neighbouring `state` bindings belong to
  // IIFEs that have already closed by that point.
  let mockBoardProfiles = window.__mockBoardProfiles
    ? JSON.parse(JSON.stringify(window.__mockBoardProfiles))
    : [];

  // Test override conventions consumed below (set via addInitScript before this mock loads):
  //   - window.__mockBoardProfiles: pre-seeded BoardProfile[] for boardConfig.getBoardProfiles()
  //   - window.__mockAgentListOverrides: per-agent override of agents.list() entries
  //   - window.__mockFolderPath: path returned by dialog.selectFolder() (consume-once)
  //   - window.__mockDefaultAgentOverride: default_agent for the next project created
  //     via projects.create() or projects.openByPath(); cleared after first use
  //     (used by agent-tab-auth-warning.spec.ts to seed projects with kimi/opencode/etc.)
  // Release-notes modal test hooks: installed eagerly here (not lazily inside
  // updater.onUpdateDownloaded) so `__mockFireUpdateDownloaded` exists even
  // before any renderer subscriber has registered. A spec that calls it too
  // early throws loudly instead of silently no-op'ing into a confusing
  // "dialog never appeared" failure.
  window.__mockUpdateDownloadedListeners = [];
  window.__mockFireUpdateDownloaded = function (info) {
    var listeners = window.__mockUpdateDownloadedListeners.slice();
    listeners.forEach(function (fn) { fn(info); });
  };

  // Notification-click test hook (App.tsx's `notifications.onClicked` handler,
  // including the isCommandTerminal branch). Installed eagerly for the same
  // reason as the update-downloaded hooks above. Unlike that hook, this one
  // throws when fired with no listener registered: firing before App.tsx has
  // mounted and subscribed would otherwise silently no-op into a confusing
  // "nothing happened" failure downstream.
  window.__mockNotificationClickListeners = [];
  window.__mockFireNotificationClicked = function (projectId, taskId) {
    var listeners = window.__mockNotificationClickListeners.slice();
    if (listeners.length === 0) {
      throw new Error('__mockFireNotificationClicked called with no onClicked listener registered');
    }
    listeners.forEach(function (fn) { fn(projectId, taskId); });
  };

  window.electronAPI = {
    projects: {
      list: async function () {
        return projects.slice().sort(function (a, b) { return a.position - b.position; });
      },
      create: async function (input) {
        // Shift existing projects down
        projects.forEach(function (p) { p.position = p.position + 1; });
        var defaultAgentOverride = window.__mockDefaultAgentOverride;
        if (defaultAgentOverride) window.__mockDefaultAgentOverride = null;
        var project = {
          id: uuid(),
          name: input.name,
          path: input.path,
          github_url: input.github_url || null,
          default_agent: defaultAgentOverride || 'claude',
          default_model: null,
          default_effort: null,
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
      // Call log for test assertions (mirrors clipboard.__writeTextCalls). Reset
      // with window.electronAPI.projects.__openCalls.length = 0.
      __openCalls: [],
      open: async function (id) {
        window.electronAPI.projects.__openCalls.push(id);
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
        var found = projects.find(function (p) {
          return p.id === currentProjectId;
        });
        // Return a new object each time so Zustand's reference equality check
        // detects field mutations (e.g. default_agent changes after setDefaultAgent).
        return found ? Object.assign({}, found) : null;
      },
      openByPath: async function (projectPath, overrides) {
        var name = (overrides && overrides.name) || basenameOf(projectPath) || 'project';
        var existing = projects.find(function (p) { return p.path === projectPath; });
        if (existing) {
          currentProjectId = existing.id;
          return existing;
        }
        // Shift existing projects down
        projects.forEach(function (p) { p.position = p.position + 1; });
        var defaultAgentOverride = window.__mockDefaultAgentOverride;
        if (defaultAgentOverride) window.__mockDefaultAgentOverride = null;
        var project = {
          id: uuid(),
          name: name,
          path: projectPath,
          github_url: null,
          default_agent: (overrides && overrides.defaultAgent) || defaultAgentOverride || 'claude',
          default_model: null,
          default_effort: null,
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
      probePath: async function (projectPath) {
        // Test hook: window.__mockProbePathOverrides merges over the defaults
        // (e.g. { isGitRepo: false } to exercise the non-git-folder warning).
        var overrides = window.__mockProbePathOverrides || {};
        var name = basenameOf(projectPath) || 'project';
        var existing = projects.find(function (p) { return p.path === projectPath; });
        var defaults = {
          exists: true,
          isDirectory: true,
          isGitRepo: true,
          isInsideWorktree: false,
          currentBranch: 'main',
          suggestedName: name,
          alreadyRegisteredProjectId: existing ? existing.id : null,
        };
        return Object.assign({}, defaults, overrides);
      },
      // Takes the folder path it ignores, matching the real signature the way `detect` and
      // `selectFolder` do, so a spec can assert WHICH path git setup was attempted on.
      ensureGit: async function (folderPath) {
        // Test hook: window.__mockEnsureGitResult overrides the outcome, so a spec can
        // exercise the "git could not be set up" warning without a real filesystem.
        // Records calls so a spec can assert git setup was attempted at all.
        window.__mockEnsureGitCalls = (window.__mockEnsureGitCalls || 0) + 1;
        window.__mockEnsureGitLastPath = folderPath;
        if (window.__mockEnsureGitResult) return window.__mockEnsureGitResult;
        // created:false by default - "the folder was already a repo", the common case and
        // the only one that raises no toast. Defaulting to created:true meant every spec
        // that calls createProject() got the "Started a git repo in this folder" info toast,
        // which broke unrelated specs asserting on a single `toast` testid. A spec that
        // wants the freshly-created path sets __mockEnsureGitResult explicitly.
        return { ok: true, created: false, error: null };
      },
      searchEntries: async function (input) {
        var normalizedQuery = normalizeEntryQuery(input.query);
        var limit = Math.max(0, Math.floor(input.limit || 0));
        var ranked = MOCK_PROJECT_ENTRIES.map(function (entry) {
          return { entry: entry, score: scoreMockProjectEntry(entry, normalizedQuery) };
        }).filter(function (candidate) {
          return candidate.score !== null;
        }).sort(function (left, right) {
          if (left.score !== right.score) return left.score - right.score;
          return left.entry.path.localeCompare(right.entry.path);
        });

        return {
          entries: ranked.slice(0, limit).map(function (candidate) { return candidate.entry; }),
          truncated: ranked.length > limit,
        };
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
      setDefaultAgent: async function (id, agentName) {
        var idx = projects.findIndex(function (p) { return p.id === id; });
        if (idx >= 0) {
          projects[idx].default_agent = agentName;
          return Object.assign({}, projects[idx]);
        }
        throw new Error('Project not found: ' + id);
      },
      setDefaultModel: async function (id, model) {
        var idx = projects.findIndex(function (p) { return p.id === id; });
        if (idx >= 0) {
          projects[idx].default_model = model;
          return Object.assign({}, projects[idx]);
        }
        throw new Error('Project not found: ' + id);
      },
      setDefaultEffort: async function (id, effort) {
        var idx = projects.findIndex(function (p) { return p.id === id; });
        if (idx >= 0) {
          projects[idx].default_effort = effort;
          return Object.assign({}, projects[idx]);
        }
        throw new Error('Project not found: ' + id);
      },
      setGroup: async function (projectId, groupId) {
        var idx = projects.findIndex(function (p) { return p.id === projectId; });
        if (idx >= 0) projects[idx].group_id = groupId;
      },
      relocate: async function (id, newPath, _options) {
        var duplicate = projects.find(function (p) { return p.id !== id && p.path === newPath; });
        if (duplicate) {
          throw new Error('Another project ("' + duplicate.name + '") already points at ' + newPath);
        }
        var idx = projects.findIndex(function (p) { return p.id === id; });
        if (idx >= 0) {
          projects[idx].path = newPath;
          return { project: Object.assign({}, projects[idx]), warnings: [] };
        }
        throw new Error('Project not found: ' + id);
      },
      onMoveProgress: function (callback) {
        // Tests drive determinate copy progress via
        // `window.__mockFireProjectMoveProgress(progress)`.
        if (!window.__mockProjectMoveProgressListeners) {
          window.__mockProjectMoveProgressListeners = [];
        }
        window.__mockProjectMoveProgressListeners.push(callback);
        if (!window.__mockFireProjectMoveProgress) {
          window.__mockFireProjectMoveProgress = function (progress) {
            var listeners = (window.__mockProjectMoveProgressListeners || []).slice();
            listeners.forEach(function (fn) { fn(progress); });
          };
        }
        return function () {
          var listeners = window.__mockProjectMoveProgressListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onPathMissing: function (callback) {
        // Tests can fire the startup missing-path push via
        // `window.__mockFireProjectPathMissing(projectId)`.
        if (!window.__mockProjectPathMissingListeners) {
          window.__mockProjectPathMissingListeners = [];
        }
        window.__mockProjectPathMissingListeners.push(callback);
        if (!window.__mockFireProjectPathMissing) {
          window.__mockFireProjectPathMissing = function (projectId) {
            var project = projects.find(function (p) { return p.id === projectId; });
            if (!project) return;
            var listeners = (window.__mockProjectPathMissingListeners || []).slice();
            listeners.forEach(function (fn) { fn(project); });
          };
        }
        return function () {
          var listeners = window.__mockProjectPathMissingListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onAutoOpened: function (callback) {
        // Tests can fire the programmatic auto-open path via
        // `window.__mockFireProjectAutoOpened(projectId)`. Useful for
        // exercising the project-switch effect without going through
        // the sidebar (which a modal dialog backdrop would intercept).
        if (!window.__mockProjectAutoOpenListeners) {
          window.__mockProjectAutoOpenListeners = [];
        }
        window.__mockProjectAutoOpenListeners.push(callback);
        if (!window.__mockFireProjectAutoOpened) {
          window.__mockFireProjectAutoOpened = function (projectId) {
            var project = projects.find(function (p) { return p.id === projectId; });
            if (!project) return;
            // Mirror PROJECT_OPEN's main-side bookkeeping so the
            // renderer sees the new currentProject after onAutoOpened.
            currentProjectId = projectId;
            var listeners = (window.__mockProjectAutoOpenListeners || []).slice();
            listeners.forEach(function (fn) { fn(project); });
          };
        }
        return function () {
          var listeners = window.__mockProjectAutoOpenListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
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
      // Call log for test assertions; see the `update` hook below for what is
      // captured. Reset between tests via
      // window.electronAPI.tasks.__updateCalls.length = 0.
      __updateCalls: [],
      list: async function () {
        // Fixture tasks tagged with a projectId are scoped to the current project
        // (mirrors the real per-project DBs, where switching projects swaps the
        // whole task set). Untagged tasks are returned for every project, so the
        // many single-project specs that never set a projectId are unaffected.
        var visible = tasks.filter(function (t) {
          return !t.projectId || t.projectId === currentProjectId;
        });
        return withAttachmentCounts(visible);
      },
      create: async function (input) {
        // Test hook: count create IPC calls so specs can verify a double-submit
        // (double-click / Enter-then-click) does not fire a second create.
        // Read via window.__mockTaskCreateCallCount.
        if (typeof window !== 'undefined') {
          window.__mockTaskCreateCallCount = (window.__mockTaskCreateCallCount || 0) + 1;
        }

        // Test hook: make tasks.create() return a controlled promise so the test
        // can observe the in-flight (submitting) state before the IPC resolves.
        // Set window.__mockTaskCreateDeferred = true before calling; the promise
        // hangs until window.__mockTaskCreateResolve() is called.
        if (typeof window !== 'undefined' && window.__mockTaskCreateDeferred) {
          window.__mockTaskCreateDeferred = false;
          var createResolveRef;
          var createPending = new Promise(function (resolve) { createResolveRef = resolve; });
          window.__mockTaskCreateResolve = createResolveRef;
          await createPending;
        }

        var sameColumn = tasks.filter(function (t) {
          return t.swimlane_id === input.swimlane_id;
        });
        var taskId = uuid();
        var task = {
          id: taskId,
          display_id: nextDisplayId++,
          title: input.title,
          description: input.description || '',
          swimlane_id: input.swimlane_id,
          position: sameColumn.length,
          agent: null,
          session_id: null,
          worktree_path: null,
          worktree_folder: null,
          branch_name: input.customBranchName || null,
          pr_number: null,
          pr_url: null,
          pr_state: null,
          base_branch: input.baseBranch || null,
          use_worktree: input.useWorktree != null ? (input.useWorktree ? 1 : 0) : null,
          labels: input.labels || [],
          priority: input.priority || 0,
          model_override: input.model_override || null,
          effort_override: input.effort_override || null,
          agent_override: input.agent_override || null,
          permission_mode: input.permission_mode || null,
          // Deliberately a plain passthrough, NOT a copy of the repository's
          // profile-vs-pin exclusivity: a dialog that sent both would then show
          // up as a failure here instead of being silently corrected.
          profile_id: input.profile_id || null,
          run_mode: input.run_mode || 'column_settings',
          auto_command: input.auto_command || null,
          attachment_count: 0,
          archived_at: null,
          detail_view_state: null,
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
        // Test hook: count update IPC calls so specs can verify a double-submit
        // (double-click / rapid keyboard activation) does not fire a second save.
        // Read via window.__mockTaskUpdateCallCount.
        if (typeof window !== 'undefined') {
          window.__mockTaskUpdateCallCount = (window.__mockTaskUpdateCallCount || 0) + 1;
        }

        // Test hook: call log of the raw update payload, so a spec can assert
        // which keys were (or were NOT) sent - e.g. that the override fields
        // (agent_override/model_override/effort_override/permission_mode/
        // profile_id/run_mode) are omitted entirely when the save gate hides
        // them (active session / archived task), rather than merely sent with
        // an unchanged value. A shallow copy is pushed so later mutation of
        // `input` by the caller can't retroactively change a captured entry.
        // Reset between tests via window.electronAPI.tasks.__updateCalls.length = 0.
        if (typeof window !== 'undefined') {
          window.electronAPI.tasks.__updateCalls.push(Object.assign({}, input));
        }

        // Test hook: make tasks.update() return a controlled promise so the test
        // can observe the in-flight (saving) state before the IPC resolves.
        // Set window.__mockTaskUpdateDeferred = true before calling; the promise
        // hangs until window.__mockTaskUpdateResolve() is called.
        if (typeof window !== 'undefined' && window.__mockTaskUpdateDeferred) {
          window.__mockTaskUpdateDeferred = false;
          var updateResolveRef;
          var updatePending = new Promise(function (resolve) { updateResolveRef = resolve; });
          window.__mockTaskUpdateResolve = updateResolveRef;
          await updatePending;
        }

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
        // Test hook: increment a per-id IPC call counter so specs can verify
        // that rapid repeats don't spawn extra IPC calls. Read via
        // window.__mockTaskDeleteCallCount[id].
        if (typeof window !== 'undefined') {
          if (!window.__mockTaskDeleteCallCount) window.__mockTaskDeleteCallCount = {};
          window.__mockTaskDeleteCallCount[id] = (window.__mockTaskDeleteCallCount[id] || 0) + 1;
        }

        // Test hook: simulate a main-process failure (e.g. worktree cleanup
        // throws). Real main process leaves the DB row in place before
        // throwing, so the mock also leaves arrays unchanged and throws.
        // Set window.__mockTaskDeleteThrow = 'error message' before calling.
        if (typeof window !== 'undefined' && window.__mockTaskDeleteThrow) {
          var throwMsg = window.__mockTaskDeleteThrow;
          window.__mockTaskDeleteThrow = null;
          throw new Error(throwMsg);
        }

        // Test hook: make tasks.delete() return a controlled promise so the
        // test can observe the optimistic state before the IPC resolves.
        // Set window.__mockTaskDeleteDeferred = true before calling; the
        // promise hangs until window.__mockTaskDeleteResolve() is called.
        if (typeof window !== 'undefined' && window.__mockTaskDeleteDeferred) {
          window.__mockTaskDeleteDeferred = false;
          var resolveRef;
          var pending = new Promise(function (res) { resolveRef = res; });
          window.__mockTaskDeleteResolve = resolveRef;
          await pending;
        }

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
      move: async function (input, projectId) {
        // Record the projectId the renderer stamped (captured at interaction
        // time) so cross-project tests can assert the move routed to the right
        // project even after a mid-flight switch. `undefined` is normalized to
        // null so an unstamped legacy call is distinguishable.
        if (typeof window !== 'undefined') {
          window.__mockLastMoveProjectId = projectId === undefined ? null : projectId;
          if (!window.__mockMoveProjectIds) window.__mockMoveProjectIds = [];
          window.__mockMoveProjectIds.push(projectId === undefined ? null : projectId);
        }

        // Test hook: simulate a main-process failure (e.g. dirty branch, spawn
        // error). Real main process reverts the DB move before throwing, so
        // the mock leaves the tasks array unchanged and throws.
        // Set window.__mockTaskMoveThrow = 'error message' before calling.
        if (typeof window !== 'undefined' && window.__mockTaskMoveThrow) {
          var throwMsg = window.__mockTaskMoveThrow;
          window.__mockTaskMoveThrow = null;
          throw new Error(throwMsg);
        }

        // Test hook: make tasks.move() return a controlled promise so the test
        // can observe behavior while the IPC is in flight (e.g. switch projects
        // before it resolves). Set window.__mockTaskMoveDeferred = true before
        // calling; the promise hangs until window.__mockTaskMoveResolve() runs.
        if (typeof window !== 'undefined' && window.__mockTaskMoveDeferred) {
          window.__mockTaskMoveDeferred = false;
          var resolveMoveRef;
          var pendingMove = new Promise(function (resolve) { resolveMoveRef = resolve; });
          window.__mockTaskMoveResolve = resolveMoveRef;
          await pendingMove;
        }

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

        // Mirror main-process behavior: moving into a lane with role 'done'
        // archives the task. See src/main/ipc/handlers/task-move.ts L236.
        // NOTE: after a Done move, tasks.list() will NOT return this task and
        // tasks.listArchived() WILL. Tests that call loadBoard() after a Done
        // move should probe archivedTasks, not tasks.
        var targetLane = swimlanes.find(function (s) { return s.id === newSwimlaneId; });
        if (targetLane && targetLane.role === 'done') {
          var archived = Object.assign({}, tasks[idx], {
            archived_at: now(),
          });
          archivedTasks.push(archived);
          tasks.splice(idx, 1);
        }
      },
      cancelSpawn: async function (taskId) {
        // Record cancellations so UI tests can assert the stall toast's Cancel
        // button wired through to the IPC layer.
        if (typeof window !== 'undefined') {
          if (!window.__mockCancelSpawnCalls) window.__mockCancelSpawnCalls = [];
          window.__mockCancelSpawnCalls.push(taskId);
        }
      },
      listArchived: async function () {
        return withAttachmentCounts(archivedTasks);
      },
      listArchivedPreview: async function (limit) {
        // Mirror the repo: newest-first by archived_at, then LIMIT. Sorting a
        // copy so seeds with more than `limit` archived tasks pick the correct
        // preview subset (the same rows the real SELECT ... ORDER BY DESC would).
        var boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
        var sorted = archivedTasks.slice().sort(function (a, b) {
          return String(b.archived_at || '').localeCompare(String(a.archived_at || ''));
        });
        return {
          totalCount: archivedTasks.length,
          tasks: withAttachmentCounts(sorted.slice(0, boundedLimit)),
        };
      },
      onAutoMoved: function () {
        return noop;
      },
      onSpawnBlocked: function (callback) {
        // Tests fire this via window.__mockFireTaskSpawnBlocked(taskId, title, message, projectId).
        if (!window.__mockTaskSpawnBlockedListeners) window.__mockTaskSpawnBlockedListeners = [];
        window.__mockTaskSpawnBlockedListeners.push(callback);
        if (!window.__mockFireTaskSpawnBlocked) {
          window.__mockFireTaskSpawnBlocked = function (taskId, taskTitle, message, projectId) {
            var listeners = (window.__mockTaskSpawnBlockedListeners || []).slice();
            listeners.forEach(function (listener) { listener(taskId, taskTitle, message, projectId); });
          };
        }
        // A REAL unsubscribe, matching the preload bridge. App.tsx pushes this
        // onto its cleanups array, so returning a noop would leave the unmounted
        // component's handler registered and fire a duplicate toast after any
        // remount, HMR update or project switch.
        return function () {
          var listeners = window.__mockTaskSpawnBlockedListeners || [];
          var index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
      onCreatedByAgent: function (callback) {
        // Tests can fire this via window.__mockFireTaskCreatedByAgent(taskId, title, column, projectId).
        if (!window.__mockTaskCreatedListeners) window.__mockTaskCreatedListeners = [];
        window.__mockTaskCreatedListeners.push(callback);
        if (!window.__mockFireTaskCreatedByAgent) {
          window.__mockFireTaskCreatedByAgent = function (taskId, taskTitle, columnName, projectId) {
            var listeners = (window.__mockTaskCreatedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](taskId, taskTitle, columnName, projectId); }
          };
        }
        return function () {
          var listeners = window.__mockTaskCreatedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onUpdatedByAgent: function (callback) {
        // Tests can fire this via window.__mockFireTaskUpdatedByAgent(taskId, title, projectId).
        if (!window.__mockTaskUpdatedListeners) window.__mockTaskUpdatedListeners = [];
        window.__mockTaskUpdatedListeners.push(callback);
        if (!window.__mockFireTaskUpdatedByAgent) {
          window.__mockFireTaskUpdatedByAgent = function (taskId, taskTitle, projectId) {
            var listeners = (window.__mockTaskUpdatedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](taskId, taskTitle, projectId); }
          };
        }
        return function () {
          var listeners = window.__mockTaskUpdatedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onDeletedByAgent: function (callback) {
        // Tests can fire this via window.__mockFireTaskDeletedByAgent(taskId, title, projectId).
        if (!window.__mockTaskDeletedListeners) window.__mockTaskDeletedListeners = [];
        window.__mockTaskDeletedListeners.push(callback);
        if (!window.__mockFireTaskDeletedByAgent) {
          window.__mockFireTaskDeletedByAgent = function (taskId, taskTitle, projectId) {
            var listeners = (window.__mockTaskDeletedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](taskId, taskTitle, projectId); }
          };
        }
        return function () {
          var listeners = window.__mockTaskDeletedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onSessionResync: function (callback) {
        // Tests can fire this via window.__mockFireTaskSessionResync(projectId).
        if (!window.__mockTaskSessionResyncListeners) window.__mockTaskSessionResyncListeners = [];
        window.__mockTaskSessionResyncListeners.push(callback);
        if (!window.__mockFireTaskSessionResync) {
          window.__mockFireTaskSessionResync = function (projectId) {
            var listeners = (window.__mockTaskSessionResyncListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](projectId); }
          };
        }
        return function () {
          var listeners = window.__mockTaskSessionResyncListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onSpawnProgress: function (callback) {
        // Tests can fire this via window.__mockFireSpawnProgress(taskId, label).
        if (!window.__mockSpawnProgressListeners) window.__mockSpawnProgressListeners = [];
        window.__mockSpawnProgressListeners.push(callback);
        if (!window.__mockFireSpawnProgress) {
          window.__mockFireSpawnProgress = function (taskId, label) {
            var listeners = (window.__mockSpawnProgressListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](taskId, label); }
          };
        }
        return function () {
          var listeners = window.__mockSpawnProgressListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      getSpawnProgress: async function () {
        return {};
      },
      onBulkDeleteProgress: function (callback) {
        bulkDeleteProgressCallbacks.push(callback);
        return function () {
          var idx = bulkDeleteProgressCallbacks.indexOf(callback);
          if (idx >= 0) bulkDeleteProgressCallbacks.splice(idx, 1);
        };
      },
      unarchive: async function (input) {
        // Test hook: simulate a main-process failure (e.g. worktree conflict).
        // Real main process leaves archivedTasks unchanged before throwing, so
        // the mock also leaves them unchanged and throws. The renderer's catch
        // block restores the optimistic snapshot, which mirrors real behaviour.
        // Set window.__mockTaskUnarchiveThrow = 'error message' before calling.
        if (typeof window !== 'undefined' && window.__mockTaskUnarchiveThrow) {
          var throwMsg = window.__mockTaskUnarchiveThrow;
          window.__mockTaskUnarchiveThrow = null;
          throw new Error(throwMsg);
        }

        // Test hook: make tasks.unarchive() return a controlled promise so the
        // test can observe the intermediate optimistic state before the IPC
        // resolves. Set window.__mockTaskUnarchiveDeferred = true before calling;
        // the promise hangs until window.__mockTaskUnarchiveResolve() is called.
        if (typeof window !== 'undefined' && window.__mockTaskUnarchiveDeferred) {
          window.__mockTaskUnarchiveDeferred = false;
          var resolveRef;
          var pending = new Promise(function (res) { resolveRef = res; });
          window.__mockTaskUnarchiveResolve = resolveRef;
          await pending;
        }

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
      // Test hook: expose the live count of registered progress listeners so
      // specs can verify that the renderer's `finally { unsubscribe() }` block
      // actually runs and drops its subscriber after the operation settles.
      __getBulkDeleteCallbackCount: function () {
        return bulkDeleteProgressCallbacks.length;
      },
      bulkDelete: async function (ids) {
        // Test hook: simulate a hard IPC throw (e.g. no project open).
        // Set window.__mockBulkDeleteThrow = 'error message' before calling.
        if (typeof window !== 'undefined' && window.__mockBulkDeleteThrow) {
          var throwMsg = window.__mockBulkDeleteThrow;
          window.__mockBulkDeleteThrow = null;
          throw new Error(throwMsg);
        }

        // Test hook: simulate partial worktree-cleanup failures.
        // Set window.__mockBulkDeleteFailureIds = ['id1', 'id2'] before calling.
        // Those IDs will be included in failures[] but still removed from the DB.
        var forcedFailureIds = (typeof window !== 'undefined' && window.__mockBulkDeleteFailureIds) || [];
        if (typeof window !== 'undefined') window.__mockBulkDeleteFailureIds = null;

        var failures = [];
        var total = ids.length;
        function emit(completed) {
          var payload = { completed: completed, total: total, failures: failures.slice() };
          for (var j = 0; j < bulkDeleteProgressCallbacks.length; j++) {
            try { bulkDeleteProgressCallbacks[j](payload); } catch (_) { /* noop */ }
          }
        }
        emit(0);
        for (var i = 0; i < ids.length; i++) {
          var taskId = ids[i];
          var idx = archivedTasks.findIndex(function (t) { return t.id === taskId; });
          if (idx >= 0) archivedTasks.splice(idx, 1);
          var tIdx = tasks.findIndex(function (t) { return t.id === taskId; });
          if (tIdx >= 0) tasks.splice(tIdx, 1);
          // Inject worktree-cleanup failure for forced IDs
          if (forcedFailureIds.indexOf(taskId) !== -1) {
            failures.push({ id: taskId, error: 'Worktree directory could not be removed: /mock/worktrees/' + taskId.slice(0, 8) });
          }
          emit(i + 1);
        }
        return { deleted: total - failures.length, failures: failures };
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
      setRuntimeOverride: async function (input) {
        // Test hook: spec can override the response (e.g. to assert error
        // handling) by setting window.__mockSetRuntimeOverrideResult before
        // calling. Defaults to a successful 'live' apply when the task has a
        // session_id, otherwise 'persisted'.
        if (typeof window !== 'undefined') {
          if (!window.__mockSetRuntimeOverrideCalls) window.__mockSetRuntimeOverrideCalls = [];
          window.__mockSetRuntimeOverrideCalls.push(input);
        }
        if (typeof window !== 'undefined' && typeof window.__mockSetRuntimeOverrideResult === 'function') {
          return window.__mockSetRuntimeOverrideResult(input);
        }
        var idx = tasks.findIndex(function (t) { return t.id === input.taskId; });
        if (idx < 0) return { ok: false, reason: 'task not found' };
        var patch = {};
        if (input.model !== undefined) patch.model_override = input.model;
        if (input.effort !== undefined) patch.effort_override = input.effort;
        tasks[idx] = Object.assign({}, tasks[idx], patch, { updated_at: now() });
        var mode = tasks[idx].session_id ? 'live' : 'persisted';
        return { ok: true, mode: mode };
      },
      resolvePr: async function (taskId) {
        // Test hook: spec can override the response by setting
        // window.__mockResolvePrResult before calling. Defaults to returning the
        // task unchanged (no PR linked) - real resolution needs the gh CLI.
        if (typeof window !== 'undefined') {
          if (!window.__mockResolvePrCalls) window.__mockResolvePrCalls = [];
          window.__mockResolvePrCalls.push(taskId);
          if (typeof window.__mockResolvePrResult === 'function') {
            return window.__mockResolvePrResult(taskId);
          }
        }
        var found = tasks.find(function (t) { return t.id === taskId; }) || null;
        var isLinked = !!(found && found.pr_url);
        return { task: found, linked: isLinked, reason: isLinked ? 'unchanged' : 'not-found' };
      },
      setDetailViewState: async function (taskId, state, projectId) {
        // Persist the detail-view-state blob onto the mock task row (serialized
        // like the real repo) so a spec can assert hydration + debounced saves.
        // Records calls + the stamped projectId for project-scoped assertions.
        if (typeof window !== 'undefined') {
          if (!window.__mockDetailViewStateCalls) window.__mockDetailViewStateCalls = [];
          window.__mockDetailViewStateCalls.push({
            taskId: taskId,
            state: state,
            projectId: projectId === undefined ? null : projectId,
          });
        }
        var found = tasks.find(function (t) { return t.id === taskId; });
        if (found) found.detail_view_state = state ? JSON.stringify(state) : null;
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
      open: async function () {
        return '';
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
          description: input.description ?? null,
          role: null,
          color: input.color || '#71717a',
          icon: input.icon || null,
          is_archived: input.is_archived || false,
          is_ghost: input.is_ghost || false,
          permission_mode: input.permission_mode || null,
          auto_spawn: (input.auto_spawn !== undefined && input.auto_spawn !== null) ? input.auto_spawn : true,
          auto_command: input.auto_command || null,
          plan_exit_target_id: input.plan_exit_target_id || null,
          agent_override: input.agent_override || null,
          model_override: input.model_override || null,
          effort_override: input.effort_override || null,
          handoff_context: input.handoff_context !== undefined ? input.handoff_context : false,
          session_target: input.session_target ?? 'main',
          session_spawn_strategy: input.session_spawn_strategy ?? 'create_or_resume',
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
        var doomed = swimlanes.find(function (s) {
          return s.id === id;
        });
        swimlanes = swimlanes.filter(function (s) {
          return s.id !== id;
        });
        // Mirror the real handler's side effect: SWIMLANE_DELETE also prunes the
        // deleted column out of the Board Profiles (entries keyed by its uuid, and
        // any planExitTarget naming it). Without this the mock and production
        // diverge in BEHAVIOR, not just storage, so a spec asserting on
        // getBoardProfiles() after a delete would answer the wrong question.
        // Deliberately re-implemented rather than importing the shared pruner:
        // this file is plain JS evaluated in the page, with no bundler.
        if (doomed) {
          var doomedName = String(doomed.name || '').trim().toLowerCase();
          mockBoardProfiles = mockBoardProfiles.map(function (profile) {
            var nextColumns = {};
            Object.keys(profile.columns || {}).forEach(function (swimlaneId) {
              if (swimlaneId === id) return;
              var entry = profile.columns[swimlaneId];
              if (entry && typeof entry === 'object'
                && typeof entry.planExitTarget === 'string'
                && entry.planExitTarget.trim().toLowerCase() === doomedName) {
                var rest = Object.assign({}, entry);
                delete rest.planExitTarget;
                nextColumns[swimlaneId] = rest;
                return;
              }
              nextColumns[swimlaneId] = entry;
            });
            return Object.assign({}, profile, { columns: nextColumns });
          });
        }
      },
      reorder: async function (ids) {
        ids.forEach(function (id, i) {
          var idx = swimlanes.findIndex(function (s) {
            return s.id === id;
          });
          if (idx >= 0) swimlanes[idx].position = i;
        });
      },
      onUpdatedByAgent: function (callback) {
        // Tests can fire this via window.__mockFireSwimlaneUpdatedByAgent(swimlaneId, name, projectId).
        if (!window.__mockSwimlaneUpdatedListeners) window.__mockSwimlaneUpdatedListeners = [];
        window.__mockSwimlaneUpdatedListeners.push(callback);
        if (!window.__mockFireSwimlaneUpdatedByAgent) {
          window.__mockFireSwimlaneUpdatedByAgent = function (swimlaneId, swimlaneName, projectId) {
            var listeners = (window.__mockSwimlaneUpdatedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](swimlaneId, swimlaneName, projectId); }
          };
        }
        return function () {
          var listeners = window.__mockSwimlaneUpdatedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
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
          isolatedSwimlaneId: null,
          agentSessionId: null,
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
      reset: async function (taskId) {
        sessions = sessions.filter(function (s) { return s.taskId !== taskId; });
        var task = tasks.find(function (t) { return t.id === taskId; });
        if (task) {
          task.session_id = null;
          task.updated_at = now();
        }
      },
      // Mock counterpart of main's SESSION_RECONCILE handler. Returns the
      // session whose taskId matches IF its status is 'running' or 'queued'
      // (the "live registry" view), else null. Tests can override via
      // window.electronAPI.sessions.reconcile = ... to exercise drift cases.
      reconcile: async function (taskId) {
        var live = sessions.find(function (s) {
          return s.taskId === taskId && (s.status === 'running' || s.status === 'queued');
        });
        return live || null;
      },
      // Call log for test assertions. Each entry is { sessionId, payload }.
      // Reset between tests via window.__mockSessionWriteCalls.length = 0.
      __writeCalls: [],
      write: async function (sessionId, payload) {
        window.electronAPI.sessions.__writeCalls.push({ sessionId: sessionId, payload: payload });
      },
      // Call log for test assertions. Each entry is { sessionId, cols, rows },
      // in call order. Mirrors the __writeCalls log above. Reset between tests
      // via window.electronAPI.sessions.__resizeCalls.length = 0.
      __resizeCalls: [],
      resize: async function (sessionId, cols, rows) {
        window.electronAPI.sessions.__resizeCalls.push({ sessionId: sessionId, cols: cols, rows: rows });
        return { colsChanged: false };
      },
      list: async function () {
        return sessions;
      },
      getScrollback: async function () {
        return '';
      },
      getFirstOutput: async function () {
        return {};
      },
      getUsage: async function (/* projectId */) {
        return {};
      },
      onData: function (callback) {
        // Tests can push live PTY data via window.__mockFireSessionData(sessionId, data),
        // which routes through the incoming-write-queue into the mounted xterm instance.
        if (!window.__mockDataListeners) window.__mockDataListeners = [];
        window.__mockDataListeners.push(callback);
        if (!window.__mockFireSessionData) {
          window.__mockFireSessionData = function (sessionId, data) {
            var listeners = (window.__mockDataListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, data); }
          };
        }
        return function () {
          var listeners = window.__mockDataListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      ackData: function () {
        // No-op in the headless mock: backpressure pause/resume has no PTY here.
      },
      onFirstOutput: function (callback) {
        // Tests can fire this via window.__mockFireFirstOutput(sessionId).
        if (!window.__mockFirstOutputListeners) window.__mockFirstOutputListeners = [];
        window.__mockFirstOutputListeners.push(callback);
        if (!window.__mockFireFirstOutput) {
          window.__mockFireFirstOutput = function (sessionId) {
            var listeners = (window.__mockFirstOutputListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId); }
          };
        }
        return function () {
          var listeners = window.__mockFirstOutputListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onExit: function (callback) {
        // Tests can fire this via
        // window.__mockFireExit(sessionId, exitCode, projectId, intentional).
        if (!window.__mockExitListeners) window.__mockExitListeners = [];
        window.__mockExitListeners.push(callback);
        if (!window.__mockFireExit) {
          window.__mockFireExit = function (sessionId, exitCode, projectId, intentional) {
            var listeners = (window.__mockExitListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, exitCode, projectId, intentional); }
          };
        }
        return function () {
          var listeners = window.__mockExitListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onStatus: function (callback) {
        // Tests can fire this via window.__mockFireStatus(sessionId, session).
        if (!window.__mockStatusListeners) window.__mockStatusListeners = [];
        window.__mockStatusListeners.push(callback);
        if (!window.__mockFireStatus) {
          window.__mockFireStatus = function (sessionId, session) {
            var listeners = (window.__mockStatusListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, session); }
          };
        }
        return function () {
          var listeners = window.__mockStatusListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onUsage: function () {
        return noop;
      },
      getActivity: async function (/* projectId */) {
        return Object.assign({}, activityCache);
      },
      getActivityReason: async function (/* sessionId */) {
        // No reason data is mocked; UI tests that assert on the reason
        // shape should extend this stub. Returning null mirrors the
        // production "session unknown" path.
        return null;
      },
      getActivityReasons: async function (/* projectId */) {
        // Batch reason map; mirrors getActivity's mock. UI tests don't
        // assert on reason content, so an empty record is fine.
        return {};
      },
      getActivityStats: async function (/* sessionId */) {
        // Debug overlay only; UI tests rarely need this. Return null
        // to mirror "session unknown" path.
        return null;
      },
      onActivity: function (callback) {
        // Tests can fire this via
        // window.__mockFireActivity(sessionId, state, reason, projectId, taskId).
        if (!window.__mockActivityListeners) window.__mockActivityListeners = [];
        window.__mockActivityListeners.push(callback);
        if (!window.__mockFireActivity) {
          window.__mockFireActivity = function (sessionId, state, reason, projectId, taskId) {
            var listeners = (window.__mockActivityListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, state, reason, projectId, taskId); }
          };
        }
        return function () {
          var listeners = window.__mockActivityListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
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
      getToolBreakdown: async function (_sessionId) {
        // Live telemetry is not captured in UI tests; specs that need a
        // breakdown override this stub per-test.
        return [];
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
          isolatedSwimlaneId: null,
          agentSessionId: null,
        };
        sessions.push(session);
        return { session: session, branch: input.branch || 'main' };
      },
      killTransient: async function (sessionId) {
        var index = sessions.findIndex(function (s) { return s.id === sessionId; });
        if (index !== -1) sessions.splice(index, 1);
      },
      // Call log for test assertions. Each entry is the string[] of session IDs
      // passed to setFocused. Reset between tests via:
      //   window.electronAPI.sessions.__setFocusedCalls.length = 0;
      __setFocusedCalls: [],
      setFocused: async function (sessionIds) {
        window.electronAPI.sessions.__setFocusedCalls.push(sessionIds.slice());
      },
      __notifyUserInterruptCalls: [],
      notifyUserInterrupt: async function (sessionId) {
        window.electronAPI.sessions.__notifyUserInterruptCalls.push(sessionId);
      },
      __injectSettingsCalls: [],
      injectSettings: async function (input) {
        window.electronAPI.sessions.__injectSettingsCalls.push(input);
        return { ok: true, injected: true };
      },
    },

    usage: {
      // Call log for test assertions. Each entry is
      // { scope, period, drill, customWindow }. Reset between tests via:
      //   window.electronAPI.usage.__getDashboardStatsCalls.length = 0;
      __getDashboardStatsCalls: [],
      // Override the returned payload for a test: set to a function
      //   (scope, period, drill, customWindow) => UsageDashboardStats
      // or null to use the default fixture below.
      __dashboardStatsFixture: null,
      getDashboardStats: async function (scope, period, drill, customWindow) {
        window.electronAPI.usage.__getDashboardStatsCalls.push({ scope: scope, period: period, drill: drill || null, customWindow: customWindow || null });
        if (window.electronAPI.usage.__dashboardStatsFixture) {
          return window.electronAPI.usage.__dashboardStatsFixture(scope, period, drill || null, customWindow || null);
        }
        // Default fixture: a small dense payload so the dashboard renders
        // tiles, charts, and breakdowns without per-test setup.
        var hourMs = 60 * 60 * 1000;
        var dayMs = 24 * hourMs;
        var nowMs = Date.now();
        var bucketSizeMs = hourMs;
        var bucketCount = 6;
        var rangeStartMs = Math.floor(nowMs / bucketSizeMs) * bucketSizeMs - (bucketCount - 1) * bucketSizeMs;
        var tokenSeries = [];
        for (var i = 0; i < bucketCount; i++) {
          tokenSeries.push({
            bucketStartMs: rangeStartMs + i * bucketSizeMs,
            inputTokens: 1000 + i * 250,
            outputTokens: 400 + i * 100,
            cacheCreationTokens: 200,
            cacheReadTokens: 5000,
            allocatedCostUsd: 0.05 * (i + 1),
            turnCount: 3 + i,
          });
        }
        var costSeries = [];
        for (var d = 0; d < 3; d++) {
          var dayCost = 1.25 + d;
          var dayInput = 20000 + d * 5000;
          var dayOutput = 8000 + d * 2000;
          costSeries.push({
            bucketStartMs: rangeStartMs - (2 - d) * dayMs,
            costUsd: dayCost,
            inputTokens: dayInput,
            outputTokens: dayOutput,
            sessionCount: 2 + d,
            byModel: [
              { modelId: 'mock-model-large', costUsd: dayCost * 0.75, inputTokens: Math.floor(dayInput * 0.75), outputTokens: Math.floor(dayOutput * 0.75) },
              { modelId: 'mock-model-small', costUsd: dayCost * 0.25, inputTokens: Math.ceil(dayInput * 0.25), outputTokens: Math.ceil(dayOutput * 0.25) },
            ],
          });
        }
        return {
          scope: scope,
          period: period,
          rangeStartMs: rangeStartMs,
          rangeEndMs: nowMs,
          bucketSizeMs: bucketSizeMs,
          costBucketSizeMs: dayMs,
          generatedAtMs: nowMs,
          kpis: {
            totalCostUsd: 12.34,
            costKnown: true,
            totalInputTokens: 150000,
            totalOutputTokens: 42000,
            totalTokens: 192000,
            sessionCount: 7,
            toolCallCount: 315,
            linesAdded: 1200,
            linesRemoved: 340,
            filesChanged: 58,
            compactionCount: 2,
            totalDurationMs: 4 * hourMs,
            turnInputTokens: 60000,
            turnOutputTokens: 20000,
            cacheCreationTokens: 30000,
            cacheReadTokens: 900000,
            burnRateTokensPerHour: 24000,
            burnRateUsdPerHour: 1.54,
          },
          previousKpis: period === 'all' ? null : {
            totalCostUsd: 10.0,
            costKnown: true,
            totalInputTokens: 120000,
            totalOutputTokens: 36000,
            totalTokens: 156000,
            sessionCount: 6,
            toolCallCount: 280,
            linesAdded: 1000,
            linesRemoved: 300,
            filesChanged: 50,
            compactionCount: 1,
            totalDurationMs: 3 * hourMs,
            turnInputTokens: 50000,
            turnOutputTokens: 16000,
            cacheCreationTokens: 24000,
            cacheReadTokens: 700000,
            burnRateTokensPerHour: 20000,
            burnRateUsdPerHour: 1.3,
          },
          tokenSeries: tokenSeries,
          costSeries: costSeries,
          byModel: [
            { modelId: 'mock-model-large', modelDisplayName: 'Mock Large', inputTokens: 120000, outputTokens: 30000, costUsd: 10.0, sessionCount: 5 },
            { modelId: 'mock-model-small', modelDisplayName: 'Mock Small', inputTokens: 30000, outputTokens: 12000, costUsd: 2.34, sessionCount: 2 },
          ],
          byAgent: [
            { agent: 'claude', inputTokens: 130000, outputTokens: 36000, costUsd: 11.0, sessionCount: 6 },
            { agent: 'codex', inputTokens: 20000, outputTokens: 6000, costUsd: 1.34, sessionCount: 1 },
          ],
          byEffort: [
            { effort: 'high', inputTokens: 90000, outputTokens: 26000, costUsd: 8.0, sessionCount: 3 },
            { effort: null, inputTokens: 40000, outputTokens: 10000, costUsd: 3.0, sessionCount: 3 },
            { effort: 'low', inputTokens: 20000, outputTokens: 6000, costUsd: 1.34, sessionCount: 1 },
          ],
          perProject: scope.kind === 'all'
            ? [
                { projectId: 'mock-project-1', projectName: 'Mock Project', inputTokens: 100000, outputTokens: 30000, costUsd: 9.0, sessionCount: 5, toolCallCount: 220, linesAdded: 900, linesRemoved: 250, filesChanged: 47, totalDurationMs: 3 * hourMs, lastActiveMs: nowMs - hourMs, topAgent: 'claude' },
                { projectId: 'mock-project-2', projectName: 'Other Project', inputTokens: 50000, outputTokens: 12000, costUsd: 3.34, sessionCount: 2, toolCallCount: 95, linesAdded: 300, linesRemoved: 90, filesChanged: 12, totalDurationMs: hourMs, lastActiveMs: nowMs - 26 * hourMs, topAgent: 'codex' },
              ]
            : undefined,
        };
      },
    },

    dictation: {
      // Call logs for test assertions. Reset between tests by truncating length.
      __startCalls: [],
      start: async function (options) {
        window.electronAPI.dictation.__startCalls.push(options);
        return { dictationSessionId: 'mock-dictation-1', engineId: 'stub', modelId: null, needsDownload: false };
      },
      __stopCalls: [],
      stop: async function (dictationSessionId, expectedFrames) {
        window.electronAPI.dictation.__stopCalls.push({ dictationSessionId, expectedFrames });
        return 'This is a test of dictation.';
      },
      __cancelCalls: [],
      cancel: async function (dictationSessionId) {
        window.electronAPI.dictation.__cancelCalls.push(dictationSessionId);
      },
      // Each entry is { sessionId, text }.
      __commits: [],
      commit: async function (sessionId, text) {
        window.electronAPI.dictation.__commits.push({ sessionId: sessionId, text: text });
        return true;
      },
      // Each entry is { sessionId, text, eraseCount }.
      __submits: [],
      submit: async function (sessionId, text, eraseCount) {
        window.electronAPI.dictation.__submits.push({ sessionId: sessionId, text: text, eraseCount: eraseCount });
        return true;
      },
      getInfo: async function () {
        return {
          hardware: { cpuModel: 'Mock CPU', cpuCores: 8, totalRamGb: 16, hasAvx2: true, gpu: 'none', gpuDescription: 'Integrated', platform: 'linux', arch: 'x64' },
          tier: 'accurate-base',
          selectedEngineId: 'stub',
          engines: [{ id: 'stub', displayName: 'Stub (test)', streaming: true, punctuation: true, license: 'none', requiresModelDownload: false }],
          installedModels: [],
          selectedModelId: null,
          selectedModelSizeMb: null,
          availableModels: [],
          liveModels: [],
          finalModels: [],
          selectedLiveModelId: null,
          selectedFinalModelId: null,
        };
      },
      // Push-event subscribers. Tests drive these via window.__emitDictationPartial
      // (dictationSessionId, text) and window.__emitDictationFinal(...).
      onPartial: function (callback) {
        if (!window.__mockDictationPartialListeners) window.__mockDictationPartialListeners = [];
        window.__mockDictationPartialListeners.push(callback);
        if (!window.__emitDictationPartial) {
          window.__emitDictationPartial = function (dictationSessionId, text) {
            var listeners = (window.__mockDictationPartialListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](dictationSessionId, text); }
          };
        }
        return function () {
          var listeners = window.__mockDictationPartialListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onFinal: function (callback) {
        if (!window.__mockDictationFinalListeners) window.__mockDictationFinalListeners = [];
        window.__mockDictationFinalListeners.push(callback);
        if (!window.__emitDictationFinal) {
          window.__emitDictationFinal = function (dictationSessionId, text) {
            var listeners = (window.__mockDictationFinalListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](dictationSessionId, text); }
          };
        }
        return function () {
          var listeners = window.__mockDictationFinalListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      // Count of streamed PCM frames (tests assert audio is flowing).
      __audioChunkCount: 0,
      sendAudioChunk: function () {
        window.electronAPI.dictation.__audioChunkCount += 1;
      },
      __requestMicCalls: 0,
      requestMic: async function () {
        window.electronAPI.dictation.__requestMicCalls += 1;
        return 'granted';
      },
      onModelProgress: function (callback) {
        if (!window.__mockDictationModelProgressListeners) window.__mockDictationModelProgressListeners = [];
        window.__mockDictationModelProgressListeners.push(callback);
        if (!window.__emitDictationModelProgress) {
          window.__emitDictationModelProgress = function (progress) {
            var listeners = (window.__mockDictationModelProgressListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](progress); }
          };
        }
        return function () {
          var listeners = window.__mockDictationModelProgressListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      __downloadModelCalls: [],
      downloadModel: async function (config) {
        window.electronAPI.dictation.__downloadModelCalls.push(config);
      },
      __liveWriteCalls: [],
      liveWrite: function (sessionId, payload) {
        window.electronAPI.dictation.__liveWriteCalls.push({ sessionId: sessionId, payload: payload });
      },
      __prewarmCalls: [],
      prewarm: function (config) {
        window.electronAPI.dictation.__prewarmCalls.push(config);
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
        // hotkeyOverrides is a dictionary-style map (CONFIG_DICTIONARY_PATHS in
        // config-manager.ts): the real save REPLACES it wholesale so a deleted
        // key (reset) actually disappears. deepMerge above would instead merge it
        // key-by-key, so mirror the replace semantics here.
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'hotkeyOverrides')) {
          config.hotkeyOverrides = Object.assign({}, partial.hotkeyOverrides);
        }
        // workspaceByProject is likewise a dictionary-style map (CONFIG_DICTIONARY_PATHS):
        // the real save REPLACES the per-project map wholesale so a changed tile tree
        // never deep-merges into the old one. Mirror the replace semantics here.
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'workspaceByProject')) {
          config.workspaceByProject = Object.assign({}, partial.workspaceByProject);
        }
        // commandTerminalWorkspace is a renderer-authoritative blob (CONFIG_DICTIONARY_PATHS):
        // the real save REPLACES it wholesale so a removed window / null reset takes effect.
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'commandTerminalWorkspace')) {
          config.commandTerminalWorkspace = partial.commandTerminalWorkspace;
        }
        // monitorWorkspace is the same kind of blob, for the Agent Monitor's detail layer.
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'monitorWorkspace')) {
          config.monitorWorkspace = partial.monitorWorkspace;
        }
        // terminal.colors is a nested dictionary-style map (CONFIG_DICTIONARY_PATHS:
        // 'terminal.colors'): the real save REPLACES it wholesale so resetting a
        // single color slot (deleting its key) actually takes effect.
        if (partial && partial.terminal && Object.prototype.hasOwnProperty.call(partial.terminal, 'colors')) {
          config.terminal.colors = Object.assign({}, partial.terminal.colors);
        }
      },
      // Synchronous sibling of set() for the quit/unload flush. Mirrors the real
      // configManager.save dictionary-path replace semantics (hotkeyOverrides + workspaceByProject + commandTerminalWorkspace + terminal.colors).
      setSync: function (partial) {
        config = deepMerge(config, partial);
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'hotkeyOverrides')) {
          config.hotkeyOverrides = Object.assign({}, partial.hotkeyOverrides);
        }
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'workspaceByProject')) {
          config.workspaceByProject = Object.assign({}, partial.workspaceByProject);
        }
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'commandTerminalWorkspace')) {
          config.commandTerminalWorkspace = partial.commandTerminalWorkspace;
        }
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'monitorWorkspace')) {
          config.monitorWorkspace = partial.monitorWorkspace;
        }
        if (partial && partial.terminal && Object.prototype.hasOwnProperty.call(partial.terminal, 'colors')) {
          config.terminal.colors = Object.assign({}, partial.terminal.colors);
        }
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
      onChanged: function (/* callback() */) { return noop; },
    },

    keybindings: {
      // Default: every probed combo is free. Tests can override the verdict by
      // setting window.__mockProbeGlobal = { 'Mod+Shift+S': 'taken', ... }.
      probeGlobal: async function (combos) {
        var overrides = (typeof window !== 'undefined' && window.__mockProbeGlobal) || {};
        var result = {};
        (combos || []).forEach(function (combo) {
          result[combo] = overrides[combo] || 'available';
        });
        return result;
      },
    },

    agent: {
      listCommands: async function (/* cwd */) {
        return [
          { name: 'code-review', displayName: '/code-review', description: 'Review code for quality and conventions', argumentHint: '', source: 'command' },
          { name: 'test', displayName: '/test', description: 'Run tests and audit coverage', argumentHint: '', source: 'command' },
          { name: 'ci:build', displayName: '/ci:build', description: 'Run CI build pipeline', argumentHint: '[fast|full]', source: 'command' },
        ];
      },
      summarize: async function (input) {
        // Deterministic stub for UI tests: return a canned title derived from
        // the first 40 chars of the prompt. Tests can override by setting
        // window.__mockAgentSummarize = (input) => ({ ok: true, title: '...' }).
        if (typeof window !== 'undefined' && typeof window.__mockAgentSummarize === 'function') {
          return window.__mockAgentSummarize(input);
        }
        var trimmed = (input && input.prompt ? String(input.prompt) : '').trim();
        if (!trimmed) return { ok: false, reason: 'empty prompt' };
        var snippet = trimmed.slice(0, 40).replace(/\s+/g, ' ');
        return { ok: true, title: 'Mock Title: ' + snippet };
      },
    },

    agents: {
      // forceRefresh is accepted to match the real API surface but ignored:
      // the mock always returns the fixture, fresh or cached alike.
      list: async function (_forceRefresh) {
        // Tests can override per-agent fields (found, version, authenticated, etc.)
        // by setting window.__mockAgentListOverrides = { kimi: { found: true, authenticated: false }, ... }
        // before navigating to the page. Useful for exercising auth-state UI without
        // changing the default fixture, which keeps every non-Claude agent as not-installed.
        var overrides = (typeof window !== 'undefined' && window.__mockAgentListOverrides) || {};
        var defaults = [
          {
            name: 'claude', displayName: 'Claude Code', found: true, path: '/usr/bin/claude', version: '2.1.72',
            permissions: [
              { mode: 'plan', label: 'Plan (Read-Only)' },
              { mode: 'dontAsk', label: "Don't Ask (Deny Unless Allowed)" },
              { mode: 'default', label: 'Default (Allowlist)' },
              { mode: 'acceptEdits', label: 'Accept Edits' },
              { mode: 'auto', label: 'Auto (Classifier)' },
              { mode: 'bypassPermissions', label: 'Bypass (Unsafe)' },
            ],
            defaultPermission: 'acceptEdits',
            supportsSummarize: true,
            // KEEP IN SYNC with ClaudeAdapter.reportsRateLimits: gates the ContextBar
            // rate-limit pill on the agent capability (account-wide snapshot).
            reportsRateLimits: true,
            // KEEP IN SYNC with ClaudeAdapter.pastedImageReferenceTemplate: the text
            // injected for a pasted/dropped image instead of a bare file path.
            pastedImageReferenceTemplate: 'Read this image: {path} ',
            // Capabilities mirror what discoverClaudeCapabilities() would return
            // for a real Claude install: parsed from `claude --help` plus the
            // user's `availableModels` setting. Tests can override per-agent
            // shape via window.__mockAgentListOverrides; clear `models` to
            // exercise the free-form input fallback.
            capabilities: {
              effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsModelOverride: true,
              models: ['opus', 'sonnet', 'haiku'],
            },
          },
          {
            name: 'codex', displayName: 'Codex CLI', found: false, path: null, version: null,
            permissions: [
              { mode: 'plan', label: 'Suggest (Read-Only)' },
              { mode: 'acceptEdits', label: 'Auto-Edit' },
              { mode: 'bypassPermissions', label: 'Full Auto (Sandboxed)' },
            ],
            defaultPermission: 'acceptEdits',
            supportsSummarize: true,
            // KEEP IN SYNC with CodexAdapter.launchOptions in
            // src/main/agent/adapters/codex/codex-adapter.ts - the only agent
            // that declares a launch option today, so the Agent tab's launch
            // option row has exactly one agent to render it for in tests.
            launchOptions: [{
              id: 'disableApps',
              label: 'Disable ChatGPT Apps',
              description: "Skips Codex's optional ChatGPT Apps connector, which can hang startup. Doesn't touch your global config.",
              default: false,
            }],
          },
          {
            name: 'gemini', displayName: 'Gemini CLI', found: false, path: null, version: null,
            permissions: [
              { mode: 'plan', label: 'Plan (Read-Only)' },
              { mode: 'default', label: 'Default (Interactive)' },
              { mode: 'acceptEdits', label: 'Auto-Edit' },
              { mode: 'bypassPermissions', label: 'YOLO (Auto-Approve All)' },
            ],
            defaultPermission: 'acceptEdits',
            supportsSummarize: true,
          },
          {
            name: 'aider', displayName: 'Aider', found: false, path: null, version: null,
            permissions: [
              { mode: 'default', label: 'Interactive (Confirm)' },
              { mode: 'bypassPermissions', label: 'Auto-Approve (--yes)' },
            ],
            defaultPermission: 'bypassPermissions',
          },
          {
            name: 'cursor', displayName: 'Cursor CLI', found: false, path: null, version: null,
            permissions: [
              { mode: 'default', label: 'Interactive (Confirm Changes)' },
              { mode: 'bypassPermissions', label: 'Non-Interactive (Full Access)' },
            ],
            defaultPermission: 'default',
            supportsSummarize: true,
          },
          {
            name: 'warp', displayName: 'Oz CLI', found: false, path: null, version: null,
            permissions: [
              { mode: 'plan', label: 'Plan Only (Read-Only)' },
              { mode: 'default', label: 'Default' },
              { mode: 'bypassPermissions', label: 'Auto (Skip Confirmations)' },
            ],
            defaultPermission: 'default',
          },
          {
            name: 'copilot', displayName: 'GitHub Copilot CLI', found: false, path: null, version: null,
            permissions: [
              { mode: 'plan', label: 'Plan (Read-Only)' },
              { mode: 'dontAsk', label: 'Plan Non-Interactive (CI)' },
              { mode: 'default', label: 'Default (Confirm Actions)' },
              { mode: 'acceptEdits', label: 'Allow All Tools' },
              { mode: 'auto', label: 'Autopilot (Allow All Tools)' },
              { mode: 'bypassPermissions', label: 'YOLO (Full Access)' },
            ],
            defaultPermission: 'acceptEdits',
            supportsSummarize: true,
          },
          {
            name: 'kimi', displayName: 'Kimi Code', found: false, path: null, version: null,
            // KEEP IN SYNC with KimiAdapter.permissions in src/main/agent/adapters/kimi/kimi-adapter.ts
            permissions: [
              { mode: 'plan', label: 'Plan (Read-Only)' },
              { mode: 'default', label: 'Default (Confirm Actions)' },
              { mode: 'bypassPermissions', label: 'YOLO (Skip Confirmations)' },
            ],
            defaultPermission: 'default',
            supportsSummarize: true,
          },
          {
            name: 'opencode', displayName: 'OpenCode', found: false, path: null, version: null,
            // KEEP IN SYNC with OpenCodeAdapter.permissions in src/main/agent/adapters/opencode/opencode-adapter.ts
            permissions: [
              { mode: 'plan', label: 'Plan' },
              { mode: 'acceptEdits', label: 'Build' },
            ],
            defaultPermission: 'acceptEdits',
            supportsSummarize: true,
            // KEEP IN SYNC with OpenCodeAdapter.remoteExecution.info - the only
            // agent that declares this capability today, so the Agent tab's
            // remote-execution rows have exactly one agent to render them for
            // in tests.
            remoteExecution: {
              urlPlaceholder: 'http://10.0.0.5:4096',
              authKind: 'basic',
              workingDirectoryScope: 'per-invocation',
              remoteModeCaveat: 'The server is the authority for providers, models, and MCP tools in remote mode.',
            },
          },
          {
            name: 'droid', displayName: 'Droid', found: false, path: null, version: null,
            // KEEP IN SYNC with DroidAdapter.permissions and DroidAdapter.liveTelemetryUnsupported
            // in src/main/agent/adapters/droid/droid-adapter.ts
            permissions: [
              { mode: 'default', label: 'Default (use Droid TUI controls)' },
            ],
            defaultPermission: 'default',
            supportsSummarize: true,
            liveTelemetryUnsupported: {
              unavailableLabel: 'Telemetry: TUI only',
              unavailableTitle:
                'Droid does not stream live telemetry to Kangentic.\n' +
                'Run /cost or /context inside the Droid TUI to see model, tokens, and cost.\n' +
                'Tracked upstream: Factory-AI/factory (see docs/agent-integration.md).',
            },
          },
          {
            name: 'ollama', displayName: 'Ollama', found: false, path: null, version: null,
            // KEEP IN SYNC with OllamaAdapter.permissions in src/main/agent/adapters/ollama/ollama-adapter.ts
            permissions: [
              { mode: 'default', label: 'Chat' },
            ],
            defaultPermission: 'default',
          },
        ];
        return defaults.map(function (agent) {
          var override = overrides[agent.name];
          return override ? Object.assign({}, agent, override) : agent;
        });
      },
      // Tests can set window.__mockProbeExecutionServer = function (agentName) { ... }
      // to control the "Test connection" result; default is a reachable stub.
      probeExecutionServer: async function (agentName) {
        if (typeof window !== 'undefined' && typeof window.__mockProbeExecutionServer === 'function') {
          return window.__mockProbeExecutionServer(agentName);
        }
        return { reachable: true, version: '1.14.25' };
      },
    },

    handoffs: {
      list: async function (_taskId) {
        return [];
      },
    },

    // Task-detail ownership. There is exactly ONE renderer under test, so a
    // handover always resolves to "open here"; what this mock genuinely exercises
    // is the never-open-twice rule and the derived syncOwned / releaseAllFor
    // lifecycle (there is no claim/release pair - see
    // .claude/rules/derived-detail-ownership.md). `__owners` is exposed so a spec
    // can assert ownership directly.
    taskDetailOwnership: {
      // key -> { host }. Mirrors main's DetailOwnerRegistry closely enough to
      // exercise the real rule: the requester wins, and the previous holder is
      // told to close. `__owners` is exposed so a spec can assert ownership.
      __owners: {},
      requestOpen: function (projectId, taskId, host) {
        var key = projectId + ':' + taskId;
        var owners = window.electronAPI.taskDetailOwnership.__owners;
        var existing = owners[key] || null;
        if (existing && existing.host === host) {
          return Promise.resolve({
            kind: 'focused-existing',
            owner: { webContentsId: 1, host: host },
          });
        }
        if (existing) {
          var closers = (window.__mockDetailCloseHereListeners || []).slice();
          for (var c = 0; c < closers.length; c++) closers[c](projectId, taskId, existing.host);
        }
        var listeners = (window.__mockDetailOpenHereListeners || []).slice();
        for (var i = 0; i < listeners.length; i++) listeners[i](projectId, taskId, host);
        return Promise.resolve({
          kind: 'open-here',
          owner: { webContentsId: 1, host: host },
          closedElsewhere: existing,
        });
      },
      // Ownership is DERIVED: a host reports the COMPLETE set of details it has
      // mounted and main reconciles to match, so a lost message cannot strand a
      // claim. Mirrors `DetailOwnerRegistry.syncOwned`, including the two asymmetric
      // halves that make a handover converge in either order:
      //   - remove only keys THIS host owns (a stale report cannot erase the new
      //     owner's key);
      //   - an add may displace another host, which is then told to close.
      // Single renderer here, so the host alone is the scope.
      syncOwned: function (host, entries) {
        var owners = window.electronAPI.taskDetailOwnership.__owners;
        var reported = {};
        var index;
        for (index = 0; index < entries.length; index++) {
          reported[entries[index].projectId + ':' + entries[index].taskId] = true;
        }

        var key;
        for (key in owners) {
          if (!Object.prototype.hasOwnProperty.call(owners, key)) continue;
          if (owners[key].host !== host) continue;
          if (reported[key]) continue;
          delete owners[key];
        }

        for (index = 0; index < entries.length; index++) {
          var entry = entries[index];
          key = entry.projectId + ':' + entry.taskId;
          var previous = owners[key] || null;
          if (previous && previous.host === host) continue;
          owners[key] = { webContentsId: 1, host: host };
          if (!previous) continue;
          var closers = (window.__mockDetailCloseHereListeners || []).slice();
          for (var c = 0; c < closers.length; c++) {
            closers[c](entry.projectId, entry.taskId, previous.host);
          }
        }
      },
      onOpenHere: function (callback) {
        if (!window.__mockDetailOpenHereListeners) window.__mockDetailOpenHereListeners = [];
        window.__mockDetailOpenHereListeners.push(callback);
        return function () {
          var listeners = window.__mockDetailOpenHereListeners || [];
          var index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      onCloseHere: function (callback) {
        if (!window.__mockDetailCloseHereListeners) window.__mockDetailCloseHereListeners = [];
        window.__mockDetailCloseHereListeners.push(callback);
        return function () {
          var listeners = window.__mockDetailCloseHereListeners || [];
          var index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      // Details held by ANOTHER renderer. The mock is a single renderer, so real
      // ownership here is never remote; a test simulates a detached monitor via
      // window.__mockSetRemoteDetailOwners([{ projectId, taskId }]).
      onRemoteOwnersChanged: function (callback) {
        if (!window.__mockDetailRemoteOwnerListeners) window.__mockDetailRemoteOwnerListeners = [];
        window.__mockDetailRemoteOwnerListeners.push(callback);
        return function () {
          var listeners = window.__mockDetailRemoteOwnerListeners || [];
          var index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
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
        // Test hook: record external-open calls so a test can assert the URL.
        // Shares window.__openedExternalUrls with the ad-hoc openExternal
        // patches in pr-link-badge.spec.ts / settings-panel.spec.ts (both
        // replace this function wholesale before use, so there is no
        // double-recording risk).
        if (typeof window !== 'undefined') {
          window.__openedExternalUrls = window.__openedExternalUrls || [];
          window.__openedExternalUrls.push(arguments[0]);
        }
        return;
      },
      showItemInFolder: async function () {
        // Test hook: record reveal-in-OS calls so a test can assert the path.
        if (typeof window !== 'undefined') {
          window.__mockShowItemInFolderCalls = window.__mockShowItemInFolderCalls || [];
          window.__mockShowItemInFolderCalls.push(arguments[0]);
        }
        return;
      },
      exec: async function (/* command, cwd */) {
        return { pid: 12345 };
      },
    },

    font: {
      getAvailable: async function () {
        return ['Cascadia Code', 'Consolas', 'Courier New', 'Fira Code', 'JetBrains Mono', 'Menlo'];
      },
    },

    git: {
      // forceRefresh is accepted to match the real API surface but ignored:
      // the mock always returns the fixture, fresh or cached alike.
      detect: async function (_forceRefresh) {
        return { found: true, path: '/usr/bin/git', version: '2.43.0', meetsMinimum: true };
      },
      listBranches: async function () {
        return ['main', 'develop', 'feature/auth', 'feature/dashboard', 'fix/login-bug'];
      },
      diffFiles: async function (request) {
        // Test hook: seed a diff fixture via window.__mockGitDiff = { files: [...] }
        // where each file is { path, status, binary?, insertions?, deletions?,
        // original, modified, language? }, or per-scope via
        // window.__mockGitDiffByScope = { working: {...}, staged: {...}, branch: {...} }.
        // Default stays empty.

        // Test hook: record every diffFiles call (scope + commitOid + whether
        // the request carries a 'commitOid' key at all) so a test can assert
        // how many calls actually fired, with what params, and from which
        // call site - used to verify ChangesPanel's fetchFiles
        // in-flight/pending-rerun guard (a burst of fs.watch fires while a
        // call is in flight must coalesce into a single queued rerun, not one
        // call per fire). fetchFiles always passes a literal `commitOid:
        // changesSelectedCommit ?? undefined` key (present even when
        // undefined); the separate, unguarded fetchUncommittedCount never
        // includes that key - hasCommitOidKey lets a test isolate fetchFiles's
        // own call sequence from fetchUncommittedCount's independent calls.
        if (typeof window !== 'undefined') {
          window.__mockGitDiffFilesCalls = window.__mockGitDiffFilesCalls || [];
          window.__mockGitDiffFilesCalls.push({
            scope: request && request.scope,
            commitOid: (request && request.commitOid) || null,
            hasCommitOidKey: Object.prototype.hasOwnProperty.call(request || {}, 'commitOid'),
          });
        }
        // Test hook: make diffFiles return a controlled promise so a test can
        // hold a call in flight and observe the overlapping-fetch guard. Set
        // window.__mockGitDiffFilesDeferred = true before triggering the
        // call; each call then hangs until its own resolver (appended to
        // window.__mockGitDiffFilesResolvers, in call order) is invoked.
        if (typeof window !== 'undefined' && window.__mockGitDiffFilesDeferred) {
          var diffFilesResolveRef;
          var diffFilesPending = new Promise(function (res) { diffFilesResolveRef = res; });
          window.__mockGitDiffFilesResolvers = window.__mockGitDiffFilesResolvers || [];
          window.__mockGitDiffFilesResolvers.push(diffFilesResolveRef);
          await diffFilesPending;
        }
        var fixture = resolveGitDiffFixture(request);
        if (fixture && Array.isArray(fixture.files)) {
          var totalInsertions = 0;
          var totalDeletions = 0;
          var files = fixture.files.map(function (entry) {
            totalInsertions += entry.insertions || 0;
            totalDeletions += entry.deletions || 0;
            return {
              path: entry.path,
              status: entry.status || 'M',
              binary: entry.binary || false,
              insertions: entry.insertions || 0,
              deletions: entry.deletions || 0,
              oldPath: entry.oldPath,
            };
          });
          return { files: files, totalInsertions: totalInsertions, totalDeletions: totalDeletions };
        }
        return { files: [], totalInsertions: 0, totalDeletions: 0 };
      },
      fileContent: async function (request) {
        // Test hook: make fileContent() return a controlled promise so a test
        // can observe a synchronous stale-cache-serve before the corrective
        // background fetch resolves (see the ContentCacheEntry
        // stale-while-revalidate path in ChangesPanel.tsx). Set
        // window.__mockGitFileContentDeferred = true before triggering the
        // call; it hangs until window.__mockGitFileContentResolve() is called.
        if (typeof window !== 'undefined' && window.__mockGitFileContentDeferred) {
          window.__mockGitFileContentDeferred = false;
          var resolveRef;
          var pending = new Promise(function (res) { resolveRef = res; });
          window.__mockGitFileContentResolve = resolveRef;
          await pending;
        }
        var fixture = resolveGitDiffFixture(request);
        if (fixture && Array.isArray(fixture.files)) {
          var match = fixture.files.find(function (entry) { return entry.path === (request && request.filePath); });
          if (match) {
            return {
              original: match.original || '',
              modified: match.modified || '',
              language: match.language || 'plaintext',
            };
          }
        }
        return { original: '', modified: '', language: 'plaintext' };
      },
      subscribeDiff: function () {},
      unsubscribeDiff: function () {},
      // Test hook: fire a live diff-changed push to every registered listener
      // via window.__mockFireDiffChanged() (no payload - mirrors the real
      // preload's GIT_DIFF_CHANGED push, which is also argument-less). Same
      // listener-registry shape as onData / onSpawnProgress above.
      onDiffChanged: function (callback) {
        if (!window.__mockDiffChangedListeners) window.__mockDiffChangedListeners = [];
        window.__mockDiffChangedListeners.push(callback);
        if (!window.__mockFireDiffChanged) {
          window.__mockFireDiffChanged = function () {
            var listeners = (window.__mockDiffChangedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](); }
          };
        }
        return function () {
          var listeners = window.__mockDiffChangedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      checkPendingChanges: async function () {
        // Test hook: simulate a slow git probe so a test can observe the board
        // during the await window (the real round-trip is ~100ms on a worktree).
        // Set window.__mockCheckPendingChangesDelayMs before the drag.
        var delay = (typeof window !== 'undefined' && window.__mockCheckPendingChangesDelayMs) || 0;
        if (delay) await new Promise(function (resolve) { setTimeout(resolve, delay); });
        // Test hook: override the result (e.g. to force the confirm dialog).
        if (typeof window !== 'undefined' && window.__mockPendingChangesResult) {
          return window.__mockPendingChangesResult;
        }
        return { hasPendingChanges: false, uncommittedFileCount: 0, unpushedCommitCount: 0, currentBranch: null };
      },
      branchSummary: async function () {
        // Test hook: override the header context (branch name, ahead/behind, last commit).
        if (typeof window !== 'undefined' && window.__mockBranchSummary) {
          return window.__mockBranchSummary;
        }
        return { currentBranch: null, ahead: 0, behind: 0, lastCommit: null };
      },
      commitGraph: async function () {
        // Test hook: seed the commit-graph pane via window.__mockCommitGraph =
        // { commits: [{ hash, shortHash, parents, authorName, authorTimestamp, subject }],
        //   tipHash, baseHash, mergeBaseHash, currentBranch, truncated }.
        if (typeof window !== 'undefined' && window.__mockCommitGraph) {
          return window.__mockCommitGraph;
        }
        return { commits: [], tipHash: null, baseHash: null, mergeBaseHash: null, currentBranch: null, truncated: false };
      },
      fileHistory: async function () {
        // Test hook: seed the file-history popover via window.__mockFileHistory =
        // { commits: [{ hash, shortHash, authorName, authorTimestamp, subject }] }.
        if (typeof window !== 'undefined' && window.__mockFileHistory) {
          return window.__mockFileHistory;
        }
        return { commits: [] };
      },
      blame: async function () {
        // Test hook: seed the blame gutter via window.__mockBlame =
        // { lines: [{ line, hash, shortHash, author, date }] }.
        if (typeof window !== 'undefined' && window.__mockBlame) {
          return window.__mockBlame;
        }
        return { lines: [] };
      },
    },

    dialog: {
      // options is accepted to match the real API surface (title, message,
      // buttonLabel, defaultPath) but ignored: the mock always returns the
      // fixture path, dialog chrome or not.
      selectFolder: async function (_options) {
        var override = window.__mockFolderPath;
        if (override) {
          window.__mockFolderPath = null;
          return override;
        }
        return '/mock/path/test-project';
      },
    },

    backlogAttachments: {
      list: async function (/* backlogTaskId */) {
        return [];
      },
      add: async function (input) {
        return {
          id: 'ba-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          backlog_task_id: input.backlog_task_id,
          filename: input.filename,
          file_path: '/mock/' + input.filename,
          media_type: input.media_type,
          size_bytes: input.data ? input.data.length : 0,
          created_at: new Date().toISOString(),
        };
      },
      remove: async function (/* id */) {},
      getDataUrl: async function (/* id */) {
        return 'data:image/png;base64,iVBORw0KGgo=';
      },
      open: async function (/* id */) { return ''; },
    },

    backlog: {
      list: async function () {
        return backlogTasks.slice().sort(function (a, b) { return a.position - b.position; });
      },
      create: async function (input) {
        var maxPos = backlogTasks.reduce(function (max, item) { return Math.max(max, item.position); }, -1);
        var item = {
          id: 'backlog-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          title: input.title,
          description: input.description || '',
          priority: input.priority || 0,
          labels: input.labels || [],
          position: maxPos + 1,
          assignee: input.assignee || null,
          due_date: input.dueDate || null,
          item_type: input.itemType || null,
          external_id: input.externalId || null,
          external_source: input.externalSource || null,
          external_url: input.externalUrl || null,
          sync_status: input.syncStatus || null,
          external_metadata: input.externalMetadata || null,
          attachment_count: input.pendingAttachments ? input.pendingAttachments.length : 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        backlogTasks.push(item);
        return item;
      },
      update: async function (input) {
        var item = backlogTasks.find(function (i) { return i.id === input.id; });
        if (!item) throw new Error('Backlog task not found');
        if (input.title !== undefined) item.title = input.title;
        if (input.description !== undefined) item.description = input.description;
        if (input.priority !== undefined) item.priority = input.priority;
        if (input.labels !== undefined) item.labels = input.labels;
        if (input.pendingAttachments) {
          item.attachment_count = (item.attachment_count || 0) + input.pendingAttachments.length;
        }
        item.updated_at = new Date().toISOString();
        return Object.assign({}, item);
      },
      delete: async function (id) {
        backlogTasks = backlogTasks.filter(function (i) { return i.id !== id; });
      },
      reorder: async function (ids) {
        ids.forEach(function (id, index) {
          var item = backlogTasks.find(function (i) { return i.id === id; });
          if (item) item.position = index;
        });
      },
      bulkDelete: async function (ids) {
        backlogTasks = backlogTasks.filter(function (i) { return ids.indexOf(i.id) === -1; });
      },
      promote: async function (input) {
        var createdTasks = [];
        input.backlogTaskIds.forEach(function (itemId) {
          var item = backlogTasks.find(function (i) { return i.id === itemId; });
          if (!item) return;
          var maxPos = tasks.reduce(function (max, t) { return t.swimlane_id === input.targetSwimlaneId ? Math.max(max, t.position) : max; }, -1);
          var task = {
            id: 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            display_id: nextDisplayId++,
            title: item.title,
            description: item.description,
            swimlane_id: input.targetSwimlaneId,
            position: maxPos + 1,
            agent: null,
            session_id: null,
            worktree_path: null,
            worktree_folder: null,
            branch_name: null,
            pr_number: null,
            pr_url: null,
            pr_state: null,
            external_id: item.external_id || null,
            external_source: item.external_source || null,
            external_url: item.external_url || null,
            base_branch: null,
            use_worktree: null,
            labels: item.labels || [],
            priority: item.priority || 0,
            agent_override: null,
            model_override: null,
            effort_override: null,
            permission_mode: null,
            auto_command: null,
            profile_id: null,
            // A promoted item has never been through the run-mode dialog, so it
            // lands on the same default TaskRepository.create would write. Left
            // undefined, the task-detail dialog would seed `runMode` from a
            // missing field and neither radio would render checked.
            run_mode: 'column_settings',
            attachment_count: 0,
            archived_at: null,
            detail_view_state: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          tasks.push(task);
          createdTasks.push(task);
          backlogTasks = backlogTasks.filter(function (i) { return i.id !== itemId; });
        });
        return createdTasks;
      },
      demote: async function (input) {
        var task = tasks.find(function (t) { return t.id === input.taskId; });
        if (!task) throw new Error('Task not found');
        var maxPos = backlogTasks.reduce(function (max, item) { return Math.max(max, item.position); }, -1);
        var item = {
          id: 'backlog-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          title: task.title,
          description: task.description,
          priority: input.priority != null ? input.priority : (task.priority || 0),
          labels: input.labels != null ? input.labels : (task.labels || []),
          position: maxPos + 1,
          assignee: null,
          due_date: null,
          item_type: null,
          external_id: task.external_id || null,
          external_source: task.external_source || null,
          external_url: task.external_url || null,
          sync_status: null,
          external_metadata: null,
          attachment_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        backlogTasks.push(item);
        tasks = tasks.filter(function (t) { return t.id !== input.taskId; });
        return item;
      },
      renameLabel: async function (oldName, newName) {
        var count = 0;
        backlogTasks.forEach(function (item) {
          var index = item.labels.indexOf(oldName);
          if (index !== -1) {
            item.labels[index] = newName;
            item.labels = item.labels.filter(function (label, labelIndex, array) { return array.indexOf(label) === labelIndex; });
            count++;
          }
        });
        tasks.forEach(function (task) {
          var taskLabels = task.labels || [];
          var index = taskLabels.indexOf(oldName);
          if (index !== -1) {
            taskLabels[index] = newName;
            task.labels = taskLabels.filter(function (label, labelIndex, array) { return array.indexOf(label) === labelIndex; });
            count++;
          }
        });
        return count;
      },
      deleteLabel: async function (name) {
        var count = 0;
        backlogTasks.forEach(function (item) {
          var before = item.labels.length;
          item.labels = item.labels.filter(function (label) { return label !== name; });
          if (item.labels.length !== before) count++;
        });
        tasks.forEach(function (task) {
          var taskLabels = task.labels || [];
          var before = taskLabels.length;
          task.labels = taskLabels.filter(function (label) { return label !== name; });
          if (task.labels.length !== before) count++;
        });
        return count;
      },
      remapPriorities: async function (mapping) {
        var count = 0;
        backlogTasks.forEach(function (item) {
          var newPriority = mapping[item.priority];
          if (newPriority !== undefined && newPriority !== item.priority) {
            item.priority = newPriority;
            count++;
          }
        });
        return count;
      },
      onChangedByAgent: function (callback) {
        // Capture the callback so tests can simulate the main-process broadcast
        // via window.__mockFireBacklogChangedByAgent(projectId).
        if (typeof window !== 'undefined') {
          if (!window.__mockBacklogChangedListeners) {
            window.__mockBacklogChangedListeners = [];
          }
          window.__mockBacklogChangedListeners.push(callback);
          if (!window.__mockFireBacklogChangedByAgent) {
            window.__mockFireBacklogChangedByAgent = function (projectId) {
              var listeners = (window.__mockBacklogChangedListeners || []).slice();
              for (var i = 0; i < listeners.length; i++) {
                listeners[i](projectId);
              }
            };
          }
        }
        return function () {
          if (typeof window === 'undefined') return;
          var listeners = window.__mockBacklogChangedListeners || [];
          var listenerIndex = listeners.indexOf(callback);
          if (listenerIndex >= 0) listeners.splice(listenerIndex, 1);
        };
      },
      onLabelColorsChanged: function (callback) {
        // Tests can fire this via window.__mockFireLabelColorsChanged().
        if (!window.__mockLabelColorsChangedListeners) window.__mockLabelColorsChangedListeners = [];
        window.__mockLabelColorsChangedListeners.push(callback);
        if (!window.__mockFireLabelColorsChanged) {
          window.__mockFireLabelColorsChanged = function () {
            var listeners = (window.__mockLabelColorsChangedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](); }
          };
        }
        return function () {
          var listeners = window.__mockLabelColorsChangedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      importCheckCli: async function (/* source */) {
        return { available: true, authenticated: true };
      },
      importFetch: async function (input) {
        // Track call count and last arguments for test assertions.
        // Tests can read window.__mockImportFetchCallCount and
        // window.__mockImportFetchLastArgs to verify fetch behavior.
        if (typeof window !== 'undefined') {
          window.__mockImportFetchCallCount = (window.__mockImportFetchCallCount || 0) + 1;
          window.__mockImportFetchLastArgs = input;
          if (!window.__mockImportFetchCallLog) window.__mockImportFetchCallLog = [];
          window.__mockImportFetchCallLog.push({ state: input && input.state, page: input && input.page });
        }
        // Persistent forced failure: window.__mockImportFetchFailUntilCleared = true
        // makes EVERY call reject until a test explicitly sets it back to false.
        // A one-shot flag is unsafe here because React StrictMode double-invokes
        // the dialog's mount effect in dev, so more than one call can be issued
        // before the "current" (non-superseded) one settles; a persistent flag
        // guarantees whichever call ends up current still observes the failure.
        // Checked before the artificial delay so a test does not have to wait
        // through it to observe the failure.
        if (typeof window !== 'undefined' && window.__mockImportFetchFailUntilCleared) {
          throw new Error('Mock import fetch failure');
        }
        // Optional artificial delay so tests can interact with the dialog
        // between page N landing and page N+1 resolving (streaming races).
        var delayMs = (typeof window !== 'undefined' && window.__mockImportFetchPageDelayMs) || 0;
        if (delayMs > 0) {
          await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
        }
        // Per-state multi-page preset: window.__mockImportFetchPagesByState is an
        // object keyed by the request's state ('open' / 'closed' / 'all'), each
        // value an array of { issues, totalCount, hasNextPage } page responses
        // (1-indexed via input.page). Lets a test seed genuinely distinct data
        // per state filter, so a stale in-flight page from the previous filter is
        // distinguishable from the new filter's data.
        var pagesByState = (typeof window !== 'undefined' && window.__mockImportFetchPagesByState) || null;
        if (pagesByState) {
          var stateKey = (input && input.state) || 'open';
          var statePages = pagesByState[stateKey];
          if (statePages) {
            var statePageNumber = (input && input.page) || 1;
            var stateResponse = statePages[statePageNumber - 1];
            if (stateResponse) return stateResponse;
          }
          return { issues: [], totalCount: 0, hasNextPage: false };
        }
        // Multi-page preset: window.__mockImportFetchPages is an array of
        // { issues, totalCount, hasNextPage } responses, one per page (1-indexed
        // via input.page). Lets tests exercise the dialog's unbounded auto-paging.
        var pages = (typeof window !== 'undefined' && window.__mockImportFetchPages) || null;
        if (pages) {
          var page = (input && input.page) || 1;
          var response = pages[page - 1];
          if (response) return response;
          return { issues: [], totalCount: 0, hasNextPage: false };
        }
        var preset = (typeof window !== 'undefined' && window.__mockImportFetchPreset) || null;
        if (preset) {
          // The single preset returns the SAME response for every page. Since the
          // dialog auto-pages unconditionally on hasNextPage, honoring a true
          // value past page 1 here would loop forever. Use __mockImportFetchPages
          // (below) to test real multi-page streaming instead.
          var presetPage = (input && input.page) || 1;
          if (presetPage > 1) return { issues: [], totalCount: preset.totalCount || 0, hasNextPage: false };
          return preset;
        }
        return { issues: [], totalCount: 0, hasNextPage: false };
      },
      importExecute: async function (input) {
        // Capture the last call argument so tests can inspect the payload.
        if (typeof window !== 'undefined') {
          window.__lastImportExecuteInput = input;
        }
        var preset = (typeof window !== 'undefined' && window.__mockImportExecutePreset) || null;
        if (preset) return preset;
        return { imported: 0, skippedDuplicates: 0, skippedAttachments: 0, items: [] };
      },
      importSourcesList: async function () {
        var preset = (typeof window !== 'undefined' && window.__mockImportSourcesPreset) || null;
        if (preset) return preset;
        return [];
      },
      importSourcesAdd: async function (input) {
        return {
          id: 'import-src-' + Date.now(),
          source: input.source,
          label: input.url,
          repository: input.url,
          url: input.url,
          createdAt: new Date().toISOString(),
        };
      },
      importSourcesRemove: async function (/* id */) {},
      asana: (function () {
        // Stateful mock. Tests can override via window.__mockAsanaPreset;
        // preset values are read on every call so tests can inject after
        // the mock loads (addInitScript runs before, page.evaluate after).
        const state = {
          connected: false,
          email: undefined,
        };
        function preset() {
          return (typeof window !== 'undefined' && window.__mockAsanaPreset) || {};
        }
        return {
          authStatus: async function () {
            const p = preset();
            if (p.state) Object.assign(state, p.state);
            return {
              connected: state.connected,
              email: state.email,
            };
          },
          setPat: async function (input) {
            const token = typeof input?.token === 'string' ? input.token.trim() : '';
            if (token.length === 0) {
              return { ok: false, error: 'Personal Access Token cannot be empty.' };
            }
            if (token.length < 30 || /\s/.test(token)) {
              return {
                ok: false,
                error: 'That does not look like an Asana Personal Access Token. Copy the full token from app.asana.com/0/my-apps.',
              };
            }
            const invalidToken = preset().invalidToken;
            if (invalidToken && token === invalidToken) {
              return { ok: false, error: 'Asana token validation failed (401): invalid token' };
            }
            state.connected = true;
            state.email = preset().email || 'mock-user@example.com';
            return { ok: true, email: state.email };
          },
          clearCredential: async function () {
            state.connected = false;
            state.email = undefined;
          },
        };
      })(),
    },

    // Mobile bridge mock. Stateful (pairing a device persists into
    // listDevices() for the rest of the test), with escape hatches for
    // specs that need to drive the pairing flow's push events directly:
    //   - window.__mockMobileBridgeStatus: shallow-merged onto getStatus()'s result
    //   - window.__mockMobileDevices: overrides listDevices()'s return value
    //   - window.__mockFireMobilePairingSas(payload) / __mockFireMobilePairingEnded(payload) / __mockFireMobileStateChanged()
    //   - window.__mockCancelPairingCallCount: incremented on every cancelPairing()
    //     call, so a spec can assert the tab's unmount cleanup actually fired one
    //   - window.__mockCompleteMobilePairing(displayName): stands in for the
    //     desktop auto-enrolling on the phone's confirm frame. Production
    //     pairing is driven by a main-process PUSH (mobile:pairingConfirmed),
    //     not a renderer-initiated confirm call, so this seeds a device with
    //     the full ten-verb grant and fires that push directly, exactly as
    //     MobileBridgeService does on a successful ceremony.
    mobile: (function () {
      var state = {
        enabled: false,
        secureStorageAvailable: true,
        identityFingerprint: null,
        relayUrl: '',
        devices: [],
        pairingInProgress: false,
      };
      var sasListeners = [];
      var pairingConfirmedListeners = [];
      var pairingEndedListeners = [];
      var stateChangedListeners = [];
      var mockDeviceCounter = 0;

      // Mirrors packages/protocol/src/capabilities/verbs.ts's CAPABILITY_VERBS -
      // pairing grants all ten, not a read-only subset.
      var FULL_CAPABILITY_SET = [
        'read-stream', 'read-board', 'read-diff', 'send-user-message', 'move-task',
        'answer-permission-prompt', 'interactive-terminal', 'board-tool-read',
        'board-tool-write', 'register-push',
      ];

      if (typeof window !== 'undefined') {
        window.__mockFireMobilePairingSas = function (payload) {
          sasListeners.forEach(function (listener) { listener(payload); });
        };
        window.__mockFireMobilePairingEnded = function (payload) {
          // MobilePairingEndedPayload.kind is required (types.ts) and the tab
          // branches on it (only 'failed' surfaces a message) - a spec that
          // forgets to pass it would otherwise fail silently (no message ever
          // shows, easy to misread as "the feature is broken") instead of
          // loudly here.
          if (payload.kind !== 'cancelled' && payload.kind !== 'failed') {
            throw new Error('__mockFireMobilePairingEnded: payload.kind must be "cancelled" or "failed", got ' + JSON.stringify(payload.kind));
          }
          pairingEndedListeners.forEach(function (listener) { listener(payload); });
        };
        window.__mockFireMobileStateChanged = function () {
          stateChangedListeners.forEach(function (listener) { listener(); });
        };
        window.__mockCompleteMobilePairing = function (displayName) {
          mockDeviceCounter += 1;
          // deviceId is production's phone static-public-key hex (64 hex
          // chars), NOT an opaque label - formatKeyFingerprint() renders its
          // first 16 chars, so a non-hex mock id would render as garbled
          // text instead of a plausible fingerprint. Zero-padded so it stays
          // valid hex and unique per call.
          var deviceIdHex = ('0'.repeat(63) + mockDeviceCounter.toString(16)).slice(-64);
          var device = {
            deviceId: deviceIdHex,
            displayName: displayName || 'Paired Device',
            capabilities: FULL_CAPABILITY_SET.slice(),
            pairedAt: new Date().toISOString(),
            connectionState: 'connected',
          };
          state.devices.push(device);
          state.pairingInProgress = false;
          // Ordering mirrors production (mobile-bridge-service.ts's
          // 'confirmed' handler): emitStateChanged() fires BEFORE
          // 'pairingConfirmed', and it is stateChanged - not pairingConfirmed
          // - that the tab answers with a devices re-fetch.
          stateChangedListeners.forEach(function (listener) { listener(); });
          pairingConfirmedListeners.forEach(function (listener) {
            listener({ deviceId: device.deviceId, displayName: device.displayName });
          });
          return device;
        };
      }

      return {
        getStatus: async function () {
          var overrides = (typeof window !== 'undefined' && window.__mockMobileBridgeStatus) || {};
          return Object.assign({
            enabled: state.enabled,
            secureStorageAvailable: state.secureStorageAvailable,
            identityFingerprint: state.identityFingerprint,
            relayUrl: state.relayUrl,
            pairedDeviceCount: state.devices.length,
            pairingInProgress: state.pairingInProgress,
            // No live transport in the mock, so 'idle' (no sessions) unless
            // a spec overrides via window.__mockMobileBridgeStatus.
            relayState: 'idle',
          }, overrides);
        },
        startPairing: async function () {
          state.pairingInProgress = true;
          return {
            qrUri: 'kangentic-pair://mock',
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          };
        },
        cancelPairing: async function () {
          state.pairingInProgress = false;
          // Call-count tracker so a spec can assert the tab's unmount cleanup
          // actually invoked this (MobileDevicesTab.tsx's own-unmount-only
          // effect), not just that no error was thrown.
          if (typeof window !== 'undefined') {
            window.__mockCancelPairingCallCount = (window.__mockCancelPairingCallCount || 0) + 1;
          }
        },
        listDevices: async function () {
          return (typeof window !== 'undefined' && window.__mockMobileDevices) || state.devices;
        },
        revokeDevice: async function (deviceId) {
          state.devices = state.devices.filter(function (device) { return device.deviceId !== deviceId; });
        },
        renameDevice: async function (deviceId, displayName) {
          // Reassign to a NEW array (see setDeviceCapabilities below) - the
          // renderer's selector is reference-equality gated.
          state.devices = state.devices.map(function (device) {
            return device.deviceId === deviceId ? Object.assign({}, device, { displayName: displayName }) : device;
          });
        },
        setDeviceCapabilities: async function (deviceId, capabilities) {
          // Reassign to a NEW array (like revokeDevice's .filter above), not an
          // in-place mutation of the existing array/device objects: the
          // renderer's useMobileStore((state) => state.devices) selector is
          // reference-equality gated, so mutating devices in place while
          // keeping the same array reference would silently skip the
          // re-render even though loadDevices() re-fetched "fresh" data.
          state.devices = state.devices.map(function (device) {
            return device.deviceId === deviceId ? Object.assign({}, device, { capabilities: capabilities }) : device;
          });
        },
        // Tests can set window.__mockTestRelay = function (relayUrl) { ... }
        // to control the "Test connection" result; default is a reachable stub.
        testRelay: async function (relayUrl) {
          if (typeof window !== 'undefined' && typeof window.__mockTestRelay === 'function') {
            return window.__mockTestRelay(relayUrl);
          }
          return { reachable: true, version: null };
        },
        onPairingSas: function (callback) {
          sasListeners.push(callback);
          return function () {
            var index = sasListeners.indexOf(callback);
            if (index >= 0) sasListeners.splice(index, 1);
          };
        },
        onPairingConfirmed: function (callback) {
          pairingConfirmedListeners.push(callback);
          return function () {
            var index = pairingConfirmedListeners.indexOf(callback);
            if (index >= 0) pairingConfirmedListeners.splice(index, 1);
          };
        },
        onPairingEnded: function (callback) {
          pairingEndedListeners.push(callback);
          return function () {
            var index = pairingEndedListeners.indexOf(callback);
            if (index >= 0) pairingEndedListeners.splice(index, 1);
          };
        },
        onStateChanged: function (callback) {
          stateChangedListeners.push(callback);
          return function () {
            var index = stateChangedListeners.indexOf(callback);
            if (index >= 0) stateChangedListeners.splice(index, 1);
          };
        },
      };
    })(),

    boardConfig: {
      exists: async function () { return false; },
      export: async function () {},
      apply: async function (/* projectId */) { return []; },
      onChanged: function (/* callback(projectId) */) { return noop; },
      onShortcutsChanged: function (/* callback(projectId) */) { return noop; },
      getBoardProfiles: async function () { return mockBoardProfiles; },
      setBoardProfiles: async function (profiles) { mockBoardProfiles = profiles; },
      onBoardProfilesChanged: function (/* callback(projectId) */) { return noop; },
      getShortcuts: async function () { return []; },
      setShortcuts: async function (/* actions, target */) {},
      setDefaultBaseBranch: async function (/* branch */) {},
    },

    updater: {
      checkForUpdate: async function () {},
      installUpdate: async function () {
        // Record calls so UI tests can assert "Restart to update" wired
        // through to the IPC layer.
        if (!window.__mockInstallUpdateCalls) window.__mockInstallUpdateCalls = [];
        window.__mockInstallUpdateCalls.push(true);
      },
      onUpdateDownloaded: function (callback) {
        // Tests can fire the update-downloaded push via
        // `window.__mockFireUpdateDownloaded({ version, releaseNotes })`. The
        // listener array and the fire hook itself are installed eagerly at
        // mock-bootstrap time (see top of file), not lazily here.
        window.__mockUpdateDownloadedListeners.push(callback);
        return function () {
          var listeners = window.__mockUpdateDownloadedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    },

    notifications: {
      show: noop,
      onClicked: function (callback) {
        // Tests fire the click push via `window.__mockFireNotificationClicked(projectId,
        // taskId)`. The listener array and the fire hook itself are installed eagerly at
        // mock-bootstrap time (see top of file), not lazily here.
        window.__mockNotificationClickListeners.push(callback);
        return function () {
          var listeners = window.__mockNotificationClickListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    },

    window: {
      minimize: noop,
      maximize: noop,
      close: noop,
      flashFrame: noop,
      isFocused: function () { return Promise.resolve(true); },
    },

    popOut: {
      open: function (kind, params) { popOutCalls.push({ type: 'open', kind: kind, params: params }); return Promise.resolve(); },
      close: function (kind, params) { popOutCalls.push({ type: 'close', kind: kind, params: params }); return Promise.resolve(); },
      focus: function (kind, params) { popOutCalls.push({ type: 'focus', kind: kind, params: params }); return Promise.resolve(); },
      isOpen: function (/* kind, params */) { return Promise.resolve(false); },
      listOpen: function () { return Promise.resolve([]); },
      onChanged: function (/* callback(openInstanceKeys) */) { return noop; },
      descriptor: null,
    },

    // Agent Monitor. Machine-global: no projectId, by design.
    // Seed rows from a spec with:
    //   window.__mockMonitorRows = [ { sessionId: 's1', projectId: 'p1', ... } ];
    // and push an update with window.__mockFireMonitorChanged(rows).
    monitor: {
      getSnapshot: function () {
        return Promise.resolve({
          rows: window.__mockMonitorRows || [],
          generatedAt: '2026-01-01T00:00:00.000Z',
        });
      },
      // Call log for assertions: the detached monitor routes clicks through here.
      __revealCalls: [],
      revealTask: function (projectId, taskId) {
        window.electronAPI.monitor.__revealCalls.push({ projectId: projectId, taskId: taskId });
        return Promise.resolve();
      },
      // The project-scoped half of a task detail, for a host that is not that
      // project's board. Resolves from the SAME seeded state the rest of the mock
      // uses, so a monitor-hosted detail sees exactly what the board would - a
      // spec cannot accidentally prove the surface works against invented data.
      getTaskDetail: function (projectId, taskId) {
        var project = null;
        for (var p = 0; p < projects.length; p++) {
          if (projects[p].id === projectId) { project = projects[p]; break; }
        }
        var task = null;
        for (var t = 0; t < tasks.length; t++) {
          if (tasks[t].id === taskId) { task = tasks[t]; break; }
        }
        if (!project || !task) return Promise.resolve(null);
        return Promise.resolve({
          task: task,
          projectId: projectId,
          projectName: project.name,
          projectPath: project.path,
          defaultAgent: project.default_agent || null,
          swimlanes: swimlanes.slice(),
          // Matches boardConfig.getShortcuts() above, so the monitor-hosted
          // detail and the board-hosted one agree on custom shortcuts.
          shortcuts: [],
          config: {
            labelColors: (config.backlog && config.backlog.labelColors) || {},
            defaultBaseBranch: config.git.defaultBaseBranch,
            worktreesEnabled: config.git.worktreesEnabled,
            browserEnabled: !(config.browser && config.browser.enabled === false),
          },
        });
      },
      onChanged: function (callback) {
        if (!window.__mockMonitorChangedListeners) window.__mockMonitorChangedListeners = [];
        window.__mockMonitorChangedListeners.push(callback);
        if (!window.__mockFireMonitorChanged) {
          window.__mockFireMonitorChanged = function (rows) {
            window.__mockMonitorRows = rows;
            var snapshot = { rows: rows, generatedAt: new Date().toISOString() };
            var listeners = (window.__mockMonitorChangedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](snapshot); }
          };
        }
        return function () {
          var listeners = window.__mockMonitorChangedListeners || [];
          var index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    },

    clipboard: {
      readImage: function () { return Promise.resolve('/tmp/kangentic-clipboard/pasted-image-1234567890.png'); },
      // Call log for test assertions. Reset with window.electronAPI.clipboard.__writeTextCalls.length = 0.
      __writeTextCalls: [],
      writeText: function (text) {
        window.electronAPI.clipboard.__writeTextCalls.push(text);
        return Promise.resolve();
      },
    },

    search: {
      everything: function (request) {
        // Record the request so specs can assert the mode plumbing (the seeded
        // hits are returned regardless of mode - only the mode wiring is tested).
        if (typeof window !== 'undefined') {
          window.__mockLastSearchRequest = request;
          if (!window.__mockSearchRequests) window.__mockSearchRequests = [];
          window.__mockSearchRequests.push(request);
        }
        return Promise.resolve(searchHits.slice());
      },
    },

    memory: {
      getStatus: function () { return Promise.resolve(Object.assign({}, memoryStatus)); },
      rebuildIndex: function (projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockRebuildIndexCalls) window.__mockRebuildIndexCalls = [];
          window.__mockRebuildIndexCalls.push({ projectId: projectId === undefined ? null : projectId });
        }
        return Promise.resolve();
      },
    },

    transcripts: {
      get: function (input) {
        var response = null;
        // Test hook: window.__mockTranscriptsGetOverride(input) => response | undefined,
        // for a live-poll test where later calls must return different content
        // than the first (a static transcriptSeeds entry can't vary per call).
        // The override may itself return an explicit `{ unchanged: true, revision }`
        // shape to drive the revision-short-circuit path directly.
        if (typeof window !== 'undefined' && typeof window.__mockTranscriptsGetOverride === 'function') {
          var overridden = window.__mockTranscriptsGetOverride(input);
          if (overridden) response = overridden;
        }
        if (!response) {
          var seed = transcriptSeeds[input.sessionId];
          response = seed || {
            // Default: nothing indexed / no native file for this session.
            sessionId: input.sessionId,
            taskId: null,
            taskTitle: '',
            agentName: '',
            startedAt: new Date().toISOString(),
            sessionStatus: null,
            source: 'none',
            sourcePath: null,
            entries: [],
            degraded: false,
            unavailableReason: 'file_missing',
            sessions: [],
            revision: 0,
          };
        }
        if (response.unchanged === true) return Promise.resolve(response);
        // Only apply the knownRevision short-circuit when the seed/override
        // EXPLICITLY set a numeric revision - most fixtures (and the
        // pre-revision override tests) don't manage revision at all and
        // expect every call to return the full current content, relying on
        // the real client-side transcriptSignature dedup instead. Defaulting
        // an implicit revision to a fixed value would incorrectly make a
        // later poll with a matching knownRevision look "unchanged" forever.
        if (typeof response.revision === 'number') {
          if (input.knownRevision !== undefined && input.knownRevision === response.revision) {
            return Promise.resolve({ unchanged: true, revision: response.revision });
          }
          return Promise.resolve(response);
        }
        return Promise.resolve(Object.assign({}, response, { revision: 0 }));
      },
      listSessions: function (taskId, _projectId) {
        var list = transcriptSessionsByTask[taskId];
        return Promise.resolve(list ? list.slice() : []);
      },
    },

    browser: {
      captureAndSend: async function (input) {
        browserCaptureCalls.push(input);
        return { filePath: '/mock/captures/capture-' + Date.now() + '.png' };
      },
      getUrls: async function (taskId) {
        var currentProject = projects.find(function (p) { return p.id === currentProjectId; });
        var overrides = currentProject ? projectConfigs[currentProject.path] : null;
        // Empty string means "no project default" -- mirrors useBrowserUrl's
        // `||` fallthrough and BrowserTab's documented sentinel for cleared
        // overrides (object-utils deepMerge skips `undefined`, so empty
        // string is the only value that survives a clear).
        var projectDefault = (overrides && overrides.browser && overrides.browser.defaultUrl) || null;
        return {
          projectDefault: projectDefault,
          taskOverride: browserUrls[taskId] || null,
        };
      },
      setTaskUrl: async function (taskId, url) {
        browserUrls[taskId] = url;
      },
      clearTaskUrl: async function (taskId) {
        delete browserUrls[taskId];
      },
      // Stub for the Clear Browser Data action in the Browser settings tab.
      // Real impl wipes the persistent partition on the main process; the
      // mock just resolves so the renderer can exercise the success/error
      // toast paths via test-time monkeypatching.
      clearStorage: function () { return Promise.resolve(); },
      registerPane: function (input) { browserPaneCalls.push({ type: 'register', input: input }); return Promise.resolve(); },
      unregisterPane: function (sessionId, webContentsId) { browserPaneCalls.push({ type: 'unregister', sessionId: sessionId, webContentsId: webContentsId }); return Promise.resolve(); },
      // Ctrl+wheel zoom is applied in the main process and broadcast back.
      // The UI tier has no main process, so the mock just registers the
      // callback and returns a no-op unsubscribe.
      onZoomChanged: function (_callback) { return function () { /* no-op */ }; },
    },

    // Platform string. Defaults to 'win32' (matches the most common dev
    // host) but tests can override via window.__mockPlatform set in an
    // addInitScript before page load -- BrowserEmptyState reads this to
    // decide whether to render the WSL hint.
    get platform() {
      return (typeof window !== 'undefined' && window.__mockPlatform) || 'win32';
    },

    webUtils: {
      getPathForFile: function () { return '/mock/path/file.txt'; },
    },
  };

  /**
   * Test hook: reset and inspect the browser-pane mock state. Specs can
   *   - reset() between cases to drop seeded URLs and capture-call logs
   *   - getCaptureCalls() to assert the BrowserCaptureInput payload that
   *     would have been shipped to the agent on Send.
   */
  window.__mockBrowser = {
    reset: function () {
      browserUrls = {};
      browserCaptureCalls = [];
      browserPaneCalls = [];
      // Also drop any project-level browser default that the empty-state
      // submit path auto-seeded via saveForProject -- otherwise the next
      // test's BrowserPane.useBrowserUrl resolves an effectiveUrl from the
      // previous run and skips the empty state entirely.
      Object.keys(projectConfigs).forEach(function (projectPath) {
        var overrides = projectConfigs[projectPath];
        if (overrides && overrides.browser) {
          delete overrides.browser;
        }
      });
    },
    getCaptureCalls: function () {
      return browserCaptureCalls.slice();
    },
    getPaneCalls: function () {
      return browserPaneCalls.slice();
    },
    seedTaskUrl: function (taskId, url) {
      browserUrls[taskId] = url;
    },
  };

  /**
   * Test hook: inspect the pop-out engine's open/close/focus call log. The
   * renderer's pop-out store itself is driven directly via
   * window.__zustandStores.popOut (exposed dev-only in App.tsx) - a test sets
   * openInstanceKeys there to simulate "a surface just detached", the same
   * shape the real popOut:changed push delivers. This hook is only for
   * asserting which verb a trigger (title-bar button, PopOutButton) called.
   */
  /**
   * Test hook: simulate a task detail being hosted in a DIFFERENT renderer (the
   * detached Agent Monitor). Real main filters this per recipient and pushes it;
   * the mock is one renderer, so a test drives it directly.
   *
   * Pass `[{ projectId, taskId }]` to claim, `[]` to hand it back.
   */
  window.__mockSetRemoteDetailOwners = function (owners) {
    var listeners = (window.__mockDetailRemoteOwnerListeners || []).slice();
    for (var i = 0; i < listeners.length; i++) listeners[i](owners);
  };

  window.__mockPopOut = {
    reset: function () {
      popOutCalls = [];
    },
    getCalls: function () {
      return popOutCalls.slice();
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
      projectGroups: projectGroups,
      tasks: tasks,
      archivedTasks: archivedTasks,
      swimlanes: swimlanes,
      sessions: sessions,
      backlogTasks: backlogTasks,
      activityCache: activityCache,
      eventCache: eventCache,
      summaryCache: summaryCache,
      projectConfigs: projectConfigs,
      // The GLOBAL app config object, mutable in place. Seeds a starting value for a
      // key the renderer reads back (e.g. a persisted window layout blob). Safe to
      // mutate here because set()/setSync() only reassign `config` later, and get()
      // returns whatever the current reference holds.
      config: config,
      uuid: uuid,
      now: now,
      DEFAULT_SWIMLANES: DEFAULT_SWIMLANES,
    });
    if (result && result.currentProjectId !== undefined) {
      currentProjectId = result.currentProjectId;
    }
    if (result && Array.isArray(result.searchHits)) {
      searchHits = result.searchHits;
    }
    if (result && result.memoryStatus && typeof result.memoryStatus === 'object') {
      memoryStatus = result.memoryStatus;
    }
    if (result && result.transcriptSeeds && typeof result.transcriptSeeds === 'object') {
      Object.assign(transcriptSeeds, result.transcriptSeeds);
    }
    if (result && result.transcriptSessionsByTask && typeof result.transcriptSessionsByTask === 'object') {
      Object.assign(transcriptSessionsByTask, result.transcriptSessionsByTask);
    }
  };

  /**
   * IPC call counter. Wraps the channels that warm-switch assertions care
   * about: anything fetched by App.tsx's project-switch effect or by
   * session-store.syncSessions. Tests reset and read via
   * `window.__resetIpcCallCounts()` / `window.__getIpcCallCounts()`.
   *
   * Intentionally narrow scope: only the channels we want to assert "zero
   * traffic on warm switch" against. Wrapping every channel would create
   * incidental coupling between unrelated tests and the counter.
   */
  (function installIpcCounter() {
    var counts = {};
    window.__getIpcCallCounts = function () {
      return Object.assign({}, counts);
    };
    window.__resetIpcCallCounts = function () {
      for (var key in counts) {
        if (counts.hasOwnProperty(key)) delete counts[key];
      }
    };

    var watched = [
      ['tasks', 'list'],
      ['tasks', 'listArchived'],
      ['tasks', 'listArchivedPreview'],
      ['swimlanes', 'list'],
      ['backlog', 'list'],
      ['config', 'get'],
      ['config', 'getGlobal'],
      ['sessions', 'list'],
      ['sessions', 'getUsage'],
      ['sessions', 'getActivity'],
      ['sessions', 'getActivityReasons'],
      ['sessions', 'getEventsCache'],
    ];
    watched.forEach(function (pair) {
      var namespace = pair[0];
      var method = pair[1];
      var ns = window.electronAPI[namespace];
      if (!ns) return;
      var original = ns[method];
      if (typeof original !== 'function') return;
      ns[method] = function () {
        var label = namespace + '.' + method;
        counts[label] = (counts[label] || 0) + 1;
        return original.apply(ns, arguments);
      };
    });
  })();
})();
