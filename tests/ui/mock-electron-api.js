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
  // Column automations. Nothing is seeded: a fresh board has none, which is
  // what the app now does too (the seeded actions that used to become them were
  // each a no-op or a duplicate of the fallback spawn).
  //
  // A demo scene seeds rows through `window.__mockAutomations`, hydrated LAZILY
  // on the first `automations.list()` rather than here. The web build injects
  // the mock BEFORE demo/boot.js assigns a scene's seeds (demo/index.html names
  // the five-script order), so a module-scope read of the global would always
  // see nothing. Every other demo seed is read the same way, inside the API
  // function; `__mockBoardProfiles` below is the module-scope exception, and it
  // works only because a Playwright spec sets it via addInitScript.
  let automations = [];
  // The agents whose plans Kangentic can approve (their adapters declare
  // `supportsPlanAutoApproval`). One list for both readers: agents.list() stamps
  // it on each entry, and the workflow detail derives a workflow's value from it.
  // tests/unit/mock-agent-list-parity.test.ts pins it against the adapters.
  const PLAN_APPROVING_AGENTS = ['claude'];
  // The adapters' display names, as main's sentence names an agent that cannot
  // approve plans; matches the mock's agents.list() entries.
  const AGENT_DISPLAY_NAMES = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' };
  // The display languages the mock ships when a spec seeds no
  // `window.__mockShippedLocales`: SHIPPED_LOCALES in src/shared/i18n/locales.ts,
  // so the web demo's Language picker offers what the app ships.
  // tests/unit/i18n-locales.test.ts pins it against that list.
  const DEFAULT_SHIPPED_LOCALES = ['en', 'zh-CN', 'zh-TW', 'fr', 'de', 'it', 'es', 'ja', 'ko', 'ru', 'pt-BR', 'tr', 'pl', 'cs', 'hu'];
  // KEEP IN SYNC with AUTOMATION_TRIGGERS in src/shared/automation-manifest.ts:
  // the three groups, in the order a task meets them.
  const AUTOMATION_TRIGGER_ORDER = ['enter', 'turn_end', 'exit'];
  let automationsHydrated = false;
  let swimlanePatchesHydrated = false;
  // Run records. Seedable through `__mockPreConfigure` so a spec can read run
  // history (`runsForTask`) without executing anything; `runAgain` appends to it.
  let automationRuns = [];
  let automationFailureListeners = [];
  let automationInterruptedListeners = [];
  let sessions = [];
  let attachments = [];
  let backlogTasks = [];
  let activityCache = {};
  // sessionId -> ActivityReason, what sessions.getActivityReason(s) serve
  // beside activityCache's states. Seeded via __mockPreConfigure: a waiting
  // session's reason names what it waits for (`waitKind`), which picks its mark
  // (bubble, shield or envelope). Empty here, so an unseeded wait draws as one
  // of unknown kind, the production answer for an agent that does not say.
  let activityReasonCache = {};
  // sessionId -> AssistantMessageTrailEntry[] (oldest first), what
  // sessions.getMessageTrails() serves; __mockFireMessageTrail writes it too
  // so a re-sync after the push sees the same trail main would report.
  let messageTrailCache = {};
  // sessionId -> ActivityStatsSnapshot, what sessions.getActivityStats() serves
  // for the Developer tab's activity debug overlay. Seeded via
  // __mockPreConfigure; empty here, so a session with no snapshot keeps the
  // production "session unknown" answer.
  let activityStatsCache = {};
  let eventCache = {};
  let summaryCache = {};
  let currentProjectId = null;

  // Whether a task summary is written, and why not, by main's rule
  // (readTaskReport): the seeded written summary, else indexing off, else
  // summaries off (the Knowledge Graph off, or its Task summaries switch off),
  // else pending. Read when the report is asked for, so a seed that sets the
  // config after its tasks still gets the state the config says.
  function mockSummaryState(taskId) {
    if (Object.prototype.hasOwnProperty.call(memoryTaskSummaries, taskId)) return { kind: 'written', text: memoryTaskSummaries[taskId] };
    var knowledgeGraph = config.knowledgeGraph;
    if (knowledgeGraph && knowledgeGraph.indexingEnabled === false) return { kind: 'indexing-off' };
    if (!knowledgeGraph || knowledgeGraph.enabled !== true || knowledgeGraph.taskSummaries === false) return { kind: 'off' };
    return { kind: 'pending' };
  }

  // The completed task view's report, derived from a task's summary the way
  // main assembles one for a task with no column moves and no index: one run in
  // one conversation, no route, models from the summary's own tokens. What a
  // seed knows about the run beyond its summary (its agent, effort and
  // permission mode) comes from taskRunFacts.
  function buildMockTaskReport(taskId) {
    var summary = summaryCache[taskId] || null;
    var facts = taskRunFacts[taskId] || {};
    var conversations = [];
    var modelFallback = [];
    // The totals main computes (assembleTaskReport), here over the one run: none
    // without a summary, and no ledger or background call to total.
    var runsTotal = { runCount: 0, runtimeMs: null, costUsd: null, toolCallCount: 0, compactionCount: 0 };
    if (summary) {
      var run = {
        recordId: summary.sessionId,
        agent: facts.agent || 'claude',
        startedAt: summary.startedAt,
        exitCode: summary.exitCode === undefined ? null : summary.exitCode,
        model: summary.modelDisplayName || null,
        effort: facts.effort || null,
        permissionMode: facts.permissionMode || null,
        costUsd: summary.totalCostUsd,
        runtimeMs: summary.durationMs,
        toolCallCount: summary.toolCallCount,
        compactionCount: summary.compactionCount || 0,
        toolBreakdown: summary.toolBreakdown || [],
        columns: [],
      };
      conversations.push({
        conversationId: summary.sessionId,
        isolatedColumn: null,
        runs: [run],
      });
      runsTotal = {
        runCount: 1,
        runtimeMs: run.runtimeMs,
        costUsd: run.costUsd,
        toolCallCount: run.toolCallCount,
        compactionCount: run.compactionCount,
      };
      modelFallback.push({
        model: summary.modelDisplayName || 'Unknown model',
        inputWithCacheTokens: summary.totalInputTokens,
        outputTokens: summary.totalOutputTokens,
      });
    }
    return {
      summary: summary,
      startedAt: summary ? summary.startedAt : null,
      endedAt: summary ? summary.exitedAt : null,
      route: [],
      conversations: conversations,
      models: null,
      modelFallback: modelFallback,
      backgroundCalls: [],
      totals: {
        runs: runsTotal,
        models: null,
        backgroundCalls: { durationMs: null, costUsd: null, tokens: null },
      },
      knowledge: null,
      summaryState: mockSummaryState(taskId),
    };
  }
  // A row tagged with a projectId belongs to that project alone, the way each
  // project's tasks and archive live in its own DB, and an untagged row shows
  // everywhere. tasks.list and the archived lists both filter by this rule.
  function belongsToCurrentProject(row) {
    return !row.projectId || row.projectId === currentProjectId;
  }
  function visibleArchivedTasks() {
    return archivedTasks.filter(belongsToCurrentProject);
  }
  let projectConfigs = {};
  let nextDisplayId = 1;
  let bulkDeleteProgressCallbacks = [];
  let searchHits = [];
  // The conversation index. `memoryStatus` feeds the Knowledge Graph
  // settings tab's index and model status. Seeded via
  // __mockPreConfigure (mirrors searchHits).
  let memoryStatus = {
    indexingEnabled: true,
    semantic: 'disabled',
    model: { id: 'granite-r2', displayName: 'Granite English R2', tier: 'best', approxSizeMb: 153, dimensions: 768, state: 'absent' },
  };
  // Knowledge Graph fixture. null means "no projection cached yet", which is the
  // first-open state the surface must handle without looking broken. Seeded via
  // __mockPreConfigure (mirrors searchHits).
  let knowledgeGraphSnapshot = null;
  // The Projects picker's list. Empty by default, which reads as a list not yet
  // loaded and leaves the picker out (the real app always lists at least the
  // open project); seeded via __mockPreConfigure.
  let knowledgeGraphProjects = [];
  // Task summaries by task id, for the selected conversation's panel. Empty by
  // default, the same as summaries switched off.
  let memoryTaskSummaries = {};
  // The completed task view's report by task id, mutable in place through
  // __mockPreConfigure. A task missing here gets one derived from its summary
  // (buildMockTaskReport).
  const taskReportCache = {};
  // The agent's last message by task id ({ text, writtenAt }), for a completed
  // task whose summary is not written. Missing reads as none.
  const taskLastMessages = {};
  // A derived report's run facts by task id ({ agent, effort, permissionMode }),
  // for a seed that recorded the run (the web demo's archived tasks).
  const taskRunFacts = {};
  // Per-project snapshots for a multi-project scope, keyed by project id.
  // A project missing here falls back to knowledgeGraphSnapshot.
  let knowledgeGraphSnapshotsByProject = {};
  let knowledgeGraphAnswerResult = null;
  // Proactive-recall fixture for task detail; empty means the panel renders
  // nothing at all, which is the common case and must stay silent.
  let memoryRelatedToTask = null;
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
  // Which project each task URL was saved against, so a test can assert a
  // popped-out or backgrounded pane wrote to its OWN project's sidecar.
  let browserUrlProjects = {};
  let browserCaptureCalls = [];
  let browserPaneCalls = [];
  let browserZoomSubscribers = [];
  let browserPaneOpenSubscribers = [];
  let browserPaneCloseSubscribers = [];
  let browserAgentInputSubscribers = [];
  // Viewport overrides an agent imposed, keyed by guest webContentsId, plus the
  // pane subscribers that render them as the toolbar chip.
  let browserViewportSubscribers = [];
  let browserViewportSeed = {};
  // Tasks whose one browser surface is currently OFFSCREEN. Only main can see
  // these (an offscreen BrowserWindow has no renderer to register itself), so
  // the UI tier drives them through the emit/seed helpers below.
  let browserOffscreenSubscribers = [];
  let browserOffscreenSeed = [];
  let browserDownloadSubscribers = [];
  let browserUserKeySubscribers = [];
  // Guest mouse back/forward presses forwarded from main. A real guest
  // consumes the mouse, so this push is the only way they reach the renderer.
  let browserGuestMouseSubscribers = [];
  // Pop-out engine call log: open/close/focus invocations, so a test can
  // assert the title-bar / surface-header trigger called the right verb
  // (e.g. focus() instead of toggling the in-app overlay) without a real
  // OS window. See window.__mockPopOut below.
  let popOutCalls = [];
  let popOutOpenResult = true;
  // Which pop-out instance keys main currently reports as open, plus the
  // popOut:changed push subscribers. A spec drives both through
  // window.__mockFirePopOutChanged below, which is the ONLY way to exercise the
  // real push path (App.tsx subscribes onChanged at mount).
  let popOutOpenKeys = [];
  let popOutChangedSubscribers = [];

  /**
   * Mirror of shared/pop-out.ts popOutInstanceKey, for the mock's isOpen(). This file is
   * loaded via addInitScript as plain browser JS, so it cannot import the real builder and
   * has to hand-copy it. Two things drift silently if pop-out.ts changes: the global-kind
   * list below duplicates GLOBAL_KINDS, and the segment order duplicates the builder's.
   * Update both together. Nothing catches a drift today because electronAPI.popOut.isOpen()
   * has no caller in src/ - the renderer reads openness off pop-out-store instead - so this
   * mirror is only here to keep the fake API self-consistent with listOpen().
   */
  function popOutKeyOf(kind, params) {
    if (kind === 'stats' || kind === 'monitor' || kind === 'knowledge-graph') return kind;
    if (kind === 'command-terminal') return kind + ':' + (params && params.projectId);
    const taskKey = kind + ':' + (params && params.projectId) + ':' + (params && params.taskId);
    if (kind === 'changes-file') return taskKey + ':' + (params && params.filePath);
    return taskKey;
  }
  // Call log for window.electronAPI.window.* (minimize/maximize/close), so a
  // test can assert a title-bar / pop-out-frame control invoked the right verb
  // without a real OS window. See window.__mockWindowControls below.
  let windowControlCalls = [];

  // Resolve the git diff fixture for a request. A test can seed a single fixture
  // via window.__mockGitDiff, per-scope fixtures via window.__mockGitDiffByScope
  // = { working: {...}, staged: {...}, branch: {...} }, per-commit fixtures
  // via window.__mockGitDiffByCommit = { '<oid>': {...} } (checked first, since a
  // commit selection overrides scope), or per-worktree fixtures via
  // window.__mockGitDiffByWorktree = { '<worktree folder>': { working, staged, branch } },
  // matched on the request's worktreePath (the sample install seeds one per task).
  // Resolve a per-worktree fixture map (keyed by worktree FOLDER name) for a request's
  // worktreePath. A worktree path ends in its folder, so the path's last segment is tried
  // first. The substring scan below it is unanchored: it matches any key that appears anywhere
  // in the path, so two slugs where one is a prefix of the other would resolve by Object.keys
  // order rather than by which folder the path is actually in. Today's slugs carry random
  // suffixes and do not collide, which is why the scan is kept as the fallback rather than
  // replaced outright. Shared by diffFiles, branchSummary, commitGraph, fileHistory, and blame,
  // which the sample install seeds per task (window.__mock*ByWorktree).
  function resolveByWorktree(byWorktree, worktreePath) {
    if (!byWorktree || !worktreePath) return null;
    var segments = worktreePath.split(/[\\/]/);
    var lastSegment = segments[segments.length - 1] || segments[segments.length - 2] || '';
    if (byWorktree[lastSegment]) return byWorktree[lastSegment];
    var folders = Object.keys(byWorktree);
    for (var folderIndex = 0; folderIndex < folders.length; folderIndex++) {
      var folder = folders[folderIndex];
      if (worktreePath.indexOf(folder) !== -1 && byWorktree[folder]) return byWorktree[folder];
    }
    return null;
  }

  function resolveGitDiffFixture(request) {
    var commitOid = request && request.commitOid;
    var byCommit = (typeof window !== 'undefined' && window.__mockGitDiffByCommit) || null;
    if (commitOid && byCommit && byCommit[commitOid]) return byCommit[commitOid];
    // A completed task's whole change: window.__mockGitDiffByRange = { '<base>..<head>': {...} },
    // checked after the commit (a commit selection inside a range wins) and before scope.
    var range = request && request.range;
    var byRange = (typeof window !== 'undefined' && window.__mockGitDiffByRange) || null;
    if (range && byRange && byRange[range.base + '..' + range.head]) return byRange[range.base + '..' + range.head];
    var scope = (request && request.scope) || 'branch';
    var byScope = (typeof window !== 'undefined' && window.__mockGitDiffByScope) || null;
    if (byScope && byScope[scope]) return byScope[scope];
    var byWorktree = (typeof window !== 'undefined' && window.__mockGitDiffByWorktree) || null;
    var forWorktree = resolveByWorktree(byWorktree, (request && request.worktreePath) || '');
    if (forWorktree && forWorktree[scope]) return forWorktree[scope];
    return (typeof window !== 'undefined' && window.__mockGitDiff) || null;
  }

  let config = Object.assign({
    theme: 'dark',
    themeFollowsSystem: false,
    themeLight: 'light',
    themeDark: 'dark',
    sidebarVisible: true,
    boardLayout: 'horizontal',
    cardDensity: 'default',
    cardPreview: 'agent-latest-message',
    columnWidth: 'default',
    showTaskNumbers: false,
    terminalPanelVisible: true,
    animationsEnabled: true,
    statusBarVisible: true,
    diffViewMode: 'split',
    diffDefaultScope: 'working',
    diffIgnoreWhitespace: false,
    diffCollapseUnchanged: false,
    diffWrapLines: false,
    diffUseInlineWhenNarrow: true,
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
    },
    sidebar: {
      width: 224,
    },
    agent: {
      permissionMode: 'acceptEdits',
      cliPaths: {},
      maxConcurrentSessions: 8,
      idleTimeoutEnabled: false,
      idleTimeoutMinutes: 30,
      pauseIdleAgentsOnLowMemory: true,
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
      prAutoRefresh: true,
      autoFetch: true,
      prBypassCountsAsReady: true,
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
        onWorkflowComplete: true,
        onWorkflowStalled: true,
        onSpawnStalled: true,
      },
      toasts: {
        onAgentIdle: true,
        onAgentCrash: true,
        onPlanComplete: true,
        onWorkflowComplete: true,
        onWorkflowStalled: true,
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
    commandTerminalPanel: null,
    // Mirrors DEFAULT_CONFIG.commandTerminalRail.
    commandTerminalRail: { width: 300, collapsed: false },
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
    // Matches the mocked app.getVersion() below, so WhatsNewDialog stays closed
    // by default. An empty marker would not match and would auto-open a
    // `fixed inset-0` backdrop over every spec in the tier. Like
    // hasCompletedFirstRun above, the mock models an ESTABLISHED install; a spec
    // that wants the dialog seeds a different version via __mockPreConfigure.
    lastWhatsNewShownVersion: '0.1.0',
    skipDeleteConfirm: false,
    skipBoardConfigConfirm: false,
    autoFocusIdleSession: false,
    stopLeftoverProcesses: true,
    // Mirrors DEFAULT_CONFIG.windowLightDismiss in src/shared/types.ts. This is an
    // independent literal, so a change there does not turn this red on its own - keep
    // them in step or every UI test silently runs under the wrong policy.
    windowLightDismiss: 'focused',
    // true, because the mock models an established install (like hasCompletedFirstRun
    // above) that has already crossed the single -> focused default flip.
    hasMigratedWindowLightDismissDefault: true,
    // true for the same reason: an established install has already run the one-shot
    // purge of seeded entries out of discoveredModelsByAgent (ConfigManager.load).
    hasPurgedSeededDiscoveredModels: true,
    // Tests pin English through config, never through the machine's language: the
    // display language is set, and the first-launch suggestion already answered, so
    // no spec sees the language toast whatever OS runs it. A spec that wants the
    // toast seeds window.__mockLanguageSuggestion and overrides these two.
    displayLanguage: 'en',
    hasAnsweredLanguageSuggestion: true,
    discoveredModelsByAgent: {},
    autoNameAskedTaskIds: [],
    autoNameRateLimitPerHour: 60,
    restoreWindowPosition: true,
    windowBounds: null,
    windowMaximized: false,
  }, window.__mockConfigOverrides || {});

  // Graphics recovery test hook (Sentry DESKTOP-18/DESKTOP-W): main can write
  // graphicsAccelerationEnabled: false during whenReady AFTER this renderer's
  // first config read, which is exactly the race App.tsx's own re-read
  // (useConfigStore.getState().loadConfig() inside the notice handler) exists
  // to close. Arm with window.__mockGraphicsAccelerationWriteLandsAfterBoot
  // (set before load, alongside a config seeded with the STALE pre-write
  // value): the first STALE_CALL_BUDGET config.get()/getGlobal() calls each
  // report the seeded value untouched, and every call after that reports
  // main's real write (graphicsAccelerationEnabled: false,
  // graphicsAccelerationOffBy: 'app'), mirroring configManager.save() in
  // src/main/index.ts's whenReady block.
  //
  // The budget is 4, not 1, because two OTHER things call loadConfig() during
  // boot with nothing to do with the GPU notice, and each is doubled by
  // React.StrictMode (src/renderer/index.tsx), which runs every mount effect
  // twice in this dev-server-backed tier:
  //   1. App.tsx's own top-level `loadConfig()` call (the boot read itself).
  //   2. useProjectSwitchEffect's mount-time reload (its null-branch with no
  //      project open, or its cold-path branch with one - either way, this
  //      fires once per mount).
  // That is 2 sources x 2 StrictMode passes = 4 incidental calls, all
  // dispatched synchronously in the same tick and settled before the GPU
  // notice's chain can reach its own inner loadConfig() call (behind two
  // extra microtask hops through readStatus().catch().then()). Empirically
  // confirmed via console instrumentation: with the notice's own re-read
  // removed, calls stop at exactly 4 (all stale); with it present, a genuine
  // 5th call lands after (corrected). Only the FIRST StrictMode pass's
  // readStatus() call ever produces a notice - it consumes
  // window.__mockGpuNoticePending on read, so the second pass's call is a
  // silent no-op - which is why the notice contributes exactly one extra
  // call rather than two.
  //
  // A spec exercising this must also pass `omitProject: true` and seed
  // `onboardedProjectIds` to a defined array (see graphics-recovery.spec.ts):
  // with a project seeded, useProjectSwitchEffect's cold path re-fires a
  // SECOND time once the project resolves (consuming budget beyond this
  // fixed accounting), and App.tsx's one-time onboardedProjectIds backfill
  // fires its own incidental updateConfig() otherwise.
  var GRAPHICS_ACCELERATION_STALE_CALL_BUDGET = 4;
  var graphicsAccelerationGetCallCount = 0;
  var graphicsAccelerationGetGlobalCallCount = 0;
  function withStaleGraphicsAccelerationOverride(effectiveConfig, callCount) {
    if (!window.__mockGraphicsAccelerationWriteLandsAfterBoot) return effectiveConfig;
    if (callCount <= GRAPHICS_ACCELERATION_STALE_CALL_BUDGET) return effectiveConfig;
    return Object.assign({}, effectiveConfig, {
      graphicsAccelerationEnabled: false,
      graphicsAccelerationOffBy: 'app',
    });
  }

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

  /** A new task row, as tasks.create and a workflow's Start and Add task write one. */
  function buildTaskRow(input, position) {
    return {
      id: uuid(),
      display_id: nextDisplayId++,
      title: input.title,
      description: input.description || '',
      swimlane_id: input.swimlane_id,
      position: position,
      agent: null,
      session_id: null,
      worktree_path: null,
      worktree_folder: null,
      worktree_skip_reason: null,
      branch_name: input.customBranchName || null,
      pushed_branch: null,
      pr_number: null,
      pr_url: null,
      pr_state: null,
      pr_merge_readiness: null,
      base_branch: input.baseBranch || null,
      resolved_base_branch: null,
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
      automations_disabled: !!input.automations_disabled,
      auto_command: input.auto_command || null,
      attachment_count: 0,
      archived_at: null,
      detail_view_state: null,
      workflow_id: null,
      workflow_project_id: null,
      route_start_swimlane_id: null,
      route_last_swimlane_id: null,
      skipped_swimlane_ids: [],
      canvas_x: null,
      canvas_y: null,
      plan_approval: null,
      created_at: now(),
      updated_at: now(),
    };
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
    if (source.themeFollowsSystem !== undefined) result.themeFollowsSystem = source.themeFollowsSystem;
    if (source.themeLight !== undefined) result.themeLight = source.themeLight;
    if (source.themeDark !== undefined) result.themeDark = source.themeDark;
    // terminal.* (shell, fontSize, fontFamily, cursorStyle) is global-only now -
    // see the comment on pickOverridableSubset() in src/main/config/config-manager.ts.
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
      prAutoRefresh: git.prAutoRefresh,
      autoFetch: git.autoFetch,
      prBypassCountsAsReady: git.prBypassCountsAsReady,
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

  // Mirrors the production seed in src/main/db/migrations/default-data.ts;
  // tests/unit/default-swimlanes-seed-parity.test.ts binds the two lists.
  var DEFAULT_SWIMLANES = [
    { name: 'To Do', description: null, role: 'todo', color: '#6b7280', icon: 'layers', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: false, auto_command: null, auto_command_mode: 'immediate', plan_exit_target_id: null, plan_approval: 'manual', agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Planning', description: null, role: null, color: '#8b5cf6', icon: 'map', is_archived: false, is_ghost: false, permission_mode: 'plan', auto_spawn: true, auto_command: null, auto_command_mode: 'immediate', plan_exit_target_id: '__executing__', plan_approval: 'manual', agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Executing', description: null, role: null, color: '#3b82f6', icon: 'square-terminal', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, auto_command_mode: 'immediate', plan_exit_target_id: null, plan_approval: 'manual', agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Code Review', description: null, role: null, color: '#f59e0b', icon: 'code', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, auto_command_mode: 'immediate', plan_exit_target_id: null, plan_approval: 'manual', agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Testing', description: null, role: null, color: '#06b6d4', icon: 'flask-conical', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, auto_command_mode: 'immediate', plan_exit_target_id: null, plan_approval: 'manual', agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Merge', description: null, role: null, color: '#f97316', icon: 'merge', is_archived: false, is_ghost: false, permission_mode: null, auto_spawn: true, auto_command: null, auto_command_mode: 'immediate', plan_exit_target_id: null, plan_approval: 'manual', agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
    { name: 'Done', description: null, role: 'done', color: '#10b981', icon: 'circle-check-big', is_archived: true, is_ghost: false, permission_mode: null, auto_spawn: false, auto_command: null, auto_command_mode: 'immediate', plan_exit_target_id: null, plan_approval: 'manual', agent_override: null, model_override: null, effort_override: null, handoff_context: false, session_target: 'main', session_spawn_strategy: 'create_or_resume' },
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

  // `config.onChanged` subscribers. A REAL list rather than a stub: the
  // Knowledge Graph re-reads its snapshot on this signal, so a no-op made that
  // path untestable and any spec asserting live refresh would pass without
  // exercising it. Tests fire it with `window.__mockEmitConfigChanged()`.
  const mockConfigChangedListeners = [];
  window.__mockEmitConfigChanged = function () {
    mockConfigChangedListeners.slice().forEach(function (listener) { listener(); });
  };

  // What config.set / setProjectOverrides / setProjectOverridesByPath resolve with.
  // Defaults to a write that reached disk; a test forces the failure path by setting
  // window.__mockConfigSetPersisted = false, which is what the settings panel's
  // "This setting did not save" toast keys off (Sentry DESKTOP-1C). Read per call,
  // not captured once, so a test can flip it mid-run to simulate a disk recovering.
  // Note the real ConfigManager.save() updates its in-memory config even when the
  // write fails, so the mock deliberately still applies the partial before returning
  // persisted: false.
  function configSetResult() {
    return { persisted: window.__mockConfigSetPersisted !== false };
  }

  // A REJECTED write is a different failure from one that degraded: the real
  // project-scoped handlers throw for an unknown or unopened project, and the settings
  // panel reports that separately (with no settings-file clause).
  //
  // Called BEFORE the mock applies the partial, because the real handlers throw their
  // precondition before ever reaching ConfigManager - nothing is written on that path.
  // Rejecting after the mutation would leave mock state a rejected real write never
  // produces, which is a trap for any later test that asserts on state after a reject.
  function rejectConfigSetIfConfigured() {
    if (window.__mockConfigSetRejects) {
      throw new Error(String(window.__mockConfigSetRejects));
    }
  }

  // Board Profiles live in kangentic.json, not the DB, so the mock keeps them
  // in a plain module-scope array. Declared here (alongside noop) rather than
  // beside the boardConfig object, whose neighbouring `state` bindings belong to
  // IIFEs that have already closed by that point.
  let mockBoardProfiles = window.__mockBoardProfiles
    ? JSON.parse(JSON.stringify(window.__mockBoardProfiles))
    : [];

  /**
   * Copy `window.__mockAutomations` into the live array, once. Called from
   * `automations.list()` rather than at module scope, so a demo scene's seed
   * (assigned after this file runs) is still picked up. After the first call the
   * array is the mock's own state again, so `replaceForColumn` behaves normally.
   */
  function hydrateSeededAutomations() {
    if (automationsHydrated) return;
    automationsHydrated = true;
    if (!Array.isArray(window.__mockAutomations)) return;
    window.__mockAutomations.forEach(function (row, index) {
      var seeded = Object.assign(
        { id: 'automation-seed-' + index, trigger: 'enter', position: index, enabled: true, condition: null, final_line: null, max_runs: null, created_at: now(), updated_at: now() },
        row,
        { config: Object.assign({}, row.config) },
      );
      // As the repository's read hands a row over: a Text match on a turn end
      // only, so a seeded enter row never shows one the app would drop.
      seeded.final_line = seeded.trigger === 'turn_end' && typeof seeded.final_line === 'string' && seeded.final_line.trim() !== ''
        ? seeded.final_line.trim()
        : null;
      automations.push(seeded);
    });
  }

  /**
   * Apply `window.__mockSwimlanePatches` ({ swimlaneId: Partial<Swimlane> }) to
   * the seeded columns, once, for the same load-order reason as the automations
   * above. A column field the sample install fixes for every lane
   * (`handoff_context`) is a per-scene patch rather than a dataset change,
   * because changing the dataset would move every docs figure already placed.
   */
  function hydrateSeededSwimlanePatches() {
    if (swimlanePatchesHydrated) return;
    swimlanePatchesHydrated = true;
    var patches = window.__mockSwimlanePatches;
    if (!patches || typeof patches !== 'object') return;
    Object.keys(patches).forEach(function (swimlaneId) {
      var lane = swimlanes.find(function (row) { return row.id === swimlaneId; });
      if (lane) Object.assign(lane, patches[swimlaneId]);
    });
  }

  /** The `window.__mockTaskReports` entry for a task, or null; read when asked, for the load-order reason above. */
  function seededTaskReportSource(taskId) {
    var seeds = window.__mockTaskReports;
    if (!seeds || typeof seeds !== 'object' || !Object.prototype.hasOwnProperty.call(seeds, taskId)) return null;
    return seeds[taskId];
  }

  /**
   * A task's report from `window.__mockTaskReports` ({ taskId: TaskReport }), the whole record a
   * demo scene shows for one archived task, once, into taskReportCache. The seed is built against a
   * fixed instant, so every time in it moves by one offset that puts its Done move (`endedAt`) on
   * the archived row's own `archived_at`, the way every dataset time is an offset from boot. Its
   * summary is the row's own summary object (summaryCache), so the header strip and the Completed
   * Tasks row read the same figures. Until the archived row exists there is nothing to anchor on,
   * so the task gets the derived report and nothing is cached. A later read then still lands the
   * Done move on `archived_at`.
   */
  function hydrateSeededTaskReport(taskId) {
    var source = seededTaskReportSource(taskId);
    if (!source) return null;
    var row = archivedTasks.find(function (task) { return task.id === taskId; });
    if (!row || !row.archived_at) return null;
    var report = JSON.parse(JSON.stringify(source));
    var offsetMs = report.endedAt ? Date.parse(row.archived_at) - Date.parse(report.endedAt) : 0;
    function shift(value) {
      return typeof value === 'string' ? new Date(Date.parse(value) + offsetMs).toISOString() : value;
    }
    report.startedAt = shift(report.startedAt);
    report.endedAt = shift(report.endedAt);
    report.route.forEach(function (column) {
      column.visits.forEach(function (visit) { visit.startedAt = shift(visit.startedAt); });
    });
    report.conversations.forEach(function (conversation) {
      conversation.runs.forEach(function (run) { run.startedAt = shift(run.startedAt); });
    });
    report.backgroundCalls.forEach(function (call) { call.startedAt = shift(call.startedAt); });
    if (report.knowledge) {
      report.knowledge.commits.forEach(function (commit) { commit.committedAt = shift(commit.committedAt); });
    }
    report.summary = summaryCache[taskId] || null;
    taskReportCache[taskId] = report;
    return report;
  }

  // Test override conventions consumed below (set via addInitScript before this mock loads):
  //   - window.__mockBoardProfiles: pre-seeded BoardProfile[] for boardConfig.getBoardProfiles()
  //   - window.__mockAgentListOverrides: per-agent override of agents.list() entries
  //   - window.__mockAutomations: pre-seeded automation rows, hydrated on first automations.list()
  //   - window.__mockSwimlanePatches: per-column field overrides, applied on first swimlanes.list()
  //   - window.__mockTaskReports: a whole completed task report by task id, served by
  //     sessions.getTaskReport (re-anchored onto the archived row, with its summary) and, when
  //     its summary is written, by knowledgeGraph.taskSummary
  //   - window.__mockInitialExit: one session-exit push fired when sessions.onExit registers
  //   - window.__mockBoardConfigChanged: a projectId pushed when boardConfig.onChanged registers
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

  // Update-blocked test hooks (Sentry DESKTOP-1A), same eager pattern as the
  // update-downloaded hooks above. Main latches this push, so a spec that
  // wants the "already toasted" case fires once and asserts on the toast
  // count rather than expecting the mock to deduplicate.
  window.__mockUpdateBlockedListeners = [];
  window.__mockFireUpdateBlocked = function (message) {
    var listeners = window.__mockUpdateBlockedListeners.slice();
    listeners.forEach(function (fn) { fn(message); });
  };

  // Host memory pressure test hooks (Sentry DESKTOP-16), same eager pattern
  // as the update-downloaded hooks above: `__mockFireHostMemoryPressure`
  // exists before any renderer subscriber has registered.
  window.__mockHostMemoryPressureListeners = [];
  window.__mockFireHostMemoryPressure = function (event) {
    var listeners = window.__mockHostMemoryPressureListeners.slice();
    listeners.forEach(function (fn) { fn(event); });
  };

  // Host memory recovery test hooks (Sentry DESKTOP-16): the clear-side edge
  // for the pressure push above, same eager pattern.
  window.__mockHostMemoryRecoveryListeners = [];
  window.__mockFireHostMemoryRecovery = function (event) {
    var listeners = window.__mockHostMemoryRecoveryListeners.slice();
    listeners.forEach(function (fn) { fn(event); });
  };

  // Low-memory agent pause test hooks: one push per agent main paused while
  // it waited on the user (src/main/diagnostics/idle-agent-pause.ts). Same
  // eager pattern as the two above.
  window.__mockHostMemoryAgentPausedListeners = [];
  window.__mockFireHostMemoryAgentPaused = function (event) {
    var listeners = window.__mockHostMemoryAgentPausedListeners.slice();
    listeners.forEach(function (fn) { fn(event); });
  };

  // Announcements test hooks: installed eagerly for the same reason as the
  // update-downloaded hooks above. `__mockFireAnnouncementsChanged(active,
  // history)` also updates `__mockActiveAnnouncements` /
  // `__mockAnnouncementHistory` so a later getActive() / getHistory() (e.g. an
  // HMR resync) returns the same lists. History defaults to one unread archive
  // entry per active announcement, which is what a real poll produces, so a
  // spec only passes it explicitly to test expired or already-read entries.
  window.__mockActiveAnnouncements = [];
  window.__mockAnnouncementHistory = [];
  // Every announcements.markRead(id) call, in order. Lets a spec assert the
  // durable write was attempted even when the renderer's local history copy
  // had nothing to stamp.
  window.__mockAnnouncementMarkReadCalls = [];
  window.__mockAnnouncementsChangedListeners = [];
  window.__mockFireAnnouncementsChanged = function (active, history) {
    window.__mockActiveAnnouncements = active;
    window.__mockAnnouncementHistory = history || active.map(function (announcement) {
      return { announcement: announcement, firstSeenAt: new Date().toISOString(), readAt: null };
    });
    var payload = {
      active: window.__mockActiveAnnouncements,
      history: window.__mockAnnouncementHistory,
    };
    var listeners = window.__mockAnnouncementsChangedListeners.slice();
    listeners.forEach(function (fn) { fn(payload); });
  };

  // MCP connection hooks (the MCP connection row and the session-start toast).
  // `__mockMcpConnection` is what checkConnection answers, a real answer by
  // default; a spec sets it to `{ connected: false, error }` for the failed
  // row, or a function of the request to hold or count calls.
  // `__mockFireMcpConnectionFailed(error)` sends the once-per-run push.
  window.__mockMcpConnection = { connected: true };
  window.__mockMcpConnectionCalls = [];
  window.__mockMcpConnectionFailedListeners = [];
  window.__mockFireMcpConnectionFailed = function (error) {
    var listeners = window.__mockMcpConnectionFailedListeners.slice();
    listeners.forEach(function (fn) { fn({ error: error }); });
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
        // Row COPIES, as getCurrent returns: the store holds what this returns, and
        // handing out the live rows would let setDefault* (which mutates in place)
        // refresh the renderer's list behind its back, masking a stale-list bug.
        return projects
          .map(function (projectRow) { return Object.assign({}, projectRow); })
          .sort(function (firstProject, secondProject) { return firstProject.position - secondProject.position; });
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
        return Object.assign({}, project);
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
          automations = [];
          automationRuns = [];
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
          return Object.assign({}, existing);
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
        return Object.assign({}, project);
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
          hasCommits: true,
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
      onListChanged: function (callback) {
        // Tests can fire the project-list-changed push via
        // `window.__mockFireProjectListChanged()`. Carries no payload; the
        // renderer is expected to refetch `list()` / `getCurrent()`.
        if (!window.__mockProjectListChangedListeners) {
          window.__mockProjectListChangedListeners = [];
        }
        window.__mockProjectListChangedListeners.push(callback);
        if (!window.__mockFireProjectListChanged) {
          window.__mockFireProjectListChanged = function () {
            var listeners = (window.__mockProjectListChangedListeners || []).slice();
            listeners.forEach(function (fn) { fn(); });
          };
        }
        return function () {
          var listeners = window.__mockProjectListChangedListeners || [];
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
        var visible = tasks.filter(belongsToCurrentProject);
        // withAttachmentCounts copies each row (Object.assign), so this payload
        // is a genuine snapshot of the board AT CALL TIME and cannot be mutated
        // by a later move.
        var payload = withAttachmentCounts(visible);
        // Test hook: hold THIS call's response until __mockReleaseTaskList().
        // Snapshot-at-call-time is the load-bearing property. The stale-reload
        // bug IS a payload computed before a write and delivered after it, so a
        // hold that recomputed lazily on release would report the post-write
        // board and pass vacuously against the buggy code.
        if (window.__mockHoldNextTaskList) {
          window.__mockHoldNextTaskList = false;
          return new Promise(function (resolve) {
            window.__mockReleaseTaskList = function () { resolve(payload); };
          });
        }
        return payload;
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
        var task = buildTaskRow(input, sameColumn.length);
        var taskId = task.id;
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

        // Mirror main-process behavior: a cross-column move into a todo-role
        // lane tears the task's session down (cleanupTaskResources ->
        // SessionManager.remove()), and main announces each removal on
        // session:removed AFTER the renderer's own optimistic eviction has
        // run. Splice in place: `sessions` is the closure array
        // __mockPreConfigure hands out, so tests that hold a reference keep
        // seeing the same array. The push is guarded on the helper being
        // installed (it is, once App.tsx has subscribed).
        if (targetLane && targetLane.role === 'todo' && oldSwimlaneId !== newSwimlaneId) {
          var removedSessions = [];
          for (var sessionIndex = sessions.length - 1; sessionIndex >= 0; sessionIndex--) {
            if (sessions[sessionIndex].taskId === input.taskId) {
              removedSessions.unshift(sessions[sessionIndex]);
              sessions.splice(sessionIndex, 1);
            }
          }
          tasks[idx] = Object.assign({}, tasks[idx], { session_id: null });
          if (typeof window !== 'undefined' && window.__mockFireRemoved) {
            removedSessions.forEach(function (removedSession) {
              window.__mockFireRemoved(
                removedSession.id,
                Object.assign({}, removedSession),
                removedSession.projectId,
              );
            });
          }
        }

        // Test hook: the move COMMITS, then the call rejects. Main can do this:
        // the DB move is written, then a later step (spawning the destination
        // column's agent, a transition action) throws, and the IPC rejects with
        // the task already in its new column. Unlike __mockTaskMoveThrow, which
        // rejects BEFORE touching anything, this leaves the committed move in the
        // arrays, so a spec can prove the caller reloads the committed half
        // however the call settles. Set window.__mockMoveRejectAfterCommit to the
        // rejection message; it is consumed by the next move. Placed after every
        // commit step above (the Done archive and the To Do session teardown).
        if (typeof window !== 'undefined' && window.__mockMoveRejectAfterCommit) {
          var rejectAfterCommitMessage = window.__mockMoveRejectAfterCommit;
          window.__mockMoveRejectAfterCommit = null;
          throw new Error(rejectAfterCommitMessage);
        }
      },
      listArchived: async function () {
        return withAttachmentCounts(visibleArchivedTasks());
      },
      listArchivedPreview: async function (limit) {
        // Mirror the repo: newest-first by archived_at, then LIMIT. Sorting a
        // copy so seeds with more than `limit` archived tasks pick the correct
        // preview subset (the same rows the real SELECT ... ORDER BY DESC would).
        var boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
        var visible = visibleArchivedTasks();
        var sorted = visible.slice().sort(function (a, b) {
          return String(b.archived_at || '').localeCompare(String(a.archived_at || ''));
        });
        return {
          totalCount: visible.length,
          tasks: withAttachmentCounts(sorted.slice(0, boundedLimit)),
        };
      },
      onAutoMoved: function (callback) {
        // Tests fire this via
        // window.__mockFireTaskAutoMoved(taskId, targetSwimlaneId, taskTitle, projectId).
        if (!window.__mockTaskAutoMovedListeners) window.__mockTaskAutoMovedListeners = [];
        window.__mockTaskAutoMovedListeners.push(callback);
        if (!window.__mockFireTaskAutoMoved) {
          window.__mockFireTaskAutoMoved = function (taskId, targetSwimlaneId, taskTitle, projectId) {
            var listeners = (window.__mockTaskAutoMovedListeners || []).slice();
            listeners.forEach(function (listener) { listener(taskId, targetSwimlaneId, taskTitle, projectId); });
          };
        }
        // A REAL unsubscribe, matching the preload bridge: App.tsx pushes this
        // onto its cleanups array, and a noop would leave the unmounted
        // renderer's listener attached across an HMR re-subscribe.
        return function () {
          var listeners = window.__mockTaskAutoMovedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
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
      onSpawnWarning: function (callback) {
        // Tests fire this via window.__mockFireTaskSpawnWarning(taskId, message, projectId).
        if (!window.__mockTaskSpawnWarningListeners) window.__mockTaskSpawnWarningListeners = [];
        window.__mockTaskSpawnWarningListeners.push(callback);
        if (!window.__mockFireTaskSpawnWarning) {
          window.__mockFireTaskSpawnWarning = function (taskId, message, projectId) {
            var listeners = (window.__mockTaskSpawnWarningListeners || []).slice();
            listeners.forEach(function (listener) { listener(taskId, message, projectId); });
          };
        }
        // A REAL unsubscribe, for the same reason onSpawnBlocked returns one.
        return function () {
          var listeners = window.__mockTaskSpawnWarningListeners || [];
          var index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
      onAutoCommandResult: function (callback) {
        // Tests fire this via window.__mockFireAutoCommandResult(notice), where
        // `notice` is an AutoCommandResultNotice.
        if (!window.__mockAutoCommandResultListeners) window.__mockAutoCommandResultListeners = [];
        window.__mockAutoCommandResultListeners.push(callback);
        if (!window.__mockFireAutoCommandResult) {
          window.__mockFireAutoCommandResult = function (notice) {
            var listeners = (window.__mockAutoCommandResultListeners || []).slice();
            listeners.forEach(function (listener) { listener(notice); });
          };
        }
        // A REAL unsubscribe, for the same reason onSpawnBlocked returns one.
        return function () {
          var listeners = window.__mockAutoCommandResultListeners || [];
          var index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
      onConversationExpired: function (callback) {
        // Tests fire this via window.__mockFireConversationExpired(notice), where
        // `notice` is a ConversationExpiredNotice. Like main, it queues the notice
        // (latest per task) BEFORE it signals, and takeConversationExpired below
        // drains the queue, so a notice for a project that is not current waits
        // for that project instead of being dropped.
        if (!window.__mockConversationExpiredListeners) window.__mockConversationExpiredListeners = [];
        window.__mockConversationExpiredListeners.push(callback);
        if (!window.__mockFireConversationExpired) {
          window.__mockFireConversationExpired = function (notice) {
            if (!window.__mockPendingConversationExpired) window.__mockPendingConversationExpired = {};
            var pending = window.__mockPendingConversationExpired[notice.projectId] || [];
            pending = pending.filter(function (queued) { return queued.taskId !== notice.taskId; });
            pending.push(notice);
            window.__mockPendingConversationExpired[notice.projectId] = pending;
            var listeners = (window.__mockConversationExpiredListeners || []).slice();
            listeners.forEach(function (listener) { listener(notice); });
          };
        }
        // A REAL unsubscribe, for the same reason onSpawnBlocked returns one.
        return function () {
          var listeners = window.__mockConversationExpiredListeners || [];
          var index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
      takeConversationExpired: async function (projectId) {
        // Drains what __mockFireConversationExpired queued, once, as main's
        // synchronous handler does.
        var queues = window.__mockPendingConversationExpired || {};
        var pending = queues[projectId] || [];
        delete queues[projectId];
        return pending;
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
      onPrLinkChanged: function (callback) {
        // Tests can fire this via window.__mockFireTaskPrLinkChanged(projectId).
        if (!window.__mockTaskPrLinkChangedListeners) window.__mockTaskPrLinkChangedListeners = [];
        window.__mockTaskPrLinkChangedListeners.push(callback);
        if (!window.__mockFireTaskPrLinkChanged) {
          window.__mockFireTaskPrLinkChanged = function (projectId) {
            var listeners = (window.__mockTaskPrLinkChangedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](projectId); }
          };
        }
        return function () {
          var listeners = window.__mockTaskPrLinkChangedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onMovedByAutomation: function (callback) {
        // Tests can fire this via window.__mockFireTaskMovedByAutomation(projectId).
        if (!window.__mockTaskMovedByAutomationListeners) window.__mockTaskMovedByAutomationListeners = [];
        window.__mockTaskMovedByAutomationListeners.push(callback);
        if (!window.__mockFireTaskMovedByAutomation) {
          window.__mockFireTaskMovedByAutomation = function (projectId) {
            var listeners = (window.__mockTaskMovedByAutomationListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](projectId); }
          };
        }
        return function () {
          var listeners = window.__mockTaskMovedByAutomationListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onChangedInOtherWindow: function (callback) {
        // Tests can fire this via window.__mockFireTaskChangedInOtherWindow(projectId),
        // standing in for main's push after a write from the detached Agent Monitor.
        if (!window.__mockTaskChangedInOtherWindowListeners) window.__mockTaskChangedInOtherWindowListeners = [];
        window.__mockTaskChangedInOtherWindowListeners.push(callback);
        if (!window.__mockFireTaskChangedInOtherWindow) {
          window.__mockFireTaskChangedInOtherWindow = function (projectId) {
            var listeners = (window.__mockTaskChangedInOtherWindowListeners || []).slice();
            for (var listenerIndex = 0; listenerIndex < listeners.length; listenerIndex++) {
              listeners[listenerIndex](projectId);
            }
          };
        }
        return function () {
          var listeners = window.__mockTaskChangedInOtherWindowListeners || [];
          var listenerIndex = listeners.indexOf(callback);
          if (listenerIndex >= 0) listeners.splice(listenerIndex, 1);
        };
      },
      onWorkflowCompleted: function (callback) {
        // Tests can fire this via window.__mockFireWorkflowCompleted({ workflowId, title, taskCount, projectId }).
        if (!window.__mockWorkflowCompletedListeners) window.__mockWorkflowCompletedListeners = [];
        window.__mockWorkflowCompletedListeners.push(callback);
        if (!window.__mockFireWorkflowCompleted) {
          window.__mockFireWorkflowCompleted = function (completed) {
            var listeners = (window.__mockWorkflowCompletedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](completed); }
          };
        }
        return function () {
          var listeners = window.__mockWorkflowCompletedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onWorkflowStalled: function (callback) {
        // Tests can fire this via window.__mockFireWorkflowStalled({ workflowId, projectId, taskId, taskTitle, reason }).
        if (!window.__mockWorkflowStalledListeners) window.__mockWorkflowStalledListeners = [];
        window.__mockWorkflowStalledListeners.push(callback);
        if (!window.__mockFireWorkflowStalled) {
          window.__mockFireWorkflowStalled = function (stalled) {
            var listeners = (window.__mockWorkflowStalledListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](stalled); }
          };
        }
        return function () {
          var listeners = window.__mockWorkflowStalledListeners || [];
          var listenerIndex = listeners.indexOf(callback);
          if (listenerIndex >= 0) listeners.splice(listenerIndex, 1);
        };
      },
      onMovedByMobile: function (callback) {
        // Tests can fire this via window.__mockFireTaskMovedByMobile(projectId).
        if (!window.__mockTaskMovedByMobileListeners) window.__mockTaskMovedByMobileListeners = [];
        window.__mockTaskMovedByMobileListeners.push(callback);
        if (!window.__mockFireTaskMovedByMobile) {
          window.__mockFireTaskMovedByMobile = function (projectId) {
            var listeners = (window.__mockTaskMovedByMobileListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](projectId); }
          };
        }
        // A REAL unsubscribe, matching the preload bridge - never a noop.
        return function () {
          var listeners = window.__mockTaskMovedByMobileListeners || [];
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
        // Test hook: record every call (task id), mirroring tasks.move's
        // __mockMoveProjectIds counter, so a test can assert this path was
        // never reached (e.g. a gate that should keep a hotkey off an
        // archived task's window).
        if (typeof window !== 'undefined') {
          if (!window.__mockUnarchiveCallIds) window.__mockUnarchiveCallIds = [];
          window.__mockUnarchiveCallIds.push(input.id);
        }

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
        // Mirrors TASK_UNARCHIVE and restoredLaneOrder (src/shared/restore-lane-order.ts):
        // a whole-number index inside the lane, the end slot included, places
        // the restored task there and writes the lane's order back as dense
        // positions. Without one the mock keeps its long-standing position 0,
        // which existing specs and the web demo rely on. Main puts it last there.
        var restorePosition = 0;
        var laneTaskIds = tasks
          .filter(function (laneTask) { return laneTask.swimlane_id === input.targetSwimlaneId && laneTask.id !== input.id; })
          .sort(function (firstTask, secondTask) { return firstTask.position - secondTask.position; })
          .map(function (laneTask) { return laneTask.id; });
        if (typeof input.position === 'number' && Number.isInteger(input.position)
          && input.position >= 0 && input.position <= laneTaskIds.length) {
          restorePosition = input.position;
          laneTaskIds.splice(restorePosition, 0, input.id);
          tasks.forEach(function (laneTask, taskIndex) {
            var densePosition = laneTaskIds.indexOf(laneTask.id);
            if (densePosition >= 0 && laneTask.position !== densePosition) {
              tasks[taskIndex] = Object.assign({}, laneTask, { position: densePosition });
            }
          });
        }
        var task = Object.assign({}, archivedTasks[idx], {
          swimlane_id: input.targetSwimlaneId,
          archived_at: null,
          position: restorePosition,
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
          // Mirrors TaskRepository.recordWorktree: a task that gains a worktree
          // stops claiming it runs in the shared checkout.
          updates.worktree_skip_reason = null;
          updates.use_worktree = 1;
        }
        tasks[idx] = Object.assign({}, task, updates);
        return withAttachmentCount(tasks[idx]);
      },
      updateFromBase: async function (input) {
        var exists = tasks.some(function (t) { return t.id === input.taskId; });
        if (!exists) throw new Error('Task not found: ' + input.taskId);
        // Tests steer the outcome by setting window.__mockUpdateFromBaseResult
        // to any TaskUpdateFromBaseResult shape.
        return window.__mockUpdateFromBaseResult || { status: 'already-up-to-date', baseBranch: 'main' };
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
        // calling. Defaults to a successful 'restart' when the task has a
        // session_id (the real handler restarts a task session on any model or
        // effort change, it never types a slash), otherwise 'persisted'.
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
        var mode = tasks[idx].session_id ? 'restart' : 'persisted';
        return { ok: true, mode: mode };
      },
      resolvePr: async function (taskId, projectId) {
        // Test hook: spec can override the response by setting
        // window.__mockResolvePrResult before calling. Defaults to returning the
        // task unchanged (no PR linked) - real resolution needs the gh CLI.
        // Takes the projectId the preload forwards, like the real handler.
        if (typeof window !== 'undefined') {
          if (!window.__mockResolvePrCalls) window.__mockResolvePrCalls = [];
          window.__mockResolvePrCalls.push({ taskId: taskId, projectId: projectId === undefined ? null : projectId });
          if (typeof window.__mockResolvePrResult === 'function') {
            return window.__mockResolvePrResult(taskId);
          }
        }
        var found = tasks.find(function (t) { return t.id === taskId; }) || null;
        // Mirror the real anchor gate: a task with nothing to search by is
        // `no-anchor`, never `not-found`.
        var hasAnchor = !!(found && (
          found.pr_number != null || found.worktree_path || found.branch_name || found.head_sha || found.pushed_branch
        ));
        if (found && !hasAnchor) return { task: found, linked: false, reason: 'no-anchor' };
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
      list: async function (projectId) {
        hydrateSeededSwimlanePatches();
        // A row that carries a projectId belongs to that project only (the real DB is per
        // project); a row without one stays global, so single-project specs are unchanged.
        // `projectId` reads another project's board, as main's swimlane:list does.
        var boardProjectId = projectId || currentProjectId;
        return swimlanes.filter(function (s) {
          return !s.projectId || s.projectId === boardProjectId;
        }).sort(function (a, b) {
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
          auto_command_mode: input.auto_command_mode || 'immediate',
          plan_exit_target_id: input.plan_exit_target_id || null,
          plan_approval: input.plan_approval === 'automatic' ? 'automatic' : 'manual',
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
          // Main's SwimlaneRepository.update applies only the keys that are not
          // undefined (null still clears), so a key the renderer sends as
          // undefined keeps the stored value here too.
          var applied = {};
          Object.keys(input).forEach(function (key) {
            if (input[key] !== undefined) applied[key] = input[key];
          });
          swimlanes[idx] = Object.assign({}, swimlanes[idx], applied);
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

    automations: {
      list: async function () {
        hydrateSeededAutomations();
        // A sorted COPY: the store holds what this returns, and handing out the
        // live array would let a renderer mutation reach the mock's state.
        return automations
          .slice()
          .sort(function (left, right) {
            if (left.swimlane_id !== right.swimlane_id) return left.swimlane_id < right.swimlane_id ? -1 : 1;
            // The triggers in the order a task meets them (AUTOMATION_TRIGGERS),
            // not the repository's alphabetical `ORDER BY trigger`: the renderer
            // groups by trigger itself, so only the order WITHIN a group matters.
            if (left.trigger !== right.trigger) {
              return AUTOMATION_TRIGGER_ORDER.indexOf(left.trigger) - AUTOMATION_TRIGGER_ORDER.indexOf(right.trigger);
            }
            return left.position - right.position;
          })
          .map(function (row) {
            return Object.assign({}, row, { config: Object.assign({}, row.config) });
          });
      },
      replaceForColumn: async function (swimlaneId, rows) {
        // Mirrors the repository: whole-column delete-and-insert, with position
        // assigned PER TRIGGER so the two groups never interleave.
        automations = automations.filter(function (row) {
          return row.swimlane_id !== swimlaneId;
        });
        var nextPosition = { enter: 0, turn_end: 0, exit: 0 };
        (rows || []).forEach(function (row) {
          // A trigger the repository would not know is stored as 'enter', the
          // column's original and default group; the other two are kept as sent.
          var trigger = AUTOMATION_TRIGGER_ORDER.indexOf(row.trigger) >= 0 ? row.trigger : 'enter';
          // One Condition kind per row, a Text match on a turn end only: the
          // repository's backstop, mirrored so a spec reads back what the app would.
          var finalLine = trigger === 'turn_end' && typeof row.final_line === 'string' && row.final_line.trim() !== ''
            ? row.final_line.trim()
            : null;
          automations.push({
            id: row.id || uuid(),
            swimlane_id: swimlaneId,
            name: row.name,
            type: row.type,
            trigger: trigger,
            position: nextPosition[trigger],
            enabled: row.enabled !== false,
            config: Object.assign({}, row.config),
            // Null when absent, as the repository returns it. `undefined` is not
            // the same thing to a consumer: the row draws its Frequency mark (Repeat
            // with a count) for any `max_runs` that is not null, so an undefined one
            // would show a Repeat with no count and the tooltip "Frequency: at most
            // undefined times until you move the task." The Condition marks read a blank
            // condition or text match as none either way.
            condition: finalLine === null && typeof row.condition === 'string' && row.condition.trim() !== '' ? row.condition.trim() : null,
            final_line: finalLine,
            max_runs: Number.isFinite(row.max_runs) && Math.floor(row.max_runs) >= 1 ? Math.floor(row.max_runs) : null,
            created_at: now(),
            updated_at: now(),
          });
          nextPosition[trigger] += 1;
        });
        return automations.filter(function (row) {
          return row.swimlane_id === swimlaneId;
        });
      },
      runsForTask: async function (taskId) {
        return automationRuns
          .filter(function (run) { return run.task_id === taskId; })
          .slice()
          .sort(function (left, right) { return left.started_at < right.started_at ? 1 : -1; })
          .map(function (run) { return Object.assign({}, run); });
      },
      runAgain: async function (automationId, taskId) {
        var automation = automations.find(function (row) { return row.id === automationId; });
        if (!automation) {
          return { ok: false, error: 'That automation no longer exists. It was probably deleted or renamed in the Column Manager.' };
        }
        var lane = swimlanes.find(function (row) { return row.id === automation.swimlane_id; });
        // A fresh run row, which is the half the spec asserts: a re-run must be
        // visible in the log rather than only in the toast.
        var run = {
          id: uuid(),
          automation_id: automation.id,
          automation_name: automation.name,
          type: automation.type,
          task_id: taskId,
          swimlane_id: automation.swimlane_id,
          trigger: automation.trigger,
          status: 'succeeded',
          detail: 'Ran again.',
          attempts: 1,
          started_at: now(),
          finished_at: now(),
        };
        automationRuns.push(run);
        return {
          ok: true,
          runId: run.id,
          automationName: automation.name,
          columnName: lane ? lane.name : '',
          status: 'succeeded',
          detail: run.detail,
        };
      },
      onRunFailed: function (callback) {
        // Tests can fire this via window.__mockFireAutomationRunFailed(failure),
        // where failure is an AutomationRunFailure. It throws with no subscriber,
        // so a missing App.tsx subscription fails by name instead of as a
        // toast that never shows.
        automationFailureListeners.push(callback);
        if (!window.__mockFireAutomationRunFailed) {
          window.__mockFireAutomationRunFailed = function (failure) {
            if (automationFailureListeners.length === 0) {
              throw new Error('__mockFireAutomationRunFailed called with no automations.onRunFailed listener registered');
            }
            automationFailureListeners.slice().forEach(function (listener) { listener(failure); });
          };
        }
        return function () {
          automationFailureListeners = automationFailureListeners.filter(function (entry) { return entry !== callback; });
        };
      },
      onRunsInterrupted: function (callback) {
        automationInterruptedListeners.push(callback);
        return function () {
          automationInterruptedListeners = automationInterruptedListeners.filter(function (entry) { return entry !== callback; });
        };
      },
    },

    sessions: {
      spawn: async function () {
        throw new Error('Mock: session spawn not available in UI tests');
      },
      kill: async function () {},
      // Suspend and resume record, in call order, the project id each was
      // stamped with to window.__mockSuspendCalls / window.__mockResumeCalls as
      // { taskId, projectId } (`undefined` normalized to null, as backlog.demote
      // does with __mockDemoteCalls), so a spec can assert that a surface
      // hosting another project's task sends that project. Reset and reconcile
      // record the same way, to __mockResetCalls / __mockReconcileCalls.
      suspend: async function (taskId, projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockSuspendCalls) window.__mockSuspendCalls = [];
          window.__mockSuspendCalls.push({ taskId: taskId, projectId: projectId === undefined ? null : projectId });
        }
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
      resume: async function (taskId, resumePrompt, projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockResumeCalls) window.__mockResumeCalls = [];
          window.__mockResumeCalls.push({ taskId: taskId, projectId: projectId === undefined ? null : projectId });
        }
        // Main labels a resume "Resuming session..." until the session is up. The
        // mock pushes no spawn-progress label from this or any other method (a
        // move into a spawn column and an unarchive label in main too): it would
        // set and clear inside this one call, so nothing would render. A spec
        // that needs a label on screen fires it through __mockFireSpawnProgress.
        var newSession = {
          id: uuid(),
          taskId: taskId,
          projectId: projectId || currentProjectId || '',
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
        // Main's respawn drops the task's paused rows from its registry
        // (session-spawn-flow.ts), so the resumed session is the task's only one. Main
        // sends no removal push for them: the renderer drops its copy when the new row's
        // status push lands (withSessionUpserted keeps one row per task). The removal
        // push below is the mock's own, not main's.
        // Spliced in place, not reassigned: __mockPreConfigure hands callers this array.
        for (var pausedIndex = sessions.length - 1; pausedIndex >= 0; pausedIndex--) {
          var paused = sessions[pausedIndex];
          if (paused.taskId !== taskId || paused.status !== 'suspended') continue;
          sessions.splice(pausedIndex, 1);
          if (typeof window !== 'undefined' && window.__mockFireRemoved) {
            window.__mockFireRemoved(paused.id, Object.assign({}, paused), paused.projectId);
          }
        }
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
      // Reset records { taskId, projectId } to window.__mockResetCalls, as suspend
      // does, so a spec can assert the project a task-detail host stamped.
      reset: async function (taskId, projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockResetCalls) window.__mockResetCalls = [];
          window.__mockResetCalls.push({ taskId: taskId, projectId: projectId === undefined ? null : projectId });
        }
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
      // Every probe records { taskId, projectId } to window.__mockReconcileCalls,
      // like suspend and resume, so a spec can assert the project it was stamped for.
      reconcile: async function (taskId, projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockReconcileCalls) window.__mockReconcileCalls = [];
          window.__mockReconcileCalls.push({ taskId: taskId, projectId: projectId === undefined ? null : projectId });
        }
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
        // Tests can force the result (e.g. { colsChanged: false, refused: true }
        // to exercise the width-drift refusal hold) via window.__mockResizeResult.
        return window.__mockResizeResult || { colsChanged: false };
      },
      list: async function () {
        return sessions;
      },
      // Per-session replay delay, in ms, via window.__mockScrollbackDelayMs
      // keyed by session id. Real main deliberately waits 150-400ms here while
      // the agent TUI's repaint settles (see pty-buffer-manager.ts), and that
      // wait is what makes the ORDER in which two concurrently mounting
      // terminals finish replaying nondeterministic. Without a way to control
      // that order a spec cannot reproduce the arrival-focus race at all.
      // Every call is logged to window.__mockScrollbackCalls as
      // { sessionId, delay }, so a spec can prove AFTER the fact that a replay
      // it meant to delay actually took the delayed path. That matters because
      // the assertions a delay enables ("the late terminal did not steal
      // focus") all still pass if the delay silently stops applying - a renamed
      // session id, a changed mock - leaving the race unexercised and the spec
      // vacuously green. Checking the log is deterministic; watching for the
      // transient replay veil to prove the same thing is not, and fails on CI.
      //
      // A delay is a RACE against whatever the spec does meanwhile (open a
      // dialog, open a panel), and it loses on a loaded runner. For an order the
      // spec must control, set window.__mockScrollbackGate = { [sessionId]: promise }:
      // every replay for that session also awaits the promise, so the spec
      // releases it (resolves it) once the surface it opened is confirmed up. One
      // promise per session, never replaced, so after the release every later
      // call passes straight through. The log entry's `gated` flag lets a spec
      // prove the gate really held the call. Opt-in: with no gate set, behavior
      // is exactly the delay above.
      getScrollback: async function (sessionId) {
        var delay = (window.__mockScrollbackDelayMs || {})[sessionId] || 0;
        var gate = (window.__mockScrollbackGate || {})[sessionId] || null;
        window.__mockScrollbackCalls = window.__mockScrollbackCalls || [];
        window.__mockScrollbackCalls.push({ sessionId: sessionId, delay: delay, gated: gate !== null });
        if (delay > 0) {
          await new Promise(function (resolve) { setTimeout(resolve, delay); });
        }
        if (gate) {
          await gate;
        }
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
      onPtyResized: function (callback) {
        // Tests can fire the width-drift echo via
        // window.__mockFirePtyResized(sessionId, cols, rows, origin).
        if (!window.__mockPtyResizedListeners) window.__mockPtyResizedListeners = [];
        window.__mockPtyResizedListeners.push(callback);
        if (!window.__mockFirePtyResized) {
          window.__mockFirePtyResized = function (sessionId, cols, rows, origin) {
            var listeners = (window.__mockPtyResizedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, cols, rows, origin || 'desktop'); }
          };
        }
        return function () {
          var listeners = window.__mockPtyResizedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
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
        // A demo scene reaches an in-app toast by seeding the PUSH that raises
        // it, never the toast store: App.tsx's own subscription decides, gated
        // on notifications.toasts.onAgentCrash, exactly as on the desktop.
        // Fired once, on the first registration, because a scene is data and
        // has no way to call a function.
        if (window.__mockInitialExit && !window.__mockInitialExitFired) {
          window.__mockInitialExitFired = true;
          var exitSeed = window.__mockInitialExit;
          // Deferred a task, so the callback this call is installing receives it.
          // It reaches THAT callback only, where real main broadcasts SESSION_EXIT
          // to every listener on the channel. Enough for the scenes that seed it
          // (App.tsx is the sole subscriber when the toast scene boots), but a
          // scene that opened a Command Terminal first would have its own
          // onExit registration consume the one-shot and App.tsx would see
          // nothing. Fan out over __mockExitListeners if that scene ever exists.
          window.setTimeout(function () {
            callback(exitSeed.sessionId, exitSeed.exitCode || 0, exitSeed.projectId || null, false);
          }, 0);
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
      onRemoved: function (callback) {
        // Tests can fire this via window.__mockFireRemoved(sessionId, session, projectId).
        // The mock's own tasks.move fires it for a move into a todo-role
        // column, mirroring SessionManager.remove() on the main side. The third
        // argument matches the real preload, which forwards session.projectId.
        if (!window.__mockRemovedListeners) window.__mockRemovedListeners = [];
        window.__mockRemovedListeners.push(callback);
        if (!window.__mockFireRemoved) {
          window.__mockFireRemoved = function (sessionId, session, projectId) {
            var listeners = (window.__mockRemovedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, session, projectId); }
          };
        }
        return function () {
          var listeners = window.__mockRemovedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onUsage: function (callback) {
        // Tests can fire this via window.__mockFireUsage(sessionId, usage, projectId).
        if (!window.__mockUsageListeners) window.__mockUsageListeners = [];
        window.__mockUsageListeners.push(callback);
        if (!window.__mockFireUsage) {
          window.__mockFireUsage = function (sessionId, usage, projectId) {
            var listeners = (window.__mockUsageListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, usage, projectId); }
          };
        }
        return function () {
          var listeners = window.__mockUsageListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      getMessageTrails: async function () {
        return Object.assign({}, messageTrailCache);
      },
      onMessageTrail: function (callback) {
        // Tests can fire this via
        // window.__mockFireMessageTrail(sessionId, entries, projectId).
        if (!window.__mockMessageTrailListeners) window.__mockMessageTrailListeners = [];
        window.__mockMessageTrailListeners.push(callback);
        if (!window.__mockFireMessageTrail) {
          window.__mockFireMessageTrail = function (sessionId, entries, projectId) {
            messageTrailCache[sessionId] = entries;
            var listeners = (window.__mockMessageTrailListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, entries, projectId); }
          };
        }
        return function () {
          var listeners = window.__mockMessageTrailListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      getActivity: async function (/* projectId */) {
        return Object.assign({}, activityCache);
      },
      getActivityReason: async function (sessionId) {
        // The seeded reason, or null: the production "session unknown" path.
        return activityReasonCache[sessionId] || null;
      },
      getActivityReasons: async function (/* projectId */) {
        // Batch reason map; mirrors getActivity's mock.
        return Object.assign({}, activityReasonCache);
      },
      getActivityStats: async function (sessionId) {
        // Debug overlay only; UI tests rarely need this. Returning null
        // mirrors the production "session unknown" path, which is also what a
        // session with no seeded snapshot gets. The web build seeds
        // `activityStatsCache` from the sample install so the overlay has
        // something real to draw; see demo-dataset.ts.
        return activityStatsCache[sessionId] || null;
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
      onIdleTimeout: function (callback) {
        // Tests can fire this via
        // window.__mockFireIdleTimeout(sessionId, taskId, minutes, projectId).
        // The unsubscribe splices, so a StrictMode double mount does not leave
        // two live listeners behind (and two toasts per push).
        if (!window.__mockIdleTimeoutListeners) window.__mockIdleTimeoutListeners = [];
        window.__mockIdleTimeoutListeners.push(callback);
        if (!window.__mockFireIdleTimeout) {
          window.__mockFireIdleTimeout = function (sessionId, taskId, minutes, projectId) {
            var listeners = (window.__mockIdleTimeoutListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](sessionId, taskId, minutes, projectId); }
          };
        }
        return function () {
          var listeners = window.__mockIdleTimeoutListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      getSummary: async function (taskId) {
        return summaryCache[taskId] || null;
      },
      listSummaries: async function () {
        return Object.assign({}, summaryCache);
      },
      getTaskReport: async function (_projectId, taskId) {
        if (Object.prototype.hasOwnProperty.call(taskReportCache, taskId)) return taskReportCache[taskId];
        return hydrateSeededTaskReport(taskId) || buildMockTaskReport(taskId);
      },
      // The route the report's Route card draws, read through the bridge's
      // getTaskReport at call time (not a closure, and not `this`, so it holds
      // however the method is bound) so a spec's or the web demo's report
      // override feeds the conversation window's tabs too. A spec that wants a
      // route with no report behind it sets window.__mockTaskRoutes[taskId].
      getTaskRoute: async function (projectId, taskId) {
        var routes = window.__mockTaskRoutes;
        if (routes && Object.prototype.hasOwnProperty.call(routes, taskId)) return routes[taskId];
        var report = await window.electronAPI.sessions.getTaskReport(projectId, taskId);
        return (report && report.route) || [];
      },
      getTaskLastMessage: async function (_projectId, taskId) {
        return Object.prototype.hasOwnProperty.call(taskLastMessages, taskId) ? taskLastMessages[taskId] : null;
      },
      getToolBreakdown: async function (_sessionId) {
        // Live telemetry is not captured in UI tests; specs that need a
        // breakdown override this stub per-test.
        return [];
      },
      getToolResultTokens: async function (_sessionId) {
        // No transcript exists in the mock, which is main's null answer for an
        // agent with no readable transcript. Specs override it per-test.
        return null;
      },
      spawnTransient: async function (input) {
        // Call log for assertions: window.__mockSpawnTransientCalls.
        if (typeof window !== 'undefined') {
          window.__mockSpawnTransientCalls = window.__mockSpawnTransientCalls || [];
          window.__mockSpawnTransientCalls.push(Object.assign({}, input));
        }
        var id = crypto.randomUUID();
        var branch = input.branch || 'main';
        // Main resumes the conversation on its own agent, and a resumed terminal
        // holds that conversation (and counts as used) from its first frame.
        var resumeId = input.resumeAgentSessionId || null;
        // Mirrors main's allocation (startCommandTerminal): a requested slot is
        // honored, and a start that names none takes the project's lowest free one.
        var slot = input.slot || null;
        if (!slot) {
          var usedSlots = sessions
            .filter(function (existing) { return existing.transient && existing.projectId === input.projectId && existing.status !== 'exited'; })
            .map(function (existing) { return existing.commandTerminalSlot; });
          for (var slotNumber = 1; slotNumber <= 4 && !slot; slotNumber += 1) {
            if (usedSlots.indexOf('slot-' + slotNumber) === -1) slot = 'slot-' + slotNumber;
          }
        }
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
          // Main stamps the slot and the RESOLVED branch onto the session row, and
          // the renderer re-pairs a surviving PTY to its window by that slot after
          // a reload. Omitting them here would let a UI test pass against a row
          // shape production never produces.
          commandTerminalSlot: slot,
          commandTerminalBranch: branch,
          commandTerminalLabel: null,
          isolatedSwimlaneId: null,
          agentSessionId: resumeId,
        };
        if (resumeId) {
          session.resuming = true;
          session.hasUserInput = true;
        }
        sessions.push(session);
        return { session: session, slot: slot, branch: branch };
      },
      setTransientBranch: async function (sessionId, branch) {
        // Mirrors main: the renderer re-derives the branch from live HEAD and
        // main records the newest reading (LAST write wins; main names a
        // terminal itself, first write wins).
        // Call log for assertions: window.__mockSetTransientBranchCalls.
        if (typeof window !== 'undefined') {
          window.__mockSetTransientBranchCalls = window.__mockSetTransientBranchCalls || [];
          window.__mockSetTransientBranchCalls.push({ sessionId: sessionId, branch: branch });
        }
        var session = sessions.find(function (session) { return session.id === sessionId; });
        var trimmed = (branch || '').trim();
        if (trimmed && session && session.transient) {
          session.commandTerminalBranch = trimmed;
        }
      },
      // Mirrors SessionManager.renameCommandTerminal: the name on one line,
      // trimmed and cut to 64; empty or the slot's own title clears it. The
      // terminal is marked named by the user either way, and the row goes out
      // on the status push, as main's session-changed does.
      // Call log for assertions: window.__mockRenameTransientCalls.
      renameTransient: async function (sessionId, name) {
        if (typeof window !== 'undefined') {
          window.__mockRenameTransientCalls = window.__mockRenameTransientCalls || [];
          window.__mockRenameTransientCalls.push({ sessionId: sessionId, name: name });
        }
        var session = sessions.find(function (candidate) { return candidate.id === sessionId; });
        if (!session || !session.transient || session.workflowId) return false;
        var line = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 64).trim();
        var slotMatch = /^slot-(\d+)$/.exec(session.commandTerminalSlot || '');
        var slotTitle = slotMatch ? 'Command Terminal ' + slotMatch[1] : 'Command Terminal';
        var label = !line || line === slotTitle ? null : line;
        var changed = (session.commandTerminalLabel || null) !== label;
        if (!changed && session.commandTerminalNamedByUser) return false;
        session.commandTerminalLabel = label;
        session.commandTerminalNamedByUser = true;
        if (typeof window !== 'undefined' && window.__mockFireStatus) {
          window.__mockFireStatus(sessionId, Object.assign({}, session));
        }
        return changed;
      },
      // A project's earlier Command Terminal conversations. Seed with
      // window.__mockCommandTerminalHistory = { [projectId]: CommandTerminalHistoryEntry[] };
      // nothing seeded answers an empty list, as a project with no ended
      // terminals does.
      listCommandTerminalHistory: async function (projectId) {
        var seeded = typeof window !== 'undefined' && window.__mockCommandTerminalHistory;
        var entries = (seeded && seeded[projectId]) || [];
        return entries.slice();
      },
      // Tests fire it via window.__mockFireCommandTerminalHistoryChanged(projectId).
      onCommandTerminalHistoryChanged: function (callback) {
        if (typeof window === 'undefined') return function () {};
        if (!window.__mockCommandTerminalHistoryListeners) window.__mockCommandTerminalHistoryListeners = [];
        window.__mockCommandTerminalHistoryListeners.push(callback);
        window.__mockFireCommandTerminalHistoryChanged = function (projectId) {
          (window.__mockCommandTerminalHistoryListeners || []).forEach(function (listener) { listener(projectId); });
        };
        return function () {
          window.__mockCommandTerminalHistoryListeners = (window.__mockCommandTerminalHistoryListeners || [])
            .filter(function (listener) { return listener !== callback; });
        };
      },
      killTransient: async function (sessionId) {
        var index = sessions.findIndex(function (s) { return s.id === sessionId; });
        if (index === -1) return;
        var removed = sessions.splice(index, 1)[0];
        // Mirrors main's endCommandTerminal, whose remove() announces the
        // removal, so a spec sees the push a desktop Stop really produces.
        if (typeof window !== 'undefined' && window.__mockFireRemoved) {
          window.__mockFireRemoved(sessionId, removed, removed.projectId);
        }
      },
      // Call log for test assertions. Each entry is the string[] of session IDs
      // passed to setFocused. Reset between tests via:
      //   window.electronAPI.sessions.__setFocusedCalls.length = 0;
      __setFocusedCalls: [],
      setFocused: async function (sessionIds) {
        window.electronAPI.sessions.__setFocusedCalls.push(sessionIds.slice());
      },
      // Which sessions have an xterm mounted, published by every terminal's
      // mount effect (terminal-mount-registry). Same call-log shape as
      // setFocused above.
      __setMountedCalls: [],
      setMounted: async function (sessionIds) {
        window.electronAPI.sessions.__setMountedCalls.push(sessionIds.slice());
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
        // The Tokens view's by-model bars: the token series split by model, so
        // each bucket's slices sum to that bucket of tokenSeries, as the
        // service's turn-ledger fold does.
        var tokenModelSeries = tokenSeries.map(function (point) {
          var largeInput = Math.floor(point.inputTokens * 0.7);
          var largeOutput = Math.floor(point.outputTokens * 0.7);
          return {
            bucketStartMs: point.bucketStartMs,
            costUsd: 0,
            inputTokens: point.inputTokens,
            outputTokens: point.outputTokens,
            sessionCount: 0,
            byModel: [
              { modelId: 'mock-model-large', costUsd: 0, inputTokens: largeInput, outputTokens: largeOutput },
              { modelId: 'mock-model-small', costUsd: 0, inputTokens: point.inputTokens - largeInput, outputTokens: point.outputTokens - largeOutput },
            ],
          };
        });
        // Background calls: per-day rows, with the per-job and total figures
        // folded from them the way foldBackgroundUsage
        // (src/main/usage-stats/background-usage.ts) folds them, so the card and
        // the history table always agree. This file cannot import it: keep the
        // totals' fields in step with BackgroundCallTotals, as the demo
        // dataset's copy does. The terminal names ran on an agent
        // that reports no usage, which exercises the "not reported" state.
        var todayStartMs = new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate()).getTime();
        var yesterdayStartMs = new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate() - 1).getTime();
        function backgroundDay(dayStartMs, job, agent, modelId, calls, failedCalls, usage, durationMs) {
          return {
            dayStartMs: dayStartMs,
            job: job,
            models: [{ agent: agent, modelId: modelId, calls: calls }],
            calls: calls,
            failedCalls: failedCalls,
            reportedCalls: usage ? calls : 0,
            inputTokens: usage ? usage[0] : 0,
            cacheCreationInputTokens: usage ? usage[1] : 0,
            cacheReadInputTokens: usage ? usage[2] : 0,
            outputTokens: usage ? usage[3] : 0,
            costUsd: usage ? usage[4] : null,
            durationMs: durationMs,
          };
        }
        var backgroundDays = [
          backgroundDay(todayStartMs, 'condition_check', 'claude', 'claude-haiku-5-5', 12, 0, [25000, 1200, 12000, 540, 0.04], 22800),
          backgroundDay(todayStartMs, 'workflow_step', 'claude', 'claude-haiku-5-5', 4, 1, [8400, 400, 4000, 180, 0.01], 8400),
          backgroundDay(todayStartMs, 'task_summary', 'claude', 'claude-sonnet-5-5', 2, 0, [32000, 4000, 10000, 3000, 0.15], 28000),
          backgroundDay(todayStartMs, 'task_title', 'claude', 'claude-haiku-5-5', 3, 0, [2400, 3000, 18000, 48, 0.02], 7200),
          backgroundDay(todayStartMs, 'terminal_name', 'codex', null, 2, 0, null, 9200),
          backgroundDay(yesterdayStartMs, 'condition_check', 'claude', 'claude-haiku-5-5', 9, 0, [19000, 900, 9000, 400, 0.03], 17100),
        ];
        var backgroundJobs = ['condition_check', 'workflow_step', 'task_summary', 'task_title', 'terminal_name'];
        function emptyBackgroundTotals() {
          return { calls: 0, failedCalls: 0, reportedCalls: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, costUsd: null, durationMs: 0 };
        }
        function addBackgroundTotals(totals, row) {
          totals.calls += row.calls;
          totals.failedCalls += row.failedCalls;
          totals.reportedCalls += row.reportedCalls;
          totals.inputTokens += row.inputTokens;
          totals.cacheCreationInputTokens += row.cacheCreationInputTokens;
          totals.cacheReadInputTokens += row.cacheReadInputTokens;
          totals.outputTokens += row.outputTokens;
          if (row.costUsd !== null) totals.costUsd = (totals.costUsd || 0) + row.costUsd;
          totals.durationMs += row.durationMs;
        }
        var backgroundTotals = emptyBackgroundTotals();
        backgroundDays.forEach(function (row) { addBackgroundTotals(backgroundTotals, row); });
        var backgroundByJob = backgroundJobs.map(function (job) {
          var jobTotals = emptyBackgroundTotals();
          var models = [];
          backgroundDays.filter(function (row) { return row.job === job; }).forEach(function (row) {
            addBackgroundTotals(jobTotals, row);
            row.models.forEach(function (model) {
              var existing = models.find(function (candidate) { return candidate.agent === model.agent && candidate.modelId === model.modelId; });
              if (existing) existing.calls += model.calls;
              else models.push({ agent: model.agent, modelId: model.modelId, calls: model.calls });
            });
          });
          return Object.assign({ job: job, models: models }, jobTotals);
        });
        // Burn rates derived from THIS fixture's own totals and range, the way
        // the service computes them: one shared denominator, each numerator
        // the field its own tile renders. Hardcoded constants here used to
        // contradict the fixture's cost and tokens, so a UI test could not
        // check the property the tiles are supposed to have.
        var rangeHours = Math.max(nowMs - rangeStartMs, 60000) / 3600000;
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
            activeMs: 90 * 60 * 1000,
            activeSessionsCovered: 6,
            turnInputTokens: 60000,
            turnOutputTokens: 20000,
            cacheCreationTokens: 30000,
            cacheReadTokens: 900000,
            subagentInputTokens: 180000,
            subagentOutputTokens: 45000,
            subagentCacheCreationTokens: 90000,
            subagentCacheReadTokens: 5200000,
            subagentTurnCount: 190,
            subagentCount: 8,
            subagentNestedCount: 2,
            burnRateTokensPerHour: (60000 + 20000) / rangeHours,
            burnRateUsdPerHour: 12.34 / rangeHours,
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
            activeMs: 72 * 60 * 1000,
            activeSessionsCovered: 5,
            turnInputTokens: 50000,
            turnOutputTokens: 16000,
            cacheCreationTokens: 24000,
            cacheReadTokens: 700000,
            subagentInputTokens: 150000,
            subagentOutputTokens: 36000,
            subagentCacheCreationTokens: 72000,
            subagentCacheReadTokens: 4100000,
            subagentTurnCount: 160,
            subagentCount: 6,
            subagentNestedCount: 1,
            burnRateTokensPerHour: (50000 + 16000) / rangeHours,
            burnRateUsdPerHour: 10.0 / rangeHours,
          },
          tokenSeries: tokenSeries,
          costSeries: costSeries,
          tokenModelSeries: tokenModelSeries,
          background: { totals: backgroundTotals, byJob: backgroundByJob, byDay: backgroundDays },
          // 'mock-model-legacy' has cost and no turn tokens, the shape of a
          // model whose sessions predate per-turn capture: it belongs in the
          // Cost view's breakdown and not in the Tokens view's.
          byModel: [
            { modelId: 'mock-model-large', modelDisplayName: 'Mock Large', inputTokens: 120000, outputTokens: 30000, costUsd: 8.0, sessionCount: 4 },
            { modelId: 'mock-model-small', modelDisplayName: 'Mock Small', inputTokens: 30000, outputTokens: 12000, costUsd: 2.34, sessionCount: 2 },
            { modelId: 'mock-model-legacy', modelDisplayName: 'Mock Legacy', inputTokens: 0, outputTokens: 0, costUsd: 2.0, sessionCount: 1 },
          ],
          byAgent: [
            { agent: 'claude', inputTokens: 130000, outputTokens: 36000, costUsd: 11.0, sessionCount: 6 },
            { agent: 'codex', inputTokens: 20000, outputTokens: 6000, costUsd: 1.34, sessionCount: 1 },
          ],
          // Cost and token order differ on purpose: 'low' is the smallest by
          // tokens but second by cost, so a breakdown list visibly re-ranks
          // when the Cost/Tokens toggle flips.
          byEffort: [
            { effort: 'high', inputTokens: 90000, outputTokens: 26000, costUsd: 8.0, sessionCount: 3 },
            { effort: null, inputTokens: 40000, outputTokens: 10000, costUsd: 1.34, sessionCount: 3 },
            { effort: 'low', inputTokens: 20000, outputTokens: 6000, costUsd: 3.0, sessionCount: 1 },
          ],
          // Subagent rollup carries no cost by design: the session's reported
          // cost already covers its whole subagent tree.
          bySubagentType: [
            { agentType: 'review-finder', inputTokens: 90000, outputTokens: 22000, cacheCreationTokens: 45000, cacheReadTokens: 3100000, turnCount: 96, subagentCount: 4, nestedTurnCount: 0, nestedSubagentCount: 0, maxSpawnDepth: 1 },
            { agentType: 'test-builder', inputTokens: 60000, outputTokens: 15000, cacheCreationTokens: 30000, cacheReadTokens: 1500000, turnCount: 62, subagentCount: 2, nestedTurnCount: 18, nestedSubagentCount: 1, maxSpawnDepth: 2 },
            { agentType: 'Explore', inputTokens: 30000, outputTokens: 8000, cacheCreationTokens: 15000, cacheReadTokens: 600000, turnCount: 32, subagentCount: 2, nestedTurnCount: 12, nestedSubagentCount: 1, maxSpawnDepth: 2 },
          ],
          // 'codex' is in byAgent above and reports no subagent usage, so the
          // Subagents tile has to say so rather than render a bare dash.
          subagentBlindAgents: ['codex'],
          liveLedgerBaseline: { costUsd: 0 },
          earliestTurnMs: nowMs - 30 * dayMs,
          perProject: scope.kind === 'all'
            ? [
                { projectId: 'mock-project-1', projectName: 'Mock Project', inputTokens: 100000, outputTokens: 30000, cacheReadTokens: 400000, costUsd: 9.0, sessionCount: 5, toolCallCount: 220, linesAdded: 900, linesRemoved: 250, filesChanged: 47, totalDurationMs: 3 * hourMs, activeMs: 55 * 60 * 1000, activeSessionsCovered: 4, lastActiveMs: nowMs - hourMs, topAgent: 'claude' },
                { projectId: 'mock-project-2', projectName: 'Other Project', inputTokens: 50000, outputTokens: 12000, cacheReadTokens: 2500000, costUsd: 3.34, sessionCount: 2, toolCallCount: 95, linesAdded: 300, linesRemoved: 90, filesChanged: 12, totalDurationMs: hourMs, activeMs: 20 * 60 * 1000, activeSessionsCovered: 2, lastActiveMs: nowMs - 26 * hourMs, topAgent: 'codex' },
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
        // Test hook: window.__mockDictationSentenceCaseFinal, a boolean, is what
        // main reports when the live model writes all caps and the committed text
        // is its own (the Zipformer with no refinement). The hook recases a final
        // only when this is true. Unset, it is false, as before.
        var sentenceCaseFinal = typeof window !== 'undefined' && window.__mockDictationSentenceCaseFinal === true;
        return { dictationSessionId: 'mock-dictation-1', engineId: 'stub', modelId: null, needsDownload: false, sentenceCaseFinal: sentenceCaseFinal };
      },
      __stopCalls: [],
      stop: async function (dictationSessionId, expectedFrames) {
        window.electronAPI.dictation.__stopCalls.push({ dictationSessionId, expectedFrames });
        // Test hook: window.__mockDictationStopError, a string, makes stop()
        // reject with an Error carrying that message - so a spec can exercise
        // useDictation's finalizeOnRelease() catch branch (a real engine fault
        // decoding the utterance) without a real crash.
        if (typeof window !== 'undefined' && window.__mockDictationStopError) {
          throw new Error(window.__mockDictationStopError);
        }
        // Test hook: window.__mockDictationStopText, a string, is the transcript
        // stop() resolves with, so a spec can feed the hook a final in the shape a
        // given model writes (all caps, an acronym) and read back what is typed.
        // Unset, the stock sentence below is returned, as before.
        if (typeof window !== 'undefined' && typeof window.__mockDictationStopText === 'string') {
          return window.__mockDictationStopText;
        }
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
      // Test hook: hold `submit` open so a spec can observe the window during
      // which an auto-submit paste is still landing. Real submits are NOT
      // instant - `terminal-submit.ts` waits for the TUI to settle rather than
      // sleeping a fixed amount, so on a loaded machine this window has been
      // measured past two seconds. A mock that always resolves immediately
      // cannot see any of the behaviour that depends on it.
      __submitGate: null,
      __blockSubmit: function () {
        var release = function () {};
        window.electronAPI.dictation.__submitGate = new Promise(function (resolve) { release = resolve; });
        window.electronAPI.dictation.__releaseSubmit = function () {
          release();
          window.electronAPI.dictation.__submitGate = null;
        };
      },
      __releaseSubmit: function () {},
      submit: async function (sessionId, text, eraseCount) {
        window.electronAPI.dictation.__submits.push({ sessionId: sessionId, text: text, eraseCount: eraseCount });
        var gate = window.electronAPI.dictation.__submitGate;
        if (gate) await gate;
        return true;
      },
      getInfo: async function () {
        // Test hook: window.__mockDictationInfoOverrides merges over the
        // defaults (e.g. { workerUnavailable: true, workerError: '...' } to
        // exercise DictationTab's worker-crashed banner), matching the
        // probePath() override idiom above.
        var overrides = (typeof window !== 'undefined' && window.__mockDictationInfoOverrides) || {};
        var defaults = {
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
          workerUnavailable: false,
        };
        return Object.assign({}, defaults, overrides);
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
      get: async function (projectId) {
        // Another project's effective config (a workflow's planned task on its
        // board), as main answers config:get with a projectId: global merged
        // with that project's overrides. Outside the graphics-acceleration
        // counters below, which track the open project's reads.
        if (projectId && projectId !== currentProjectId) {
          var otherProject = projects.find(function (p) { return p.id === projectId; });
          if (!otherProject) throw new Error('Unknown project');
          return projectConfigs[otherProject.path] ? deepMerge(config, projectConfigs[otherProject.path]) : config;
        }
        // Return effective config: global merged with current project's overrides
        var currentProject = projects.find(function (p) { return p.id === currentProjectId; });
        graphicsAccelerationGetCallCount++;
        var effective = (currentProject && projectConfigs[currentProject.path])
          ? deepMerge(config, projectConfigs[currentProject.path])
          : config;
        return withStaleGraphicsAccelerationOverride(effective, graphicsAccelerationGetCallCount);
      },
      getGlobal: async function () {
        graphicsAccelerationGetGlobalCallCount++;
        return withStaleGraphicsAccelerationOverride(config, graphicsAccelerationGetGlobalCallCount);
      },
      set: async function (partial) {
        rejectConfigSetIfConfigured();
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
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'commandTerminalPanel')) {
          config.commandTerminalPanel = partial.commandTerminalPanel;
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
        return configSetResult();
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
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'commandTerminalPanel')) {
          config.commandTerminalPanel = partial.commandTerminalPanel;
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
        rejectConfigSetIfConfigured();
        var currentProject = projects.find(function (p) { return p.id === currentProjectId; });
        if (currentProject) {
          projectConfigs[currentProject.path] = overrides;
        }
        return configSetResult();
      },
      getProjectOverridesByPath: async function (projectPath) {
        return projectConfigs[projectPath] || null;
      },
      setProjectOverridesByPath: async function (projectPath, overrides) {
        rejectConfigSetIfConfigured();
        projectConfigs[projectPath] = overrides;
        return configSetResult();
      },
      syncDefaultToProjects: async function () {
        return 0;
      },
      onChanged: function (callback) {
        mockConfigChangedListeners.push(callback);
        return function () {
          const index = mockConfigChangedListeners.indexOf(callback);
          if (index >= 0) mockConfigChangedListeners.splice(index, 1);
        };
      },
      onWriteFailed: function (callback) {
        // Tests fire this via window.__mockFireConfigWriteFailed(message).
        if (!window.__mockConfigWriteFailedListeners) window.__mockConfigWriteFailedListeners = [];
        window.__mockConfigWriteFailedListeners.push(callback);
        if (!window.__mockFireConfigWriteFailed) {
          window.__mockFireConfigWriteFailed = function (message) {
            var listeners = (window.__mockConfigWriteFailedListeners || []).slice();
            listeners.forEach(function (listener) { listener(message); });
          };
        }
        // A REAL unsubscribe, for the same reason onSpawnBlocked returns one.
        return function () {
          var listeners = window.__mockConfigWriteFailedListeners || [];
          var index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
    },

    leftoverProcesses: {
      onReport: function (callback) {
        // Tests push a report via window.__mockFireLeftoverReport(report).
        if (!window.__mockLeftoverReportListeners) window.__mockLeftoverReportListeners = [];
        window.__mockLeftoverReportListeners.push(callback);
        if (!window.__mockFireLeftoverReport) {
          window.__mockFireLeftoverReport = function (report) {
            var listeners = (window.__mockLeftoverReportListeners || []).slice();
            listeners.forEach(function (listener) { listener(report); });
          };
        }
        return function () {
          var listeners = window.__mockLeftoverReportListeners || [];
          var index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
      // Answers 'stopped' unless a test sets window.__mockLeftoverStopOutcomes =
      // { '<process id>': 'failed' | 'ended' }. Every call is recorded in
      // window.__mockLeftoverStopCalls. A test may hold every answer open by setting
      // window.__mockLeftoverStopGate to a promise, so the row's Stopping state can
      // be observed before it settles; unset (the default, and always in the web
      // demo) the answer comes at once and nothing here awaits.
      stop: async function (processId) {
        if (!window.__mockLeftoverStopCalls) window.__mockLeftoverStopCalls = [];
        window.__mockLeftoverStopCalls.push(processId);
        if (window.__mockLeftoverStopGate) await window.__mockLeftoverStopGate;
        var outcomes = window.__mockLeftoverStopOutcomes || {};
        return outcomes[processId] || 'stopped';
      },
      // Main pushes this only for a Stop it stopped waiting for, so the mock never
      // does on its own. Tests push one via
      // window.__mockFireLeftoverStopSettled({ processId, outcome }).
      onStopSettled: function (callback) {
        if (!window.__mockLeftoverStopSettledListeners) window.__mockLeftoverStopSettledListeners = [];
        window.__mockLeftoverStopSettledListeners.push(callback);
        if (!window.__mockFireLeftoverStopSettled) {
          window.__mockFireLeftoverStopSettled = function (settled) {
            var listeners = (window.__mockLeftoverStopSettledListeners || []).slice();
            listeners.forEach(function (listener) { listener(settled); });
          };
        }
        return function () {
          var listeners = window.__mockLeftoverStopSettledListeners || [];
          var index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
      // The recheck. Nothing has ended unless a test lists ids in
      // window.__mockLeftoverEndedIds; every call's ids are recorded in
      // window.__mockLeftoverCheckCalls, so a test can see what was asked and when.
      // A test may hold every answer open by setting window.__mockLeftoverCheckGate
      // to a promise, so a check can be observed while it is still in flight; the
      // call is recorded BEFORE the wait. Unset (the default, and always in the web
      // demo) the answer comes at once and nothing here awaits.
      check: async function (processIds) {
        if (!window.__mockLeftoverCheckCalls) window.__mockLeftoverCheckCalls = [];
        window.__mockLeftoverCheckCalls.push(processIds.slice());
        if (window.__mockLeftoverCheckGate) await window.__mockLeftoverCheckGate;
        var ended = window.__mockLeftoverEndedIds || [];
        return processIds.filter(function (processId) { return ended.indexOf(processId) !== -1; });
      },
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
      // forceRefresh and projectPath are accepted to match the real API surface but
      // ignored: the mock returns the same fixture for every project, fresh or cached.
      list: async function (_forceRefresh, _projectPath, mainsOwnRead) {
        // Off unless a spec sets window.__mockAgentListRejects = true: every read the
        // renderer makes rejects (a detection that fails), so the config store's agent
        // list stays unloaded. Main's own read (the third argument, passed by
        // mockWorkflowAgentRefusal) is not the renderer's and still answers.
        if (typeof window !== 'undefined' && window.__mockAgentListRejects && !mainsOwnRead) {
          throw new Error('Could not read the agent list');
        }
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
            // KEEP IN SYNC with ClaudeAdapter.answerFromContext: gates the Knowledge
            // Graph's Ask on the capability rather than on the agent's name.
            supportsAnswerFromContext: true,
            // KEEP IN SYNC with ClaudeAdapter.answerCapabilities. `model: true` is
            // what makes the Answering model setting required for Claude, and
            // `defaultEffort` is the level the Answering effort row shows unset.
            answerCapabilities: { streaming: true, search: true, model: true, effort: true, defaultEffort: 'low' },
            // KEEP IN SYNC with each adapter's `kangenticMcp` and canBeWorkflowAgent(adapter)
            // (every entry below carries both; tests/unit/mock-agent-list-parity.test.ts
            // pins them). Claude reaches the MCP server per session and resumes by an
            // id Kangentic chose, so it can be the Workflow agent.
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
            // supportsPlanAutoApproval is stamped from PLAN_APPROVING_AGENTS below.
            // KEEP IN SYNC with ClaudeAdapter.reportsRateLimits: gates the ContextBar
            // rate-limit pill on the agent capability (account-wide snapshot).
            reportsRateLimits: true,
            // KEEP IN SYNC with ClaudeAdapter.pastedImageNativeExtensions: the image
            // extensions Claude attaches natively from a bracketed-paste path, so the
            // renderer pastes the bare quoted path for these.
            pastedImageNativeExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
            // KEEP IN SYNC with ClaudeAdapter.pastedImageReferenceTemplate: the fallback
            // text pasted for an image outside the native set (bmp, svg).
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
            // KEEP IN SYNC with CodexAdapter.permissions in src/main/agent/adapters/codex/codex-adapter.ts
            permissions: [
              { mode: 'plan', label: 'Safe Read-Only Browsing' },
              { mode: 'dontAsk', label: 'Read-Only Non-Interactive (CI)' },
              { mode: 'default', label: 'Automatically Edit, Ask When Needed' },
              { mode: 'acceptEdits', label: 'Auto (Preset)' },
              { mode: 'bypassPermissions', label: 'Dangerous Full Access' },
            ],
            defaultPermission: 'acceptEdits',
            supportsSummarize: true,
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
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
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
          },
          {
            name: 'qwen', displayName: 'Qwen Code', found: false, path: null, version: null,
            // KEEP IN SYNC with QwenAdapter.permissions in src/main/agent/adapters/qwen-code/qwen-adapter.ts
            permissions: [
              { mode: 'plan', label: 'Plan (Read-Only Research)' },
              { mode: 'default', label: 'Default (Confirm Actions)' },
              { mode: 'acceptEdits', label: 'Auto Edit (Auto-Approve Edits)' },
              { mode: 'bypassPermissions', label: 'YOLO (Auto-Approve All)' },
            ],
            defaultPermission: 'acceptEdits',
            supportsSummarize: true,
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
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
            // An interactive session prints no id, so `create-chat` names one before launch.
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
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
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
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
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
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
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
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
            kangenticMcp: 'shared-folder',
            supportsWorkflowAgent: false,
            liveTelemetryUnsupported: {
              unavailableLabel: 'Telemetry: TUI only',
              unavailableTitle:
                'Droid does not stream live telemetry to Kangentic.\n' +
                'Run /cost or /context inside the Droid TUI to see model, tokens, and cost.\n' +
                'Tracked upstream: Factory-AI/factory (see docs/integrations/agents/droid.md).',
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
          {
            name: 'grok', displayName: 'Grok Build', found: false, path: null, version: null,
            // KEEP IN SYNC with GrokAdapter.permissions in src/main/agent/adapters/grok/grok-adapter.ts
            permissions: [
              { mode: 'plan', label: 'Plan Mode (read-only)' },
              { mode: 'default', label: 'Default (ask for approval)' },
              { mode: 'acceptEdits', label: 'Accept Edits' },
              { mode: 'auto', label: 'Auto (model decides when to ask)' },
              { mode: 'dontAsk', label: 'Never Ask (auto-deny)' },
              { mode: 'bypassPermissions', label: 'Dangerous Full Access' },
            ],
            defaultPermission: 'acceptEdits',
            supportsSummarize: true,
            kangenticMcp: 'per-session',
            supportsWorkflowAgent: true,
            // KEEP IN SYNC with GrokAdapter.answerFromContext / answerCapabilities:
            // a second answering agent with its own effort levels, so a spec can
            // switch agents by marking it found.
            supportsAnswerFromContext: true,
            answerCapabilities: { streaming: false, search: false, model: true, effort: true, defaultEffort: 'low' },
          },
          {
            name: 'antigravity', displayName: 'Antigravity CLI', found: false, path: null, version: null,
            supportsSummarize: true,
            kangenticMcp: 'shared-folder',
            supportsWorkflowAgent: false,
            // KEEP IN SYNC with AntigravityAdapter.permissions and AntigravityAdapter.liveTelemetryUnsupported
            // in src/main/agent/adapters/antigravity/antigravity-adapter.ts
            permissions: [
              { mode: 'plan', label: 'Plan (Read-Only Research)' },
              { mode: 'default', label: 'Default (Request Review)' },
              { mode: 'acceptEdits', label: 'Accept Edits (Auto-Approve Edits)' },
              { mode: 'bypassPermissions', label: 'Skip Permissions (Auto-Approve All)' },
            ],
            defaultPermission: 'acceptEdits',
            liveTelemetryUnsupported: {
              unavailableLabel: 'Telemetry: TUI only',
              unavailableTitle:
                'Antigravity does not stream live telemetry to Kangentic.\n' +
                'The agy TUI footer shows the active model and effort; per-thought\n' +
                'token counts appear inline in its output.',
            },
          },
          {
            name: 'goose', displayName: 'Goose CLI', found: false, path: null, version: null,
            // KEEP IN SYNC with GooseAdapter.permissions in src/main/agent/adapters/goose/goose-adapter.ts
            permissions: [
              { mode: 'plan', label: 'Plan (Chat Only, No File Access)' },
              { mode: 'default', label: 'Default (Smart Approve)' },
              { mode: 'bypassPermissions', label: 'Auto (Skip All Approvals)' },
            ],
            defaultPermission: 'default',
          },
        ];
        return defaults.map(function (agent) {
          var override = overrides[agent.name];
          // What lets a plan column's Plan approval offer Automatic for the agent.
          var withPlanApproval = PLAN_APPROVING_AGENTS.indexOf(agent.name) !== -1
            ? Object.assign({}, agent, { supportsPlanAutoApproval: true })
            : agent;
          return override ? Object.assign({}, withPlanApproval, override) : withPlanApproval;
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
      // Records rather than discarding, like the other fire-and-forget mocks, so a
      // UI test can assert what a boundary actually reported.
      // context carries { boundary, panel? }.
      trackRendererError: function (message, context) {
        window.__mockTrackRendererErrorCalls = window.__mockTrackRendererErrorCalls || [];
        window.__mockTrackRendererErrorCalls.push({ message: message, context: context });
      },
      trackFeatureUsed: function (feature) {
        window.__mockTrackFeatureUsedCalls = window.__mockTrackFeatureUsedCalls || [];
        window.__mockTrackFeatureUsedCalls.push(feature);
      },
      // Sentry never initializes under the UI harness.
      errorReportingEnabled: false,
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
      // `projectId` lists another project's branches, as main's git:listBranches
      // does: seed them per project with window.__mockGitBranchesByProject =
      // { [projectId]: string[] }. Every other read gets the one fixed list.
      listBranches: async function (projectId) {
        var byProject = window.__mockGitBranchesByProject || {};
        if (projectId && byProject[projectId]) return byProject[projectId].slice();
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
      // Image bytes for the Changes panel's image view, mirroring
      // DiffService.getImageContent. A fixture entry carries the bytes as
      // `originalImageBase64` / `modifiedImageBase64`; an SVG entry with no
      // base64 is read from its `original` / `modified` text, UTF-8 encoded,
      // as main reads the file. `originalImageSize` / `modifiedImageSize`
      // override the reported size, and a size over the 10 MB preview cap
      // reports 'too-large' with no bytes, as main does. A side with neither
      // reads 'unreadable', and bytes that start with the Git LFS pointer
      // header read 'lfs-pointer'. Added/Untracked have no original side and
      // Deleted has no modified side.
      //
      // Each side's fingerprint is derived from its bytes, so a side whose
      // fixture bytes were swapped reads as changed, and a side matching the
      // request's `knownFingerprints` answers 'unchanged' with no bytes, as
      // main does. Test hooks: every call is recorded in
      // window.__mockGitFileImageCalls ({ filePath, knownFingerprints, result },
      // each result side reduced to its kind and fingerprint),
      // window.__mockGitFileImageDeferred = true holds the next call until
      // window.__mockGitFileImageResolve() is called, and every call for a
      // path listed in window.__mockGitFileImageRejectPaths rejects, as the IPC
      // call does when main throws (a worktree removed under the panel). The
      // reject is keyed by path and lasts until the list is cleared, not one
      // call: a selection can read a file twice, and with a one-shot reject
      // whichever read landed last decided what showed. A rejected call is
      // recorded too, with `rejected: true` and no sides.
      fileImage: async function (request) {
        var rejectPaths = typeof window !== 'undefined' ? window.__mockGitFileImageRejectPaths : null;
        if (Array.isArray(rejectPaths) && rejectPaths.indexOf(request && request.filePath) !== -1) {
          window.__mockGitFileImageCalls = window.__mockGitFileImageCalls || [];
          window.__mockGitFileImageCalls.push({
            filePath: request.filePath,
            knownFingerprints: request.knownFingerprints,
            rejected: true,
            result: { original: null, modified: null },
          });
          throw new Error('Mock fileImage failure');
        }
        if (typeof window !== 'undefined' && window.__mockGitFileImageDeferred) {
          window.__mockGitFileImageDeferred = false;
          var resolveImageRef;
          var pendingImage = new Promise(function (resolve) { resolveImageRef = resolve; });
          window.__mockGitFileImageResolve = resolveImageRef;
          await pendingImage;
        }
        var IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
        var LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/';
        var status = (request && request.status) || 'M';
        var filePath = (request && request.filePath) || '';
        var knownFingerprints = (request && request.knownFingerprints) || {};
        var fixture = resolveGitDiffFixture(request);
        var match = fixture && Array.isArray(fixture.files)
          ? fixture.files.find(function (entry) { return entry.path === filePath; })
          : null;
        function bytesOf(base64, svgText) {
          if (base64) {
            var binary = atob(base64);
            var decoded = new Uint8Array(binary.length);
            for (var byteIndex = 0; byteIndex < binary.length; byteIndex++) decoded[byteIndex] = binary.charCodeAt(byteIndex);
            return decoded;
          }
          if (typeof svgText === 'string' && /\.svg$/i.test(filePath)) return new TextEncoder().encode(svgText);
          return null;
        }
        function fingerprintOf(bytes) {
          var hash = 5381;
          for (var hashIndex = 0; hashIndex < bytes.length; hashIndex++) hash = ((hash * 33) ^ bytes[hashIndex]) >>> 0;
          return 'mock:' + bytes.length + ':' + hash.toString(16);
        }
        function readSide(base64, svgText, sizeOverride, knownFingerprint) {
          if (typeof sizeOverride === 'number' && sizeOverride > IMAGE_PREVIEW_MAX_BYTES) {
            var tooLargeFingerprint = 'mock-size:' + sizeOverride;
            if (tooLargeFingerprint === knownFingerprint) return { kind: 'unchanged', fingerprint: tooLargeFingerprint };
            return { kind: 'too-large', size: sizeOverride, fingerprint: tooLargeFingerprint };
          }
          var bytes = bytesOf(base64, svgText);
          if (bytes === null) return { kind: 'unreadable' };
          var fingerprint = fingerprintOf(bytes);
          if (fingerprint === knownFingerprint) return { kind: 'unchanged', fingerprint: fingerprint };
          var head = String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, 0, LFS_POINTER_PREFIX.length));
          if (bytes.length <= 1024 && head === LFS_POINTER_PREFIX) {
            return { kind: 'lfs-pointer', size: bytes.length, fingerprint: fingerprint };
          }
          return { kind: 'bytes', size: typeof sizeOverride === 'number' ? sizeOverride : bytes.length, bytes: bytes, fingerprint: fingerprint };
        }
        var needsOriginal = status !== 'A' && status !== 'U';
        var needsModified = status !== 'D';
        var result = {
          original: needsOriginal
            ? readSide(match && match.originalImageBase64, match && match.original, match && match.originalImageSize, knownFingerprints.original)
            : null,
          modified: needsModified
            ? readSide(match && match.modifiedImageBase64, match && match.modified, match && match.modifiedImageSize, knownFingerprints.modified)
            : null,
        };
        if (typeof window !== 'undefined') {
          // Kinds and fingerprints only: the log outlives the call, and this
          // mock is also the web demo's bridge, so it must not hold every image.
          var summarize = function (side) { return side === null ? null : { kind: side.kind, fingerprint: side.fingerprint }; };
          window.__mockGitFileImageCalls = window.__mockGitFileImageCalls || [];
          window.__mockGitFileImageCalls.push({
            filePath: filePath,
            knownFingerprints: request && request.knownFingerprints,
            result: { original: summarize(result.original), modified: summarize(result.modified) },
          });
        }
        return result;
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
      prefetchRemotes: async function (checkPath) {
        // Test hook: record every prefetch so drag-prefetch-remotes.spec.ts can
        // assert the board warms the fetch for a worktree-backed card at drag
        // start and never for a card without a worktree.
        if (typeof window !== 'undefined') {
          window.__mockPrefetchRemotesCalls = window.__mockPrefetchRemotesCalls || [];
          window.__mockPrefetchRemotesCalls.push(checkPath);
          // Test hook: force this call to reject, so a test can pin that the
          // fire-and-forget `.catch(() => {})` in handleDragStart is load-bearing
          // and a rejecting prefetch cannot break the drag. Default off (falsy)
          // so no existing spec's behavior changes. Set
          // window.__mockPrefetchRemotesShouldReject = true before the drag.
          if (window.__mockPrefetchRemotesShouldReject) {
            throw new Error('mock prefetchRemotes rejection');
          }
        }
      },
      branchSummary: async function (request) {
        // Test hook: record every branchSummary call (worktreePath, projectPath,
        // baseBranch, refreshRemote) so a test can assert how the mount-only
        // remote-refresh opt-in (ChangesPanel's refreshBranchSummaryFromRemote)
        // differs from the flagless fs.watch refetch (fetchBranchSummary) -
        // used by changes-panel-remote-refresh.spec.ts. Mirrors the diffFiles
        // call log above.
        if (typeof window !== 'undefined') {
          window.__mockBranchSummaryCalls = window.__mockBranchSummaryCalls || [];
          window.__mockBranchSummaryCalls.push({
            worktreePath: (request && request.worktreePath) || null,
            projectPath: (request && request.projectPath) || null,
            baseBranch: (request && request.baseBranch) || null,
            refreshRemote: Boolean(request && request.refreshRemote),
          });
        }
        // Test hook: override the header context (branch name, ahead/behind, last commit).
        if (typeof window !== 'undefined' && window.__mockBranchSummary) {
          return window.__mockBranchSummary;
        }
        // Per-worktree summaries, as the sample install seeds them (one per task with a
        // worktree), keyed by worktree folder name.
        var summaryForWorktree = typeof window !== 'undefined'
          ? resolveByWorktree(window.__mockBranchSummaryByWorktree, (request && request.worktreePath) || '')
          : null;
        if (summaryForWorktree) return summaryForWorktree;
        return { currentBranch: null, ahead: 0, behind: 0, lastCommit: null };
      },
      worktreeHead: async function () {
        // Test hook: window.__mockWorktreeHead = { branch, sha } drives the
        // Command Terminal's branch-pill re-derive. Both null means "unknown",
        // which the renderer treats as keep-what-we-have, so a spec that never
        // sets it sees the spawn-time branch exactly as before.
        if (typeof window !== 'undefined' && window.__mockWorktreeHead) {
          return window.__mockWorktreeHead;
        }
        return { branch: null, sha: null };
      },
      commitGraph: async function (request) {
        // Test hook: seed the commit-graph pane via window.__mockCommitGraph =
        // { commits: [{ hash, shortHash, parents, authorName, authorTimestamp, subject }],
        //   tipHash, baseHash, mergeBaseHash, currentBranch, truncated }.
        if (typeof window !== 'undefined' && window.__mockCommitGraph) {
          return window.__mockCommitGraph;
        }
        // Per-worktree graphs (window.__mockCommitGraphByWorktree, keyed by worktree folder), as
        // the sample install seeds a scaffolded project's real history.
        var graphForWorktree = typeof window !== 'undefined'
          ? resolveByWorktree(window.__mockCommitGraphByWorktree, (request && request.worktreePath) || '')
          : null;
        if (graphForWorktree) return graphForWorktree;
        return { commits: [], tipHash: null, baseHash: null, mergeBaseHash: null, currentBranch: null, truncated: false };
      },
      taskChanges: async function (input) {
        // What a completed task changed (git:taskChanges). Test hook: seed per task via
        // window.__mockTaskChanges = { '<taskId>': { range, commits, files, totals, ... } };
        // any field left out takes the default below. Every call is recorded in
        // window.__mockTaskChangesCalls. Unseeded, a task has no commits, which is what
        // main answers for a task whose work it cannot find.
        var taskId = input && input.taskId;
        if (typeof window !== 'undefined') {
          window.__mockTaskChangesCalls = window.__mockTaskChangesCalls || [];
          window.__mockTaskChangesCalls.push({ projectId: input && input.projectId, taskId: taskId });
        }
        var seeded = (typeof window !== 'undefined' && window.__mockTaskChanges && window.__mockTaskChanges[taskId]) || null;
        if (seeded && seeded.reject) throw new Error(seeded.reject);
        var project = projects.find(function (candidate) { return candidate.id === (input && input.projectId); });
        return Object.assign({
          range: null,
          commits: [],
          truncated: false,
          files: [],
          totals: null,
          emptyReason: seeded ? null : 'no-commits',
          branchName: null,
          baseBranch: 'main',
          projectPath: project ? project.path : '/mock/project',
          webProviderName: null,
        }, seeded || {});
      },
      fileHistory: async function (request) {
        // Test hook: seed the file-history popover via window.__mockFileHistory =
        // { commits: [{ hash, shortHash, authorName, authorTimestamp, subject }] }.
        if (typeof window !== 'undefined' && window.__mockFileHistory) {
          return window.__mockFileHistory;
        }
        // Per-worktree, per-file (window.__mockFileHistoryByWorktree[folder][filePath]).
        var historyForWorktree = typeof window !== 'undefined'
          ? resolveByWorktree(window.__mockFileHistoryByWorktree, (request && request.worktreePath) || '')
          : null;
        var filePath = (request && request.filePath) || '';
        if (historyForWorktree && historyForWorktree[filePath]) return historyForWorktree[filePath];
        return { commits: [] };
      },
      blame: async function (request) {
        // Test hook: seed the blame gutter via window.__mockBlame =
        // { lines: [{ line, hash, shortHash, author, date }] }.
        if (typeof window !== 'undefined' && window.__mockBlame) {
          return window.__mockBlame;
        }
        // Per-worktree, per-file (window.__mockBlameByWorktree[folder][filePath]), the blame of
        // the working tree a recorded session left behind.
        var blameForWorktree = typeof window !== 'undefined'
          ? resolveByWorktree(window.__mockBlameByWorktree, (request && request.worktreePath) || '')
          : null;
        var blamePath = (request && request.filePath) || '';
        if (blameForWorktree && blameForWorktree[blamePath]) return blameForWorktree[blamePath];
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
            worktree_skip_reason: null,
            branch_name: null,
            pushed_branch: null,
            pr_number: null,
            pr_url: null,
            pr_state: null,
            pr_merge_readiness: null,
            external_id: item.external_id || null,
            external_source: item.external_source || null,
            external_url: item.external_url || null,
            base_branch: null,
            resolved_base_branch: null,
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
      // The mock holds one task list, so the project id the desktop routes by
      // (the Agent Monitor names a task's own project) does not pick a list. It is
      // recorded, in call order, to window.__mockDemoteCalls as
      // { taskId, projectId } (`undefined` normalized to null, as tasks.move does
      // with __mockMoveProjectIds), so a spec can assert which project a demote was
      // stamped for and that a cancelled confirm made no call at all.
      demote: async function (input, projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockDemoteCalls) window.__mockDemoteCalls = [];
          window.__mockDemoteCalls.push({
            taskId: input.taskId,
            projectId: projectId === undefined ? null : projectId,
          });
        }
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
      importGetCached: async function (input) {
        // Instant, no-network cache read. Tests seed window.__mockImportCached with
        // { issues: [...] } (or an array), and can read window.__mockImportGetCachedCallCount
        // / window.__mockImportGetCachedLastArgs.
        if (typeof window !== 'undefined') {
          window.__mockImportGetCachedCallCount = (window.__mockImportGetCachedCallCount || 0) + 1;
          window.__mockImportGetCachedLastArgs = input;
        }
        // Forced failure, so a test can prove a cache-read error is non-fatal and the
        // reconcile still populates the dialog.
        if (typeof window !== 'undefined' && window.__mockImportGetCachedFailUntilCleared) {
          throw new Error('Mock import cache read failure');
        }
        var cached = (typeof window !== 'undefined' && window.__mockImportCached) || null;
        if (Array.isArray(cached)) return { issues: cached };
        if (cached && Array.isArray(cached.issues)) return { issues: cached.issues };
        return { issues: [] };
      },
      importReconcile: async function (input) {
        // Background reconcile. Tests read window.__mockImportReconcileCallCount /
        // window.__mockImportReconcileLastArgs and seed window.__mockImportReconcile
        // with { issues, added, updated, removed }.
        if (typeof window !== 'undefined') {
          window.__mockImportReconcileCallCount = (window.__mockImportReconcileCallCount || 0) + 1;
          window.__mockImportReconcileLastArgs = input;
          if (!window.__mockImportReconcileCallLog) window.__mockImportReconcileCallLog = [];
          window.__mockImportReconcileCallLog.push({ mode: input && input.mode });
        }
        // Persistent forced failure (StrictMode double-invoke safe, mirrors the old
        // import-fetch flag): every call rejects until a test clears it.
        if (typeof window !== 'undefined' && window.__mockImportReconcileFailUntilCleared) {
          throw new Error('Mock import reconcile failure');
        }
        // Optional delay so a test can observe the cached paint before the reconcile
        // resolves, and assert the fetchSequenceRef supersession.
        var delayMs = (typeof window !== 'undefined' && window.__mockImportReconcileDelayMs) || 0;
        if (delayMs > 0) {
          await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
        }
        var byMode = (typeof window !== 'undefined' && window.__mockImportReconcileByMode) || null;
        if (byMode) {
          var modeKey = (input && input.mode) || 'incremental';
          if (byMode[modeKey]) return byMode[modeKey];
        }
        var preset = (typeof window !== 'undefined' && window.__mockImportReconcile) || null;
        if (preset) {
          if (Array.isArray(preset)) return { issues: preset, added: 0, updated: 0, removed: 0 };
          return {
            // Pass `issues` through verbatim (including a malformed null) so a test
            // can exercise the dialog's error path.
            issues: ('issues' in preset) ? preset.issues : [],
            added: preset.added || 0,
            updated: preset.updated || 0,
            removed: preset.removed || 0,
          };
        }
        return { issues: [], added: 0, updated: 0, removed: 0 };
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
    //     the full every-verb grant and fires that push directly, exactly as
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
      var terminalStreamsListeners = [];
      var mockDeviceCounter = 0;

      // Mirrors packages/protocol/src/capabilities/verbs.ts's CAPABILITY_VERBS -
      // pairing grants every verb, not a read-only subset. Hand-mirrored, so a
      // new verb is appended here too; tests/unit/mobile-capability-verbs-parity.test.ts
      // reads this literal as text and fails when it drifts from the protocol.
      var FULL_CAPABILITY_SET = [
        'read-stream', 'read-board', 'read-diff', 'send-user-message', 'move-task',
        'answer-permission-prompt', 'interactive-terminal', 'board-tool-read',
        'board-tool-write', 'register-push', 'start-session', 'pause-session',
        'command-terminal',
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
        // Drives the panel-suspension sync (useMobileTerminalStreamsSync):
        // the sessions a phone streams the TERMINAL of, whose bottom-panel
        // tab is dropped. Also seeds getTerminalStreams below, matching
        // production where the push and the invoke read the same registry.
        window.__mockFireMobileTerminalStreamsChanged = function (sessionIds) {
          window.__mockMobileTerminalStreams = sessionIds;
          terminalStreamsListeners.forEach(function (listener) { listener(sessionIds); });
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
            connectionStateSince: new Date().toISOString(),
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
        // The default deliberately reports NEITHER a version nor a latency, so
        // it exercises the bare-verdict path a relay that answers /healthz with
        // {"status":"ok"} produces; a test wanting the fuller pill supplies both
        // through __mockTestRelay.
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
        getTerminalStreams: async function () {
          return (typeof window !== 'undefined' && window.__mockMobileTerminalStreams) || [];
        },
        onTerminalStreamsChanged: function (callback) {
          terminalStreamsListeners.push(callback);
          return function () {
            var index = terminalStreamsListeners.indexOf(callback);
            if (index >= 0) terminalStreamsListeners.splice(index, 1);
          };
        },
      };
    })(),

    boardConfig: {
      exists: async function () { return false; },
      export: async function () {},
      apply: async function (/* projectId */) { return []; },
      onChanged: function (callback) {
        // The push main sends when kangentic.json changes on disk. A demo scene
        // seeds the projectId through `window.__mockBoardConfigChanged` and this
        // fires it once, on the first registration, so the app raises its own
        // reconciliation dialog rather than the demo drawing one. Same shape as
        // the seeded activity push in sessions.onActivity above.
        if (window.__mockBoardConfigChanged && !window.__mockBoardConfigChangedFired) {
          window.__mockBoardConfigChangedFired = true;
          var projectId = window.__mockBoardConfigChanged;
          window.setTimeout(function () { callback(projectId); }, 0);
        }
        return noop;
      },
      // The project-open reconcile's warnings. The mock has no kangentic.json,
      // so nothing ever pushes. A spec seeds `window.__mockLastConfigWarnings`
      // (an array) and the renderer's fetch on a project becoming current reads
      // it, which is the path a launch restore takes.
      onWarnings: function (/* callback(projectId, warnings) */) { return noop; },
      getLastWarnings: async function (/* projectId */) {
        return Array.isArray(window.__mockLastConfigWarnings) ? window.__mockLastConfigWarnings.slice() : [];
      },
      onShortcutsChanged: function (/* callback(projectId) */) { return noop; },
      // `projectId` reads another project's board, as main's
      // boardConfig:getBoardProfiles does: seed it with
      // window.__mockBoardProfilesByProject = { [projectId]: BoardProfile[] }.
      // An unseeded other board has none.
      getBoardProfiles: async function (projectId) {
        if (projectId && projectId !== currentProjectId) {
          var byProject = window.__mockBoardProfilesByProject || {};
          return JSON.parse(JSON.stringify(byProject[projectId] || []));
        }
        return mockBoardProfiles;
      },
      // window.__mockBoardProfilesSaveError makes the write reject, for a spec
      // covering the failure path. It throws BEFORE assigning, deliberately:
      // board-store's catch reloads via getBoardProfiles() before it toasts, so
      // the last good array has to survive or the spec fails on a second,
      // different error instead of the one under test.
      setBoardProfiles: async function (profiles) {
        if (window.__mockBoardProfilesSaveError) {
          throw new Error(String(window.__mockBoardProfilesSaveError));
        }
        mockBoardProfiles = profiles;
      },
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
      onUpdateBlocked: function (callback) {
        // Fired via `window.__mockFireUpdateBlocked('<sentence>')`; the
        // listener array and the fire hook are installed eagerly at
        // mock-bootstrap time (see top of file), not lazily here.
        window.__mockUpdateBlockedListeners.push(callback);
        return function () {
          var listeners = window.__mockUpdateBlockedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    },

    hostMemory: {
      onPressure: function (callback) {
        window.__mockHostMemoryPressureListeners.push(callback);
        return function () {
          var listeners = window.__mockHostMemoryPressureListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onRecovery: function (callback) {
        window.__mockHostMemoryRecoveryListeners.push(callback);
        return function () {
          var listeners = window.__mockHostMemoryRecoveryListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
      onAgentPaused: function (callback) {
        window.__mockHostMemoryAgentPausedListeners.push(callback);
        return function () {
          var listeners = window.__mockHostMemoryAgentPausedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    },

    // noticePending is consumed on read, like the real handler, so a spec
    // asserting the toast fires exactly once gets main's real behaviour.
    // Arm with window.__mockGpuNoticePending / __mockGpuSoftwareRendering
    // before load.
    gpuHealth: {
      readStatus: function () {
        // Test hook: simulate the invoke itself rejecting (a stale preload, a
        // handler throw). Set window.__mockGpuHealthReadStatusRejects = true
        // before load. App.tsx guards this call with .catch, so the only
        // observable effect should be "no toast, otherwise a normal boot".
        if (window.__mockGpuHealthReadStatusRejects === true) {
          return Promise.reject(new Error('mock gpuHealth.readStatus rejection'));
        }
        var noticePending = window.__mockGpuNoticePending === true;
        window.__mockGpuNoticePending = false;
        return Promise.resolve({
          softwareRendering: window.__mockGpuSoftwareRendering === true,
          noticePending: noticePending,
        });
      },
      // The real handler saves the setting and restarts the app. The mock
      // cannot restart, so it records the request in
      // window.__mockGraphicsRestartRequests (a spec asserts on it) and applies
      // the same config write, which is what the relaunched app would read.
      // Set window.__mockGraphicsRestartRejects = true to simulate the restart
      // failing.
      setAccelerationAndRestart: function (enabled) {
        if (window.__mockGraphicsRestartRejects === true) {
          return Promise.reject(new Error('mock gpuHealth.setAccelerationAndRestart rejection'));
        }
        if (!Array.isArray(window.__mockGraphicsRestartRequests)) window.__mockGraphicsRestartRequests = [];
        window.__mockGraphicsRestartRequests.push(enabled);
        config = deepMerge(config, {
          graphicsAccelerationEnabled: enabled,
          graphicsAccelerationOffBy: enabled ? null : 'user',
        });
        // Test hook: hold this call pending instead of resolving it, so a spec
        // can drive a second confirm (a second click, a second Enter) while
        // the first is still in flight, the way restartInFlightRef's guard is
        // meant to be exercised. Set window.__mockGraphicsRestartHold = true
        // before the confirm; the promise resolves once the spec calls the
        // function this stashes on window.__mockGraphicsRestartHoldRelease.
        // Default behaviour (hold unset) is unchanged: resolves immediately.
        if (window.__mockGraphicsRestartHold === true) {
          return new Promise(function (resolve) {
            window.__mockGraphicsRestartHoldRelease = resolve;
          });
        }
        return Promise.resolve();
      },
    },

    // Display language. The real bridge reads the boot locale off the window's
    // command line; the mock reads the config's displayLanguage, which is what
    // main would have started in. getInfo mirrors readLanguageInfo: the shipped
    // list is DEFAULT_SHIPPED_LOCALES unless a spec seeds
    // window.__mockShippedLocales, and the suggestion is
    // window.__mockLanguageSuggestion while the config has not answered it, and
    // counts each call in window.__mockLanguageGetInfoCalls so a spec can tell a
    // component that asked main from one that never did.
    language: {
      getBootLocale: function () {
        return typeof config.displayLanguage === 'string' ? config.displayLanguage : 'en';
      },
      getInfo: async function () {
        window.__mockLanguageGetInfoCalls = (window.__mockLanguageGetInfoCalls || 0) + 1;
        var shippedLocales = (Array.isArray(window.__mockShippedLocales) ? window.__mockShippedLocales : DEFAULT_SHIPPED_LOCALES).slice();
        var suggestion = config.hasAnsweredLanguageSuggestion === true
          ? null
          : (window.__mockLanguageSuggestion || null);
        return {
          locale: typeof config.displayLanguage === 'string' ? config.displayLanguage : 'en',
          shippedLocales: shippedLocales,
          suggestion: suggestion,
        };
      },
      // The real handler saves and restarts. The mock records the request in
      // window.__mockLanguageRestartRequests and applies the same config write.
      // Like saveLanguageForRestart, it rejects a language that does not ship.
      // Set window.__mockLanguageRestartRejects = true to simulate a failed save.
      // Test hook: set window.__mockLanguageRestartHold = true to hold each call
      // pending after it is recorded, so a spec can drive a second confirm (a
      // second Enter, a second click) while the first is still in flight, the way
      // useLanguageRestart's restartInFlightRef guard is meant to be exercised,
      // as __mockGraphicsRestartHold does for the Graphics restart. Calling
      // window.__mockLanguageRestartHoldRelease() resolves every held call. With
      // the hold unset the call resolves immediately.
      setLanguageAndRestart: function (locale) {
        var shipped = Array.isArray(window.__mockShippedLocales) ? window.__mockShippedLocales : DEFAULT_SHIPPED_LOCALES;
        if (shipped.indexOf(locale) === -1) {
          return Promise.reject(new Error('mock language.setLanguageAndRestart: ' + locale + ' does not ship'));
        }
        if (window.__mockLanguageRestartRejects === true) {
          return Promise.reject(new Error('mock language.setLanguageAndRestart rejection'));
        }
        if (!Array.isArray(window.__mockLanguageRestartRequests)) window.__mockLanguageRestartRequests = [];
        window.__mockLanguageRestartRequests.push(locale);
        config = deepMerge(config, { displayLanguage: locale, hasAnsweredLanguageSuggestion: true });
        if (window.__mockLanguageRestartHold === true) {
          return new Promise(function (resolve) {
            if (!Array.isArray(window.__mockLanguageRestartHeld)) window.__mockLanguageRestartHeld = [];
            window.__mockLanguageRestartHeld.push(resolve);
            window.__mockLanguageRestartHoldRelease = function () {
              var held = window.__mockLanguageRestartHeld;
              window.__mockLanguageRestartHeld = [];
              held.forEach(function (release) { release(); });
            };
          });
        }
        return Promise.resolve();
      },
    },

    announcements: {
      getActive: async function () {
        return window.__mockActiveAnnouncements || [];
      },
      getHistory: async function () {
        return window.__mockAnnouncementHistory || [];
      },
      markRead: async function (announcementId) {
        window.__mockAnnouncementMarkReadCalls.push(announcementId);
        // Stamp the backing array too, not just the store's optimistic copy,
        // so a later getHistory() (HMR resync) agrees with the badge.
        window.__mockAnnouncementHistory = (window.__mockAnnouncementHistory || []).map(
          function (entry) {
            if (entry.announcement.id !== announcementId || entry.readAt !== null) return entry;
            return {
              announcement: entry.announcement,
              firstSeenAt: entry.firstSeenAt,
              readAt: new Date().toISOString(),
            };
          },
        );
      },
      onChanged: function (callback) {
        // Tests fire the changed push via
        // `window.__mockFireAnnouncementsChanged([announcement, ...])`, which
        // delivers `{ active, history }`. The listener array and the fire hook
        // itself are installed eagerly at mock-bootstrap time (see top of
        // file), not lazily here.
        window.__mockAnnouncementsChangedListeners.push(callback);
        return function () {
          var listeners = window.__mockAnnouncementsChangedListeners || [];
          var idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    },

    mcpServer: {
      checkConnection: async function (options) {
        window.__mockMcpConnectionCalls.push(options || {});
        var answer = window.__mockMcpConnection;
        return typeof answer === 'function' ? answer(options || {}) : answer;
      },
      onConnectionFailed: function (callback) {
        window.__mockMcpConnectionFailedListeners.push(callback);
        return function () {
          var listeners = window.__mockMcpConnectionFailedListeners || [];
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
      minimize: function () { windowControlCalls.push('minimize'); },
      maximize: function () { windowControlCalls.push('maximize'); },
      close: function () { windowControlCalls.push('close'); },
      flashFrame: noop,
      isFocused: function () { return Promise.resolve(true); },
      // No compositor to read in a browser: a swap drag floats its stand-in
      // card instead. Tests can hand back a picture via window.__mockCaptureRegion.
      captureRegion: function () { return Promise.resolve(window.__mockCaptureRegion || null); },
    },

    popOut: {
      // Resolves the seedable boolean (window.__mockPopOut.setOpenResult): false
      // simulates the main-side maxInstances cap refusing the open.
      open: function (kind, params) { popOutCalls.push({ type: 'open', kind: kind, params: params }); return Promise.resolve(popOutOpenResult); },
      close: function (kind, params) { popOutCalls.push({ type: 'close', kind: kind, params: params }); return Promise.resolve(); },
      focus: function (kind, params) { popOutCalls.push({ type: 'focus', kind: kind, params: params }); return Promise.resolve(); },
      isOpen: function (kind, params) { return Promise.resolve(popOutOpenKeys.indexOf(popOutKeyOf(kind, params)) !== -1); },
      // Resolves the same set __mockFirePopOutChanged last pushed, so App.tsx's
      // mount-time loadOpen() (and its HMR re-sync) cannot land late and clobber
      // a simulated open set.
      listOpen: function () { return Promise.resolve(popOutOpenKeys.slice()); },
      onChanged: function (callback) {
        popOutChangedSubscribers.push(callback);
        return function () {
          var index = popOutChangedSubscribers.indexOf(callback);
          if (index !== -1) popOutChangedSubscribers.splice(index, 1);
        };
      },
      descriptor: null,
    },

    // Workflows. In-memory, on each task's own board's swimlanes (boardLanes:
    // a UI spec's untagged set, or one project's tagged set). Seed from a spec
    // (read lazily on the first call, like __mockAutomations):
    //   window.__mockWorkflows = [ { workflow: <Workflow row>, projectId?: 'p1' } ]
    //   window.__mockWorkflowLinks = [ { workflow_id, blocker_task_id, blocked_task_id, blocker_project_id? } ]
    // A link whose blocker is not a task here reads as main's linkEndState reads
    // it: held (named 'a task') when window.__mockUnreadableProjects lists its
    // blocker_project_id, else gone (left out, as the engine drops it).
    // A started workflow's tasks are ordinary task fixtures carrying workflow_id.
    // The engine does not run here: Start creates the tasks in To Do and stops.
    // window.__mockFireWorkflowChanged({ projectId, workflowId }) pushes a change.
    // window.__mockHoldNextWorkflowGet = true holds the next get() until
    // window.__mockReleaseWorkflowGet() runs; window.__mockWorkflowSetPositionsRejectOnce
    // = 'message' makes the next setPositions() throw before it writes anything.
    workflows: (function () {
      var entries = [];
      var links = [];
      var hydrated = false;
      var listeners = [];
      // The session each workflow's agent started over in, by workflow id, as
      // main's workflow-agent.ts keeps it. Set by __mockWorkflowAgentStartOver.
      var startedOverSessions = {};

      function fireMockWorkflowAgentStatus(session) {
        if (window.__mockFireStatus) window.__mockFireStatus(session.id, JSON.parse(JSON.stringify(session)));
      }

      function makeMockWorkflowAgentSession(projectId, workflowId) {
        return {
          id: crypto.randomUUID(),
          taskId: workflowId,
          projectId: projectId,
          pid: null,
          status: 'running',
          shell: '/bin/bash',
          cwd: '/mock/project',
          startedAt: new Date().toISOString(),
          exitCode: null,
          resuming: false,
          transient: true,
          workflowId: workflowId,
          commandTerminalSlot: null,
          commandTerminalBranch: null,
          commandTerminalLabel: null,
          isolatedSwimlaneId: null,
          agentSessionId: crypto.randomUUID(),
        };
      }

      // Mirrors main's checks before a start, over the mock's own agent list:
      // `workflowAgentSetupGap` (src/shared/workflow-agent-choice.ts), so no start
      // until Settings > Workflows names an agent that can be a workflow's agent,
      // with a model when its CLI takes one; then the CLI's detection, which main
      // reports as unavailable when it is not installed. Null when a start may run.
      async function mockWorkflowAgentRefusal() {
        var choice = (config && config.workflows) || {};
        var setupNeeded = { session: null, unavailable: null, setupNeeded: true, startsOnRequest: false };
        if (!choice.agent) return setupNeeded;
        var agents = await window.electronAPI.agents.list(false, undefined, true);
        var candidate = agents.find(function (entry) { return entry.name === choice.agent; });
        if (!candidate || !candidate.supportsWorkflowAgent) return setupNeeded;
        var takesModel = Boolean(candidate.capabilities && candidate.capabilities.supportsModelOverride);
        if (takesModel && !choice.model) return setupNeeded;
        if (!candidate.found) {
          return { session: null, unavailable: 'Kangentic cannot find ' + (candidate.displayName || candidate.name) + ' on this machine.', setupNeeded: false, startsOnRequest: false };
        }
        return null;
      }

      function findMockWorkflowAgent(workflowId) {
        return sessions.find(function (candidate) { return candidate.workflowId === workflowId && candidate.status !== 'exited'; });
      }

      async function openMockWorkflowAgent(projectId, workflowId, resume) {
        if (window.__mockWorkflowAgentUnavailable) {
          return { session: null, unavailable: String(window.__mockWorkflowAgentUnavailable), setupNeeded: false, startsOnRequest: false };
        }
        var before = findMockWorkflowAgent(workflowId);
        // As main does before any start: a live agent comes back as it is, and
        // an open leaves a paused one paused. A Resume or a new start needs the setting.
        if (before && (before.status !== 'suspended' || !resume)) {
          return { session: JSON.parse(JSON.stringify(before)), unavailable: null, setupNeeded: false, startsOnRequest: false };
        }
        // As main's `planNoAgentHasSeen`, by the rule it shares with the pane
        // (`awaitsFirstAgent`, src/shared/workflow-agent-first-open.ts): an open
        // on a workflow with tasks and no agent ever recorded starts nothing,
        // before any setting check. The tasks are the draft's before Start and
        // the board's after. The pane's Ask for changes comes back as a resume.
        if (!resume) {
          hydrate();
          var planned = entries.find(function (entry) { return entry.workflow.id === workflowId; });
          var plannedWorkflow = planned ? planned.workflow : null;
          var plannedTaskCount = !plannedWorkflow ? 0
            : plannedWorkflow.state === 'draft'
              ? (plannedWorkflow.draft ? plannedWorkflow.draft.tasks.length : 0)
              : createdTasks(workflowId).length;
          if (plannedWorkflow && plannedWorkflow.state !== 'done' && plannedWorkflow.agent_name === null && plannedTaskCount > 0) {
            return { session: null, unavailable: null, setupNeeded: false, startsOnRequest: true };
          }
        }
        var refusal = await mockWorkflowAgentRefusal();
        if (refusal) return refusal;
        // Read again after the await: an open in flight alongside this one may have started it.
        var existing = findMockWorkflowAgent(workflowId);
        if (existing && resume && existing.status === 'suspended') {
          existing.status = 'running';
          // A normal resume ends what the pane said about a start-over.
          delete startedOverSessions[workflowId];
          fireMockWorkflowAgentStatus(existing);
        }
        if (existing) return { session: JSON.parse(JSON.stringify(existing)), unavailable: null, setupNeeded: false, startsOnRequest: false };
        var session = makeMockWorkflowAgentSession(projectId, workflowId);
        sessions.push(session);
        // Main records the conversation on the workflow at every start, on the
        // Workflow agent setting's agent (the refusal check above passed it).
        var owner = entries.find(function (entry) { return entry.workflow.id === workflowId; });
        if (owner && !owner.workflow.agent_session_id) {
          owner.workflow.agent_name = ((config && config.workflows) || {}).agent || 'claude';
          owner.workflow.agent_session_id = session.agentSessionId;
          owner.workflow.agent_cwd = session.cwd;
        }
        fireMockWorkflowAgentStatus(session);
        return { session: JSON.parse(JSON.stringify(session)), unavailable: null, setupNeeded: false, startsOnRequest: false };
      }

      function hydrate() {
        if (hydrated) return;
        hydrated = true;
        (window.__mockWorkflows || []).forEach(function (seed) {
          var row = seed.workflow || seed;
          entries.push({
            projectId: seed.projectId || null,
            workflow: Object.assign({
              brief: null, source_task_id: null, state: 'draft', draft: null, color_slot: 1, revision: 1,
              created_at: now(), started_at: null, finished_at: null, paused_at: null, agent_name: null, agent_session_id: null, agent_cwd: null, agent_read_project_ids: [], plan_approval: null,
            }, JSON.parse(JSON.stringify(row))),
          });
        });
        (window.__mockWorkflowLinks || []).forEach(function (link) { links.push(Object.assign({}, link)); });
      }

      function homeOf(entry) { return entry.projectId || currentProjectId; }

      function blockerHeld(link) {
        return (window.__mockUnreadableProjects || []).indexOf(link.blocker_project_id) !== -1;
      }

      function requireEntry(projectId, workflowId) {
        hydrate();
        var entry = entries.find(function (candidate) { return candidate.workflow.id === workflowId; });
        if (!entry) throw new Error('No workflow "' + workflowId + '" in this project.');
        return entry;
      }

      function emit(projectId, workflowId, boardChanged) {
        var event = { projectId: projectId, workflowId: workflowId };
        setTimeout(function () { listeners.slice().forEach(function (fn) { fn(event); }); }, 0);
        if (boardChanged && window.__mockFireTaskMovedByAutomation) window.__mockFireTaskMovedByAutomation(projectId);
      }
      window.__mockFireWorkflowChanged = function (event) {
        listeners.slice().forEach(function (fn) { fn(event); });
      };
      // A resume the agent CLI could not honour, as main's startOverIfResumeFailed
      // handles it: the agent's session exits, a new one starts on a new
      // conversation, the summary names it, and a change is pushed.
      window.__mockWorkflowAgentStartOver = function (workflowId) {
        var entry = requireEntry(null, workflowId);
        var previous = sessions.find(function (candidate) { return candidate.workflowId === workflowId && candidate.status !== 'exited'; });
        if (previous) {
          previous.status = 'exited';
          previous.exitCode = 1;
          fireMockWorkflowAgentStatus(previous);
        }
        var session = makeMockWorkflowAgentSession(homeOf(entry), workflowId);
        sessions.push(session);
        entry.workflow.agent_session_id = session.agentSessionId;
        startedOverSessions[workflowId] = session.id;
        fireMockWorkflowAgentStatus(session);
        emit(homeOf(entry), workflowId, false);
        return session.id;
      };
      // The agent's CLI ends on its own (the user typed /exit): its session
      // exits and nothing starts in its place. Main resumes the conversation on
      // the pane's next open, as it does for any workflow with no live session.
      window.__mockWorkflowAgentExit = function (workflowId) {
        var live = sessions.find(function (candidate) { return candidate.workflowId === workflowId && candidate.status !== 'exited'; });
        if (!live) return null;
        live.status = 'exited';
        live.exitCode = 0;
        fireMockWorkflowAgentStatus(live);
        return live.id;
      };

      // A board's columns, as main reads them from that project's own database.
      // Where the lanes are tagged by project (the web build's sample install
      // seeds three boards), a project has only its own; untagged lanes (a UI
      // spec's one set) belong to every project.
      function boardLanes(projectId) {
        var tagged = swimlanes.filter(function (lane) { return lane.projectId === projectId; });
        return tagged.length > 0 ? tagged : swimlanes.filter(function (lane) { return !lane.projectId; });
      }
      // The board a workflow task sits on, as main's read model names it: a task
      // row's projectId tag (tasks.list scopes a row by it), a planned task's
      // project_id, else the workflow's home.
      function boardOf(entry, task) {
        return task.projectId || task.project_id || homeOf(entry);
      }
      // A task made on another board is that board's project's row, as main
      // creates it in that project's database, so boardOf reads it there later.
      // A home-board row stays untagged, which every UI spec's one board reads.
      function tagBoard(row, entry, projectId) {
        if (projectId && projectId !== homeOf(entry)) row.projectId = projectId;
      }

      // KEEP IN SYNC with src/shared/workflow-route.ts.
      function candidates(projectId) {
        return boardLanes(projectId).filter(function (lane) {
          return !lane.is_archived && !lane.is_ghost && lane.role !== 'todo' && lane.role !== 'done';
        }).sort(function (left, right) { return left.position - right.position; });
      }
      function routeColumns(route, projectId) {
        var list = candidates(projectId);
        if (list.length === 0) return [];
        var start = route.route_start_swimlane_id ? list.findIndex(function (lane) { return lane.id === route.route_start_swimlane_id; }) : 0;
        var last = route.route_last_swimlane_id ? list.findIndex(function (lane) { return lane.id === route.route_last_swimlane_id; }) : list.length - 1;
        var from = start >= 0 ? start : 0;
        var to = last >= 0 ? last : list.length - 1;
        if (to < from) return [];
        var skipped = route.skipped_swimlane_ids || [];
        return list.slice(from, to + 1).filter(function (lane) { return skipped.indexOf(lane.id) === -1; });
      }
      function routeFromColumns(ids, projectId) {
        var list = candidates(projectId);
        var first = list.findIndex(function (lane) { return ids.indexOf(lane.id) !== -1; });
        if (first < 0) return null;
        var last = first;
        list.forEach(function (lane, index) { if (ids.indexOf(lane.id) !== -1) last = index; });
        return {
          route_start_swimlane_id: first === 0 ? null : list[first].id,
          route_last_swimlane_id: last === list.length - 1 ? null : list[last].id,
          skipped_swimlane_ids: list.slice(first, last + 1).filter(function (lane) { return ids.indexOf(lane.id) === -1; }).map(function (lane) { return lane.id; }),
        };
      }
      // A lane id is unique across boards, so finding one needs no board.
      function laneOf(id) { return swimlanes.find(function (lane) { return lane.id === id; }); }
      // KEEP IN SYNC with todoColumn and doneColumn in src/shared/workflow-route.ts.
      function todoLane(projectId) { return boardLanes(projectId).find(function (lane) { return lane.role === 'todo' && !lane.is_ghost; }); }
      function doneLane(projectId) { return boardLanes(projectId).find(function (lane) { return lane.role === 'done' && !lane.is_ghost; }); }
      function step(lane, state) {
        return { swimlaneId: lane.id, name: lane.name, color: lane.color || null, icon: lane.icon || null, state: state, finishedAt: null };
      }

      function createdTasks(workflowId) {
        return tasks.concat(archivedTasks).filter(function (task) { return task.workflow_id === workflowId; });
      }
      function placeOf(task) {
        var lane = laneOf(task.swimlane_id);
        if (task.archived_at || (lane && lane.role === 'done')) return 'done';
        return lane && lane.role === 'todo' ? 'todo' : 'working';
      }
      function stepsOf(task, place, projectId) {
        var onRoute = routeColumns(task, projectId).map(function (lane) { return lane.id; });
        var current = laneOf(task.swimlane_id);
        return candidates(projectId).map(function (lane) {
          if (place === 'working' && current && lane.id === current.id) return step(lane, 'current');
          if (onRoute.indexOf(lane.id) === -1) return step(lane, 'skipped');
          if (place === 'done') return step(lane, 'done');
          if (place === 'working' && current && lane.position < current.position) return step(lane, 'done');
          return step(lane, 'ahead');
        });
      }

      // A board's To Do and Done columns, as main's readWorkflowDetail reads
      // them (boardEnds), on that board's own lanes (boardLanes).
      function boardEndsOf(projectId) {
        function endOf(lane) {
          return lane ? { swimlaneId: lane.id, name: lane.name, color: lane.color || null, icon: lane.icon || null } : null;
        }
        return { todo: endOf(todoLane(projectId)), done: endOf(doneLane(projectId)) };
      }

      // KEEP IN SYNC with taskPlanApproval (src/shared/plan-approval.ts) and its
      // main reader (src/main/plan-approval/workflow-plan-approval.ts): a task's
      // own value wins; left alone, it is Automatic only when every plan column
      // on its OWN route is Automatic on an agent that can approve plans; where no
      // plan column's agent can approve, it is Manual. Null when its route has no
      // plan column. A legacy whole-workflow value sits between the two. The mock
      // folds no Board Profile, since no UI spec seeds one on a workflow task.
      // Each column's agent resolves as
      // resolveTargetAgent does: the task's override, then the column's, then the
      // project's default.
      function taskPlanApprovalOf(entry, task, projectId, place) {
        var project = projects.find(function (candidate) { return candidate.id === projectId; });
        var planLanes = [];
        var planColumns = [];
        routeColumns(task, projectId).forEach(function (lane) {
          if (lane.permission_mode !== 'plan') return;
          var agentName = task.agent_override || lane.agent_override || (project && project.default_agent) || 'claude';
          planLanes.push(lane);
          planColumns.push({
            name: lane.name,
            planApproval: lane.plan_approval || 'manual',
            agentCanApprove: PLAN_APPROVING_AGENTS.indexOf(agentName) !== -1,
            agentName: AGENT_DISPLAY_NAMES[agentName] || agentName,
          });
        });
        if (planColumns.length === 0) return null;
        function approves(column) { return column.planApproval === 'automatic' && column.agentCanApprove; }
        var columnValue = planColumns.every(approves) ? 'automatic' : 'manual';
        var canApprove = planColumns.some(function (column) { return column.agentCanApprove; });
        var deciding = planColumns.find(function (column) { return !approves(column); }) || planColumns[0];
        var set = task.plan_approval || entry.workflow.plan_approval || null;
        var passed = place === 'done';
        if (place === 'working') {
          var current = laneOf(task.swimlane_id);
          passed = Boolean(current && current.position > planLanes[planLanes.length - 1].position);
        }
        var unable = planColumns.find(function (column) { return !column.agentCanApprove; });
        return {
          set: set,
          value: canApprove ? (set || columnValue) : 'manual',
          columnValue: columnValue,
          canApprove: canApprove,
          column: { name: deciding.name, boardName: project ? project.name : 'its board' },
          agentName: canApprove ? null : (unable || deciding).agentName,
          waitingAgentName: canApprove && unable ? unable.agentName : null,
          passed: passed,
        };
      }

      function detail(entry) {
        var workflow = entry.workflow;
        var home = homeOf(entry);
        var names = {};
        var boardEnds = {};
        var project = projects.find(function (candidate) { return candidate.id === home; });
        names[home] = project ? project.name : 'Project';
        boardEnds[home] = boardEndsOf(home);
        function noteProject(taskProjectId) {
          if (!names[taskProjectId]) {
            var other = projects.find(function (candidate) { return candidate.id === taskProjectId; });
            names[taskProjectId] = other ? other.name : 'Another project';
          }
          if (!Object.prototype.hasOwnProperty.call(boardEnds, taskProjectId)) boardEnds[taskProjectId] = boardEndsOf(taskProjectId);
        }
        if (workflow.state === 'draft') {
          var draft = workflow.draft || { tasks: [], links: [] };
          return {
            workflow: JSON.parse(JSON.stringify(workflow)),
            homeProjectId: home,
            projectNames: names,
            boardEnds: boardEnds,
            tasks: draft.tasks.map(function (planned) {
              var taskProjectId = boardOf(entry, planned);
              noteProject(taskProjectId);
              return {
                key: planned.key, projectId: taskProjectId, task: null, planned: Object.assign({}, planned),
                title: planned.title, displayId: null, place: 'planned', swimlaneId: null,
                steps: stepsOf(planned, 'planned', taskProjectId), canvasX: planned.canvas_x, canvasY: planned.canvas_y,
                unnamedBlockerCount: 0,
                stallReason: null,
                planApproval: taskPlanApprovalOf(entry, planned, taskProjectId, 'planned'),
              };
            }),
            links: draft.links.map(function (link) { return { blockerKey: link.blocker, blockedKey: link.blocked }; }),
          };
        }
        var created = createdTasks(workflow.id);
        var keys = created.map(function (task) { return task.id; });
        return {
          workflow: JSON.parse(JSON.stringify(workflow)),
          homeProjectId: home,
          projectNames: names,
          boardEnds: boardEnds,
          tasks: created.map(function (task) {
            var place = placeOf(task);
            var taskProjectId = boardOf(entry, task);
            noteProject(taskProjectId);
            return {
              key: task.id, projectId: taskProjectId, task: withAttachmentCount(task), planned: null,
              title: task.title, displayId: task.display_id, place: place, swimlaneId: task.swimlane_id,
              steps: stepsOf(task, place, taskProjectId), canvasX: task.canvas_x == null ? null : task.canvas_x, canvasY: task.canvas_y == null ? null : task.canvas_y,
              unnamedBlockerCount: links.filter(function (link) {
                return link.workflow_id === workflow.id && link.blocked_task_id === task.id && keys.indexOf(link.blocker_task_id) === -1 && blockerHeld(link);
              }).length,
              stallReason: place === 'done' ? null : stallOf(workflow, task),
              planApproval: taskPlanApprovalOf(entry, task, taskProjectId, place),
            };
          }),
          links: links.filter(function (link) {
            return link.workflow_id === workflow.id && keys.indexOf(link.blocker_task_id) !== -1 && keys.indexOf(link.blocked_task_id) !== -1;
          }).map(function (link) { return { blockerKey: link.blocker_task_id, blockedKey: link.blocked_task_id }; }),
        };
      }

      // The workflow agent for the picker's note. The mock tracks no activity in
      // main, so a running agent reads as idle; a suspended one as paused.
      function agentSummary(workflowId) {
        var agent = sessions.find(function (candidate) { return candidate.workflowId === workflowId && candidate.status !== 'exited'; });
        if (!agent) return null;
        return {
          state: agent.status === 'suspended' ? 'paused' : 'idle',
          lastReplyAt: null,
          startedOverSessionId: startedOverSessions[workflowId] === agent.id ? agent.id : null,
        };
      }

      // Why a running workflow is stalled on a task. Main reads it from the run
      // log; a test seeds it as window.__mockWorkflowStalls = { [taskId]: reason }.
      // As main's stallReader: no mark while the workflow is not running, or
      // while the task's own automations are paused.
      function stallOf(workflow, task) {
        if (workflow.state !== 'running' || task.automations_disabled) return null;
        var stalls = window.__mockWorkflowStalls || {};
        return typeof stalls[task.id] === 'string' ? stalls[task.id] : null;
      }

      function summary(entry) {
        var workflow = entry.workflow;
        if (workflow.state === 'draft') {
          return { workflow: JSON.parse(JSON.stringify(workflow)), taskCount: (workflow.draft || { tasks: [] }).tasks.length, doneCount: 0, inProgressCount: 0, queuedCount: 0, blockedCount: 0, neverStartedCount: 0, boardTasks: {}, agent: agentSummary(workflow.id), stalledTasks: [] };
        }
        var created = createdTasks(workflow.id);
        var counts = { done: 0, working: 0, queued: 0, blocked: 0 };
        var boardTasks = {};
        var stalledTasks = [];
        function noteStall(task) {
          var reason = stallOf(workflow, task);
          if (reason !== null) stalledTasks.push({ taskId: task.id, displayId: task.display_id, reason: reason });
          return reason;
        }
        function hasLinks(taskId) {
          return links.some(function (link) {
            return link.workflow_id === workflow.id && (link.blocker_task_id === taskId || link.blocked_task_id === taskId);
          });
        }
        created.forEach(function (task) {
          var place = placeOf(task);
          if (place === 'done') { counts.done += 1; return; }
          if (place === 'working') {
            counts.working += 1;
            boardTasks[task.id] = { waitingFor: [], humanGateTargetId: humanGateExit(workflow, task, boardOf(entry, task)), hasLinks: hasLinks(task.id), stallReason: noteStall(task) };
            return;
          }
          var waitingFor = links.filter(function (link) {
            if (link.workflow_id !== workflow.id || link.blocked_task_id !== task.id) return false;
            var blocker = created.find(function (candidate) { return candidate.id === link.blocker_task_id; });
            return blocker ? placeOf(blocker) !== 'done' : blockerHeld(link);
          }).map(function (link) {
            var blocker = created.find(function (candidate) { return candidate.id === link.blocker_task_id; });
            // 'a task' is UNNAMED_BLOCKER_LABEL (src/shared/workflow-waiting.ts), which this plain script cannot import.
            return blocker ? '#' + blocker.display_id : 'a task';
          });
          counts[waitingFor.length > 0 ? 'blocked' : 'queued'] += 1;
          boardTasks[task.id] = { waitingFor: waitingFor, humanGateTargetId: null, hasLinks: hasLinks(task.id), stallReason: noteStall(task) };
        });
        return {
          workflow: JSON.parse(JSON.stringify(workflow)), taskCount: created.length, doneCount: counts.done,
          inProgressCount: counts.working, queuedCount: counts.queued, blockedCount: counts.blocked,
          neverStartedCount: created.filter(neverStarted).length, boardTasks: boardTasks,
          agent: agentSummary(workflow.id),
          stalledTasks: stalledTasks,
        };
      }

      // Main's human gate (isHumanGate) also counts a column whose agent reports no
      // turn end, and every column while no Automation agent is set up. The mock
      // checks only auto_spawn, even where the web build's agent list carries
      // reportsTurnEnd, so here a column that starts no agent is the only gate.
      function humanGateExit(workflow, task, projectId) {
        if (workflow.state !== 'running' || task.automations_disabled) return null;
        var column = laneOf(task.swimlane_id);
        if (!column || column.auto_spawn) return null;
        var after = routeColumns(task, projectId).find(function (lane) { return lane.position > column.position; });
        var next = after || doneLane(projectId);
        return next ? next.id : null;
      }

      function editDraft(entry, edit) {
        if (entry.workflow.state !== 'draft') throw new Error('"' + entry.workflow.title + '" has started.');
        var draft = JSON.parse(JSON.stringify(entry.workflow.draft || { tasks: [], links: [] }));
        edit(draft);
        entry.workflow.draft = draft;
        entry.workflow.revision += 1;
        emit(homeOf(entry), entry.workflow.id, false);
      }
      function wouldLoop(edges, blocker, blocked) {
        var seen = {};
        var stack = [blocker];
        while (stack.length > 0) {
          var current = stack.pop();
          if (current === blocked) return true;
          if (seen[current]) continue;
          seen[current] = true;
          edges.forEach(function (edge) { if (edge.blocked === current) stack.push(edge.blocker); });
        }
        return false;
      }
      function requireTask(entry, key) {
        var task = createdTasks(entry.workflow.id).find(function (candidate) { return candidate.id === key; });
        if (!task) throw new Error('That task is no longer in this workflow.');
        return task;
      }
      function membership(task, entry, route) {
        task.workflow_id = entry.workflow.id;
        task.workflow_project_id = homeOf(entry);
        task.route_start_swimlane_id = route.route_start_swimlane_id;
        task.route_last_swimlane_id = route.route_last_swimlane_id;
        task.skipped_swimlane_ids = route.skipped_swimlane_ids;
        // A workflow column like the route: Start copies the planned task's.
        task.plan_approval = route.plan_approval || null;
      }
      // Main's isNeverStarted (src/main/workflows/workflow-never-started.ts) also
      // reads the task's session records and its moves; the mock keeps neither,
      // so a task in To Do with no session and no worktree is one that never started.
      function neverStarted(task) {
        return placeOf(task) === 'todo' && !task.session_id && !task.worktree_path;
      }

      function release(task) {
        task.workflow_id = null;
        task.workflow_project_id = null;
        task.route_start_swimlane_id = null;
        task.route_last_swimlane_id = null;
        task.skipped_swimlane_ids = [];
        task.plan_approval = null;
      }

      // A planned task's run settings (WorkflowTaskRunSettings), in the task
      // row's shape. KEEP IN SYNC with src/shared/workflow-run-settings.ts.
      // A plain passthrough of what the form sent, like buildTaskRow: main's
      // profile-vs-pin exclusivity is not copied here.
      var RUN_SETTINGS_FIELDS = ['base_branch', 'use_worktree', 'run_mode', 'profile_id', 'agent_override', 'model_override', 'effort_override', 'permission_mode'];
      function runSettingsOver(current, input) {
        var next = {
          base_branch: null, use_worktree: null, run_mode: 'column_settings', profile_id: null,
          agent_override: null, model_override: null, effort_override: null, permission_mode: null,
        };
        RUN_SETTINGS_FIELDS.forEach(function (field) {
          if (current && current[field] !== undefined) next[field] = current[field];
          if (input && input[field] !== undefined) next[field] = input[field];
        });
        return next;
      }
      // The run settings as buildTaskRow takes them (TaskCreateInput's names), as main's Start does.
      function runSettingsCreateInput(settings) {
        var run = runSettingsOver(settings, null);
        return {
          baseBranch: run.base_branch || undefined,
          useWorktree: run.use_worktree === null ? null : run.use_worktree === 1,
          run_mode: run.run_mode, profile_id: run.profile_id,
          agent_override: run.agent_override, model_override: run.model_override,
          effort_override: run.effort_override, permission_mode: run.permission_mode,
        };
      }

      return {
        list: async function (projectId) {
          hydrate();
          return entries
            .filter(function (entry) { return homeOf(entry) === projectId && entry.workflow.state !== 'done'; })
            .map(summary);
        },
        // Main reads the move Start wrote; the mock has no move history, so a
        // seeded started workflow whose source sits in Done stands for one
        // whose Start moved it, and start() above records whether it did.
        // Finished workflows stay, unlike list. A source two workflows share
        // goes to the one that started last, as main credits it.
        listSupersessions: async function (projectId) {
          hydrate();
          var everyTask = tasks.concat(archivedTasks);
          var bySource = {};
          entries
            .filter(function (entry) {
              return homeOf(entry) === projectId && entry.workflow.state !== 'draft' && entry.workflow.source_task_id && entry.supersededSource !== false;
            })
            .slice()
            .sort(function (left, right) { return String(right.workflow.started_at || '').localeCompare(String(left.workflow.started_at || '')); })
            .forEach(function (entry) {
              var sourceId = entry.workflow.source_task_id;
              if (bySource[sourceId]) return;
              var source = everyTask.find(function (task) { return task.id === sourceId; });
              if (!source || placeOf(source) !== 'done' || source.workflow_id === entry.workflow.id) return;
              bySource[sourceId] = { sourceTaskId: sourceId, workflowId: entry.workflow.id, title: entry.workflow.title, colorSlot: entry.workflow.color_slot };
            });
          return Object.keys(bySource).map(function (sourceId) { return bySource[sourceId]; });
        },
        get: async function (projectId, workflowId) {
          // Snapshot at call time, so a held answer is the workflow as it was
          // when it was asked for (the same property __mockHoldNextTaskList keeps).
          var answer = detail(requireEntry(projectId, workflowId));
          // Test hook: hold THIS call's answer until __mockReleaseWorkflowGet().
          // Set window.__mockHoldNextWorkflowGet = true before the call; it is
          // consumed by the next get, and __mockReleaseWorkflowGet exists only
          // while an answer is held, so a spec can poll for "the call is in flight".
          if (window.__mockHoldNextWorkflowGet) {
            window.__mockHoldNextWorkflowGet = false;
            return new Promise(function (resolve) {
              window.__mockReleaseWorkflowGet = function () {
                delete window.__mockReleaseWorkflowGet;
                resolve(answer);
              };
            });
          }
          return answer;
        },
        create: async function (projectId, sourceTaskId) {
          hydrate();
          var source = sourceTaskId ? tasks.find(function (task) { return task.id === sourceTaskId; }) : null;
          var held = entries.filter(function (entry) { return entry.workflow.state !== 'done'; }).map(function (entry) { return entry.workflow.color_slot; });
          var slot = 1;
          while (held.indexOf(slot) !== -1 && slot < 6) slot += 1;
          var workflow = {
            id: uuid(), title: 'Untitled workflow',
            brief: source ? [source.title, source.description].filter(Boolean).join('\n\n') : null,
            source_task_id: source ? source.id : null, state: 'draft', draft: { tasks: [], links: [] },
            color_slot: slot, revision: 1, created_at: now(), started_at: null, finished_at: null, paused_at: null,
            agent_name: null, agent_session_id: null, agent_cwd: null, agent_read_project_ids: [], plan_approval: null,
          };
          entries.unshift({ projectId: projectId, workflow: workflow });
          emit(projectId, workflow.id, false);
          return JSON.parse(JSON.stringify(workflow));
        },
        rename: async function (projectId, workflowId, title) {
          var entry = requireEntry(projectId, workflowId);
          if (!String(title || '').trim()) throw new Error('A workflow needs a name.');
          entry.workflow.title = String(title).trim();
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, false);
          return JSON.parse(JSON.stringify(entry.workflow));
        },
        // As main's setViewPlanApproval: a planned task's draft entry, or a
        // started task's row, refused once the task has passed its plan column.
        // The columns' own value is stored as nothing (normalizeTaskPlanApproval).
        setTaskPlanApproval: async function (projectId, workflowId, key, planApproval) {
          var entry = requireEntry(projectId, workflowId);
          if (planApproval !== 'automatic' && planApproval !== 'manual' && planApproval !== null) {
            throw new Error('planApproval must be "automatic", "manual", or null.');
          }
          if (entry.workflow.state === 'done') throw new Error('"' + entry.workflow.title + '" is complete.');
          // As main's storedPlanApproval. The mock never adopts a legacy value, so
          // while one is on the workflow the pick is stored as given.
          function normalized(task, place) {
            var view = taskPlanApprovalOf(entry, Object.assign({}, task, { plan_approval: null }), boardOf(entry, task), place);
            if (!view) return planApproval;
            if (entry.workflow.plan_approval) return planApproval || view.columnValue;
            return planApproval === view.columnValue ? null : planApproval;
          }
          if (entry.workflow.state === 'draft') {
            editDraft(entry, function (draft) {
              var planned = draft.tasks.find(function (task) { return task.key === key; });
              if (!planned) throw new Error('That task is no longer in the plan.');
              planned.plan_approval = normalized(planned, 'planned');
            });
            return;
          }
          var task = requireTask(entry, key);
          var place = placeOf(task);
          var label = '#' + task.display_id;
          if (place === 'done') throw new Error(label + ' is done. Its plan approval can no longer change.');
          var view = taskPlanApprovalOf(entry, task, boardOf(entry, task), place);
          if (view && view.passed) throw new Error(label + ' has passed ' + view.column.name + '. Its plan approval can no longer change.');
          task.plan_approval = normalized(task, place);
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, true);
        },
        delete: async function (projectId, workflowId, options) {
          var entry = requireEntry(projectId, workflowId);
          var doomedIds = [];
          if (entry.workflow.state !== 'draft') {
            createdTasks(workflowId).forEach(function (task) {
              if (placeOf(task) === 'done') return;
              if (options && options.deleteNeverStarted === true && neverStarted(task)) doomedIds.push(task.id);
              release(task);
            });
          }
          entries = entries.filter(function (candidate) { return candidate !== entry; });
          links = links.filter(function (link) { return link.workflow_id !== workflowId; });
          // Main deletes each through the board's own task delete (deleteNeverStartedTasks).
          tasks = tasks.filter(function (task) { return doomedIds.indexOf(task.id) === -1; });
          attachments = attachments.filter(function (attachment) { return doomedIds.indexOf(attachment.task_id) === -1; });
          emit(homeOf(entry), workflowId, true);
          return { deleted: doomedIds.length, failed: [] };
        },
        start: async function (projectId, workflowId) {
          var entry = requireEntry(projectId, workflowId);
          var draft = entry.workflow.draft || { tasks: [], links: [] };
          if (entry.workflow.state !== 'draft') throw new Error('"' + entry.workflow.title + '" has already started.');
          if (draft.tasks.length === 0) throw new Error('"' + entry.workflow.title + '" has no tasks yet. Save a plan with kangentic_save_workflow first.');
          var idByKey = {};
          draft.tasks.forEach(function (planned) {
            // Each task starts in its own board's To Do.
            var board = boardOf(entry, planned);
            var todo = todoLane(board);
            var row;
            if (planned.existing_task_id) {
              // Main's Start takes a board task in where it is (setWorkflowMembership)
              // and creates nothing; one that left To Do refuses the Start.
              row = tasks.find(function (task) { return task.id === planned.existing_task_id; });
              var lane = row ? laneOf(row.swimlane_id) : null;
              if (!row || row.archived_at || !lane || lane.role !== 'todo' || row.workflow_id) {
                throw new Error('"' + planned.title + '" takes in a board task that is no longer in To Do. Save the plan again without it.');
              }
            } else {
              // Main's Start creates every other task with its planned run settings.
              row = buildTaskRow(Object.assign(
                { title: planned.title, description: planned.description, swimlane_id: todo.id, labels: planned.labels, priority: planned.priority },
                runSettingsCreateInput(planned),
              ), tasks.filter(function (task) { return task.swimlane_id === todo.id; }).length);
              tagBoard(row, entry, board);
              tasks.push(row);
            }
            membership(row, entry, planned);
            row.canvas_x = planned.canvas_x;
            row.canvas_y = planned.canvas_y;
            idByKey[planned.key] = row.id;
          });
          draft.links.forEach(function (link) {
            links.push({ workflow_id: workflowId, blocker_task_id: idByKey[link.blocker], blocked_task_id: idByKey[link.blocked] });
          });
          var source = entry.workflow.source_task_id ? tasks.find(function (task) { return task.id === entry.workflow.source_task_id; }) : null;
          // Main's supersedeSourceTask: only an unarchived source still in To Do
          // moves to Done, and only that move makes it superseded
          // (listSupersessions). Main reads the source on the workflow's home
          // board and moves it to that board's Done.
          entry.supersededSource = false;
          var sourceDone = source && !source.archived_at ? doneLane(homeOf(entry)) : null;
          if (source && laneOf(source.swimlane_id) && laneOf(source.swimlane_id).role === 'todo' && sourceDone) {
            source.swimlane_id = sourceDone.id;
            source.archived_at = now();
            entry.supersededSource = true;
          }
          entry.workflow.state = 'running';
          entry.workflow.draft = null;
          entry.workflow.started_at = now();
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, true);
        },
        pause: async function (projectId, workflowId) {
          var entry = requireEntry(projectId, workflowId);
          if (entry.workflow.state !== 'running') throw new Error('"' + entry.workflow.title + '" is not running.');
          entry.workflow.state = 'paused';
          // Main's setState stamps it on Pause and clears it on every other state.
          entry.workflow.paused_at = now();
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, false);
          // The mock runs no agents, so main's report reads nothing paused.
          return { paused: 0, notLive: 0, failed: [] };
        },
        resume: async function (projectId, workflowId) {
          var entry = requireEntry(projectId, workflowId);
          if (entry.workflow.state !== 'paused') throw new Error('"' + entry.workflow.title + '" is not paused.');
          entry.workflow.state = 'running';
          entry.workflow.paused_at = null;
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, false);
          return { resumed: 0, started: 0, alreadyRunning: 0, failed: [] };
        },
        addTask: async function (projectId, workflowId, input) {
          var entry = requireEntry(projectId, workflowId);
          var title = String((input && input.title) || '').trim();
          if (!title) throw new Error('The task needs a title.');
          if (entry.workflow.state === 'draft') {
            var key = '';
            editDraft(entry, function (draft) {
              var index = draft.tasks.length + 1;
              var used = draft.tasks.map(function (task) { return task.key; });
              while (used.indexOf('task-' + index) !== -1) index += 1;
              key = 'task-' + index;
              draft.tasks.push(Object.assign({
                key: key, title: title, description: input.description || '',
                // Main stores the workflow's own project as null.
                project_id: input.projectId && input.projectId !== homeOf(entry) ? input.projectId : null,
                existing_task_id: null,
                route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [],
                labels: input.labels || [], priority: input.priority || 0, canvas_x: null, canvas_y: null,
                plan_approval: null,
              }, runSettingsOver(null, input)));
            });
            return key;
          }
          var todo = todoLane(input.projectId || homeOf(entry));
          // A real task in To Do with the settings the form chose, as main's addViewTask makes it.
          var row = buildTaskRow(Object.assign(
            { title: title, description: input.description, swimlane_id: todo.id, labels: input.labels, priority: input.priority },
            runSettingsCreateInput(runSettingsOver(null, input)),
          ), tasks.filter(function (task) { return task.swimlane_id === todo.id; }).length);
          membership(row, entry, { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [] });
          tagBoard(row, entry, input.projectId);
          tasks.push(row);
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, true);
          return row.id;
        },
        updateTask: async function (projectId, workflowId, key, input) {
          var entry = requireEntry(projectId, workflowId);
          editDraft(entry, function (draft) {
            var planned = draft.tasks.find(function (task) { return task.key === key; });
            if (!planned) throw new Error('That task is no longer in the plan.');
            if (input.title !== undefined) {
              if (!String(input.title).trim()) throw new Error('The task needs a title.');
              planned.title = String(input.title).trim();
            }
            if (input.description !== undefined) planned.description = input.description;
            if (input.labels !== undefined) planned.labels = input.labels;
            if (input.priority !== undefined) planned.priority = input.priority;
            var current = runSettingsOver(planned, null);
            if (input.projectId !== undefined) {
              var storedProject = input.projectId && input.projectId !== homeOf(entry) ? input.projectId : null;
              if (storedProject !== (planned.project_id || null)) {
                // Main's updatePlannedTask: a new board resets the route, and the
                // base branch and profile that named the old one's.
                planned.project_id = storedProject;
                planned.route_start_swimlane_id = null;
                planned.route_last_swimlane_id = null;
                planned.skipped_swimlane_ids = [];
                current.base_branch = null;
                current.profile_id = null;
              }
            }
            Object.assign(planned, runSettingsOver(current, input));
          });
        },
        removeTask: async function (projectId, workflowId, key) {
          var entry = requireEntry(projectId, workflowId);
          if (entry.workflow.state === 'draft') {
            editDraft(entry, function (draft) {
              draft.tasks = draft.tasks.filter(function (task) { return task.key !== key; });
              draft.links = draft.links.filter(function (link) { return link.blocker !== key && link.blocked !== key; });
            });
            return;
          }
          var task = requireTask(entry, key);
          if (placeOf(task) === 'done') throw new Error('#' + task.display_id + ' is done and stays with its workflow.');
          release(task);
          links = links.filter(function (link) { return link.blocker_task_id !== key && link.blocked_task_id !== key; });
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, true);
        },
        setLink: async function (projectId, workflowId, blockerKey, blockedKey, linked) {
          var entry = requireEntry(projectId, workflowId);
          if (blockerKey === blockedKey) throw new Error('A task cannot wait for itself.');
          if (entry.workflow.state === 'draft') {
            editDraft(entry, function (draft) {
              draft.links = draft.links.filter(function (link) { return !(link.blocker === blockerKey && link.blocked === blockedKey); });
              if (!linked) return;
              if (wouldLoop(draft.links, blockerKey, blockedKey)) throw new Error('That link closes a loop. A workflow\'s links cannot go in a circle.');
              draft.links.push({ blocker: blockerKey, blocked: blockedKey });
            });
            return;
          }
          var blocker = requireTask(entry, blockerKey);
          var blocked = requireTask(entry, blockedKey);
          // Built aside and kept only once every check passes: a refused link
          // leaves the links as they were, as main's does.
          var remaining = links.filter(function (link) { return !(link.blocker_task_id === blocker.id && link.blocked_task_id === blocked.id); });
          if (linked) {
            // KEEP IN SYNC with src/shared/workflow-refusals.ts.
            if (placeOf(blocked) !== 'todo') throw new Error('#' + blocked.display_id + ' has started. Only a task in To Do can wait for another.');
            if (placeOf(blocker) === 'done') throw new Error('#' + blocker.display_id + ' is done. Waiting for it changes nothing.');
            var edges = remaining.filter(function (link) { return link.workflow_id === workflowId; }).map(function (link) { return { blocker: link.blocker_task_id, blocked: link.blocked_task_id }; });
            if (wouldLoop(edges, blocker.id, blocked.id)) throw new Error('That link closes a loop. A workflow\'s links cannot go in a circle.');
            remaining.push({ workflow_id: workflowId, blocker_task_id: blocker.id, blocked_task_id: blocked.id });
          }
          links = remaining;
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, true);
        },
        setRoute: async function (projectId, workflowId, key, swimlaneIds) {
          var entry = requireEntry(projectId, workflowId);
          // A route is read against the columns of the task's own board.
          function routeOn(task) {
            var route = routeFromColumns(swimlaneIds || [], boardOf(entry, task));
            if (!route) throw new Error('A task visits at least one column.');
            return route;
          }
          if (entry.workflow.state === 'draft') {
            editDraft(entry, function (draft) {
              var planned = draft.tasks.find(function (task) { return task.key === key; });
              if (!planned) throw new Error('That task is no longer in the plan.');
              Object.assign(planned, routeOn(planned));
            });
            return;
          }
          var task = requireTask(entry, key);
          Object.assign(task, routeOn(task));
          entry.workflow.revision += 1;
          emit(homeOf(entry), workflowId, true);
        },
        setPositions: async function (projectId, workflowId, positions) {
          // Test hook: refuse the next save the way main does, before anything is
          // written and with no change push. Set window.__mockWorkflowSetPositionsRejectOnce
          // = 'message'; it is consumed by the next call.
          if (typeof window !== 'undefined' && window.__mockWorkflowSetPositionsRejectOnce) {
            var refusal = String(window.__mockWorkflowSetPositionsRejectOnce);
            window.__mockWorkflowSetPositionsRejectOnce = null;
            throw new Error(refusal);
          }
          // KEEP IN SYNC with the WORKFLOW_SET_POSITIONS handler in src/main/ipc/handlers/workflows.ts.
          if (positions !== null && !Array.isArray(positions)) throw new Error('Card places must be a list, or null to clear them.');
          var entry = requireEntry(projectId, workflowId);
          var byKey = {};
          (positions || []).forEach(function (position) { byKey[position.key] = position; });
          function place(target, key) {
            if (positions === null) { target.canvas_x = null; target.canvas_y = null; return; }
            if (!byKey[key]) return;
            target.canvas_x = Math.round(byKey[key].x);
            target.canvas_y = Math.round(byKey[key].y);
          }
          if (entry.workflow.state === 'draft') {
            (entry.workflow.draft || { tasks: [] }).tasks.forEach(function (planned) { place(planned, planned.key); });
          } else {
            createdTasks(workflowId).forEach(function (task) { place(task, task.id); });
          }
          emit(homeOf(entry), workflowId, false);
        },
        // The workflow's own agent: a transient session carrying `workflowId`,
        // the row shape main's workflow-agent.ts produces. A test makes it
        // unavailable with window.__mockWorkflowAgentUnavailable = '<reason>'.
        // Nothing starts until config.workflows names the Workflow agent (and
        // its model), as in main: seed it with __mockConfigOverrides.
        // window.__mockWorkflowAgentOpenCount counts the opens (not the resumes).
        // window.__mockWorkflowAgentSetupNeededOnce = true makes the NEXT open answer
        // `setupNeeded: true` whatever config.workflows says, as main does when its
        // own read of the setting disagrees with the pane's; it clears itself.
        agentOpen: async function (projectId, workflowId) {
          window.__mockWorkflowAgentOpenCount = (window.__mockWorkflowAgentOpenCount || 0) + 1;
          if (window.__mockWorkflowAgentSetupNeededOnce) {
            window.__mockWorkflowAgentSetupNeededOnce = false;
            return { session: null, unavailable: null, setupNeeded: true, startsOnRequest: false };
          }
          return openMockWorkflowAgent(projectId, workflowId, false);
        },
        agentResume: async function (projectId, workflowId) {
          return openMockWorkflowAgent(projectId, workflowId, true);
        },
        agentPause: async function (projectId, workflowId) {
          var session = sessions.find(function (candidate) { return candidate.workflowId === workflowId && candidate.status !== 'exited'; });
          if (!session || session.status === 'suspended') return;
          session.status = 'suspended';
          fireMockWorkflowAgentStatus(session);
        },
        onChanged: function (callback) {
          listeners.push(callback);
          return function () {
            var index = listeners.indexOf(callback);
            if (index !== -1) listeners.splice(index, 1);
          };
        },
      };
    })(),

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
      // Subscription handshake (monitor:subscribe / monitor:unsubscribe). The
      // mock has no push pipeline to gate, so subscribe just returns the same
      // seeded snapshot getSnapshot serves; the call log lets a spec assert the
      // monitor registered/unregistered itself.
      __subscribeCalls: 0,
      __unsubscribeCalls: 0,
      subscribe: function () {
        window.electronAPI.monitor.__subscribeCalls += 1;
        return window.electronAPI.monitor.getSnapshot();
      },
      unsubscribe: function () {
        window.electronAPI.monitor.__unsubscribeCalls += 1;
        return Promise.resolve();
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
      // Call log for test assertions (mirrors __subscribeCalls): pins that a
      // detail refetches on a real snapshot change but NOT on every activity tick.
      __getTaskDetailCalls: 0,
      getTaskDetail: function (projectId, taskId) {
        window.electronAPI.monitor.__getTaskDetailCalls += 1;
        var project = null;
        for (var p = 0; p < projects.length; p++) {
          if (projects[p].id === projectId) { project = projects[p]; break; }
        }
        // Archived tasks too, as main's `tasks.getById` reads them: a completed
        // task's detached Changes window looks its row up here.
        var task = null;
        var searched = tasks.concat(archivedTasks);
        for (var t = 0; t < searched.length; t++) {
          if (searched[t].id === taskId) { task = searched[t]; break; }
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
            // Required by TaskDetailBundle.config, and `useBranchConfig` indexes
            // it without a guard. This file is plain .js, so tsc cannot catch a
            // missing field here: omitting it threw on every monitor-hosted
            // detail render and the ErrorBoundary tore down the whole app.
            agentExecution: (config.agent && config.agent.execution) || {},
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
      // Live output peek. Subscribe-gated in production, so the call log lets a
      // spec assert that a mounted monitor subscribes and an unmounted one stops
      // (the property that keeps main from watching PTY output for nobody).
      __peekSubscribeCalls: [],
      // The session ids each subscribe named (null when it named none), so a spec
      // can assert which rows the renderer asked main to sample.
      __peekWantedCalls: [],
      setPeekSubscribed: function (subscribed, sessionIds) {
        window.electronAPI.monitor.__peekSubscribeCalls.push(subscribed);
        window.electronAPI.monitor.__peekWantedCalls.push(Array.isArray(sessionIds) ? sessionIds.slice() : null);
        return Promise.resolve();
      },
      // Push peeks from a spec with window.__mockFireMonitorPeek({ 's1': ['line'] }).
      onPeek: function (callback) {
        if (!window.__mockMonitorPeekListeners) window.__mockMonitorPeekListeners = [];
        window.__mockMonitorPeekListeners.push(callback);
        if (!window.__mockFireMonitorPeek) {
          window.__mockFireMonitorPeek = function (peeks) {
            var listeners = (window.__mockMonitorPeekListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) { listeners[i](peeks); }
          };
        }
        return function () {
          var listeners = window.__mockMonitorPeekListeners || [];
          var index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    },

    clipboard: {
      readImage: function () { return Promise.resolve('/tmp/kangentic-clipboard/pasted-image-1234567890.png'); },
      // Call log for test assertions (each entry is the PNG byte length the drop
      // path handed over). Reset with window.electronAPI.clipboard.__saveImageCalls.length = 0.
      // Answers with a fixed path, the way main answers a decodable image; a spec
      // that needs the "not an image" null overrides this per page.
      __saveImageCalls: [],
      saveImage: function (pngBytes) {
        window.electronAPI.clipboard.__saveImageCalls.push(pngBytes ? pngBytes.byteLength : 0);
        return Promise.resolve('/tmp/kangentic-clipboard/pasted-image-normalized.png');
      },
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

    knowledgeGraph: {
      getStatus: function () { return Promise.resolve(Object.assign({}, memoryStatus)); },
      // Fire-and-forget worker warm-up on a Knowledge Graph open. Recorded (one
      // timestamp per call) so a UI test can assert Quick Find never sends it.
      // Not an exact count: StrictMode double-invokes a mount effect, and the
      // second send is a no-op against the worker's memoized init.
      // A prewarm that names a chat also warms that chat's answering session;
      // those are recorded as their own list, chat ids and all.
      prewarm: function (chat) {
        if (typeof window !== 'undefined') {
          if (!window.__mockMemoryPrewarmCalls) window.__mockMemoryPrewarmCalls = [];
          window.__mockMemoryPrewarmCalls.push(Date.now());
          if (chat && chat.chatId) {
            if (!window.__mockAnswerPrewarms) window.__mockAnswerPrewarms = [];
            window.__mockAnswerPrewarms.push({ chatId: chat.chatId, projectId: chat.projectId });
          }
        }
      },
      // The chat's warm session is released; recorded so a UI test can assert
      // X and closing the graph both let it go.
      endChat: function (chatId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockEndChatCalls) window.__mockEndChatCalls = [];
          window.__mockEndChatCalls.push(chatId);
        }
      },
      // The summaries Rebuild would rewrite: those in the seeded status written
      // some other way, which is what main would count and mark.
      rebuildPlan: function () {
        var summaries = memoryStatus && memoryStatus.summaries;
        var summariesToRewrite = 0;
        if (summaries && summaries.choice && summaries.writtenWith) {
          summaries.writtenWith.forEach(function (entry) {
            var same = entry.agent === summaries.choice.agent && entry.model === summaries.choice.model && entry.effort === summaries.choice.effort;
            if (!same) summariesToRewrite += entry.count;
          });
        }
        return Promise.resolve({ summariesToRewrite: summariesToRewrite });
      },
      // Recorded for the Rebuild spec. Global, so it carries no project.
      rebuildIndex: function () {
        if (typeof window !== 'undefined') {
          if (!window.__mockRebuildIndexCalls) window.__mockRebuildIndexCalls = [];
          window.__mockRebuildIndexCalls.push(Date.now());
        }
        return this.rebuildPlan();
      },
      taskSummary: function (projectId, taskId) {
        // Seeded per task id via __mockPreConfigure's memoryTaskSummaries, or
        // the written summary of a __mockTaskReports report, so the graph and
        // the completed task view read one summary; null otherwise, which is
        // what main answers with summaries switched off.
        if (typeof window !== 'undefined') {
          if (!window.__mockTaskSummaryCalls) window.__mockTaskSummaryCalls = [];
          window.__mockTaskSummaryCalls.push({ projectId: projectId, taskId: taskId });
        }
        if (Object.prototype.hasOwnProperty.call(memoryTaskSummaries, taskId)) return Promise.resolve(memoryTaskSummaries[taskId]);
        var seededReport = seededTaskReportSource(taskId);
        var seededState = seededReport && seededReport.summaryState;
        return Promise.resolve(seededState && seededState.kind === 'written' ? seededState.text : null);
      },
      graphSnapshot: function (projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockGraphSnapshotCalls) window.__mockGraphSnapshotCalls = [];
          window.__mockGraphSnapshotCalls.push({ projectId: projectId === undefined ? null : projectId });
        }
        var keyed = projectId ? knowledgeGraphSnapshotsByProject[projectId] : undefined;
        var source = keyed || knowledgeGraphSnapshot;
        return Promise.resolve(source ? JSON.parse(JSON.stringify(source)) : null);
      },
      graphProjects: function () {
        if (typeof window !== 'undefined') {
          window.__mockGraphProjectsCalls = (window.__mockGraphProjectsCalls || 0) + 1;
        }
        return Promise.resolve(JSON.parse(JSON.stringify(knowledgeGraphProjects)));
      },
      refreshGraph: function (projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockRefreshGraphCalls) window.__mockRefreshGraphCalls = [];
          window.__mockRefreshGraphCalls.push({ projectId: projectId === undefined ? null : projectId });
        }
        // Main answers with the first build's progress when one runs, else
        // null. A spec sets `window.__mockRefreshGraphResult` to say a first
        // build started; by default nothing runs, as a refresh with no worker.
        var refreshResult = typeof window !== 'undefined' ? window.__mockRefreshGraphResult : undefined;
        return Promise.resolve(refreshResult ? JSON.parse(JSON.stringify(refreshResult)) : null);
      },
      answerFromGraph: function (question, projectId, granularity, requestId, context) {
        if (typeof window !== 'undefined') {
          if (!window.__mockGraphAnswerCalls) window.__mockGraphAnswerCalls = [];
          window.__mockGraphAnswerCalls.push({
            question: question,
            projectId: projectId === undefined ? null : projectId,
            granularity: granularity === undefined ? null : granularity,
            requestId: requestId === undefined ? null : requestId,
            context: context === undefined ? null : JSON.parse(JSON.stringify(context)),
          });
        }
        // Defaults to a FAILURE, deliberately. Ask spawns a real CLI, so a spec
        // that has not said what the agent returns has not set up the case it is
        // testing, and a plausible default answer would let it pass anyway.
        // A spec may set `window.__mockAnswerResultQueue` to answer successive
        // questions differently (a failure, then a retry that works).
        var queued = typeof window !== 'undefined' && Array.isArray(window.__mockAnswerResultQueue)
          ? window.__mockAnswerResultQueue.shift()
          : undefined;
        var settled = queued || knowledgeGraphAnswerResult;
        var result = settled
          ? JSON.parse(JSON.stringify(settled))
          : { ok: false, reason: 'no agent configured' };
        // A spec that sets `window.__mockHoldAnswer` gets the answer held open
        // until it calls `window.__mockReleaseAnswer()`, so it can drive the
        // stream (the related set, searches, text) through
        // `__mockFireAnswerStream` in between, as main does.
        if (typeof window !== 'undefined' && window.__mockHoldAnswer) {
          return new Promise(function (resolve) {
            window.__mockReleaseAnswer = function () { resolve(result); };
          });
        }
        return Promise.resolve(result);
      },
      relatedToTask: function (taskId, projectId) {
        if (typeof window !== 'undefined') {
          if (!window.__mockRelatedToTaskCalls) window.__mockRelatedToTaskCalls = [];
          window.__mockRelatedToTaskCalls.push({ taskId: taskId, projectId: projectId === undefined ? null : projectId });
        }
        return Promise.resolve(memoryRelatedToTask ? JSON.parse(JSON.stringify(memoryRelatedToTask)) : []);
      },
      onGraphChanged: function (callback) {
        if (!window.__mockGraphChangedListeners) window.__mockGraphChangedListeners = [];
        window.__mockGraphChangedListeners.push(callback);
        if (!window.__mockFireGraphChanged) {
          // Drives the push path from a spec: window.__mockFireGraphChanged(id).
          window.__mockFireGraphChanged = function (projectId) {
            var listeners = (window.__mockGraphChangedListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) listeners[i](projectId);
          };
        }
        return function () {
          var listeners = window.__mockGraphChangedListeners || [];
          var index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      onGraphBuildProgress: function (callback) {
        if (!window.__mockGraphBuildProgressListeners) window.__mockGraphBuildProgressListeners = [];
        window.__mockGraphBuildProgressListeners.push(callback);
        if (!window.__mockFireGraphBuildProgress) {
          // Drives a first build's progress from a spec:
          // window.__mockFireGraphBuildProgress(id, { pass, stage, percent }).
          window.__mockFireGraphBuildProgress = function (projectId, progress) {
            var listeners = (window.__mockGraphBuildProgressListeners || []).slice();
            for (var listenerIndex = 0; listenerIndex < listeners.length; listenerIndex++) listeners[listenerIndex](projectId, progress);
          };
        }
        return function () {
          var listeners = window.__mockGraphBuildProgressListeners || [];
          var index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      onAnswerStream: function (callback) {
        if (!window.__mockAnswerStreamListeners) window.__mockAnswerStreamListeners = [];
        window.__mockAnswerStreamListeners.push(callback);
        if (!window.__mockFireAnswerStream) {
          // Drives the streaming path from a spec. A spec that wants to see text
          // arrive before the answer settles fires text events, then resolves
          // the answer: window.__mockFireAnswerStream({ requestId, kind, text }).
          // The requestId is what the store minted; read it back off the last
          // answerFromGraph call.
          window.__mockFireAnswerStream = function (event) {
            var listeners = (window.__mockAnswerStreamListeners || []).slice();
            for (var i = 0; i < listeners.length; i++) listeners[i](event);
          };
        }
        return function () {
          var listeners = window.__mockAnswerStreamListeners || [];
          var index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
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
      // History paging. The sample install records no transcript past the read
      // cap, so nothing ever pages: an honest empty answer, the one the desktop
      // gives once a history file is gone. Test hook:
      // window.__mockTranscriptsPageOverride(input) => response | Promise | undefined,
      // and the same for locate and timeline. Every call is recorded on
      // window.__mockTranscriptPageCalls for assertions.
      page: function (input) {
        if (typeof window !== 'undefined') {
          window.__mockTranscriptPageCalls = window.__mockTranscriptPageCalls || [];
          window.__mockTranscriptPageCalls.push(input);
          if (typeof window.__mockTranscriptsPageOverride === 'function') {
            var overridden = window.__mockTranscriptsPageOverride(input);
            if (overridden) return Promise.resolve(overridden);
          }
        }
        return Promise.resolve({ status: 'unavailable', reason: 'file_missing' });
      },
      locate: function (input) {
        if (typeof window !== 'undefined') {
          window.__mockTranscriptLocateCalls = window.__mockTranscriptLocateCalls || [];
          window.__mockTranscriptLocateCalls.push(input);
          if (typeof window.__mockTranscriptsLocateOverride === 'function') {
            var overridden = window.__mockTranscriptsLocateOverride(input);
            if (overridden) return Promise.resolve(overridden);
          }
        }
        return Promise.resolve({ status: 'not_found' });
      },
      timeline: function (input) {
        if (typeof window !== 'undefined' && typeof window.__mockTranscriptsTimelineOverride === 'function') {
          var overridden = window.__mockTranscriptsTimelineOverride(input);
          if (overridden) return Promise.resolve(overridden);
        }
        return Promise.resolve({ status: 'unavailable', reason: 'file_missing' });
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
      // projectId is the TASK's project (a popped-out pane outlives a project
      // switch). The mock resolves the project default from it, falling back to
      // the current project the way resolveProjectContext does in main.
      getUrls: async function (taskId, projectId) {
        var lookupId = projectId || currentProjectId;
        var currentProject = projects.find(function (p) { return p.id === lookupId; });
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
      setTaskUrl: async function (taskId, url, projectId) {
        browserUrlProjects[taskId] = projectId || currentProjectId;
        browserUrls[taskId] = url;
      },
      clearTaskUrl: async function (taskId) {
        delete browserUrlProjects[taskId];
        delete browserUrls[taskId];
      },
      // Stub for the Clear Browser Data action in the Browser settings tab.
      // Real impl wipes the persistent partition on the main process; the
      // mock just resolves so the renderer can exercise the success/error
      // toast paths via test-time monkeypatching.
      clearStorage: function () { return Promise.resolve(); },
      // Real impl syncs the worktree jar with the project identity jar in main.
      // The mock resolves instantly so the pane's jar-sync gate opens and every
      // browser-pane spec still mounts (a test can monkeypatch it to a slow
      // promise to exercise the timeout-proceed path).
      ensureJar: function () { return Promise.resolve(); },
      registerPane: function (input) { browserPaneCalls.push({ type: 'register', input: input }); return Promise.resolve(); },
      unregisterPane: function (webContentsId) { browserPaneCalls.push({ type: 'unregister', webContentsId: webContentsId }); return Promise.resolve(); },
      // The user's Close control and the visibility report, recorded in the same
      // log so a spec can assert a close was DELIBERATE (main retires the handle
      // with `user-closed` and stands no lane up) and what the agent would be
      // told about where the pane is.
      closePaneByUser: function (webContentsId) { browserPaneCalls.push({ type: 'user-close', webContentsId: webContentsId }); return Promise.resolve(); },
      setPaneVisibility: function (webContentsId, visibility) { browserPaneCalls.push({ type: 'visibility', webContentsId: webContentsId, visibility: visibility }); return Promise.resolve(); },
      // Ctrl+wheel zoom is applied in the main process and broadcast back.
      // The UI tier has no main process, so the mock just registers the
      // callback and returns a no-op unsubscribe.
      // Records subscribers so a test can fire a zoom broadcast at ONE pane and
      // assert the others ignore it (the payload carries the guest's id because
      // a window can host several panes).
      onZoomChanged: function (callback) {
        browserZoomSubscribers.push(callback);
        return function () {
          const index = browserZoomSubscribers.indexOf(callback);
          if (index >= 0) browserZoomSubscribers.splice(index, 1);
        };
      },
      // Main -> renderer pane open/close pushes, behind the
      // kangentic_browser_open_pane / _close_pane MCP tools. The UI tier has no
      // main process, so a test drives them through the emit helpers below
      // (window.__mockBrowser.emitPaneOpenRequest(projectId, taskId)).
      onPaneOpenRequest: function (callback) {
        browserPaneOpenSubscribers.push(callback);
        return function () {
          const index = browserPaneOpenSubscribers.indexOf(callback);
          if (index >= 0) browserPaneOpenSubscribers.splice(index, 1);
        };
      },
      // Main -> renderer "an agent is driving guest N right now" interval, which
      // is what lets the pane put the user's focus back after a CDP dispatch
      // moves it. Driven from a test via
      // window.__mockBrowser.emitAgentInput(webContentsId, active).
      onAgentInput: function (callback) {
        browserAgentInputSubscribers.push(callback);
        return function () {
          const index = browserAgentInputSubscribers.indexOf(callback);
          if (index >= 0) browserAgentInputSubscribers.splice(index, 1);
        };
      },
      // Main -> renderer "an agent set this guest's viewport" push, behind the
      // pane's viewport chip. Driven from a test via
      // window.__mockBrowser.emitViewportOverride(webContentsId, override|null).
      onViewportOverride: function (callback) {
        browserViewportSubscribers.push(callback);
        return function () {
          const index = browserViewportSubscribers.indexOf(callback);
          if (index >= 0) browserViewportSubscribers.splice(index, 1);
        };
      },
      // The pane element's measured size, which only the renderer can know.
      setPaneWidgetSize: function (webContentsId, width, height) {
        browserPaneCalls.push({ type: 'widget-size', webContentsId: webContentsId, width: width, height: height });
        return Promise.resolve();
      },
      // What the pane asks on registration, for an override set before it
      // mounted. Tests seed it via window.__mockBrowser.seedViewportOverride().
      getViewportOverride: function (webContentsId) {
        return Promise.resolve(browserViewportSeed[webContentsId] || null);
      },
      clearViewportOverride: function (webContentsId) {
        browserPaneCalls.push({ type: 'viewport-clear', webContentsId: webContentsId });
        delete browserViewportSeed[webContentsId];
        browserViewportSubscribers.forEach(function (callback) { callback(webContentsId, null); });
        return Promise.resolve(true);
      },
      // Main -> renderer "these tasks hold their surface offscreen" push, which
      // is what lights the card globe and the Browser pill for a surface no
      // <webview> backs. Driven via
      // window.__mockBrowser.emitOffscreenSurfaces([taskId, ...]).
      onOffscreenSurfaces: function (callback) {
        browserOffscreenSubscribers.push(callback);
        return function () {
          const index = browserOffscreenSubscribers.indexOf(callback);
          if (index >= 0) browserOffscreenSubscribers.splice(index, 1);
        };
      },
      // The mount-time read, for a surface that was already offscreen before
      // this renderer existed. Seeded via
      // window.__mockBrowser.seedOffscreenSurfaces([taskId, ...]).
      getOffscreenSurfaces: function () {
        return Promise.resolve(browserOffscreenSeed.slice());
      },
      closeOffscreenSurface: function (taskId, projectId) {
        browserPaneCalls.push({ type: 'offscreen-close', taskId: taskId, projectId: projectId ?? null });
        const index = browserOffscreenSeed.indexOf(taskId);
        if (index < 0) return Promise.resolve(false);
        browserOffscreenSeed.splice(index, 1);
        const next = browserOffscreenSeed.slice();
        browserOffscreenSubscribers.slice().forEach(function (callback) { callback(next); });
        return Promise.resolve(true);
      },
      // Main -> renderer "a pane download finished" push, behind the toast.
      // Driven via window.__mockBrowser.emitDownloadDone({fileName, filePath, state}).
      onDownloadDone: function (callback) {
        browserDownloadSubscribers.push(callback);
        return function () {
          const index = browserDownloadSubscribers.indexOf(callback);
          if (index >= 0) browserDownloadSubscribers.splice(index, 1);
        };
      },
      // Main -> renderer push carrying a keystroke the user typed into the guest
      // while an agent was driving it. Main already blocked it from the page.
      onUserKeyDuringDrive: function (callback) {
        browserUserKeySubscribers.push(callback);
        return function () {
          const index = browserUserKeySubscribers.indexOf(callback);
          if (index >= 0) browserUserKeySubscribers.splice(index, 1);
        };
      },
      onPaneCloseRequest: function (callback) {
        browserPaneCloseSubscribers.push(callback);
        return function () {
          const index = browserPaneCloseSubscribers.indexOf(callback);
          if (index >= 0) browserPaneCloseSubscribers.splice(index, 1);
        };
      },
      // Main -> renderer push for a mouse back/forward press inside the guest.
      // A real guest consumes the mouse outright, so this channel is the ONLY
      // way those presses reach the renderer; there is no DOM event to simulate
      // instead. Driven via window.__mockBrowser.emitGuestMouseButton(...).
      onGuestMouseButton: function (callback) {
        browserGuestMouseSubscribers.push(callback);
        return function () {
          const index = browserGuestMouseSubscribers.indexOf(callback);
          if (index >= 0) browserGuestMouseSubscribers.splice(index, 1);
        };
      },
    },

    // Platform string. Defaults to 'win32' (matches the most common dev
    // host) but tests can override via window.__mockPlatform set in an
    // addInitScript before page load -- BrowserEmptyState reads this to
    // decide whether to render the WSL hint.
    get platform() {
      return (typeof window !== 'undefined' && window.__mockPlatform) || 'win32';
    },

    // Arch string. Overridden per spec via window.__mockArch; with
    // __mockPlatform: darwin, x64 is an Intel Mac, where the Knowledge Graph
    // reports itself unavailable. The default follows the platform, arm64 on a
    // Mac and x64 elsewhere, so a spec that sets only __mockPlatform: darwin
    // gets the Mac the release mostly ships to, not an Intel one.
    get arch() {
      if (typeof window !== 'undefined' && window.__mockArch) return window.__mockArch;
      return typeof window !== 'undefined' && window.__mockPlatform === 'darwin' ? 'arm64' : 'x64';
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
      browserUrlProjects = {};
      browserCaptureCalls = [];
      browserPaneCalls = [];
      browserZoomSubscribers = [];
      // NOT reset: the pane open/close subscribers are registered once by
      // useBrowserPaneRequestBridge at app mount, long before a test calls
      // reset(). Clearing them here would silently unsubscribe the bridge and
      // every emitted push would land nowhere. (The zoom subscribers above are
      // per-pane, so they re-register when a pane remounts.)
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
    /** The project a task URL was last saved against (null if never saved). */
    getTaskUrlProject: function (taskId) {
      return browserUrlProjects[taskId] || null;
    },
    /** Fire the main-process zoom broadcast at a specific guest. */
    emitZoomChanged: function (factor, webContentsId) {
      browserZoomSubscribers.slice().forEach(function (callback) {
        callback(factor, webContentsId);
      });
    },
    /**
     * Fire main's guest mouse back/forward push. `at` defaults to now, and is
     * the MAIN-side clock the renderer measures tap-vs-hold against - pass an
     * explicit pair to model a hold without actually waiting.
     */
    emitGuestMouseButton: function (webContentsId, button, phase, at) {
      browserGuestMouseSubscribers.slice().forEach(function (callback) {
        callback({
          webContentsId: webContentsId,
          button: button,
          phase: phase,
          at: typeof at === 'number' ? at : Date.now(),
        });
      });
    },
    /** Fire main's "open this task's Browser pane" push (kangentic_browser_open_pane). */
    emitPaneOpenRequest: function (projectId, taskId) {
      browserPaneOpenSubscribers.slice().forEach(function (callback) {
        callback(projectId, taskId);
      });
    },
    /** Fire main's "close these Browser panes" push (kangentic_browser_close_pane). */
    emitPaneCloseRequest: function (projectId, taskIds) {
      browserPaneCloseSubscribers.slice().forEach(function (callback) {
        callback(projectId, taskIds);
      });
    },
    /** Fire main's "an agent is driving this guest" interval edge. Pass true to
     *  arm the pane's focus guard and false to end the drive. */
    emitAgentInput: function (webContentsId, active) {
      browserAgentInputSubscribers.slice().forEach(function (callback) {
        callback(webContentsId, active);
      });
    },
    /** Fire main's "an agent set this guest's viewport" push. Pass null to
     *  clear it. Only the pane whose guest id matches should react. */
    emitViewportOverride: function (webContentsId, override) {
      browserViewportSubscribers.slice().forEach(function (callback) {
        callback(webContentsId, override);
      });
    },
    /** Seed an override so a pane that mounts LATER finds one on registration,
     *  which is the pop-out case the push alone cannot cover. */
    seedViewportOverride: function (webContentsId, override) {
      browserViewportSeed[webContentsId] = override;
    },
    /** Fire main's "these tasks hold their surface offscreen" push. Pass the
     *  WHOLE set, as main does: an empty array means none. */
    emitOffscreenSurfaces: function (taskIds) {
      browserOffscreenSeed = taskIds.slice();
      browserOffscreenSubscribers.slice().forEach(function (callback) {
        callback(taskIds.slice());
      });
    },
    /** Seed the set a renderer reads on mount, for a surface that was already
     *  offscreen before this renderer existed (a reload, or an HMR update). */
    seedOffscreenSurfaces: function (taskIds) {
      browserOffscreenSeed = taskIds.slice();
    },
    /** Fire main's "a pane download finished" push. */
    emitDownloadDone: function (download) {
      browserDownloadSubscribers.slice().forEach(function (callback) {
        callback(download);
      });
    },
    /** Fire main's "the user typed into the guest mid-drive" push, carrying
     *  already-encoded terminal bytes. */
    emitUserKeyDuringDrive: function (webContentsId, data) {
      browserUserKeySubscribers.slice().forEach(function (callback) {
        callback(webContentsId, data);
      });
    },
  };

  /**
   * Test hook: inspect the pop-out engine's open/close/focus call log. This hook
   * is only for asserting which verb a trigger (title-bar button, PopOutButton)
   * called. To simulate a surface actually detaching or its window closing, fire
   * window.__mockFirePopOutChanged below - it drives the real popOut:changed
   * push, so the renderer's own side effects run. (Older specs poke
   * window.__zustandStores.popOut directly, which mirrors the store but skips
   * those effects.)
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
      popOutOpenResult = true;
      // The open SET is reset too, not just the call log: a shared-page suite
      // that fires a push would otherwise leave a surface reported as detached
      // for every later test in the file. Registered onChanged subscribers are
      // deliberately NOT dropped - App.tsx subscribes once at mount, so
      // clearing them would silently make every later push a no-op.
      popOutOpenKeys = [];
    },
    getCalls: function () {
      return popOutCalls.slice();
    },
    /** Seed what popOut.open resolves: false = the maxInstances cap refused. */
    setOpenResult: function (value) {
      popOutOpenResult = value;
    },
  };

  /**
   * Test hook: fire main's popOut:changed push with the given open-instance-key
   * set, e.g. window.__mockFirePopOutChanged(['changes:p1:t1']) to detach a
   * task's Changes view and then ([]) to close that window.
   *
   * Drives the REAL renderer path (App.tsx's onChanged subscription), not just
   * the pop-out store, which is what makes the push's side effects observable -
   * closing a `changes` window leaves its in-app panel closed rather than
   * reclaiming the split. Also updates what listOpen() resolves, so the
   * mount-time loadOpen() cannot land afterwards and undo the pushed set.
   *
   * Deliberately not cleared by __mockPopOut.reset(): App.tsx subscribes once at
   * mount, and dropping the subscriber would silently make every later push a
   * no-op.
   */
  window.__mockFirePopOutChanged = function (openInstanceKeys) {
    popOutOpenKeys = (openInstanceKeys || []).slice();
    popOutChangedSubscribers.slice().forEach(function (callback) {
      callback(popOutOpenKeys.slice());
    });
  };

  /**
   * Test hook: inspect window.electronAPI.window.* call log (minimize/
   * maximize/close), e.g. to assert PopOutWindowFrame's Escape handler called
   * (or did not call) window.close() without a real OS window.
   */
  window.__mockWindowControls = {
    reset: function () {
      windowControlCalls = [];
    },
    getCalls: function () {
      return windowControlCalls.slice();
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
      automations: automations,
      automationRuns: automationRuns,
      sessions: sessions,
      backlogTasks: backlogTasks,
      activityCache: activityCache,
      activityReasonCache: activityReasonCache,
      messageTrailCache: messageTrailCache,
      activityStatsCache: activityStatsCache,
      eventCache: eventCache,
      summaryCache: summaryCache,
      taskReportCache: taskReportCache,
      taskLastMessages: taskLastMessages,
      taskRunFacts: taskRunFacts,
      // The report the mock derives from a seeded summary, for a test that
      // holds the derivation to its summary.
      buildTaskReport: buildMockTaskReport,
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
    if (result && result.knowledgeGraphSnapshot && typeof result.knowledgeGraphSnapshot === 'object') {
      knowledgeGraphSnapshot = result.knowledgeGraphSnapshot;
    }
    if (result && Array.isArray(result.knowledgeGraphProjects)) {
      knowledgeGraphProjects = result.knowledgeGraphProjects;
    }
    if (result && result.memoryTaskSummaries && typeof result.memoryTaskSummaries === 'object') {
      memoryTaskSummaries = result.memoryTaskSummaries;
    }
    if (result && result.knowledgeGraphSnapshotsByProject && typeof result.knowledgeGraphSnapshotsByProject === 'object') {
      knowledgeGraphSnapshotsByProject = result.knowledgeGraphSnapshotsByProject;
    }
    if (result && result.knowledgeGraphAnswerResult && typeof result.knowledgeGraphAnswerResult === 'object') {
      knowledgeGraphAnswerResult = result.knowledgeGraphAnswerResult;
    }
    if (result && Array.isArray(result.memoryRelatedToTask)) {
      memoryRelatedToTask = result.memoryRelatedToTask;
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
      ['sessions', 'getMessageTrails'],
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
