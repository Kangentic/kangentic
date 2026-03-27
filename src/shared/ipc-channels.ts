export const IPC = {
  // Projects
  PROJECT_LIST: 'project:list',
  PROJECT_CREATE: 'project:create',
  PROJECT_DELETE: 'project:delete',
  PROJECT_OPEN: 'project:open',
  PROJECT_GET_CURRENT: 'project:getCurrent',
  PROJECT_OPEN_BY_PATH: 'project:openByPath',
  PROJECT_SEARCH_ENTRIES: 'project:searchEntries',
  PROJECT_REORDER: 'project:reorder',
  PROJECT_SET_GROUP: 'project:setGroup',
  PROJECT_RENAME: 'project:rename',
  PROJECT_AUTO_OPENED: 'project:autoOpened',

  // Project Groups
  PROJECT_GROUP_LIST: 'projectGroup:list',
  PROJECT_GROUP_CREATE: 'projectGroup:create',
  PROJECT_GROUP_UPDATE: 'projectGroup:update',
  PROJECT_GROUP_DELETE: 'projectGroup:delete',
  PROJECT_GROUP_REORDER: 'projectGroup:reorder',
  PROJECT_GROUP_SET_COLLAPSED: 'projectGroup:setCollapsed',

  // Tasks
  TASK_LIST: 'task:list',
  TASK_CREATE: 'task:create',
  TASK_UPDATE: 'task:update',
  TASK_DELETE: 'task:delete',
  TASK_MOVE: 'task:move',
  TASK_LIST_ARCHIVED: 'task:list-archived',
  TASK_UNARCHIVE: 'task:unarchive',
  TASK_BULK_DELETE: 'task:bulk-delete',
  TASK_BULK_UNARCHIVE: 'task:bulk-unarchive',
  TASK_SWITCH_BRANCH: 'task:switchBranch',
  TASK_AUTO_MOVED: 'task:autoMoved',
  TASK_CREATED_BY_AGENT: 'task:createdByAgent',
  TASK_UPDATED_BY_AGENT: 'task:updatedByAgent',

  // Attachments
  ATTACHMENT_LIST: 'attachment:list',
  ATTACHMENT_ADD: 'attachment:add',
  ATTACHMENT_REMOVE: 'attachment:remove',
  ATTACHMENT_GET_DATA_URL: 'attachment:getDataUrl',
  ATTACHMENT_OPEN: 'attachment:open',

  // Swimlanes
  SWIMLANE_LIST: 'swimlane:list',
  SWIMLANE_CREATE: 'swimlane:create',
  SWIMLANE_UPDATE: 'swimlane:update',
  SWIMLANE_DELETE: 'swimlane:delete',
  SWIMLANE_REORDER: 'swimlane:reorder',

  // Actions
  ACTION_LIST: 'action:list',
  ACTION_CREATE: 'action:create',
  ACTION_UPDATE: 'action:update',
  ACTION_DELETE: 'action:delete',

  // Transitions
  TRANSITION_LIST: 'transition:list',
  TRANSITION_SET: 'transition:set',
  TRANSITION_GET_FOR: 'transition:getFor',

  // Sessions
  SESSION_SPAWN: 'session:spawn',
  SESSION_KILL: 'session:kill',
  SESSION_WRITE: 'session:write',
  SESSION_RESIZE: 'session:resize',
  SESSION_LIST: 'session:list',
  SESSION_GET_SCROLLBACK: 'session:getScrollback',
  SESSION_DATA: 'session:data',
  SESSION_FIRST_OUTPUT: 'session:firstOutput',
  SESSION_EXIT: 'session:exit',
  SESSION_USAGE: 'session:usage',
  SESSION_GET_USAGE: 'session:getUsage',
  SESSION_ACTIVITY: 'session:activity',
  SESSION_GET_ACTIVITY: 'session:getActivity',
  SESSION_EVENT: 'session:event',
  SESSION_GET_EVENTS: 'session:getEvents',
  SESSION_GET_EVENTS_CACHE: 'session:getEventsCache',
  SESSION_STATUS: 'session:status',
  SESSION_SUSPEND: 'session:suspend',
  SESSION_RESUME: 'session:resume',
  SESSION_IDLE_TIMEOUT: 'session:idleTimeout',
  SESSION_GET_SUMMARY: 'session:getSummary',
  SESSION_LIST_SUMMARIES: 'session:listSummaries',
  SESSION_SPAWN_TRANSIENT: 'session:spawnTransient',
  SESSION_KILL_TRANSIENT: 'session:killTransient',
  SESSION_GET_PERIOD_STATS: 'session:getPeriodStats',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_GET_GLOBAL: 'config:getGlobal',
  CONFIG_SET: 'config:set',
  CONFIG_GET_PROJECT: 'config:getProject',
  CONFIG_SET_PROJECT: 'config:setProject',
  CONFIG_GET_PROJECT_BY_PATH: 'config:getProjectByPath',
  CONFIG_SET_PROJECT_BY_PATH: 'config:setProjectByPath',
  CONFIG_SYNC_DEFAULT_TO_PROJECTS: 'config:syncDefaultToProjects',

  // Claude
  CLAUDE_DETECT: 'claude:detect',
  CLAUDE_LIST_COMMANDS: 'claude:listCommands',

  // Shell
  SHELL_GET_AVAILABLE: 'shell:getAvailable',
  SHELL_GET_DEFAULT: 'shell:getDefault',

  // Shell utilities
  SHELL_OPEN_PATH: 'shell:openPath',
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  SHELL_EXEC: 'shell:exec',

  // Git
  GIT_DETECT: 'git:detect',
  GIT_LIST_BRANCHES: 'git:listBranches',

  // Dialog
  DIALOG_SELECT_FOLDER: 'dialog:selectFolder',

  // Window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_FLASH_FRAME: 'window:flashFrame',
  WINDOW_IS_FOCUSED: 'window:isFocused',

  // Analytics
  TRACK_RENDERER_ERROR: 'analytics:trackRendererError',

  // App
  APP_GET_VERSION: 'app:getVersion',

  // Notifications
  NOTIFICATION_SHOW: 'notification:show',
  NOTIFICATION_CLICKED: 'notification:clicked',

  // Board Config
  BOARD_CONFIG_EXISTS: 'boardConfig:exists',
  BOARD_CONFIG_EXPORT: 'boardConfig:export',
  BOARD_CONFIG_APPLY: 'boardConfig:apply',
  BOARD_CONFIG_CHANGED: 'boardConfig:changed',
  BOARD_CONFIG_GET_SHORTCUTS: 'boardConfig:getShortcuts',
  BOARD_CONFIG_SET_SHORTCUTS: 'boardConfig:setShortcuts',
  BOARD_CONFIG_SHORTCUTS_CHANGED: 'boardConfig:shortcutsChanged',
  BOARD_CONFIG_SET_DEFAULT_BASE_BRANCH: 'boardConfig:setDefaultBaseBranch',

  // Backlog
  BACKLOG_LIST: 'backlog:list',
  BACKLOG_CREATE: 'backlog:create',
  BACKLOG_UPDATE: 'backlog:update',
  BACKLOG_DELETE: 'backlog:delete',
  BACKLOG_REORDER: 'backlog:reorder',
  BACKLOG_BULK_DELETE: 'backlog:bulk-delete',
  BACKLOG_PROMOTE: 'backlog:promote',
  BACKLOG_DEMOTE: 'backlog:demote',
  BACKLOG_RENAME_LABEL: 'backlog:renameLabel',
  BACKLOG_DELETE_LABEL: 'backlog:deleteLabel',
  BACKLOG_REMAP_PRIORITIES: 'backlog:remapPriorities',
  BACKLOG_CHANGED_BY_AGENT: 'backlog:changedByAgent',
  BACKLOG_LABEL_COLORS_CHANGED: 'backlog:labelColorsChanged',

  // Backlog Import
  BACKLOG_IMPORT_CHECK_CLI: 'backlog:importCheckCli',
  BACKLOG_IMPORT_FETCH: 'backlog:importFetch',
  BACKLOG_IMPORT_EXECUTE: 'backlog:importExecute',
  BACKLOG_IMPORT_SOURCES_LIST: 'backlog:importSourcesList',
  BACKLOG_IMPORT_SOURCES_ADD: 'backlog:importSourcesAdd',
  BACKLOG_IMPORT_SOURCES_REMOVE: 'backlog:importSourcesRemove',

  // Backlog Attachments
  BACKLOG_ATTACHMENT_LIST: 'backlogAttachment:list',
  BACKLOG_ATTACHMENT_ADD: 'backlogAttachment:add',
  BACKLOG_ATTACHMENT_REMOVE: 'backlogAttachment:remove',
  BACKLOG_ATTACHMENT_GET_DATA_URL: 'backlogAttachment:getDataUrl',
  BACKLOG_ATTACHMENT_OPEN: 'backlogAttachment:open',

  // Updater
  UPDATE_CHECK: 'updater:check',
  UPDATE_INSTALL: 'updater:install',
  UPDATE_DOWNLOADED: 'updater:downloaded',
} as const;
