export const IPC = {
  // Projects
  PROJECT_LIST: 'project:list',
  PROJECT_CREATE: 'project:create',
  PROJECT_DELETE: 'project:delete',
  PROJECT_OPEN: 'project:open',
  PROJECT_GET_CURRENT: 'project:getCurrent',
  PROJECT_OPEN_BY_PATH: 'project:openByPath',
  PROJECT_AUTO_OPENED: 'project:autoOpened',

  // Tasks
  TASK_LIST: 'task:list',
  TASK_CREATE: 'task:create',
  TASK_UPDATE: 'task:update',
  TASK_DELETE: 'task:delete',
  TASK_MOVE: 'task:move',
  TASK_LIST_ARCHIVED: 'task:list-archived',
  TASK_UNARCHIVE: 'task:unarchive',

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
  SESSION_EXIT: 'session:exit',
  SESSION_USAGE: 'session:usage',
  SESSION_GET_USAGE: 'session:getUsage',
  SESSION_ACTIVITY: 'session:activity',
  SESSION_GET_ACTIVITY: 'session:getActivity',
  SESSION_EVENT: 'session:event',
  SESSION_GET_EVENTS: 'session:getEvents',
  SESSION_SUSPEND: 'session:suspend',
  SESSION_RESUME: 'session:resume',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_PROJECT: 'config:getProject',
  CONFIG_SET_PROJECT: 'config:setProject',

  // Claude
  CLAUDE_DETECT: 'claude:detect',

  // Shell
  SHELL_GET_AVAILABLE: 'shell:getAvailable',
  SHELL_GET_DEFAULT: 'shell:getDefault',

  // Shell utilities
  SHELL_OPEN_PATH: 'shell:openPath',

  // Dialog
  DIALOG_SELECT_FOLDER: 'dialog:selectFolder',

  // Window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
} as const;
