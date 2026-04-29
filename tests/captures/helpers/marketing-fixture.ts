/**
 * Deterministic seed data for marketing captures.
 * Returns a script string for page.addInitScript() that calls
 * window.__mockPreConfigure() to populate the mock with realistic
 * board state — tasks across multiple columns, active sessions,
 * activity indicators, labels, and usage data.
 *
 * All IDs are hardcoded strings and timestamps use a fixed base date
 * so captures are fully deterministic.
 */

// Fixed IDs for deterministic output
const PROJECT_ID = 'proj-mkt-acme';
const LANE_TODO = 'lane-mkt-todo';
const LANE_PLANNING = 'lane-mkt-planning';
const LANE_EXECUTING = 'lane-mkt-executing';
const LANE_REVIEW = 'lane-mkt-review';
const LANE_TESTS = 'lane-mkt-tests';
const LANE_SHIPIT = 'lane-mkt-shipit';
const LANE_DONE = 'lane-mkt-done';

const LANE_IDS = [
  LANE_TODO,
  LANE_PLANNING,
  LANE_EXECUTING,
  LANE_REVIEW,
  LANE_TESTS,
  LANE_SHIPIT,
  LANE_DONE,
];

// Task IDs
const TASK_AUTH = 'task-mkt-auth';
const TASK_API_ERRORS = 'task-mkt-api-errors';
const TASK_WEBSOCKET = 'task-mkt-websocket';
const TASK_MIDDLEWARE = 'task-mkt-middleware';
const TASK_API_CLIENT = 'task-mkt-api-client';
const TASK_RATE_LIMIT = 'task-mkt-rate-limit';
const TASK_INTEGRATION = 'task-mkt-integration';
const TASK_DONE_DEPLOY = 'task-mkt-done-deploy';
const TASK_DONE_SCHEMA = 'task-mkt-done-schema';
const TASK_DONE_LOGGING = 'task-mkt-done-logging';

// Session IDs (only tasks with active agents have sessions)
const SESSION_WEBSOCKET = 'sess-mkt-websocket';
const SESSION_MIDDLEWARE = 'sess-mkt-middleware';
const SESSION_API_CLIENT = 'sess-mkt-api-client';
const SESSION_RATE_LIMIT = 'sess-mkt-rate-limit';
const SESSION_INTEGRATION = 'sess-mkt-integration';

// Fixed base timestamp: 2026-04-10T14:30:00Z
const BASE_TS = '2026-04-10T14:30:00.000Z';

export function buildMarketingPreConfig(): string {
  return `
    window.__mockPreConfigure(function (state) {
      var ts = '${BASE_TS}';

      // --- Project ---
      state.projects.push({
        id: '${PROJECT_ID}',
        name: 'acme-saas',
        path: '/home/dev/projects/acme-saas',
        github_url: 'https://github.com/acme/acme-saas',
        default_agent: 'claude',
        last_opened: ts,
        created_at: ts,
      });

      // --- Swimlanes (use DEFAULT_SWIMLANES for roles/colors, override IDs) ---
      var laneIds = ${JSON.stringify(LANE_IDS)};
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push({
          id: laneIds[i],
          name: s.name,
          role: s.role,
          color: s.color,
          icon: s.icon,
          is_archived: s.is_archived,
          is_ghost: s.is_ghost || false,
          permission_mode: s.permission_mode || null,
          permission_strategy: s.permission_strategy || null,
          auto_spawn: s.auto_spawn || false,
          auto_command: s.auto_command || null,
          plan_exit_target_id: s.plan_exit_target_id || null,
          agent_override: s.agent_override || null,
          handoff_context: s.handoff_context || false,
          position: i,
          created_at: ts,
        });
      });

      // --- Tasks ---

      // To Do column (no sessions)
      state.tasks.push({
        id: '${TASK_AUTH}',
        display_id: 1,
        title: 'Add user auth flow',
        description: 'Implement OAuth2 login with GitHub and Google providers',
        swimlane_id: '${LANE_TODO}',
        position: 0,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: null,
        labels: ['feature', 'auth'],
        priority: 2,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      state.tasks.push({
        id: '${TASK_API_ERRORS}',
        display_id: 2,
        title: 'Refactor API error handling',
        description: 'Standardize error responses and add error codes',
        swimlane_id: '${LANE_TODO}',
        position: 1,
        agent: null,
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_number: null,
        pr_url: null,
        base_branch: null,
        use_worktree: null,
        labels: ['refactor', 'api'],
        priority: 1,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Planning column (thinking agent)
      state.tasks.push({
        id: '${TASK_WEBSOCKET}',
        display_id: 3,
        title: 'Fix WebSocket reconnection',
        description: 'Handle dropped connections with exponential backoff',
        swimlane_id: '${LANE_PLANNING}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_WEBSOCKET}',
        worktree_path: '/home/dev/projects/acme-saas/.kangentic/worktrees/fix-websocket-abc123',
        branch_name: 'fix-websocket-reconnection',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: ['bug'],
        priority: 3,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Executing column (two agents — one running, one idle)
      state.tasks.push({
        id: '${TASK_MIDDLEWARE}',
        display_id: 4,
        title: 'Extract auth middleware',
        description: 'Move auth logic into reusable Express middleware',
        swimlane_id: '${LANE_EXECUTING}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_MIDDLEWARE}',
        worktree_path: '/home/dev/projects/acme-saas/.kangentic/worktrees/auth-middleware-def456',
        branch_name: 'extract-auth-middleware',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: ['refactor', 'auth'],
        priority: 2,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      state.tasks.push({
        id: '${TASK_API_CLIENT}',
        display_id: 5,
        title: 'Generate API client types',
        description: 'Auto-generate TypeScript types from OpenAPI spec',
        swimlane_id: '${LANE_EXECUTING}',
        position: 1,
        agent: 'claude',
        session_id: '${SESSION_API_CLIENT}',
        worktree_path: '/home/dev/projects/acme-saas/.kangentic/worktrees/api-types-ghi789',
        branch_name: 'generate-api-types',
        pr_number: null,
        pr_url: null,
        base_branch: 'main',
        use_worktree: 1,
        labels: ['feature', 'api'],
        priority: 1,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Code Review column (idle agent)
      state.tasks.push({
        id: '${TASK_RATE_LIMIT}',
        display_id: 6,
        title: 'Add rate limiting',
        description: 'Implement per-user rate limiting on API endpoints',
        swimlane_id: '${LANE_REVIEW}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_RATE_LIMIT}',
        worktree_path: '/home/dev/projects/acme-saas/.kangentic/worktrees/rate-limit-jkl012',
        branch_name: 'add-rate-limiting',
        pr_number: 42,
        pr_url: 'https://github.com/acme/acme-saas/pull/42',
        base_branch: 'main',
        use_worktree: 1,
        labels: ['feature', 'api'],
        priority: 2,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // Tests column (running agent)
      state.tasks.push({
        id: '${TASK_INTEGRATION}',
        display_id: 7,
        title: 'Integration test coverage',
        description: 'Add integration tests for auth and billing flows',
        swimlane_id: '${LANE_TESTS}',
        position: 0,
        agent: 'claude',
        session_id: '${SESSION_INTEGRATION}',
        worktree_path: '/home/dev/projects/acme-saas/.kangentic/worktrees/integration-tests-mno345',
        branch_name: 'integration-tests',
        pr_number: 38,
        pr_url: 'https://github.com/acme/acme-saas/pull/38',
        base_branch: 'main',
        use_worktree: 1,
        labels: ['tests'],
        priority: 1,
        attachment_count: 0,
        archived_at: null,
        created_at: ts,
        updated_at: ts,
      });

      // --- Sessions ---
      state.sessions.push(
        {
          id: '${SESSION_WEBSOCKET}',
          taskId: '${TASK_WEBSOCKET}',
          projectId: '${PROJECT_ID}',
          pid: 10001,
          status: 'running',
          shell: 'bash',
          cwd: '/home/dev/projects/acme-saas',
          startedAt: ts,
          exitCode: null,
        },
        {
          id: '${SESSION_MIDDLEWARE}',
          taskId: '${TASK_MIDDLEWARE}',
          projectId: '${PROJECT_ID}',
          pid: 10002,
          status: 'running',
          shell: 'bash',
          cwd: '/home/dev/projects/acme-saas',
          startedAt: ts,
          exitCode: null,
        },
        {
          id: '${SESSION_API_CLIENT}',
          taskId: '${TASK_API_CLIENT}',
          projectId: '${PROJECT_ID}',
          pid: 10003,
          status: 'running',
          shell: 'bash',
          cwd: '/home/dev/projects/acme-saas',
          startedAt: ts,
          exitCode: null,
        },
        {
          id: '${SESSION_RATE_LIMIT}',
          taskId: '${TASK_RATE_LIMIT}',
          projectId: '${PROJECT_ID}',
          pid: 10004,
          status: 'running',
          shell: 'bash',
          cwd: '/home/dev/projects/acme-saas',
          startedAt: ts,
          exitCode: null,
        },
        {
          id: '${SESSION_INTEGRATION}',
          taskId: '${TASK_INTEGRATION}',
          projectId: '${PROJECT_ID}',
          pid: 10005,
          status: 'running',
          shell: 'bash',
          cwd: '/home/dev/projects/acme-saas',
          startedAt: ts,
          exitCode: null,
        }
      );

      // --- Activity states ---
      state.activityCache['${SESSION_WEBSOCKET}'] = 'thinking';
      state.activityCache['${SESSION_MIDDLEWARE}'] = 'running';
      state.activityCache['${SESSION_API_CLIENT}'] = 'idle';
      state.activityCache['${SESSION_RATE_LIMIT}'] = 'idle';
      state.activityCache['${SESSION_INTEGRATION}'] = 'running';

      // --- Event caches (recent tool use for context bars) ---
      state.eventCache['${SESSION_WEBSOCKET}'] = [
        { ts: Date.now() - 3000, type: 'tool_start', tool: 'Read', detail: 'src/lib/websocket.ts' },
        { ts: Date.now() - 1000, type: 'tool_start', tool: 'Grep', detail: 'reconnect pattern' },
      ];
      state.eventCache['${SESSION_MIDDLEWARE}'] = [
        { ts: Date.now() - 5000, type: 'tool_start', tool: 'Edit', detail: 'src/middleware/auth.ts' },
        { ts: Date.now() - 2000, type: 'tool_start', tool: 'Write', detail: 'src/middleware/index.ts' },
        { ts: Date.now() - 500, type: 'tool_start', tool: 'Bash', detail: 'npm run typecheck' },
      ];
      state.eventCache['${SESSION_API_CLIENT}'] = [
        { ts: Date.now() - 10000, type: 'tool_start', tool: 'Write', detail: 'src/types/api.d.ts' },
      ];
      state.eventCache['${SESSION_RATE_LIMIT}'] = [
        { ts: Date.now() - 8000, type: 'tool_start', tool: 'Read', detail: 'src/routes/api.ts' },
      ];
      state.eventCache['${SESSION_INTEGRATION}'] = [
        { ts: Date.now() - 4000, type: 'tool_start', tool: 'Bash', detail: 'npm test -- --grep auth' },
        { ts: Date.now() - 1000, type: 'tool_start', tool: 'Write', detail: 'tests/auth.integration.ts' },
      ];

      // --- Archived/done tasks ---
      state.archivedTasks.push(
        {
          id: '${TASK_DONE_DEPLOY}',
          display_id: 8,
          title: 'Set up CI/CD pipeline',
          description: 'GitHub Actions for build, test, deploy',
          swimlane_id: '${LANE_DONE}',
          position: 0,
          agent: null,
          session_id: null,
          worktree_path: null,
          branch_name: 'setup-cicd',
          pr_number: 31,
          pr_url: 'https://github.com/acme/acme-saas/pull/31',
          base_branch: 'main',
          use_worktree: null,
          labels: ['feature'],
          priority: 0,
          attachment_count: 0,
          archived_at: '2026-04-09T10:00:00.000Z',
          created_at: '2026-04-07T09:00:00.000Z',
          updated_at: '2026-04-09T10:00:00.000Z',
        },
        {
          id: '${TASK_DONE_SCHEMA}',
          display_id: 9,
          title: 'Database schema migration',
          description: 'Migrate to new normalized schema',
          swimlane_id: '${LANE_DONE}',
          position: 1,
          agent: null,
          session_id: null,
          worktree_path: null,
          branch_name: 'schema-v2',
          pr_number: 35,
          pr_url: 'https://github.com/acme/acme-saas/pull/35',
          base_branch: 'main',
          use_worktree: null,
          labels: ['refactor'],
          priority: 0,
          attachment_count: 0,
          archived_at: '2026-04-09T16:00:00.000Z',
          created_at: '2026-04-08T11:00:00.000Z',
          updated_at: '2026-04-09T16:00:00.000Z',
        },
        {
          id: '${TASK_DONE_LOGGING}',
          display_id: 10,
          title: 'Structured logging',
          description: 'Replace console.log with pino structured logging',
          swimlane_id: '${LANE_DONE}',
          position: 2,
          agent: null,
          session_id: null,
          worktree_path: null,
          branch_name: 'structured-logging',
          pr_number: 37,
          pr_url: 'https://github.com/acme/acme-saas/pull/37',
          base_branch: 'main',
          use_worktree: null,
          labels: ['refactor'],
          priority: 0,
          attachment_count: 0,
          archived_at: '2026-04-10T09:00:00.000Z',
          created_at: '2026-04-09T08:00:00.000Z',
          updated_at: '2026-04-10T09:00:00.000Z',
        }
      );

      return { currentProjectId: '${PROJECT_ID}' };
    });

    // Override getScrollback to return realistic Claude Code terminal output.
    // The middleware session uses real captured TUI data from
    // scripts/capture-claude-scrollback.js, sanitized of personal info.
    // Other sessions use hand-crafted ANSI that follows Claude Code's color scheme.
    var scrollbackData = {
      '${SESSION_WEBSOCKET}': '\\x1b[0m' + [
        '\\x1b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────\\x1b[0m',
        '\\x1b[38;2;177;185;249m❯\\x1b[0m Fix the WebSocket reconnection handling',
        '',
        ' \\x1b[38;2;16;185;129mRead 2 files\\x1b[0m \\x1b[38;2;153;153;153m(ctrl+o to expand)\\x1b[0m',
        '  \\x1b[38;2;153;153;153m⎿\\x1b[0m  src/lib/websocket.ts, src/lib/http-client.ts',
        '',
        'I can see the WebSocket client connects but has no reconnection',
        'logic. Let me search for existing retry patterns...',
        '',
        '\\x1b[38;2;107;114;128m╭──────────────────────────────────────────────────────────────────────────────────────────────╮\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m \\x1b[1m\\x1b[38;2;91;141;239mGrep\\x1b[0m reconnect pattern                                                                      \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m                                                                                             \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  src/lib/http-client.ts:42  \\x1b[38;2;245;158;11mretryWithBackoff\\x1b[0m(req, {                                    \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  src/lib/http-client.ts:43    maxRetries: 3,                                                \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  src/lib/http-client.ts:44    backoff: \\'exponential\\'                                       \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  src/services/queue.ts:118  \\x1b[38;2;245;158;11mreconnect\\x1b[0m()                                               \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m╰──────────────────────────────────────────────────────────────────────────────────────────────╯\\x1b[0m',
        '',
        '\\x1b[38;2;215;119;87m✶\\x1b[0m \\x1b[38;2;235;159;127mThinking...\\x1b[0m',
      ].join('\\r\\n'),
      '${SESSION_MIDDLEWARE}': '\\x1b[0m' + [
        '\\x1b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────\\x1b[0m',
        '\\x1b[38;2;177;185;249m❯\\x1b[0m Extract the auth logic into a standalone middleware',
        '',
        ' \\x1b[38;2;16;185;129mRead 3 files\\x1b[0m \\x1b[38;2;153;153;153m(ctrl+o to expand)\\x1b[0m',
        '  \\x1b[38;2;153;153;153m⎿\\x1b[0m  src/routes/api.ts, src/middleware/auth.ts, src/lib/jwt.ts',
        '',
        'I\\'ll extract the authentication logic into a reusable middleware.',
        'The current code duplicates JWT verification across 4 route files.',
        '',
        '\\x1b[38;2;107;114;128m╭──────────────────────────────────────────────────────────────────────────────────────────────╮\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m \\x1b[1m\\x1b[38;2;91;141;239mEdit\\x1b[0m src/middleware/auth.ts                                                                   \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m                                                                                             \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;239;68;68m- export function authenticate(req, res, next) {\\x1b[0m                                           \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;239;68;68m-   const token = req.headers.authorization;\\x1b[0m                                               \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;239;68;68m-   if (!token) return res.status(401).json({ error: \\'Unauthorized\\' });\\x1b[0m                    \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;239;68;68m-   try { req.user = verifyJwt(token); next(); }\\x1b[0m                                            \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;239;68;68m-   catch (e) { res.status(401).json({ error: e.message }); }\\x1b[0m                                \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;239;68;68m- }\\x1b[0m                                                                                         \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+ export const authMiddleware = createMiddleware({\\x1b[0m                                         \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+   verify: validateJwt,\\x1b[0m                                                                   \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+   onError: handleAuthError,\\x1b[0m                                                              \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+ });\\x1b[0m                                                                                       \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m╰──────────────────────────────────────────────────────────────────────────────────────────────╯\\x1b[0m',
        '',
        '\\x1b[38;2;107;114;128m╭──────────────────────────────────────────────────────────────────────────────────────────────╮\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m \\x1b[1m\\x1b[38;2;91;141;239mBash\\x1b[0m npm run typecheck                                                                       \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m✓\\x1b[0m TypeScript compilation successful (2.1s)                                                   \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m╰──────────────────────────────────────────────────────────────────────────────────────────────╯\\x1b[0m',
        '',
        'Extracted the authentication logic into a reusable middleware.',
        'The new \\x1b[1mauthMiddleware\\x1b[0m validates JWTs and handles errors',
        'consistently across all routes. Typecheck passes.',
      ].join('\\r\\n'),
      '${SESSION_API_CLIENT}': [
        '\\x1b[0m\\x1b[38;2;107;114;128m╭─\\x1b[0m \\x1b[1;38;2;91;141;239mWrite\\x1b[0m src/types/api.d.ts\\r\\n',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+ export interface CreateUserRequest {\\x1b[0m\\r\\n',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+   email: string;\\x1b[0m\\r\\n',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+   role: \\'admin\\' | \\'member\\' | \\'viewer\\';\\x1b[0m\\r\\n',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+ }\\x1b[0m\\r\\n',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[2m… 180 more lines\\x1b[0m\\r\\n',
        '\\x1b[38;2;107;114;128m╰─\\x1b[0m\\r\\n',
        '\\r\\n',
        '\\x1b[38;2;16;185;129m✓\\x1b[0m Generated types for all 24 API endpoints.\\r\\n',
      ].join(''),
      '${SESSION_RATE_LIMIT}': '\\x1b[0m' + [
        '',
        '\\x1b[38;2;107;114;128m╭──────────────────────────────────────────────────────────────╮\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m \\x1b[1m\\x1b[38;2;91;141;239mRead\\x1b[0m src/routes/api.ts                                    \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m╰──────────────────────────────────────────────────────────────╯\\x1b[0m',
        '',
        'Added sliding-window rate limiter using Redis sorted sets.',
        'Each user gets 100 req/min on standard endpoints, 20 req/min',
        'on write endpoints. PR #42 is ready for review.',
        '',
        '\\x1b[38;2;16;185;129m✓\\x1b[0m Done. Waiting for next instruction.',
        '',
      ].join('\\r\\n'),
      '${SESSION_INTEGRATION}': '\\x1b[0m' + [
        '\\x1b[38;2;107;114;128m╭──────────────────────────────────────────────────────────────╮\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m \\x1b[1m\\x1b[38;2;91;141;239mBash\\x1b[0m npm test -- --grep auth                              \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m                                                              \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m✓\\x1b[0m auth.integration.ts > login flow (142ms)                \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m✓\\x1b[0m auth.integration.ts > token refresh (89ms)              \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m✓\\x1b[0m auth.integration.ts > logout invalidates session (56ms) \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;245;158;11m◌\\x1b[0m billing.integration.ts > create subscription...         \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m╰──────────────────────────────────────────────────────────────╯\\x1b[0m',
        '',
        '\\x1b[38;2;107;114;128m╭──────────────────────────────────────────────────────────────╮\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m \\x1b[1m\\x1b[38;2;91;141;239mWrite\\x1b[0m tests/billing.integration.ts                        \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+ describe(\\'billing\\', () => {\\x1b[0m                           \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+   it(\\'creates subscription\\', async () => {\\x1b[0m            \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[38;2;16;185;129m+     const sub = await billing.create(plan);\\x1b[0m             \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m│\\x1b[0m  \\x1b[2m… 24 more lines\\x1b[0m                                        \\x1b[38;2;107;114;128m│\\x1b[0m',
        '\\x1b[38;2;107;114;128m╰──────────────────────────────────────────────────────────────╯\\x1b[0m',
      ].join('\\r\\n'),
    };
    // Return empty from getScrollback — content is delivered via onData
    // instead, which avoids the scroll-to-bottom issue with scrollback replay.
    window.electronAPI.sessions.getScrollback = async function () {
      return '';
    };

    // Pump scrollback data via onData. Fire repeatedly until content
    // appears (the scrollbackPending guard may drop early attempts).
    window.electronAPI.sessions.onData = function (callback) {
      var fired = 0;
      var interval = setInterval(function () {
        fired++;
        Object.keys(scrollbackData).forEach(function (sid) {
          if (scrollbackData[sid]) {
            callback(sid, scrollbackData[sid]);
          }
        });
        if (fired >= 3) clearInterval(interval);
      }, 1000);
      return function () { clearInterval(interval); };
    };

    // Override agent.detect to show correct version in context bar
    window.electronAPI.agent.detect = async function () {
      return { found: true, path: '/usr/bin/claude', version: '2.1.104 (Claude Code)' };
    };

    // Override getUsage to return realistic model/cost data
    var origGetUsage = window.electronAPI.sessions.getUsage;
    window.electronAPI.sessions.getUsage = async function () {
      return {
        '${SESSION_WEBSOCKET}': {
          model: { id: 'claude-opus-4-6', displayName: 'Opus 4.6 (1M)' },
          contextWindow: { usedPercentage: 12, usedTokens: 24000, cacheTokens: 8000, totalInputTokens: 18000, totalOutputTokens: 6000, contextWindowSize: 200000 },
          cost: { totalCostUsd: 0.42, totalDurationMs: 45000 },
        },
        '${SESSION_MIDDLEWARE}': {
          model: { id: 'claude-opus-4-6', displayName: 'Opus 4.6 (1M)' },
          contextWindow: { usedPercentage: 53, usedTokens: 106000, cacheTokens: 45000, totalInputTokens: 75000, totalOutputTokens: 31000, contextWindowSize: 200000 },
          cost: { totalCostUsd: 2.47, totalDurationMs: 180000 },
          rateLimits: [
            { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 20, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 8, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 5 },
          ],
        },
        '${SESSION_API_CLIENT}': {
          model: { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
          contextWindow: { usedPercentage: 65, usedTokens: 130000, cacheTokens: 45000, totalInputTokens: 95000, totalOutputTokens: 35000, contextWindowSize: 200000 },
          cost: { totalCostUsd: 2.87, totalDurationMs: 420000 },
        },
        '${SESSION_RATE_LIMIT}': {
          model: { id: 'claude-opus-4-6', displayName: 'Opus 4.6 (1M)' },
          contextWindow: { usedPercentage: 51, usedTokens: 102000, cacheTokens: 40000, totalInputTokens: 72000, totalOutputTokens: 30000, contextWindowSize: 200000 },
          cost: { totalCostUsd: 4.15, totalDurationMs: 600000 },
        },
        '${SESSION_INTEGRATION}': {
          model: { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
          contextWindow: { usedPercentage: 22, usedTokens: 44000, cacheTokens: 15000, totalInputTokens: 32000, totalOutputTokens: 12000, contextWindowSize: 200000 },
          cost: { totalCostUsd: 0.78, totalDurationMs: 90000 },
        },
      };
    };
  `;
}
