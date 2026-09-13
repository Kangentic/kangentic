/**
 * The sample install: three projects in two groups, their boards, sessions, backlog, usage, and
 * the terminal recordings behind every running session. One dataset, two consumers: the marketing
 * captures (through `buildMarketingPreConfig()` in marketing-fixture.ts) and the web build
 * (demo/vite.config.mts), so the two cannot drift.
 *
 * Names were chosen with the user on GitHub star and fork data (see demo/README.md): Contoso is
 * the one placeholder company developers in the Microsoft world already know, spring-petclinic
 * is the most-forked sample repo on GitHub, and Online Boutique is the cloud-native reference app.
 *
 * Every timestamp is an OFFSET from boot (`minutesAgo`), so a card reads "3 min ago" whenever the
 * frame opens; a capture that needs a fixed clock pins `Date.now` on the page.
 *
 * No Node imports on purpose: the returned script string runs inside the page against the mock,
 * and demo/vite.config.mts serializes this module into the static build.
 */

export interface DemoScrollbackMap {
  /** Session id to the serialized terminal stream replayed into that session's xterm. */
  [sessionId: string]: string;
}

/** One file of a recorded working tree, in the shape the mock's git.diffFiles returns. */
export interface DemoDiffFile {
  path: string;
  status: string;
  binary?: boolean;
  insertions: number;
  deletions: number;
  original: string;
  modified: string;
  language: string | null;
}

export interface DemoDiff {
  files: DemoDiffFile[];
  totalInsertions: number;
  totalDeletions: number;
}

export interface DemoChangesMap {
  /** Session id to the working tree its agent left behind. */
  [sessionId: string]: DemoDiff;
}

interface DemoProjectGroup {
  id: string;
  name: string;
  position: number;
  is_collapsed: boolean;
}

interface DemoProject {
  id: string;
  name: string;
  path: string;
  github_url: string | null;
  default_agent: string;
  group_id: string | null;
  position: number;
  lastOpenedMinutesAgo: number;
  createdDaysAgo: number;
}

interface DemoLane {
  slug: string;
  name: string;
  role: 'todo' | 'done' | null;
  color: string;
  icon: string;
  is_archived: boolean;
  auto_spawn: boolean;
  permission_mode: string | null;
  /** The column's agent (the swimlane's agent_override); null inherits the project default. */
  agent: string | null;
}

interface DemoTask {
  id: string;
  projectId: string;
  display_id: number;
  title: string;
  description: string;
  lane: string;
  position: number;
  agent: string | null;
  session_id: string | null;
  worktree_folder: string | null;
  branch_name: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: 'open' | 'draft' | 'merged' | 'closed' | null;
  pr_merge_readiness: 'ready' | 'blocked' | 'conflicting' | 'queued' | 'running' | 'unknown' | null;
  base_branch: string | null;
  labels: string[];
  priority: number;
  attachment_count: number;
  createdDaysAgo: number;
  updatedMinutesAgo: number;
  archivedDaysAgo?: number;
}

interface DemoSession {
  id: string;
  taskId: string | null;
  projectId: string;
  agent: string;
  status: 'running' | 'suspended' | 'queued';
  activity: 'thinking' | 'idle' | 'permission' | null;
  /** How long before its recording's end the live frame opens this working session, when not the manifest's liveTailMs. */
  liveTailMs?: number;
  startedMinutesAgo: number;
  model: { id: string; displayName: string } | null;
  effort: string | null;
  permissionMode: string;
  contextPercent: number | null;
  contextWindowSize: number;
  costUsd: number;
  durationMinutes: number;
  peek: string[];
  events: Array<{ minutesAgo: number; tool: string; detail: string }>;
  transient?: boolean;
  commandTerminalBranch?: string;
  isolated?: boolean;
  rateLimits?: boolean;
}

interface DemoBacklogItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
  position: number;
  external_source: string | null;
  external_id: string | null;
  external_url: string | null;
  createdDaysAgo: number;
}

// ---------------------------------------------------------------- ids
export const PROJECT_CONTOSO = 'proj-contoso-web';
export const PROJECT_PETCLINIC = 'proj-spring-petclinic';
export const PROJECT_BOUTIQUE = 'proj-online-boutique';
export const GROUP_CONTOSO = 'group-contoso';
export const GROUP_OSS = 'group-open-source';

export const TASK_MIDDLEWARE = 'task-cw-middleware';
export const SESSION_WEBSOCKET = 'sess-cw-websocket';
export const SESSION_MIDDLEWARE = 'sess-cw-middleware';
export const SESSION_API_CLIENT = 'sess-cw-api-client';
export const SESSION_RATE_LIMIT = 'sess-cw-rate-limit';
export const SESSION_INTEGRATION = 'sess-cw-integration';
export const SESSION_CONTOSO_TERMINAL = 'sess-cw-terminal-1';
export const SESSION_PETCLINIC_FLAKY = 'sess-pc-flaky-tests';
export const SESSION_PETCLINIC_SEARCH = 'sess-pc-owner-search';
export const SESSION_PETCLINIC_CACHE = 'sess-pc-caffeine';
export const SESSION_BOUTIQUE_REDIS = 'sess-ob-redis-ttl';
export const SESSION_BOUTIQUE_MTLS = 'sess-ob-mtls';
export const SESSION_BOUTIQUE_A11Y = 'sess-ob-currency-a11y';
export const SESSION_BOUTIQUE_OTEL = 'sess-ob-otel';
export const SESSION_EMPTY_STATES = 'sess-cw-empty-states';
export const SESSION_VITE8 = 'sess-cw-vite8';
export const SESSION_PETCLINIC_BOOT35 = 'sess-pc-boot-35';

// The sample install is a Windows machine, as the recording machine and the mock's platform are.
const HOME = 'C:\\Users\\dev';
/** Where a task's worktree lives under its project, as the desktop lays it out. */
const WORKTREE_SUBPATH = '\\.kangentic\\worktrees\\';

export const DEMO_GROUPS: DemoProjectGroup[] = [
  // Named for the client rather than the category, which is how an agency groups a sidebar and
  // which says WHY these are grouped. "Open source" stays a category beside it: mixing the two
  // shapes is what real sidebars do, and the two repos under it are recognizable enough that
  // calling them "other" would undersell them.
  { id: GROUP_CONTOSO, name: 'Contoso', position: 0, is_collapsed: false },
  { id: GROUP_OSS, name: 'Open source', position: 1, is_collapsed: false },
];

export const DEMO_PROJECTS: DemoProject[] = [
  { id: PROJECT_CONTOSO, name: 'contoso-web', path: `${HOME}\\work\\contoso-web`, github_url: 'https://github.com/contoso/contoso-web', default_agent: 'claude', group_id: GROUP_CONTOSO, position: 0, lastOpenedMinutesAgo: 2, createdDaysAgo: 140 },
  { id: PROJECT_PETCLINIC, name: 'spring-petclinic', path: `${HOME}\\oss\\spring-petclinic`, github_url: 'https://github.com/spring-projects/spring-petclinic', default_agent: 'codex', group_id: GROUP_OSS, position: 1, lastOpenedMinutesAgo: 35, createdDaysAgo: 61 },
  { id: PROJECT_BOUTIQUE, name: 'online-boutique', path: `${HOME}\\oss\\online-boutique`, github_url: 'https://github.com/GoogleCloudPlatform/microservices-demo', default_agent: 'codex', group_id: GROUP_OSS, position: 2, lastOpenedMinutesAgo: 90, createdDaysAgo: 24 },
];

/** The seven default lanes, mirroring src/main/db/migrations/default-data.ts. */
const DEFAULT_LANES: DemoLane[] = [
  { slug: 'todo', name: 'To Do', role: 'todo', color: '#6b7280', icon: 'layers', is_archived: false, auto_spawn: false, permission_mode: null, agent: null },
  { slug: 'planning', name: 'Planning', role: null, color: '#8b5cf6', icon: 'map', is_archived: false, auto_spawn: true, permission_mode: 'plan', agent: null },
  { slug: 'executing', name: 'Executing', role: null, color: '#3b82f6', icon: 'square-terminal', is_archived: false, auto_spawn: true, permission_mode: null, agent: null },
  { slug: 'review', name: 'Code Review', role: null, color: '#f59e0b', icon: 'code', is_archived: false, auto_spawn: true, permission_mode: null, agent: null },
  { slug: 'testing', name: 'Testing', role: null, color: '#06b6d4', icon: 'flask-conical', is_archived: false, auto_spawn: true, permission_mode: null, agent: null },
  { slug: 'merge', name: 'Merge', role: null, color: '#f97316', icon: 'merge', is_archived: false, auto_spawn: true, permission_mode: null, agent: null },
  { slug: 'done', name: 'Done', role: 'done', color: '#10b981', icon: 'circle-check-big', is_archived: true, auto_spawn: false, permission_mode: null, agent: null },
];

/** contoso-web names Claude on every auto-spawn column past Executing, the way a configured board does. */
const CONTOSO_LANES: DemoLane[] = [
  ...DEFAULT_LANES.slice(0, 3),
  ...DEFAULT_LANES.slice(3).map((lane) => (lane.auto_spawn ? { ...lane, agent: 'claude' } : lane)),
];

export const DEMO_LANES_BY_PROJECT: Record<string, DemoLane[]> = {
  [PROJECT_CONTOSO]: CONTOSO_LANES,
  [PROJECT_PETCLINIC]: DEFAULT_LANES,
  [PROJECT_BOUTIQUE]: DEFAULT_LANES,
};

/**
 * A label is coloured only when the colour changes what the reader does about it: something is
 * broken (red) or something is slow (amber). Everything else classifies the work rather than
 * flagging it, so it takes one muted slate and stays quiet.
 *
 * This is deliberately not a colour per label. Twelve saturated hues put seven of them on the
 * contoso board at once, which reads as decoration rather than as a team's convention, and a
 * board that looks decorated is the first thing a viewer distrusts about a demo. A new label
 * joins the slate group unless it means broken or slow.
 */
/*
 * A label carries ONE hex, and the frame ships a dark default theme and a light one (the site
 * embeds theme=sand), so each colour is judged on its WORST contrast across the two rather than on
 * how it looks in whichever was opened last. There is a hard ceiling on that: a single colour
 * cannot clear 4.5 against both a near-black and a near-white ground, because the luminance that
 * maximises the worse side lands at about 4.07 for both. So these are chosen to sit as close to
 * that ceiling as a recognizable palette step allows, and 4.5 is not reachable by any hex.
 *
 * Measured against #18181b and #faf7f2, worst of the two: broken 3.67, slow 3.53, neutral 3.72.
 * Broken was red-700 (#b91c1c) until it was measured at 2.74 on the dark theme, which is a fail,
 * not a near miss: it is a light-background colour, and the frame's default ground is dark.
 * red-600 is the step that trades the least light-theme contrast for the most dark-theme contrast.
 * Slow and neutral already sat at their families' best worst-case and did not move.
 */
const LABEL_BROKEN = '#dc2626';
const LABEL_SLOW = '#b45309';
const LABEL_NEUTRAL = '#64748b';

export const DEMO_LABEL_COLORS: Record<string, string> = {
  bug: LABEL_BROKEN,
  security: LABEL_BROKEN,
  perf: LABEL_SLOW,
  feature: LABEL_NEUTRAL,
  refactor: LABEL_NEUTRAL,
  auth: LABEL_NEUTRAL,
  api: LABEL_NEUTRAL,
  tests: LABEL_NEUTRAL,
  design: LABEL_NEUTRAL,
  chore: LABEL_NEUTRAL,
  a11y: LABEL_NEUTRAL,
  docs: LABEL_NEUTRAL,
};

function worktree(projectPath: string, folder: string | null): string | null {
  return folder ? `${projectPath}${WORKTREE_SUBPATH}${folder}` : null;
}

// ---------------------------------------------------------------- tasks
const CONTOSO = `${HOME}\\work\\contoso-web`;
const PETCLINIC = `${HOME}\\oss\\spring-petclinic`;
const BOUTIQUE = `${HOME}\\oss\\online-boutique`;

export const DEMO_TASKS: DemoTask[] = [
  // contoso-web
  { id: 'task-cw-auth', projectId: PROJECT_CONTOSO, display_id: 1, title: 'Add user auth flow', description: 'Implement OAuth2 login with GitHub and Google providers', lane: 'todo', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['feature', 'auth'], priority: 2, attachment_count: 1, createdDaysAgo: 3, updatedMinutesAgo: 340 },
  { id: 'task-cw-api-errors', projectId: PROJECT_CONTOSO, display_id: 2, title: 'Refactor API error handling', description: 'Standardize error responses and add error codes', lane: 'todo', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['refactor', 'api'], priority: 1, attachment_count: 0, createdDaysAgo: 5, updatedMinutesAgo: 1500 },
  { id: 'task-cw-websocket', projectId: PROJECT_CONTOSO, display_id: 3, title: 'Fix WebSocket reconnection', description: 'Handle dropped connections with exponential backoff', lane: 'planning', position: 0, agent: 'claude', session_id: SESSION_WEBSOCKET, worktree_folder: 'fix-websocket-abc123', branch_name: 'fix-websocket-reconnection', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['bug'], priority: 3, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 4 },
  { id: TASK_MIDDLEWARE, projectId: PROJECT_CONTOSO, display_id: 4, title: 'Extract auth middleware', description: 'Move auth logic into reusable Express middleware', lane: 'executing', position: 0, agent: 'claude', session_id: SESSION_MIDDLEWARE, worktree_folder: 'auth-middleware-def456', branch_name: 'extract-auth-middleware', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['refactor', 'auth'], priority: 2, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 1 },
  { id: 'task-cw-api-client', projectId: PROJECT_CONTOSO, display_id: 5, title: 'Generate API client types', description: 'Request and response interfaces for every route in server/routes.ts, and apiFetch generic over them', lane: 'executing', position: 1, agent: 'claude', session_id: SESSION_API_CLIENT, worktree_folder: 'api-types-ghi789', branch_name: 'generate-api-types', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['feature', 'api'], priority: 1, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 12 },
  { id: 'task-cw-empty-states', projectId: PROJECT_CONTOSO, display_id: 8, title: 'Onboarding empty states', description: 'First-run screens for the dashboard, projects, and billing pages before any data exists', lane: 'planning', position: 1, agent: null, session_id: SESSION_EMPTY_STATES, worktree_folder: 'empty-states-stu901', branch_name: 'onboarding-empty-states', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['design'], priority: 2, attachment_count: 3, createdDaysAgo: 4, updatedMinutesAgo: 95 },
  { id: 'task-cw-rate-limit', projectId: PROJECT_CONTOSO, display_id: 6, title: 'Add rate limiting', description: 'Implement per-user rate limiting on API endpoints', lane: 'review', position: 0, agent: 'copilot', session_id: SESSION_RATE_LIMIT, worktree_folder: 'rate-limit-jkl012', branch_name: 'add-rate-limiting', pr_number: 42, pr_url: 'https://github.com/contoso/contoso-web/pull/42', pr_state: 'open', base_branch: 'main', labels: ['feature', 'api'], priority: 2, attachment_count: 0, createdDaysAgo: 3, updatedMinutesAgo: 22 },
  { id: 'task-cw-integration', projectId: PROJECT_CONTOSO, display_id: 7, title: 'Integration test coverage', description: 'Add integration tests for auth and billing flows', lane: 'testing', position: 0, agent: 'cursor', session_id: SESSION_INTEGRATION, worktree_folder: 'integration-tests-mno345', branch_name: 'integration-tests', pr_number: 38, pr_url: 'https://github.com/contoso/contoso-web/pull/38', pr_state: 'open', pr_merge_readiness: 'blocked', base_branch: 'main', labels: ['tests'], priority: 1, attachment_count: 0, createdDaysAgo: 4, updatedMinutesAgo: 6 },
  { id: 'task-cw-vite8', projectId: PROJECT_CONTOSO, display_id: 9, title: 'Upgrade to Vite 8', description: 'Move the build to Vite 8 and drop the legacy Rollup plugins', lane: 'merge', position: 0, agent: null, session_id: SESSION_VITE8, worktree_folder: 'vite-8-pqr678', branch_name: 'upgrade-vite-8', pr_number: 45, pr_url: 'https://github.com/contoso/contoso-web/pull/45', pr_state: 'open', pr_merge_readiness: 'ready', base_branch: 'main', labels: ['chore'], priority: 1, attachment_count: 0, createdDaysAgo: 6, updatedMinutesAgo: 48 },
  { id: 'task-cw-done-deploy', projectId: PROJECT_CONTOSO, display_id: 10, title: 'Set up CI/CD pipeline', description: 'GitHub Actions for build, test, deploy', lane: 'done', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: 'setup-cicd', pr_number: 31, pr_url: 'https://github.com/contoso/contoso-web/pull/31', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['chore'], priority: 0, attachment_count: 0, createdDaysAgo: 12, updatedMinutesAgo: 4300, archivedDaysAgo: 3 },
  { id: 'task-cw-done-schema', projectId: PROJECT_CONTOSO, display_id: 11, title: 'Database schema migration', description: 'Add billing tables and indexes', lane: 'done', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: 'billing-schema', pr_number: 35, pr_url: 'https://github.com/contoso/contoso-web/pull/35', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['feature'], priority: 0, attachment_count: 0, createdDaysAgo: 10, updatedMinutesAgo: 2900, archivedDaysAgo: 2 },
  { id: 'task-cw-done-logging', projectId: PROJECT_CONTOSO, display_id: 12, title: 'Structured logging', description: 'Replace console.log with pino structured logging', lane: 'done', position: 2, agent: null, session_id: null, worktree_folder: null, branch_name: 'structured-logging', pr_number: 37, pr_url: 'https://github.com/contoso/contoso-web/pull/37', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['refactor'], priority: 0, attachment_count: 0, createdDaysAgo: 8, updatedMinutesAgo: 1450, archivedDaysAgo: 1 },

  // spring-petclinic
  { id: 'task-pc-vets-paging', projectId: PROJECT_PETCLINIC, display_id: 1, title: 'Add pagination to the vets list', description: 'The /vets page renders every vet; page it like the owners list and keep the JSON endpoint stable', lane: 'todo', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['feature'], priority: 1, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 600 },
  { id: 'task-pc-layout-dialect', projectId: PROJECT_PETCLINIC, display_id: 2, title: 'Replace Thymeleaf fragments with the layout dialect', description: 'Every template repeats the header and footer fragments; move to one layout', lane: 'todo', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['refactor'], priority: 0, attachment_count: 0, createdDaysAgo: 7, updatedMinutesAgo: 2100 },
  { id: 'task-pc-testcontainers', projectId: PROJECT_PETCLINIC, display_id: 3, title: 'Migrate integration tests to Testcontainers', description: 'Replace the MySQL and Postgres docker-compose profiles in the integration tests with Testcontainers', lane: 'planning', position: 0, agent: 'codex', session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['tests'], priority: 2, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 3 },
  { id: 'task-pc-flaky-tests', projectId: PROJECT_PETCLINIC, display_id: 4, title: 'Fix flaky PetClinicIntegrationTests on MySQL', description: 'testOwnerDetails fails one run in ten on the MySQL profile; suspect the visit ordering', lane: 'executing', position: 0, agent: 'codex', session_id: SESSION_PETCLINIC_FLAKY, worktree_folder: 'flaky-mysql-9b8c7d', branch_name: 'fix-flaky-mysql-integration', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['bug', 'tests'], priority: 3, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 2 },
  { id: 'task-pc-owner-search', projectId: PROJECT_PETCLINIC, display_id: 5, title: 'Add owner search by phone number', description: 'The find-owners form only searches last name; add a telephone field and a repository query', lane: 'executing', position: 1, agent: 'gemini', session_id: SESSION_PETCLINIC_SEARCH, worktree_folder: 'owner-phone-search-1e2d3c', branch_name: 'owner-search-by-phone', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['feature'], priority: 1, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 9 },
  { id: 'task-pc-boot-35', projectId: PROJECT_PETCLINIC, display_id: 6, title: 'Upgrade the toolchain to Java 25', description: 'java.version in pom.xml, the GitHub Actions matrix, and the Dockerfile base image', lane: 'review', position: 0, agent: 'claude', session_id: SESSION_PETCLINIC_BOOT35, worktree_folder: 'java-25-7a6b5c', branch_name: 'java-25-toolchain', pr_number: 1412, pr_url: 'https://github.com/spring-projects/spring-petclinic/pull/1412', pr_state: 'draft', pr_merge_readiness: null, base_branch: 'main', labels: ['chore'], priority: 2, attachment_count: 0, createdDaysAgo: 3, updatedMinutesAgo: 130 },
  { id: 'task-pc-caffeine', projectId: PROJECT_PETCLINIC, display_id: 7, title: 'Cache vets with Caffeine instead of JCache', description: 'Drop the JCache config in favour of the Caffeine starter; keep the cache name so the actuator view stays', lane: 'testing', position: 0, agent: 'opencode', session_id: SESSION_PETCLINIC_CACHE, worktree_folder: 'caffeine-cache-3c4d5e', branch_name: 'vets-cache-caffeine', pr_number: 1408, pr_url: 'https://github.com/spring-projects/spring-petclinic/pull/1408', pr_state: 'open', base_branch: 'main', labels: ['perf'], priority: 1, attachment_count: 0, createdDaysAgo: 4, updatedMinutesAgo: 17 },
  { id: 'task-pc-done-java21', projectId: PROJECT_PETCLINIC, display_id: 8, title: 'Bump Java to 21', description: 'Toolchain, CI matrix, and the Dockerfile base image', lane: 'done', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: 'java-21', pr_number: 1391, pr_url: 'https://github.com/spring-projects/spring-petclinic/pull/1391', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['chore'], priority: 0, attachment_count: 0, createdDaysAgo: 14, updatedMinutesAgo: 8600, archivedDaysAgo: 5 },
  { id: 'task-pc-done-postgres', projectId: PROJECT_PETCLINIC, display_id: 9, title: 'Add a Postgres profile', description: 'application-postgres.properties plus the docker-compose service', lane: 'done', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: 'postgres-profile', pr_number: 1397, pr_url: 'https://github.com/spring-projects/spring-petclinic/pull/1397', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['feature'], priority: 0, attachment_count: 0, createdDaysAgo: 11, updatedMinutesAgo: 7200, archivedDaysAgo: 4 },

  // online-boutique
  { id: 'task-ob-checkout-retry', projectId: PROJECT_BOUTIQUE, display_id: 1, title: 'Add retry with backoff to checkoutservice gRPC calls', description: 'PlaceOrder fails hard when paymentservice restarts; wrap the client calls with a bounded exponential retry', lane: 'todo', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['bug'], priority: 3, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 400 },
  { id: 'task-ob-locust', projectId: PROJECT_BOUTIQUE, display_id: 2, title: 'Locust load profile for cartservice', description: 'Extend loadgenerator with a cart-heavy scenario so the Redis change can be measured', lane: 'todo', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['tests', 'perf'], priority: 1, attachment_count: 0, createdDaysAgo: 3, updatedMinutesAgo: 1900 },
  { id: 'task-ob-py313', projectId: PROJECT_BOUTIQUE, display_id: 3, title: 'Move recommendationservice to Python 3.13', description: 'Base image, grpcio pin, and the profiler dependency that has no 3.13 wheel yet', lane: 'planning', position: 0, agent: 'codex', session_id: null, worktree_folder: null, branch_name: null, pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: null, labels: ['chore'], priority: 1, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 240 },
  { id: 'task-ob-redis-ttl', projectId: PROJECT_BOUTIQUE, display_id: 4, title: 'cartservice: expire abandoned carts in Redis', description: 'Carts never expire; set a TTL on write and refresh it on read so the memory store stops growing', lane: 'executing', position: 0, agent: 'codex', session_id: SESSION_BOUTIQUE_REDIS, worktree_folder: 'cart-ttl-8d9e0f', branch_name: 'cartservice-redis-ttl', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['bug', 'perf'], priority: 2, attachment_count: 0, createdDaysAgo: 1, updatedMinutesAgo: 5 },
  { id: 'task-ob-mtls', projectId: PROJECT_BOUTIQUE, display_id: 5, title: 'Istio strict mTLS for the frontend namespace', description: 'PeerAuthentication in STRICT mode plus the DestinationRules the frontend needs to keep talking to the services', lane: 'executing', position: 1, agent: 'opencode', session_id: SESSION_BOUTIQUE_MTLS, worktree_folder: 'istio-mtls-2b3c4d', branch_name: 'istio-strict-mtls', pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, base_branch: 'main', labels: ['security'], priority: 2, attachment_count: 0, createdDaysAgo: 2, updatedMinutesAgo: 41 },
  { id: 'task-ob-currency-a11y', projectId: PROJECT_BOUTIQUE, display_id: 6, title: 'Frontend: currency selector keyboard and screen-reader support', description: 'The header currency dropdown is a styled div; make it a real select with a label', lane: 'review', position: 0, agent: 'copilot', session_id: SESSION_BOUTIQUE_A11Y, worktree_folder: 'currency-a11y-5e6f7a', branch_name: 'frontend-currency-a11y', pr_number: 2941, pr_url: 'https://github.com/GoogleCloudPlatform/microservices-demo/pull/2941', pr_state: 'open', pr_merge_readiness: 'conflicting', base_branch: 'main', labels: ['a11y'], priority: 1, attachment_count: 0, createdDaysAgo: 3, updatedMinutesAgo: 75 },
  { id: 'task-ob-otel', projectId: PROJECT_BOUTIQUE, display_id: 7, title: 'OpenTelemetry traces for shippingservice', description: 'Instrument the gRPC server with the otel Go SDK and export to the collector already in the cluster', lane: 'testing', position: 0, agent: 'codex', session_id: SESSION_BOUTIQUE_OTEL, worktree_folder: 'otel-shipping-6f7a8b', branch_name: 'shippingservice-otel', pr_number: 2937, pr_url: 'https://github.com/GoogleCloudPlatform/microservices-demo/pull/2937', pr_state: 'open', base_branch: 'main', labels: ['feature'], priority: 1, attachment_count: 0, createdDaysAgo: 4, updatedMinutesAgo: 30 },
  { id: 'task-ob-done-go124', projectId: PROJECT_BOUTIQUE, display_id: 8, title: 'Bump Go to 1.24 across services', description: 'go.mod, the Dockerfiles, and the release workflow', lane: 'done', position: 0, agent: null, session_id: null, worktree_folder: null, branch_name: 'go-1-24', pr_number: 2921, pr_url: 'https://github.com/GoogleCloudPlatform/microservices-demo/pull/2921', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['chore'], priority: 0, attachment_count: 0, createdDaysAgo: 9, updatedMinutesAgo: 5800, archivedDaysAgo: 3 },
  { id: 'task-ob-done-skaffold', projectId: PROJECT_BOUTIQUE, display_id: 9, title: 'Update the Skaffold profiles for the new registry', description: 'Image names and the kustomize overlays', lane: 'done', position: 1, agent: null, session_id: null, worktree_folder: null, branch_name: 'skaffold-registry', pr_number: 2915, pr_url: 'https://github.com/GoogleCloudPlatform/microservices-demo/pull/2915', pr_state: 'merged', pr_merge_readiness: null, base_branch: 'main', labels: ['chore', 'docs'], priority: 0, attachment_count: 0, createdDaysAgo: 12, updatedMinutesAgo: 9000, archivedDaysAgo: 6 },
];

// ---------------------------------------------------------------- sessions
// The models the recordings were made on, named the way each CLI prints them.
const OPUS = { id: 'claude-opus-5', displayName: 'Opus 5 (1M)' };
const CODEX = { id: 'gpt-5.5', displayName: 'GPT-5.5' };
const GEMINI = { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash' };
const OPENCODE = { id: 'opencode/big-pickle', displayName: 'Big Pickle' };
const COPILOT = { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' };
// Cursor and Gemini both run their session on a router rather than a named model, and print that
// router ("Auto") in their own status line. Kangentic does not show a router: it reads the model
// the router RESOLVED to, from Cursor's init event and Gemini's session history, so a card names a
// real model. These are the two the recordings' context windows fit, 1M each: gemini-3-flash is
// the Flash tier in resolveGeminiContextWindowSize (Pro is 2M), and the Cursor id and its display
// string are as "cursor-agent --list-models" prints them, which is Sonnet-first, not 4.5-first.
const CURSOR = { id: 'claude-4.5-sonnet', displayName: 'Claude Sonnet 4.5' };
/** The model a fresh spawn of each agent runs on, for the context bar of a session a visitor starts. */
const MODEL_BY_AGENT: Record<string, { id: string; displayName: string }> = { claude: OPUS, codex: CODEX, gemini: GEMINI, opencode: OPENCODE, copilot: COPILOT, cursor: CURSOR };
/** The mock's global default, which a lane with no permission mode of its own spawns in. */
const DEFAULT_PERMISSION_MODE = 'acceptEdits';

export const DEMO_SESSIONS: DemoSession[] = [
  { id: SESSION_WEBSOCKET, taskId: 'task-cw-websocket', projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'permission', startedMinutesAgo: 14, model: OPUS, effort: 'medium', permissionMode: 'plan', contextPercent: 12, contextWindowSize: 1000000, costUsd: 0.42, durationMinutes: 14, peek: ['Read src/lib/websocket.ts, src/App.tsx', 'Claude has written up a plan and is ready to execute'], events: [{ minutesAgo: 2, tool: 'Read', detail: 'src/lib/websocket.ts' }, { minutesAgo: 1, tool: 'Grep', detail: 'websocket' }, { minutesAgo: 0.3, tool: 'ExitPlanMode', detail: 'Plan ready for approval' }], rateLimits: true },
  { id: SESSION_MIDDLEWARE, taskId: TASK_MIDDLEWARE, projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'thinking', startedMinutesAgo: 47, model: OPUS, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 53, contextWindowSize: 1000000, costUsd: 2.47, durationMinutes: 47, peek: ['Write server/middleware/auth.ts', 'Edit server/routes.ts', 'Bash npm test'], events: [{ minutesAgo: 6, tool: 'Read', detail: 'server/routes.ts' }, { minutesAgo: 4, tool: 'Write', detail: 'server/middleware/auth.ts' }, { minutesAgo: 2, tool: 'Edit', detail: 'server/routes.ts' }, { minutesAgo: 0.5, tool: 'Bash', detail: 'npm test' }], rateLimits: true },
  { id: SESSION_API_CLIENT, taskId: 'task-cw-api-client', projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'thinking', liveTailMs: 150000, startedMinutesAgo: 88, model: OPUS, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 65, contextWindowSize: 1000000, costUsd: 2.87, durationMinutes: 88, peek: ['Write src/types/api.ts', 'Edit src/lib/http-client.ts', 'Bash npm run typecheck'], events: [{ minutesAgo: 4, tool: 'Write', detail: 'src/types/api.ts' }, { minutesAgo: 2, tool: 'Edit', detail: 'src/lib/http-client.ts' }, { minutesAgo: 0.5, tool: 'Bash', detail: 'npm run typecheck' }] },
  { id: SESSION_RATE_LIMIT, taskId: 'task-cw-rate-limit', projectId: PROJECT_CONTOSO, agent: 'copilot', status: 'running', activity: 'idle', startedMinutesAgo: 130, model: COPILOT, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 51, contextWindowSize: 1000000, costUsd: 4.15, durationMinutes: 130, peek: ['Read server/rate-limit.ts', 'Edit server/rate-limit.ts', 'Bash npm test'], events: [{ minutesAgo: 24, tool: 'Read', detail: 'server/rate-limit.ts' }, { minutesAgo: 22, tool: 'Edit', detail: 'server/rate-limit.ts' }, { minutesAgo: 20, tool: 'Bash', detail: 'npm test' }], isolated: true },
  { id: SESSION_INTEGRATION, taskId: 'task-cw-integration', projectId: PROJECT_CONTOSO, agent: 'cursor', status: 'running', activity: 'idle', startedMinutesAgo: 26, model: CURSOR, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 9, contextWindowSize: 1000000, costUsd: 0.78, durationMinutes: 26, peek: ['Read server/routes.ts', 'Write tests/auth.integration.test.ts'], events: [{ minutesAgo: 3, tool: 'Read', detail: 'server/routes.ts' }, { minutesAgo: 1, tool: 'Write', detail: 'tests/auth.integration.test.ts' }] },
  { id: SESSION_CONTOSO_TERMINAL, taskId: null, projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'idle', startedMinutesAgo: 9, model: OPUS, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 4, contextWindowSize: 1000000, costUsd: 0.06, durationMinutes: 9, peek: ['Summarize what this repository does', 'Baked for 13s'], events: [], transient: true, commandTerminalBranch: 'main' },
  { id: SESSION_EMPTY_STATES, taskId: 'task-cw-empty-states', projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'permission', startedMinutesAgo: 98, model: OPUS, effort: 'medium', permissionMode: 'plan', contextPercent: 16, contextWindowSize: 1000000, costUsd: 0.38, durationMinutes: 98, peek: ['Read src/App.tsx', 'Claude has written up a plan and is ready to execute'], events: [{ minutesAgo: 12, tool: 'Read', detail: 'src/App.tsx' }, { minutesAgo: 9, tool: 'Grep', detail: 'empty' }, { minutesAgo: 6, tool: 'ExitPlanMode', detail: 'Plan ready for approval' }], rateLimits: true },
  { id: SESSION_VITE8, taskId: 'task-cw-vite8', projectId: PROJECT_CONTOSO, agent: 'claude', status: 'running', activity: 'permission', startedMinutesAgo: 51, model: OPUS, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 31, contextWindowSize: 1000000, costUsd: 1.05, durationMinutes: 51, peek: ['Bash npx tsc --noEmit', 'Claude wants to fetch content from vitest.dev'], events: [{ minutesAgo: 14, tool: 'Read', detail: 'package.json' }, { minutesAgo: 6, tool: 'Bash', detail: 'npx tsc --noEmit' }, { minutesAgo: 2, tool: 'WebFetch', detail: 'https://vitest.dev/guide/migration.html' }] },

  { id: SESSION_PETCLINIC_FLAKY, taskId: 'task-pc-flaky-tests', projectId: PROJECT_PETCLINIC, agent: 'codex', status: 'running', activity: 'thinking', startedMinutesAgo: 21, model: CODEX, effort: 'medium', permissionMode: 'bypassPermissions', contextPercent: 34, contextWindowSize: 400000, costUsd: 0.91, durationMinutes: 21, peek: ['Read PetClinicIntegrationTests.java', 'rg -n @OrderBy src/main/java'], events: [{ minutesAgo: 8, tool: 'Read', detail: 'src/test/java/org/springframework/samples/petclinic/PetClinicIntegrationTests.java' }, { minutesAgo: 2, tool: 'Bash', detail: 'rg -n "@OrderBy\\(" src/main/java' }] },
  { id: SESSION_PETCLINIC_SEARCH, taskId: 'task-pc-owner-search', projectId: PROJECT_PETCLINIC, agent: 'gemini', status: 'running', activity: 'permission', startedMinutesAgo: 39, model: GEMINI, effort: null, permissionMode: 'default', contextPercent: 18, contextWindowSize: 1000000, costUsd: 0.33, durationMinutes: 39, peek: ['ReadFolder src/main/java/org/springframework/samples/petclinic/owner', 'Allow execution of [Shell] .\\gradlew.bat test?'], events: [{ minutesAgo: 12, tool: 'ReadFile', detail: 'src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java' }, { minutesAgo: 9, tool: 'Shell', detail: '.\\gradlew.bat test' }] },
  { id: SESSION_PETCLINIC_CACHE, taskId: 'task-pc-caffeine', projectId: PROJECT_PETCLINIC, agent: 'opencode', status: 'running', activity: 'idle', startedMinutesAgo: 58, model: OPENCODE, effort: null, permissionMode: 'acceptEdits', contextPercent: 27, contextWindowSize: 200000, costUsd: 0, durationMinutes: 58, peek: ['Read src/main/java/org/springframework/samples/petclinic/system/CacheConfiguration.java', 'Grep cache'], events: [{ minutesAgo: 17, tool: 'Read', detail: 'src/main/java/org/springframework/samples/petclinic/system/CacheConfiguration.java' }, { minutesAgo: 9, tool: 'Grep', detail: 'cache' }] },
  { id: SESSION_PETCLINIC_BOOT35, taskId: 'task-pc-boot-35', projectId: PROJECT_PETCLINIC, agent: 'claude', status: 'running', activity: 'permission', startedMinutesAgo: 133, model: OPUS, effort: 'medium', permissionMode: 'acceptEdits', contextPercent: 24, contextWindowSize: 1000000, costUsd: 0.83, durationMinutes: 133, peek: ['Edit pom.xml', 'Edit .github/workflows/maven-build.yml'], events: [{ minutesAgo: 40, tool: 'Read', detail: 'pom.xml' }, { minutesAgo: 36, tool: 'Edit', detail: 'pom.xml' }, { minutesAgo: 33, tool: 'Edit', detail: '.github/workflows/maven-build.yml' }] },

  { id: SESSION_BOUTIQUE_REDIS, taskId: 'task-ob-redis-ttl', projectId: PROJECT_BOUTIQUE, agent: 'codex', status: 'running', activity: 'idle', startedMinutesAgo: 33, model: CODEX, effort: 'medium', permissionMode: 'bypassPermissions', contextPercent: 41, contextWindowSize: 400000, costUsd: 1.12, durationMinutes: 33, peek: ['Read src/cartservice/src/cartstore/RedisCartStore.cs', 'Edit RedisCartStore.cs'], events: [{ minutesAgo: 9, tool: 'Read', detail: 'src/cartservice/src/cartstore/RedisCartStore.cs' }, { minutesAgo: 5, tool: 'Edit', detail: 'src/cartservice/src/cartstore/RedisCartStore.cs' }] },
  { id: SESSION_BOUTIQUE_MTLS, taskId: 'task-ob-mtls', projectId: PROJECT_BOUTIQUE, agent: 'opencode', status: 'suspended', activity: null, startedMinutesAgo: 210, model: OPENCODE, effort: null, permissionMode: 'acceptEdits', contextPercent: 18, contextWindowSize: 200000, costUsd: 0, durationMinutes: 62, peek: ['Write istio-manifests/frontend-peerauth.yaml', 'Write istio-manifests/frontend-destinationrule.yaml'], events: [{ minutesAgo: 152, tool: 'Write', detail: 'istio-manifests/frontend-peerauth.yaml' }, { minutesAgo: 150, tool: 'Write', detail: 'istio-manifests/frontend-destinationrule.yaml' }] },
  { id: SESSION_BOUTIQUE_A11Y, taskId: 'task-ob-currency-a11y', projectId: PROJECT_BOUTIQUE, agent: 'copilot', status: 'running', activity: 'thinking', startedMinutesAgo: 96, model: COPILOT, effort: null, permissionMode: 'acceptEdits', contextPercent: 38, contextWindowSize: 200000, costUsd: 0.7, durationMinutes: 96, peek: ['Edit src/frontend/templates/header.html', 'Shell go test ./...'], events: [{ minutesAgo: 41, tool: 'Edit', detail: 'src/frontend/templates/header.html' }, { minutesAgo: 40, tool: 'Shell', detail: 'go test ./...' }], isolated: true },
  { id: SESSION_BOUTIQUE_OTEL, taskId: 'task-ob-otel', projectId: PROJECT_BOUTIQUE, agent: 'codex', status: 'running', activity: 'thinking', startedMinutesAgo: 44, model: CODEX, effort: 'medium', permissionMode: 'bypassPermissions', contextPercent: 23, contextWindowSize: 400000, costUsd: 0.21, durationMinutes: 44, peek: ['Read src/shippingservice/main.go', 'rg -n otel src/shippingservice'], events: [{ minutesAgo: 7, tool: 'Read', detail: 'src/shippingservice/main.go' }, { minutesAgo: 2, tool: 'Bash', detail: 'rg -n otel src/shippingservice' }] },
];

export const DEMO_BACKLOG: DemoBacklogItem[] = [
  { id: 'backlog-cw-dark-mode', projectId: PROJECT_CONTOSO, title: 'Dark mode for the dashboard', description: 'Token pass over the dashboard cards and charts; the marketing site already ships both themes', priority: 2, labels: ['feature', 'design'], position: 0, external_source: null, external_id: null, external_url: null, createdDaysAgo: 9 },
  { id: 'backlog-cw-invoice-pdf', projectId: PROJECT_CONTOSO, title: 'Invoice PDF export', description: 'Customers ask for a downloadable invoice from the billing page', priority: 1, labels: ['feature'], position: 1, external_source: 'github', external_id: '112', external_url: 'https://github.com/contoso/contoso-web/issues/112', createdDaysAgo: 15 },
  { id: 'backlog-cw-flaky-e2e', projectId: PROJECT_CONTOSO, title: 'Flaky checkout e2e on Firefox', description: 'The Playwright checkout spec times out on Firefox one run in five', priority: 3, labels: ['bug', 'tests'], position: 2, external_source: 'github', external_id: '118', external_url: 'https://github.com/contoso/contoso-web/issues/118', createdDaysAgo: 4 },
  { id: 'backlog-pc-i18n-de', projectId: PROJECT_PETCLINIC, title: 'German translations for the visit forms', description: 'messages_de.properties is missing the visit keys added in the last release', priority: 1, labels: ['docs'], position: 0, external_source: 'github', external_id: '1420', external_url: 'https://github.com/spring-projects/spring-petclinic/issues/1420', createdDaysAgo: 6 },
  { id: 'backlog-ob-chaos', projectId: PROJECT_BOUTIQUE, title: 'Chaos test: kill paymentservice during checkout', description: 'A repeatable failure drill for the retry work', priority: 2, labels: ['tests'], position: 0, external_source: null, external_id: null, external_url: null, createdDaysAgo: 3 },
  { id: 'backlog-ob-helm', projectId: PROJECT_BOUTIQUE, title: 'Publish the Helm chart to the OCI registry', description: 'The chart lives in the repo but is not pushed on release', priority: 1, labels: ['chore'], position: 1, external_source: null, external_id: null, external_url: null, createdDaysAgo: 11 },
];

/** Agents the sample install reports as installed: those the boards use, at the versions the recordings were made on. */
export const DEMO_AGENT_OVERRIDES: Record<string, Record<string, unknown>> = {
  claude: { version: '2.1.270' },
  codex: { found: true, path: '/usr/local/bin/codex', version: '0.141.0' },
  gemini: { found: true, path: '/usr/local/bin/gemini', version: '0.58.0' },
  opencode: { found: true, path: '/usr/local/bin/opencode', version: '1.18.30' },
  copilot: { found: true, path: '/usr/local/bin/copilot', version: '1.0.83' },
};

// ---------------------------------------------------------------- the applier
/**
 * The script the page runs after the mock has loaded. Everything above is inlined as JSON; the
 * only code is the small applier that turns offsets into timestamps and pushes rows.
 */
export function buildDemoPreConfig(options: {
  scrollback?: DemoScrollbackMap;
  changes?: DemoChangesMap;
  peeks?: Record<string, string[]>;
  ends?: Record<string, { durationMs: number; stopReason: string }>;
  openFrames?: Record<string, { serialized: string; peek: string[] }>;
  peekTimelines?: Record<string, Array<{ t: number; lines: string[] }>>;
  liveTailMs?: number;
  currentProjectId?: string;
  appVersion?: string;
} = {}): string {
  const dataset = {
    groups: DEMO_GROUPS,
    projects: DEMO_PROJECTS,
    lanesByProject: DEMO_LANES_BY_PROJECT,
    tasks: DEMO_TASKS,
    sessions: DEMO_SESSIONS,
    backlog: DEMO_BACKLOG,
    labelColors: DEMO_LABEL_COLORS,
    agentOverrides: DEMO_AGENT_OVERRIDES,
    modelByAgent: MODEL_BY_AGENT,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    currentProjectId: options.currentProjectId ?? PROJECT_CONTOSO,
    // The real app version, so the status bar and the What's New gate agree with the build
    // rather than with the mock's placeholder.
    appVersion: options.appVersion ?? null,
    // When each session's recording ends and why (loadDemoEnds): a working session's clock and
    // whether it finishes, without fetching a stream.
    ends: options.ends ?? {},
    // How long before its recording's end the live frame opens a working session (the manifest's
    // liveTailMs; a session row can carry its own).
    liveTailMs: options.liveTailMs ?? 90000,
  };
  const scrollback = options.scrollback ?? {};
  const changes = options.changes ?? {};
  const peeks = options.peeks ?? {};
  // The frame and Monitor peek at the moment the live frame opens each working session
  // (loadDemoOpenFrames): what a still and the captures show for it.
  const openFrames = options.openFrames ?? {};
  // How each working session's Monitor peek changes as its recording plays (loadDemoPeekTimelines):
  // the motion a Monitor card shows on the desktop, on the recording's own clock.
  const peekTimelines = options.peekTimelines ?? {};
  // Every session with a terminal replays a recording; there is no hand-authored fallback. A
  // missing one would be a blank terminal in the frame and in every capture, so it fails the
  // build and the rig instead.
  const missingRecordings = DEMO_SESSIONS
    .filter((session) => session.status !== 'queued' && !(typeof scrollback[session.id] === 'string' && scrollback[session.id].length > 0))
    .map((session) => session.id);
  if (missingRecordings.length > 0) {
    throw new Error(
      `[demo] no terminal recording for ${missingRecordings.join(', ')}: add each to `
      + 'tests/captures/fixtures/demo/manifest.json and run "node scripts/capture-demo-sessions.mjs --skip-existing"',
    );
  }
  return `
    (function () {
      var data = ${JSON.stringify(dataset)};
      var worktreeSubpath = ${JSON.stringify(WORKTREE_SUBPATH)};
      var scrollback = ${JSON.stringify(scrollback)};
      var changes = ${JSON.stringify(changes)};
      var peeks = ${JSON.stringify(peeks)};
      var openFrames = ${JSON.stringify(openFrames)};
      var peekTimelines = ${JSON.stringify(peekTimelines)};
      var now = Date.now();
      function minutesAgo(minutes) { return new Date(now - minutes * 60000).toISOString(); }
      function daysAgo(days) { return minutesAgo(days * 1440); }
      var projectsById = {};
      data.projects.forEach(function (project) { projectsById[project.id] = project; });
      var tasksById = {};
      data.tasks.forEach(function (task) { tasksById[task.id] = task; });
      function laneName(projectId, slug) {
        var lanes = data.lanesByProject[projectId] || [];
        for (var index = 0; index < lanes.length; index++) if (lanes[index].slug === slug) return lanes[index].name;
        return slug;
      }
      // The mock's live state (its session, task, and swimlane arrays), kept so a visitor's
      // drag or click can add a session the way the main process would.
      var mockState = null;

      window.__mockPreConfigure(function (state) {
        data.groups.forEach(function (group) {
          state.projectGroups.push({ id: group.id, name: group.name, position: group.position, is_collapsed: group.is_collapsed });
        });
        data.projects.forEach(function (project) {
          state.projects.push({
            id: project.id, name: project.name, path: project.path, github_url: project.github_url,
            default_agent: project.default_agent, group_id: project.group_id, position: project.position,
            last_opened: minutesAgo(project.lastOpenedMinutesAgo), created_at: daysAgo(project.createdDaysAgo),
          });
          (data.lanesByProject[project.id] || []).forEach(function (lane, index) {
            state.swimlanes.push({
              id: 'lane-' + project.id.replace(/^proj-/, '') + '-' + lane.slug,
              projectId: project.id,
              name: lane.name, role: lane.role, color: lane.color, icon: lane.icon,
              is_archived: lane.is_archived, is_ghost: false,
              permission_mode: lane.permission_mode, permission_strategy: null,
              auto_spawn: lane.auto_spawn, auto_command: null, plan_exit_target_id: null,
              agent_override: lane.agent || null, handoff_context: false,
              position: index, created_at: daysAgo(project.createdDaysAgo),
            });
          });
        });
        data.tasks.forEach(function (task) {
          var project = projectsById[task.projectId];
          var row = {
            id: task.id, projectId: task.projectId, display_id: task.display_id, title: task.title, description: task.description,
            swimlane_id: 'lane-' + task.projectId.replace(/^proj-/, '') + '-' + task.lane, position: task.position,
            agent: task.agent, session_id: task.session_id,
            worktree_path: task.worktree_folder ? project.path + worktreeSubpath + task.worktree_folder : null,
            worktree_folder: task.worktree_folder, branch_name: task.branch_name,
            pr_number: task.pr_number, pr_url: task.pr_url, pr_state: task.pr_state, pr_merge_readiness: task.pr_merge_readiness, base_branch: task.base_branch,
            use_worktree: task.worktree_folder ? 1 : null, labels: task.labels, priority: task.priority,
            attachment_count: task.attachment_count, archived_at: task.archivedDaysAgo ? daysAgo(task.archivedDaysAgo) : null,
            created_at: daysAgo(task.createdDaysAgo), updated_at: minutesAgo(task.updatedMinutesAgo),
          };
          if (task.archivedDaysAgo) state.archivedTasks.push(row); else state.tasks.push(row);
        });
        data.sessions.forEach(function (session, index) {
          var project = projectsById[session.projectId];
          var task = session.taskId ? tasksById[session.taskId] : null;
          state.sessions.push({
            id: session.id, taskId: session.taskId, projectId: session.projectId, pid: 20000 + index,
            status: session.status, shell: 'bash',
            cwd: task && task.worktree_folder ? project.path + worktreeSubpath + task.worktree_folder : project.path,
            startedAt: minutesAgo(session.startedMinutesAgo), exitCode: null,
            transient: session.transient || false, branch: session.commandTerminalBranch || null,
          });
          if (session.activity) state.activityCache[session.id] = session.activity;
          state.eventCache[session.id] = session.events.map(function (event) {
            return { ts: now - event.minutesAgo * 60000, type: 'tool_start', tool: event.tool, detail: event.detail };
          });
        });
        data.backlog.forEach(function (item) {
          state.backlogTasks.push({
            id: item.id, projectId: item.projectId, title: item.title, description: item.description, priority: item.priority,
            labels: item.labels, position: item.position, assignee: null, due_date: null, item_type: null,
            external_id: item.external_id, external_source: item.external_source, external_url: item.external_url,
            sync_status: item.external_source ? 'synced' : null, external_metadata: null, attachment_count: 0,
            created_at: daysAgo(item.createdDaysAgo), updated_at: daysAgo(item.createdDaysAgo),
          });
        });
        state.config.backlog.labelColors = data.labelColors;
        if (data.appVersion) state.config.lastWhatsNewShownVersion = data.appVersion;
        // The concurrency cap leaves room above the running count, so a drag into an auto-spawn
        // column starts an agent the way it does on the desktop rather than queueing it.
        state.config.agent.maxConcurrentSessions = data.sessions.filter(function (session) { return session.status === 'running'; }).length + 4;
        mockState = state;
        return { currentProjectId: data.currentProjectId };
      });

      if (data.appVersion) {
        window.electronAPI.app.getVersion = function () { return Promise.resolve(data.appVersion); };
      }
      window.__mockAgentListOverrides = data.agentOverrides;

      // Monitor rows are DERIVED from the sessions so the two views cannot disagree. The output
      // peek is the recording's own last lines as the terminal displays them (rendered at build
      // time by loadDemoPeeks), or for a working session the lines at the moment the frame opens
      // it; the authored peek covers only a session with no recording.
      function seededPeek(session) {
        var open = session.activity === 'thinking' ? openFrames[session.id] : null;
        if (open) return open.peek;
        return peeks[session.id] || session.peek;
      }
      window.__mockMonitorRows = data.sessions.map(function (session) {
        var project = projectsById[session.projectId];
        var task = session.taskId ? tasksById[session.taskId] : null;
        return {
          sessionId: session.id, projectId: session.projectId, projectName: project.name,
          taskId: session.taskId || session.id, taskTitle: task ? task.title : 'Command Terminal 1',
          outputPeek: seededPeek(session), displayId: task ? task.display_id : null,
          columnName: task ? laneName(task.projectId, task.lane) : '',
          commandTerminalBranch: session.commandTerminalBranch || null,
          labels: task ? task.labels : [], prUrl: task ? task.pr_url : null, prNumber: task ? task.pr_number : null,
          prState: task ? task.pr_state : null, prMergeReadiness: task ? task.pr_merge_readiness : null,
          agentName: session.agent, modelDisplayName: session.model ? session.model.displayName : null,
          effort: session.effort, permissionMode: session.permissionMode,
          startedAt: minutesAgo(session.startedMinutesAgo), exitedAt: null,
          status: session.status, activity: session.activity, activityReason: null,
          lastEvent: null, contextPercent: session.contextPercent, isolated: session.isolated || false,
          isCommandTerminal: session.transient || false,
        };
      });

      var usageBySession = {};
      data.sessions.forEach(function (session) {
        if (!session.model || session.contextPercent === null) return;
        var used = Math.round(session.contextWindowSize * session.contextPercent / 100);
        usageBySession[session.id] = {
          model: session.model,
          contextWindow: {
            usedPercentage: session.contextPercent, usedTokens: used, cacheTokens: Math.round(used * 0.42),
            totalInputTokens: Math.round(used * 0.7), totalOutputTokens: Math.round(used * 0.3), contextWindowSize: session.contextWindowSize,
          },
          cost: { totalCostUsd: session.costUsd, totalDurationMs: session.durationMinutes * 60000 },
        };
        if (session.rateLimits) {
          usageBySession[session.id].rateLimits = [
            { id: 'five-hour', label: '5h session', iconKind: 'session', usedPercentage: 20, resetsAt: Math.floor(now / 1000) + 3600, windowDurationSeconds: 5 * 60 * 60 },
            { id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: 8, resetsAt: Math.floor(now / 1000) + 86400 * 5, windowDurationSeconds: 7 * 24 * 60 * 60 },
          ];
        }
      });
      window.electronAPI.sessions.getUsage = function () { return Promise.resolve(usageBySession); };

      // ---- terminal replay -------------------------------------------------------------
      // A still frame, and the marketing captures, paint each session's final terminal state
      // from the inline scrollback through the production mount-replay path. The live frame
      // replays a recording's timed byte stream instead: a session the app shows as working
      // streams its last stretch after the page opens, a spawn a visitor starts streams from its
      // first byte, and a new Command Terminal boots the way it does on the desktop. Recording
      // files are fetched from the same origin when a terminal mounts (window.__demoRecordings,
      // emitted by the build), and the bytes reach the mounted xterm through the mock's own
      // onData listeners, which is the path main's PTY output takes.
      var recordings = window.__demoRecordings || null;
      var stillFrame = !!(window.__demoBoot && window.__demoBoot.params && window.__demoBoot.params.still);
      var live = !!recordings && !stillFrame;
      var LIVE_TAIL_MS = data.liveTailMs;
      var replays = {};
      var recordingCache = {};
      var replayTimers = {};
      data.sessions.forEach(function (session) {
        if (!recordings || !recordings.sessions[session.id]) return;
        replays[session.id] = { file: recordings.sessions[session.id], startedAt: null, tail: session.activity === 'thinking' ? (session.liveTailMs || LIVE_TAIL_MS) : 0, projectId: session.projectId };
      });
      function fetchRecording(file) {
        if (!recordingCache[file]) {
          recordingCache[file] = fetch(recordings.base + file).then(function (response) {
            if (!response.ok) throw new Error('[demo] recording ' + file + ' returned ' + response.status);
            return response.json();
          });
        }
        return recordingCache[file];
      }
      function emitBytes(sessionId, bytes, projectId) {
        var listeners = (window.__mockDataListeners || []).slice();
        for (var index = 0; index < listeners.length; index++) listeners[index](sessionId, bytes, projectId);
      }
      function clearReplayTimers(sessionId) {
        (replayTimers[sessionId] || []).forEach(function (timer) { clearTimeout(timer); });
        replayTimers[sessionId] = [];
      }
      // A recording that ran to the agent's own end (the capture stopped on idle or exit) flips
      // its session to needs-you when the replay gets there, as main's activity engine does when
      // a turn completes. One cut short (stop-after, stop-when) stays working: its last frame is
      // a spinner and tool calls in flight.
      function endedOnItsOwn(recording) {
        return recording.stopReason === 'idle' || recording.stopReason === 'exited';
      }
      function finishSession(sessionId) {
        var row = sessionById(sessionId);
        if (!row || mockState.activityCache[sessionId] !== 'thinking') return;
        mockState.activityCache[sessionId] = 'idle';
        if (window.__mockFireActivity) window.__mockFireActivity(sessionId, 'idle', null, row.projectId, row.taskId);
        var rows = (window.__mockMonitorRows || []).map(function (monitorRow) {
          return monitorRow.sessionId === sessionId ? Object.assign({}, monitorRow, { activity: 'idle' }) : monitorRow;
        });
        window.__mockMonitorRows = rows;
        if (window.__mockFireMonitorChanged) window.__mockFireMonitorChanged(rows);
      }
      // The inverse, for loop=1: the session goes back to working and the Monitor says so, the
      // way it does on the desktop when the next turn starts.
      function startSession(sessionId) {
        var row = sessionById(sessionId);
        if (!row || mockState.activityCache[sessionId] === 'thinking') return;
        mockState.activityCache[sessionId] = 'thinking';
        if (window.__mockFireActivity) window.__mockFireActivity(sessionId, 'thinking', null, row.projectId, row.taskId);
        var rows = (window.__mockMonitorRows || []).map(function (monitorRow) {
          return monitorRow.sessionId === sessionId ? Object.assign({}, monitorRow, { activity: 'thinking' }) : monitorRow;
        });
        window.__mockMonitorRows = rows;
        if (window.__mockFireMonitorChanged) window.__mockFireMonitorChanged(rows);
      }
      function setMonitorPeek(sessionId, peek) {
        var changed = false;
        var rows = (window.__mockMonitorRows || []).map(function (row) {
          if (row.sessionId !== sessionId || JSON.stringify(row.outputPeek) === JSON.stringify(peek)) return row;
          changed = true;
          return Object.assign({}, row, { outputPeek: peek });
        });
        if (!changed) return;
        window.__mockMonitorRows = rows;
        if (window.__mockFireMonitorChanged) window.__mockFireMonitorChanged(rows);
      }
      // Everything a working session's clock does between now and its recording's end, in one
      // place: the Monitor peek changes on the way, the peek and the activity flip at the end,
      // and under loop=1 the next cycle. The two callers (the seed below, and a terminal
      // mounting) both clear the session's timers and then call this, so neither can schedule
      // half of it. The byte stream is separate because only a mounted terminal needs it: the
      // seed never fetches a recording, which is what keeps a Monitor-only frame off the wire.
      var LOOP_PAUSE_MS = 6000;
      var looping = !!(window.__demoBoot && window.__demoBoot.params && window.__demoBoot.params.loop);
      function scheduleSessionClock(sessionId, entry, clock) {
        if (!replayTimers[sessionId]) replayTimers[sessionId] = [];
        (peekTimelines[sessionId] || []).forEach(function (change) {
          var delay = entry.startedAt + change.t - Date.now();
          if (delay < 0) return;
          replayTimers[sessionId].push(setTimeout(function () { setMonitorPeek(sessionId, change.lines); }, delay));
        });
        // When the replay reaches the recording's end: the Monitor's output peek becomes the
        // recording's own last displayed lines, and a session whose agent finished flips to
        // needs-you.
        replayTimers[sessionId].push(setTimeout(function () {
          if (clock.endPeek && clock.endPeek.length) setMonitorPeek(sessionId, clock.endPeek);
          if (clock.endedOnItsOwn) finishSession(sessionId);
          // Only a session the board seeds as WORKING has a stretch to replay: every other one
          // carries tail 0, so its recording is already at its end and its clock lands at once.
          // Looping those would flip an idle session to working and blank its terminal, since
          // there is no opening frame to repaint from and no chunk left to schedule. A working
          // session whose terminal cannot take the bytes still loops: its card and its Monitor
          // row are the part that moves, and restartSession emits nothing to it.
          if (!looping || entry.tail <= 0) return;
          replayTimers[sessionId].push(setTimeout(function () { restartSession(sessionId, entry, clock); }, LOOP_PAUSE_MS));
        }, Math.max(0, entry.startedAt + clock.durationMs - Date.now())));
      }
      // loop=1: the session goes back to working and replays the same stretch again, after a beat
      // long enough to read the state it finished in. Each session loops on its own clock, so the
      // Monitor keeps changing instead of going quiet until the longest recording comes round.
      // A mounted terminal is repainted from the opening frame rather than left to grow a
      // cycle's scrollback every time.
      function restartSession(sessionId, entry, clock) {
        clearReplayTimers(sessionId);
        entry.startedAt = Date.now() - Math.max(0, clock.durationMs - entry.tail);
        startSession(sessionId);
        var open = openFrames[sessionId];
        setMonitorPeek(sessionId, open ? open.peek : []);
        if (entry.mounted && recordingCache[entry.file]) {
          recordingCache[entry.file].then(function (recording) {
            if (entry.frameOnly) {
              // This terminal plays frames, not bytes: re-arm the same timeline and repaint it
              // at the moment the cycle opens on.
              var cols = mountedGeometry[sessionId] ? mountedGeometry[sessionId].cols : 0;
              var current = scheduleFrameTimeline(sessionId, entry, recording, cols);
              emitBytes(sessionId, REPAINT + fitFrameToCols(current || (open ? open.serialized : recording.serialized), cols), entry.projectId);
            } else {
              emitBytes(sessionId, REPAINT + (open ? open.serialized : ''), entry.projectId);
              scheduleStreamBytes(sessionId, entry, recording);
            }
            scheduleSessionClock(sessionId, entry, clock);
          });
          return;
        }
        scheduleSessionClock(sessionId, entry, clock);
      }
      /** Queue the chunks still ahead of the session's clock, and return the ones already behind it. */
      function scheduleStreamBytes(sessionId, entry, recording) {
        if (!replayTimers[sessionId]) replayTimers[sessionId] = [];
        var elapsed = Date.now() - entry.startedAt;
        var head = '';
        recording.stream.forEach(function (chunk) {
          if (chunk.t <= elapsed) { head += chunk.data; return; }
          replayTimers[sessionId].push(setTimeout(function () { emitBytes(sessionId, chunk.data, entry.projectId); }, Math.max(0, entry.startedAt + chunk.t - Date.now())));
        });
        return head;
      }
      // A terminal on any other grid plays the recording's FRAMES instead of its bytes. A frame
      // reflows where a stream cannot, so the same recording is live at any size: the 15-row
      // bottom panel shows the last 15 rows of a 37-row frame, which is what a terminal scrolled
      // to the bottom shows anyway, and a display scaled to 125 percent gets the frame fitted to
      // its width. Each entry replaces the screen rather than appending, so the terminal never
      // grows and the repaint is one screen of bytes.
      var REPAINT = '\\x1b[2J\\x1b[3J\\x1b[H';
      function scheduleFrameTimeline(sessionId, entry, recording, cols) {
        if (!replayTimers[sessionId]) replayTimers[sessionId] = [];
        var timeline = recording.frameTimeline || [];
        var elapsed = Date.now() - entry.startedAt;
        var current = '';
        timeline.forEach(function (step) {
          if (step.t <= elapsed) { current = step.frame; return; }
          replayTimers[sessionId].push(setTimeout(function () {
            emitBytes(sessionId, REPAINT + fitFrameToCols(step.frame, cols), entry.projectId);
          }, Math.max(0, entry.startedAt + step.t - Date.now())));
        });
        return current;
      }
      function liveScrollback(sessionId, entry) {
        return fetchRecording(entry.file).then(function (recording) {
          var last = recording.stream[recording.stream.length - 1];
          var duration = last ? last.t : 0;
          if (entry.startedAt === null) {
            // A pre-seeded working session has been running for a while: everything but its
            // last stretch is already scrollback, and that stretch streams from here.
            entry.startedAt = Date.now() - Math.max(0, duration - entry.tail);
          }
          entry.mounted = true;
          clearReplayTimers(sessionId);
          var head = scheduleStreamBytes(sessionId, entry, recording);
          scheduleSessionClock(sessionId, entry, { durationMs: duration, endPeek: recording.peek, endedOnItsOwn: endedOnItsOwn(recording) });
          return head;
        });
      }
      // A working session's clock runs from page open whether or not its terminal is mounted,
      // as an agent's does on the desktop: the recording's end lands at the same moment on the
      // card, in the sidebar count, in the Monitor, and in a window opened later. Where no
      // stream plays (a still frame, the captures' seed) the terminal paints the moment the live
      // frame would open at, when the recording kept that frame; otherwise it paints the end,
      // where a recording that ran to the agent's own end reads as finished.
      var ends = data.ends || {};
      data.sessions.forEach(function (session) {
        var end = ends[session.id];
        if (!end || session.activity !== 'thinking') return;
        var entry = replays[session.id];
        if (!live || !entry) {
          if (openFrames[session.id]) scrollback[session.id] = openFrames[session.id].serialized;
          else if (endedOnItsOwn(end)) finishSession(session.id);
          return;
        }
        entry.startedAt = Date.now() - Math.max(0, end.durationMs - entry.tail);
        // A recording shorter than the tail plays from its first byte, so the Monitor row shows
        // no lines yet; the clock's changes and its end timer fill them in.
        if (!openFrames[session.id]) setMonitorPeek(session.id, []);
        clearReplayTimers(session.id);
        scheduleSessionClock(session.id, entry, { durationMs: end.durationMs, endPeek: peeks[session.id], endedOnItsOwn: endedOnItsOwn(end) });
      });
      window.__demoScrollback = scrollback;
      // The grid a terminal mounts with is the visitor's, not the recording's: the bottom panel
      // is 15 rows tall, and a display scaled to 125 percent fits 144 by 36 in the task window
      // where the recordings hold 154 by 37. A recording's bytes address rows for its own grid
      // (Windows ConPTY re-emits Claude's classic renderer with absolute cursor positions), so
      // replayed into any other grid they land two frames' text on one row. Main routes such a
      // session to its parsed-grid frame instead of the byte replay; so does this. The frame
      // reflows in a different grid, and the session stays on it there: a live stream cannot be
      // re-laid out without the CLI.
      var mountedGeometry = {};
      // A frame serialized at the recording's width still holds rows the CLI drew to that width
      // with characters: rules of box-drawing glyphs, bands of styled spaces. On a narrower grid
      // those wrap into a stub row and push the frame's cursor a row down, where the desktop's
      // CLI would have drawn them to the new width. Cut such trailing runs at the grid's width;
      // a row that carries real text past it is left to wrap, as text does anywhere.
      // Two things overrun a narrower grid: a right-aligned tail the CLI placed with a
      // cursor-forward sized to its own width (Claude's "/rc" at the footer's edge), and rules or
      // bands drawn to that width. The gap shrinks first, so the tail ends at this width as the CLI
      // would align it; then trailing rule glyphs and spaces are cut. Real text past the width is
      // left to wrap. The serializer's final cursor move is relative to the frame's bottom, so a
      // row that no longer wraps below the cursor is what keeps the cursor on its row.
      var FRAME_SEQUENCE = /^\x1b\\[[0-9;?]*[A-Za-z]/;
      var CURSOR_FORWARD = /^\x1b\\[(\\d*)C$/;
      var RULE_OR_SPACE = /[ ─-╿]/;
      // Box drawing AND block elements: Claude rules with ─, Copilot borders with ┃, and Codex
      // draws its input band with ▄ and ▀, which sit past the box-drawing range.
      var RULE_GLYPH = /[\\u2500-\\u259F]/;
      function fitFrameToCols(frame, cols) {
        if (!cols) return frame;
        return frame.split('\\r\\n').map(function (row) {
          var tokens = [];
          var index = 0;
          while (index < row.length) {
            if (row.charAt(index) === '\x1b') {
              var match = FRAME_SEQUENCE.exec(row.slice(index));
              var sequence = match ? match[0] : row.charAt(index);
              var forward = CURSOR_FORWARD.exec(sequence);
              tokens.push(forward ? { forward: Math.max(1, parseInt(forward[1] || '1', 10)) } : { sequence: sequence });
              index += sequence.length;
            } else {
              var end = row.indexOf('\x1b', index);
              if (end === -1) end = row.length;
              tokens.push({ text: row.slice(index, end) });
              index = end;
            }
          }
          function render() {
            return tokens.map(function (token) {
              if (token.text !== undefined) return token.text;
              if (token.forward !== undefined) return token.forward > 0 ? '\x1b[' + token.forward + 'C' : '';
              return token.sequence;
            }).join('');
          }
          var excess = tokens.reduce(function (sum, token) { return sum + (token.text !== undefined ? token.text.length : token.forward || 0); }, 0) - cols;
          if (excess === 0) return row;
          // WIDER than the recording. A CLI draws its rules and bands to the width it was given,
          // so on a wider grid they stop short and the frame reads as though it fills only part of
          // the terminal. A rule is the one run that can honestly be stretched: extend it with its
          // own glyph, and the frame's horizontal lines reach the edge the way the desktop drew
          // them. Nothing else is touched. A cursor-forward gap in particular must NOT be grown:
          // the serializer emits one at every point it joined a wrapped row, so widening gaps
          // shoves the continuation of a sentence out to the right margin. The CLI chose its wrap
          // points at the recorded width, and only the CLI could re-wrap that prose.
          if (excess < 0) {
            var deficit = -excess;
            for (var grow = tokens.length - 1; grow >= 0; grow--) {
              var end = tokens[grow];
              if (end.sequence !== undefined) continue;
              if (end.text === undefined || end.text.length === 0) break;
              var glyph = end.text.charAt(end.text.length - 1);
              if (!RULE_GLYPH.test(glyph)) break;
              var run = '';
              while (run.length < deficit) run += glyph;
              end.text += run;
              return render();
            }
            return row;
          }
          for (var gap = tokens.length - 1; gap >= 0 && excess > 0; gap--) {
            if (tokens[gap].forward === undefined) continue;
            var shrink = Math.min(excess, tokens[gap].forward - 1);
            tokens[gap].forward -= shrink;
            excess -= shrink;
          }
          for (var tail = tokens.length - 1; tail >= 0 && excess > 0; tail--) {
            var token = tokens[tail];
            if (token.sequence !== undefined) continue;
            if (token.forward !== undefined) { var drop = Math.min(excess, token.forward); token.forward -= drop; excess -= drop; continue; }
            var keep = token.text.length;
            while (keep > 0 && excess > 0 && RULE_OR_SPACE.test(token.text.charAt(keep - 1))) { keep -= 1; excess -= 1; }
            token.text = token.text.slice(0, keep);
            if (excess > 0) return row;
          }
          return render();
        }).join('\\r\\n');
      }
      function geometryFits(sessionId, recording) {
        var geometry = mountedGeometry[sessionId];
        if (!geometry || !recording.cols || !recording.rows) return true;
        return geometry.cols === recording.cols && geometry.rows === recording.rows;
      }
      function layoutFileFor(entry, cols) {
        // A boot recorded for each layout its window can open in: the one for this width.
        var singleCols = recordings && recordings.geometry && recordings.geometry.commandTerminal ? recordings.geometry.commandTerminal.cols : null;
        if (!entry.layouts || !singleCols) return entry.file;
        return cols < singleCols ? entry.layouts.tiled : entry.layouts.single;
      }
      window.electronAPI.sessions.getScrollback = function (sessionId) {
        var entry = replays[sessionId];
        if (live && entry) {
          if (mountedGeometry[sessionId]) entry.file = layoutFileFor(entry, mountedGeometry[sessionId].cols);
          return fetchRecording(entry.file).then(function (recording) {
            if (geometryFits(sessionId, recording)) return liveScrollback(sessionId, entry);
            // The bytes cannot replay into this grid, so the terminal paints a parsed frame
            // instead, the way main routes a geometry-changed session on the desktop. That does
            // not END the session there: the agent goes on working and only the replay is
            // replaced. So a session the board shows as working keeps the clock the seed
            // started, which emits no bytes of its own, and its card, its sidebar count and its
            // Monitor peeks go on changing; the terminal holds the frame the live replay opens
            // at, since a stream cannot be re-laid out without the CLI. frameOnly means exactly
            // "never emit bytes to this session", nothing about whether it is finished.
            entry.frameOnly = true;
            entry.mounted = true;
            var cols = mountedGeometry[sessionId] ? mountedGeometry[sessionId].cols : 0;
            if (entry.tail > 0) {
              clearReplayTimers(sessionId);
              var last = recording.stream[recording.stream.length - 1];
              var openFrame = openFrames[sessionId];
              var current = scheduleFrameTimeline(sessionId, entry, recording, cols);
              scheduleSessionClock(sessionId, entry, { durationMs: last ? last.t : 0, endPeek: recording.peek, endedOnItsOwn: endedOnItsOwn(recording) });
              return fitFrameToCols(current || (openFrame ? openFrame.serialized : recording.serialized), cols);
            }
            // A session already at its end: the frame is the recording's end, so the row's peek
            // and a finished session's state read as they would at the end here too.
            clearReplayTimers(sessionId);
            if (recording.peek && recording.peek.length) setMonitorPeek(sessionId, recording.peek);
            if (endedOnItsOwn(recording)) finishSession(sessionId);
            return fitFrameToCols(recording.serialized, cols);
          });
        }
        if (scrollback[sessionId]) return Promise.resolve(scrollback[sessionId]);
        if (entry && recordings) return fetchRecording(entry.file).then(function (recording) { return recording.serialized; });
        return Promise.resolve('');
      };

      // ---- what a drag or a click starts -----------------------------------------------
      // The transition engine lives in the main process; here the same outcome is produced
      // from the recordings: a card dragged into an auto-spawn column gets its agent started
      // in the lane's permission mode (the boot recorded for that task and mode), a paused
      // session resumes on its own transcript, and a new Command Terminal boots the project's
      // default agent. Each is announced through the same pushes main sends (session status,
      // activity, first output, usage, the Monitor snapshot), so the renderer treats it as it
      // would the real thing.
      function isoNow() { return new Date().toISOString(); }
      function laneById(laneId) {
        return mockState.swimlanes.find(function (lane) { return lane.id === laneId; }) || null;
      }
      function sessionById(sessionId) {
        return mockState.sessions.find(function (session) { return session.id === sessionId; }) || null;
      }
      function seedUsage(sessionId, agent) {
        var model = data.modelByAgent[agent] || null;
        var contextWindowSize = model && model.id.indexOf('opus') !== -1 ? 1000000 : 200000;
        usageBySession[sessionId] = {
          model: model,
          contextWindow: { usedPercentage: 1, usedTokens: Math.round(contextWindowSize / 100), cacheTokens: 0, totalInputTokens: Math.round(contextWindowSize / 140), totalOutputTokens: Math.round(contextWindowSize / 350), contextWindowSize: contextWindowSize },
          cost: { totalCostUsd: 0, totalDurationMs: 0 },
        };
      }
      // The renderer keeps a "Starting agent" veil over a new session's terminal until main
      // reports the PTY's first output, then mounts the terminal (which is what fetches the
      // recording). Main fires that when the first bytes arrive; here it fires when the
      // recording's first window would, or after a beat for a resumed transcript.
      var firstOutputFired = {};
      var originalGetFirstOutput = window.electronAPI.sessions.getFirstOutput;
      window.electronAPI.sessions.getFirstOutput = function () {
        return originalGetFirstOutput.apply(this, arguments).then(function (map) { return Object.assign({}, map, firstOutputFired); });
      };
      // The context bar's pills (model, context window, cost) replace its "Starting agent"
      // spinner once main pushes the session's first usage snapshot, which the CLI's status
      // line delivers a beat after it starts painting. Same order here, from the seeded usage.
      var USAGE_AFTER_FIRST_OUTPUT_MS = 1200;
      function fireFirstOutput(sessionId) {
        firstOutputFired[sessionId] = true;
        if (window.__mockFireFirstOutput) window.__mockFireFirstOutput(sessionId);
        var usage = usageBySession[sessionId];
        if (!usage || !window.__mockFireUsage) return;
        var row = sessionById(sessionId);
        var projectId = row ? row.projectId : (replays[sessionId] ? replays[sessionId].projectId : undefined);
        setTimeout(function () { window.__mockFireUsage(sessionId, usage, projectId); }, USAGE_AFTER_FIRST_OUTPUT_MS);
      }
      function scheduleFirstOutput(sessionId) {
        var entry = replays[sessionId];
        if (live && entry) {
          fetchRecording(entry.file).then(function (recording) {
            var first = recording.stream[0];
            setTimeout(function () { fireFirstOutput(sessionId); }, Math.max(0, entry.startedAt + (first ? first.t : 0) - Date.now()));
          }).catch(function () { fireFirstOutput(sessionId); });
        } else {
          setTimeout(function () { fireFirstOutput(sessionId); }, 300);
        }
      }
      function announceSession(row, activity) {
        mockState.activityCache[row.id] = activity;
        mockState.eventCache[row.id] = [];
        if (window.__mockFireStatus) window.__mockFireStatus(row.id, row, row.projectId);
        if (window.__mockFireActivity) window.__mockFireActivity(row.id, activity, null, row.projectId, row.taskId);
        scheduleFirstOutput(row.id);
      }
      function announceMonitorRow(row, mockTask, agent, permissionMode) {
        var project = projectsById[row.projectId];
        var lane = mockTask ? laneById(mockTask.swimlane_id) : null;
        var model = data.modelByAgent[agent] || null;
        var rows = (window.__mockMonitorRows || []).concat([{
          sessionId: row.id, projectId: row.projectId, projectName: project.name,
          taskId: mockTask ? mockTask.id : row.id, taskTitle: mockTask ? mockTask.title : 'Command Terminal',
          outputPeek: [], displayId: mockTask ? mockTask.display_id : null, columnName: lane ? lane.name : '',
          commandTerminalBranch: row.branch || null,
          labels: mockTask ? mockTask.labels : [], prUrl: mockTask ? mockTask.pr_url : null, prNumber: mockTask ? mockTask.pr_number : null,
          prState: mockTask ? mockTask.pr_state : null, prMergeReadiness: mockTask ? mockTask.pr_merge_readiness : null,
          agentName: agent, modelDisplayName: model ? model.displayName : null, effort: null, permissionMode: permissionMode,
          startedAt: row.startedAt, exitedAt: null, status: 'running', activity: mockState.activityCache[row.id], activityReason: null,
          lastEvent: null, contextPercent: 1, isolated: false, isCommandTerminal: !!row.transient,
        }]);
        window.__mockMonitorRows = rows;
        if (window.__mockFireMonitorChanged) window.__mockFireMonitorChanged(rows);
      }
      function startTaskSession(mockTask, permissionMode) {
        var project = projectsById[mockTask.projectId];
        var targetLane = laneById(mockTask.swimlane_id);
        var agent = mockTask.agent || (targetLane && targetLane.agent_override) || project.default_agent;
        var id = 'sess-' + mockTask.id.replace(/^task-/, '') + '-' + Date.now().toString(36);
        var row = {
          id: id, taskId: mockTask.id, projectId: mockTask.projectId, pid: 30000 + mockState.sessions.length,
          status: 'running', shell: 'bash', cwd: mockTask.worktree_path || project.path, startedAt: isoNow(), exitCode: null,
          resuming: false, transient: false, branch: null, isolatedSwimlaneId: null, agentSessionId: null,
        };
        mockState.sessions.push(row);
        mockTask.session_id = id;
        mockTask.updated_at = isoNow();
        seedUsage(id, agent);
        // The boot recorded for this task in this mode. A task the visitor created has none and
        // gets the project's Command Terminal boot: the agent starting with nothing to do yet.
        var file = recordings ? (recordings.spawns[mockTask.id + ':' + permissionMode] || recordings.terminals[mockTask.projectId] || null) : null;
        if (file) replays[id] = { file: file, startedAt: Date.now(), tail: 0, projectId: mockTask.projectId };
        announceSession(row, 'thinking');
        announceMonitorRow(row, mockTask, agent, permissionMode);
        return row;
      }
      function resumeTaskSession(mockTask, suspended) {
        var project = projectsById[mockTask.projectId];
        var agent = mockTask.agent || project.default_agent;
        var id = 'sess-' + mockTask.id.replace(/^task-/, '') + '-resumed-' + Date.now().toString(36);
        var row = {
          id: id, taskId: mockTask.id, projectId: mockTask.projectId, pid: 30000 + mockState.sessions.length,
          status: 'running', shell: 'bash', cwd: mockTask.worktree_path || project.path, startedAt: isoNow(), exitCode: null,
          resuming: true, transient: false, branch: null, isolatedSwimlaneId: null, agentSessionId: null,
        };
        mockState.sessions.push(row);
        mockTask.session_id = id;
        mockTask.updated_at = isoNow();
        // A resumed agent prints its earlier transcript and waits, so the paused session's final
        // frame is the new one's scrollback, and the row is idle: it needs the user next.
        scrollback[id] = scrollback[suspended.id] || '';
        usageBySession[id] = usageBySession[suspended.id] || usageBySession[id];
        if (!usageBySession[id]) seedUsage(id, agent);
        announceSession(row, 'idle');
        announceMonitorRow(row, mockTask, agent, 'acceptEdits');
        return row;
      }
      var originalMove = window.electronAPI.tasks.move;
      window.electronAPI.tasks.move = function (input) {
        var moveArguments = arguments;
        return originalMove.apply(this, moveArguments).then(function (result) {
          var lane = laneById(input.targetSwimlaneId);
          var mockTask = mockState.tasks.find(function (task) { return task.id === input.taskId; });
          if (lane && lane.auto_spawn && mockTask) {
            // The engine's create_or_resume: a live session follows the card, a paused one
            // resumes, a card with none gets its agent started in the lane's permission mode.
            var current = mockTask.session_id ? sessionById(mockTask.session_id) : null;
            if (!current || current.status !== 'running') {
              if (current && current.status === 'suspended') resumeTaskSession(mockTask, current);
              else startTaskSession(mockTask, lane.permission_mode || data.defaultPermissionMode);
            }
          }
          return result;
        });
      };
      window.electronAPI.sessions.resume = function (taskId) {
        var mockTask = mockState.tasks.find(function (task) { return task.id === taskId; });
        if (!mockTask) return Promise.reject(new Error('Task not found: ' + taskId));
        var previous = mockTask.session_id ? sessionById(mockTask.session_id) : null;
        var lane = laneById(mockTask.swimlane_id);
        var row = previous
          ? resumeTaskSession(mockTask, previous)
          : startTaskSession(mockTask, (lane && lane.permission_mode) || data.defaultPermissionMode);
        return Promise.resolve(row);
      };
      var originalSpawnTransient = window.electronAPI.sessions.spawnTransient;
      window.electronAPI.sessions.spawnTransient = function (input) {
        return originalSpawnTransient.apply(this, arguments).then(function (result) {
          var project = projectsById[input.projectId];
          var agent = project ? project.default_agent : 'claude';
          // The new window opens alone or tiled beside the project's running terminal, and the
          // boot was recorded at both sizes; pick the one for the layout this spawn lands in.
          var tiled = mockState.sessions.some(function (session) {
            return session.transient && session.projectId === input.projectId && session.status === 'running' && session.id !== result.session.id;
          });
          var single = recordings ? recordings.terminals[input.projectId] || null : null;
          var tiledFile = recordings ? recordings.terminals[input.projectId + '-tiled'] || null : null;
          var file = (tiled && tiledFile) || single;
          if (file) replays[result.session.id] = { file: file, startedAt: Date.now(), tail: 0, projectId: input.projectId, layouts: single && tiledFile ? { single: single, tiled: tiledFile } : null };
          seedUsage(result.session.id, agent);
          announceSession(result.session, 'idle');
          announceMonitorRow(result.session, null, agent, data.defaultPermissionMode);
          return result;
        });
      };

      // A Command Terminal window that tiles beside a new one, or stands alone again when that
      // one stops, changes width, and the desktop's PTY resize has the CLI repaint at the new
      // size. A replay cannot repaint, but a boot recorded at both sizes can be swapped: a
      // resize across the single-window width switches the session to the other recording and
      // repaints it from a cleared screen at the same point in the boot.
      var originalResize = window.electronAPI.sessions.resize;
      window.electronAPI.sessions.resize = function (sessionId, cols, rows) {
        // The renderer resizes before it asks for the scrollback, so a mount's grid is known when
        // getScrollback decides between the byte replay and the frame. A later resize of a mounted
        // terminal (a window tiling beside a new one, the panel's terminal handed to a task window)
        // brings no new getScrollback: the desktop's PTY resize has the CLI repaint for the new
        // grid, and here the session repaints from a cleared screen with whichever of its bytes or
        // its frame fits that grid, switching boot recordings by layout on the way.
        var previous = mountedGeometry[sessionId];
        mountedGeometry[sessionId] = { cols: cols, rows: rows };
        var entry = replays[sessionId];
        var changed = !!previous && (previous.cols !== cols || previous.rows !== rows);
        if (live && entry && changed) {
          entry.file = layoutFileFor(entry, cols);
          fetchRecording(entry.file).then(function (recording) {
            if (geometryFits(sessionId, recording)) {
              return liveScrollback(sessionId, entry).then(function (head) { emitBytes(sessionId, '\x1b[2J\x1b[3J\x1b[H' + head, entry.projectId); });
            }
            clearReplayTimers(sessionId);
            emitBytes(sessionId, '\x1b[2J\x1b[3J\x1b[H' + fitFrameToCols(recording.serialized, cols), entry.projectId);
          });
        }
        return originalResize.apply(this, arguments);
      };

      // The working tree each recorded session left behind, keyed by its task's worktree folder,
      // so a task's Changes panel shows what its agent changed. Nothing is committed on a scratch
      // clone, so the Working and Branch scopes show the same files and Staged is empty.
      var diffByWorktree = {};
      data.tasks.forEach(function (task) {
        var diff = task.session_id && changes[task.session_id];
        if (!diff || !task.worktree_folder) return;
        diffByWorktree[task.worktree_folder] = { working: diff, branch: diff, staged: { files: [], totalInsertions: 0, totalDeletions: 0 } };
      });
      window.__mockGitDiffByWorktree = diffByWorktree;

      // A deterministic usage dashboard: fourteen days of sessions per project, seeded so every
      // boot draws the same charts, scaled by the project's share of the sample install.
      function seeded(seed) { var value = seed; return function () { value = (value * 1664525 + 1013904223) % 4294967296; return value / 4294967296; }; }
      window.electronAPI.usage.__dashboardStatsFixture = function (scope, period) {
        var hourMs = 3600000;
        var dayMs = 24 * hourMs;
        var random = seeded(scope.kind === 'all' ? 7 : (String(scope.projectId || '').length + 11));
        var scale = scope.kind === 'all' ? 1 : 0.42;
        var days = period === 'all' ? 30 : period === '7d' ? 7 : 14;
        var rangeStartMs = Math.floor(now / dayMs) * dayMs - (days - 1) * dayMs;
        var costSeries = [];
        var totalCost = 0, totalInput = 0, totalOutput = 0, sessionCount = 0;
        for (var day = 0; day < days; day++) {
          var bucketStart = rangeStartMs + day * dayMs;
          var weekend = new Date(bucketStart).getDay() % 6 === 0;
          var cost = (weekend ? 1.2 : 6.5 + random() * 5) * scale;
          var input = Math.round((weekend ? 40000 : 180000 + random() * 120000) * scale);
          var output = Math.round(input * 0.28);
          var sessions = weekend ? 1 : 3 + Math.floor(random() * 4);
          totalCost += cost; totalInput += input; totalOutput += output; sessionCount += sessions;
          costSeries.push({
            bucketStartMs: bucketStart, costUsd: cost, inputTokens: input, outputTokens: output, sessionCount: sessions,
            byModel: [
              { modelId: 'claude-opus-4-8', costUsd: cost * 0.62, inputTokens: Math.round(input * 0.55), outputTokens: Math.round(output * 0.55) },
              { modelId: 'gpt-5.2-codex', costUsd: cost * 0.23, inputTokens: Math.round(input * 0.28), outputTokens: Math.round(output * 0.28) },
              { modelId: 'gemini-3-pro', costUsd: cost * 0.15, inputTokens: Math.round(input * 0.17), outputTokens: Math.round(output * 0.17) },
            ],
          });
        }
        var tokenSeries = [];
        var bucketCount = 12;
        var tokenStart = Math.floor(now / hourMs) * hourMs - (bucketCount - 1) * hourMs;
        for (var bucket = 0; bucket < bucketCount; bucket++) {
          var perBucketInput = Math.round((6000 + random() * 9000) * scale);
          tokenSeries.push({
            bucketStartMs: tokenStart + bucket * hourMs, inputTokens: perBucketInput, outputTokens: Math.round(perBucketInput * 0.3),
            cacheCreationTokens: Math.round(perBucketInput * 0.15), cacheReadTokens: Math.round(perBucketInput * 4.5),
            allocatedCostUsd: (0.18 + random() * 0.3) * scale, turnCount: 4 + Math.floor(random() * 6),
          });
        }
        var kpis = {
          totalCostUsd: totalCost, costKnown: true, totalInputTokens: totalInput, totalOutputTokens: totalOutput,
          totalTokens: totalInput + totalOutput, sessionCount: sessionCount, toolCallCount: Math.round(sessionCount * 41),
          linesAdded: Math.round(sessionCount * 160), linesRemoved: Math.round(sessionCount * 55), filesChanged: Math.round(sessionCount * 7),
          compactionCount: Math.round(sessionCount / 6), totalDurationMs: sessionCount * 38 * 60000,
          turnInputTokens: Math.round(totalInput * 0.35), turnOutputTokens: Math.round(totalOutput * 0.5),
          cacheCreationTokens: Math.round(totalInput * 0.2), cacheReadTokens: Math.round(totalInput * 5.5),
          burnRateTokensPerHour: Math.round(26000 * scale), burnRateUsdPerHour: 1.7 * scale,
        };
        var previous = {};
        Object.keys(kpis).forEach(function (key) { previous[key] = typeof kpis[key] === 'number' ? Math.round(kpis[key] * 0.86 * 1000) / 1000 : kpis[key]; });
        // The model, agent, and effort breakdowns come from the sessions the boards actually show,
        // weighted by the tokens each has used, so the dashboard names the same models the
        // terminals do.
        var scopedSessions = data.sessions.filter(function (session) {
          return session.model && session.contextPercent !== null && (scope.kind === 'all' || session.projectId === scope.projectId);
        });
        function breakdown(keyOf, labelOf) {
          var groups = {};
          var totalWeight = 0;
          scopedSessions.forEach(function (session) {
            var key = keyOf(session);
            if (key === null || key === undefined) return;
            var weight = session.contextWindowSize * session.contextPercent / 100;
            if (!groups[key]) groups[key] = { key: key, label: labelOf ? labelOf(session) : key, weight: 0, cost: 0, count: 0 };
            groups[key].weight += weight;
            groups[key].cost += session.costUsd;
            groups[key].count += 1;
            totalWeight += weight;
          });
          var totalGroupCost = Object.keys(groups).reduce(function (sum, key) { return sum + groups[key].cost; }, 0);
          return Object.keys(groups).map(function (key) {
            var group = groups[key];
            var share = totalWeight ? group.weight / totalWeight : 0;
            var costShare = totalGroupCost ? group.cost / totalGroupCost : share;
            return {
              key: key, label: group.label,
              inputTokens: Math.round(totalInput * share), outputTokens: Math.round(totalOutput * share),
              costUsd: totalCost * costShare, sessionCount: Math.max(1, Math.round(sessionCount * share)),
            };
          }).sort(function (left, right) { return right.inputTokens - left.inputTokens; });
        }
        return {
          scope: scope, period: period, rangeStartMs: rangeStartMs, rangeEndMs: now, bucketSizeMs: hourMs, costBucketSizeMs: dayMs, generatedAtMs: now,
          kpis: kpis, previousKpis: period === 'all' ? null : previous, tokenSeries: tokenSeries, costSeries: costSeries,
          byModel: breakdown(function (session) { return session.model ? session.model.id : null; }, function (session) { return session.model.displayName; }).map(function (row) {
            return { modelId: row.key, modelDisplayName: row.label, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd, sessionCount: row.sessionCount };
          }),
          byAgent: breakdown(function (session) { return session.agent; }).map(function (row) {
            return { agent: row.key, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd, sessionCount: row.sessionCount };
          }),
          byEffort: breakdown(function (session) { return session.effort || '(default)'; }).map(function (row) {
            return { effort: row.key === '(default)' ? null : row.key, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd, sessionCount: row.sessionCount };
          }),
          perProject: scope.kind === 'all'
            ? data.projects.map(function (project, index) {
                var share = [0.55, 0.27, 0.18][index] || 0.1;
                return {
                  projectId: project.id, projectName: project.name, inputTokens: Math.round(totalInput * share), outputTokens: Math.round(totalOutput * share),
                  costUsd: totalCost * share, sessionCount: Math.round(sessionCount * share), toolCallCount: Math.round(sessionCount * 41 * share),
                  linesAdded: Math.round(sessionCount * 160 * share), linesRemoved: Math.round(sessionCount * 55 * share), filesChanged: Math.round(sessionCount * 7 * share),
                  totalDurationMs: Math.round(sessionCount * 38 * 60000 * share), lastActiveMs: now - project.lastOpenedMinutesAgo * 60000, topAgent: project.default_agent,
                };
              })
            : undefined,
        };
      };
    })();
  `;
}
