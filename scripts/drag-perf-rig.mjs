#!/usr/bin/env node
/**
 * Board drag frame-cost rig against the PRODUCTION build.
 *
 * A packaged build has no devtools bridge and the UI tier understates renderer cost
 * about 10x (SwiftShader, a tiny DOM), so this is the only way to answer "does the
 * drag drop frames in production". It launches `.vite/build/index.js` in a visible
 * on-screen window with the GPU enabled, seeds a board shaped like a working one
 * (10 active cards across lanes, 15 archived cards in Done, mock sessions that push
 * real status and activity updates through the status-file pipeline), and drives
 * trusted mouse drags through a scenario matrix while an in-page probe records
 * animation-frame deltas, long animation frames, long tasks, and pointer event
 * timing. Results are written as JSON and summarized on stdout.
 *
 * Usage (build first):
 *   npm run build
 *   node scripts/drag-perf-rig.mjs [--scenarios=S0,S1,S2,S3,S4a,S4b,S4c,S5,S6]
 *                                  [--runs=5] [--label=name] [--out=path.json]
 *                                  [--push-hz=3] [--analyze=path.json]
 *
 * Scenarios: S0 idle and mouse-move controls (the noise floor); S1 plain cross-column
 * drag; S6 drag-start latency; S4b same-column reorder; S5 autoscroll with the
 * pointer held at the scroller's edge; S3 a spawn from a drop landing inside the NEXT
 * drag (runs before S2 so it spawns the board's first session, whose pane mounts an
 * xterm); S2 a drag with two live mock sessions pushing updates; S4a cross-column drop
 * with sessions live; S4c a Done drop of a worktree-backed task with a running session.
 *
 * Read the numbers against the display's refresh: on a 144Hz display a 13.8 or 20.7ms
 * frame is a missed refresh, not a dropped 60Hz frame, and idle shows a few of those
 * per second on its own. The first drags after a launch run slow for a whole gesture
 * (JIT), so S1 warms up twice before measuring. Keep the window unoccluded: a hidden
 * Chromium page stops requestAnimationFrame and throttles timers to once a second.
 *
 * Never point this at the dogfooding instance; it launches its own app with its own
 * data directory under tests/.test-data and a throwaway project under tests/.tmp.
 * The 2026-09-16 audit that produced it is docs/board-drag-perf-audit.md.
 */
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true'];
  }),
);
const RUNS = parseInt(argv.runs ?? '5', 10);
const ONLY = (argv.scenarios ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = argv.label ?? 'prod';
const OUT = path.resolve(argv.out ?? path.join(repoRoot, 'tests', '.tmp', `drag-perf-${LABEL}.json`));
const PUSH_HZ = argv['push-hz'] ?? '3';
const wants = (id) => ONLY.length === 0 || ONLY.includes(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (argv.analyze) {
  analyze(path.resolve(argv.analyze));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// In-page probe and summary (run inside the renderer through page.evaluate)
// ---------------------------------------------------------------------------
function installProbe() {
  if (window.__perf) return;
  const perf = { frames: [], loaf: [], longtasks: [], marks: [], events: [] };
  window.__perf = perf;
  const tick = (now) => {
    perf.frames.push(now);
    if (perf.frames.length > 400000) perf.frames.splice(0, 200000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perf.loaf.push({
          start: entry.startTime,
          duration: entry.duration,
          blocking: entry.blockingDuration,
          styleLayout: entry.styleAndLayoutDuration,
          scripts: (entry.scripts ?? []).map((script) => ({
            url: String(script.sourceURL ?? '').split('/').slice(-1)[0],
            fn: script.sourceFunctionName,
            invoker: script.invoker,
            type: script.invokerType,
            duration: script.duration,
            forced: script.forcedStyleAndLayoutDuration,
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (error) {
    perf.loafError = String(error);
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) perf.longtasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch (error) {
    perf.longtaskError = String(error);
  }
  const mark = (name) => (event) => perf.marks.push({ name, t: event.timeStamp });
  document.addEventListener('pointerdown', mark('pointerdown'), true);
  document.addEventListener('pointerup', mark('pointerup'), true);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith('pointer') && !entry.name.startsWith('mouse')) continue;
        perf.events.push({
          name: entry.name,
          start: entry.startTime,
          processing: entry.processingEnd - entry.processingStart,
          inputDelay: entry.processingStart - entry.startTime,
          duration: entry.duration,
        });
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch (error) {
    perf.eventError = String(error);
  }
}

function summarizeWindow(input) {
  const perf = window.__perf;
  const frames = perf.frames.filter((t) => t >= input.start && t <= input.end);
  const deltas = frames.slice(1).map((t, index) => t - frames[index]);
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  const median = pct(0.5) ?? 16.7;
  const inWindow = (entry) => entry.start + entry.duration >= input.start && entry.start <= input.end;
  const loaf = perf.loaf.filter(inWindow);
  const longtasks = perf.longtasks.filter(inWindow);
  const marks = perf.marks.filter((m) => m.t >= input.start - 100 && m.t <= input.end + 100);
  const pointerup = [...marks].reverse().find((m) => m.name === 'pointerup');
  const pointerdown = marks.find((m) => m.name === 'pointerdown');
  const firstFrameAfterUp = pointerup ? perf.frames.find((t) => t > pointerup.t) : undefined;
  const events = perf.events.filter((e) => e.start >= input.start && e.start <= input.end);
  const buckets = { le8: 0, le17: 0, le33: 0, le50: 0, le100: 0, gt100: 0 };
  for (const d of deltas) {
    if (d <= 8) buckets.le8 += 1;
    else if (d <= 16.7) buckets.le17 += 1;
    else if (d <= 33) buckets.le33 += 1;
    else if (d <= 50) buckets.le50 += 1;
    else if (d <= 100) buckets.le100 += 1;
    else buckets.gt100 += 1;
  }
  const slowFrames = deltas
    .map((d, index) => ({ t: Math.round(frames[index + 1] - input.start), d: Math.round(d * 10) / 10 }))
    .filter((entry) => entry.d > median * 1.6);
  return {
    durationMs: Math.round(input.end - input.start),
    frames: frames.length,
    refreshMs: Math.round(median * 10) / 10,
    missedVsync: deltas.filter((d) => d > median * 1.6).length,
    buckets,
    slowFrames,
    dropped33: deltas.filter((d) => d > 33).length,
    over50: deltas.filter((d) => d > 50).length,
    over100: deltas.filter((d) => d > 100).length,
    p50: pct(0.5),
    p95: pct(0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    stallMsOver16: Math.round(deltas.filter((d) => d > 16.7).reduce((acc, d) => acc + (d - 16.7), 0)),
    pointerupToPaint: pointerup && firstFrameAfterUp ? Math.round((firstFrameAfterUp - pointerup.t) * 10) / 10 : null,
    pointerdownAt: pointerdown ? Math.round(pointerdown.t) : null,
    pointerupAt: pointerup ? Math.round(pointerup.t) : null,
    eventStats: {
      count: events.length,
      maxProcessing: events.length ? Math.round(Math.max(...events.map((e) => e.processing)) * 10) / 10 : null,
      maxDuration: events.length ? Math.max(...events.map((e) => e.duration)) : null,
      slowEvents: events.filter((e) => e.processing > 4).slice(0, 40).map((e) => ({ name: e.name, t: Math.round(e.start - input.start), processing: Math.round(e.processing * 10) / 10 })),
    },
    loaf: loaf.map((e) => ({ ...e, start: Math.round(e.start), duration: Math.round(e.duration) })),
    longtasks: longtasks.map((e) => ({ start: Math.round(e.start), duration: Math.round(e.duration) })),
    ...(input.extra ?? {}),
  };
}

function animationCensus() {
  const counts = {};
  for (const animation of document.getAnimations()) {
    const effect = animation.effect;
    const target = effect ? effect.target : null;
    const name = animation.animationName ?? animation.transitionProperty ?? animation.id ?? 'anim';
    const key = `${target ? target.tagName : '?'}:${name}:${animation.playState}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { total: document.getAnimations().length, kinds: counts };
}

// ---------------------------------------------------------------------------
// Rig state
// ---------------------------------------------------------------------------
const results = { label: LABEL, startedAt: new Date().toISOString(), scenarios: {} };
function record(scenario, summary) {
  (results.scenarios[scenario] ??= []).push(summary);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
}

let app;
let page;
let laneIds;
const todoTasks = [];
let sessionTaskX = '';
let spawnWorktreeTask = '';
const worktreeTasks = [];

async function nowInPage() {
  return page.evaluate(() => performance.now());
}

async function pollUntil(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function createTaskIpc(title, swimlaneId, useWorktree) {
  return page.evaluate(async (input) => {
    const task = await window.electronAPI.tasks.create({
      title: input.title,
      description: 'perf rig card with a couple of lines of description text so the card body is realistic',
      swimlane_id: input.swimlaneId,
      useWorktree: input.useWorktree,
    });
    return task.id;
  }, { title, swimlaneId, useWorktree });
}

async function moveIpc(taskId, swimlaneId) {
  await page.evaluate(async (input) => {
    await window.electronAPI.tasks.move({ taskId: input.taskId, targetSwimlaneId: input.swimlaneId, targetPosition: 0 });
  }, { taskId, swimlaneId });
}

async function runningTaskIds() {
  return page.evaluate(async () => (await window.electronAPI.sessions.list()).filter((s) => s.status === 'running').map((s) => s.taskId));
}

async function waitRunningCount(count, timeoutMs = 60000) {
  const ok = await pollUntil(async () => (await runningTaskIds()).length >= count, timeoutMs, 500);
  if (!ok) throw new Error(`fewer than ${count} sessions running after ${timeoutMs}ms`);
}

async function waitTaskRunning(taskId, timeoutMs = 60000) {
  const ok = await pollUntil(async () => (await runningTaskIds()).includes(taskId), timeoutMs, 500);
  if (!ok) throw new Error(`task ${taskId} not running after ${timeoutMs}ms`);
}

/**
 * A held, trusted drag. Options: holdMs; sweep (vertical sweep inside the target for the
 * last third, to cross card centres); targetPoint (absolute, overrides the selector centre);
 * settle 'in-lane' | 'gone' | 'overlay'; laneName; cancel (Escape before release);
 * screenshotAtHold; quickReturn / quickStart (skip the pre and post pauses so the next
 * gesture can overlap a spawn); extra (merged into the summary).
 */
async function heldDrag(taskId, targetSelector, options) {
  const card = page.locator(`[data-task-id="${taskId}"]`).first();
  await card.scrollIntoViewIfNeeded();
  if (!options.quickStart) await sleep(150);
  const from = await card.boundingBox();
  if (!from) throw new Error(`no box for task ${taskId}`);
  let to = options.targetPoint;
  const targetBox = await page.locator(targetSelector).first().boundingBox();
  if (!to) {
    if (!targetBox) throw new Error(`no box for target ${targetSelector}`);
    to = { x: targetBox.x + targetBox.width / 2, y: Math.min(targetBox.y + 120, targetBox.y + targetBox.height / 2) };
  }
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };

  const start = await nowInPage();
  await page.mouse.move(fromCenter.x, fromCenter.y);
  await page.mouse.down();
  await page.mouse.move(fromCenter.x + 12, fromCenter.y, { steps: 3 });
  const overlayAt = await page
    .waitForFunction(() => (document.querySelector('.drag-overlay') ? performance.now() : false), null, { polling: 'raf', timeout: 3000 })
    .then((handle) => handle.jsonValue());

  const steps = Math.max(10, Math.round(options.holdMs / 16));
  const travelSteps = options.sweep ? Math.round(steps * 0.66) : steps;
  const startPoint = { x: fromCenter.x + 12, y: fromCenter.y };
  for (let i = 1; i <= travelSteps; i++) {
    const t = i / travelSteps;
    await page.mouse.move(startPoint.x + (to.x - startPoint.x) * t, startPoint.y + (to.y - startPoint.y) * t + Math.sin(t * Math.PI * 2) * 20);
    await sleep(16);
  }
  if (options.sweep && targetBox) {
    const sweepSteps = steps - travelSteps;
    const top = targetBox.y + 60;
    const bottom = Math.min(targetBox.y + targetBox.height - 60, top + 500);
    for (let i = 1; i <= sweepSteps; i++) {
      const t = i / sweepSteps;
      await page.mouse.move(to.x, top + (bottom - top) * (0.5 - 0.5 * Math.cos(t * Math.PI * 2)));
      await sleep(16);
    }
  }
  if (options.screenshotAtHold) await page.screenshot({ path: options.screenshotAtHold });
  const animationsAtHold = await page.evaluate(animationCensus);
  const beforeRelease = await nowInPage();
  if (options.cancel) await page.keyboard.press('Escape');
  await page.mouse.up();

  const settleMode = options.settle ?? 'in-lane';
  let settleTimeout = false;
  const settleAt = await page
    .waitForFunction(
      (input) => {
        if (document.querySelector('.drag-overlay') || document.querySelector('.flying-card')) return false;
        if (input.mode === 'in-lane') return document.querySelector(`[data-swimlane-name="${input.laneName}"] [data-task-id="${input.taskId}"]`) ? performance.now() : false;
        if (input.mode === 'gone') return document.querySelector(`[data-task-id="${input.taskId}"]`) ? false : performance.now();
        return performance.now();
      },
      { mode: settleMode, laneName: options.laneName ?? '', taskId },
      { polling: 'raf', timeout: 8000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(async () => {
      settleTimeout = true;
      return nowInPage();
    });
  const landedIn = await page.evaluate((id) => document.querySelector(`[data-task-id="${id}"]`)?.closest('[data-swimlane-name]')?.getAttribute('data-swimlane-name') ?? null, taskId);

  const tail = options.quickReturn ? 0 : 400;
  if (tail > 0) await sleep(tail);
  const summary = await page.evaluate(summarizeWindow, {
    start,
    end: settleAt + tail,
    extra: {
      releaseAt: Math.round(beforeRelease),
      settleAt: Math.round(settleAt),
      releaseToSettleMs: Math.round(settleAt - beforeRelease),
      gestureMs: Math.round(beforeRelease - start),
      animationsAtHold,
      settleTimeout,
      landedIn,
      ...(options.extra ?? {}),
    },
  });
  summary.overlayLatencyMs = summary.pointerdownAt ? Math.round(overlayAt - summary.pointerdownAt) : null;
  // dnd-kit swallows the first click for 50ms after a drop (a pointerdown is not a click).
  if (!options.quickReturn) await sleep(120);
  return summary;
}

// A raw IPC move bypasses the renderer store (no reload follows it), so the reset is
// an unmeasured UI drag back, which the store's own moveTask reconciles.
async function resetToTodo(taskId) {
  await heldDrag(taskId, '[data-swimlane-name="To Do"]', { holdMs: 400, laneName: 'To Do' });
  await sleep(500);
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------
function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function setup() {
  const mainEntry = path.join(repoRoot, '.vite', 'build', 'index.js');
  if (!fs.existsSync(mainEntry)) throw new Error(`Build not found at ${mainEntry}. Run "npm run build" first.`);
  // `scripts/dev.js` (npm start, /preview) writes its DEV main bundle to the same path, and
  // that bundle loads the renderer from the Vite dev server: React's development build with
  // StrictMode, which is 4 to 7x slower on every synchronous cost. The dev-only inspection
  // route string is dead-code-eliminated from a production build, so its presence means the
  // bundle on disk is not the one this rig exists to measure.
  if (fs.readFileSync(mainEntry, 'utf-8').includes('/event-loop-lag')) {
    throw new Error(`${mainEntry} is the DEV bundle (a running npm start or /preview wrote it). Run "npm run build" again first.`);
  }

  const dataDir = path.join(repoRoot, 'tests', '.test-data', 'drag-perf-rig');
  const projectPath = path.join(repoRoot, 'tests', '.tmp', 'drag-perf-rig-project');
  const barePath = path.join(repoRoot, 'tests', '.tmp', 'drag-perf-rig-remote.git');
  for (const dir of [dataDir, projectPath, barePath]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });

  const mockPath = process.platform === 'win32'
    ? path.join(repoRoot, 'tests', 'fixtures', 'mock-claude-perf.cmd')
    : path.join(repoRoot, 'tests', 'fixtures', 'mock-claude-perf.js');
  if (process.platform !== 'win32') fs.chmodSync(mockPath, 0o755);

  const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version;
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    hasCompletedFirstRun: true,
    lastWhatsNewShownVersion: appVersion,
    notifications: {
      desktop: { onAgentIdle: false, onAgentCrash: false, onPlanComplete: false },
      toasts: { onAgentIdle: false, onAgentCrash: false, onPlanComplete: false, durationSeconds: 4, maxCount: 5 },
      cooldownSeconds: 60,
    },
    agent: { cliPaths: { claude: mockPath }, permissionMode: 'acceptEdits', maxConcurrentSessions: 8, queueOverflow: 'queue' },
  }));

  // A throwaway repo with a local bare remote so the Done probe's fetch path runs.
  git(projectPath, ['init', '-b', 'main']);
  git(projectPath, ['-c', 'user.email=rig@kangentic.test', '-c', 'user.name=kangentic', 'commit', '--allow-empty', '-m', 'init']);
  git(projectPath, ['clone', '--bare', '--quiet', projectPath, barePath]);
  git(projectPath, ['remote', 'add', 'origin', barePath]);
  git(projectPath, ['fetch', '--quiet', 'origin']);
  git(projectPath, ['branch', '--set-upstream-to=origin/main', 'main']);

  app = await electron.launch({
    args: [mainEntry, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, NODE_ENV: 'test', KANGENTIC_DATA_DIR: dataDir, MOCK_PERF_PUSH_HZ: PUSH_HZ, MOCK_PERF_LIFETIME_MS: '1200000' },
    colorScheme: 'dark',
  });
  page = await app.firstWindow({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1600, 1000);
    win.setPosition(60, 60);
    win.show();
    win.focus();
  });
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });

  await page.evaluate((p) => window.electronAPI.projects.openByPath(p), projectPath);
  await page.reload();
  const checklist = page.locator('[data-testid="onboarding-checklist"]');
  await checklist.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
  if (await checklist.isVisible().catch(() => false)) {
    await page.locator('[data-testid="onboarding-skip"]').click();
    await checklist.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  laneIds = await page.evaluate(async () => Object.fromEntries((await window.electronAPI.swimlanes.list()).map((lane) => [lane.name, lane.id])));
  for (const name of ['Executing', 'Code Review', 'Testing', 'Merge']) {
    await page.evaluate(async (id) => { await window.electronAPI.swimlanes.update({ id, auto_spawn: false }); }, laneIds[name]);
  }
  const placements = [['To Do', 4], ['Executing', 2], ['Code Review', 1], ['Testing', 1]];
  let index = 0;
  for (const [laneName, count] of placements) {
    for (let i = 0; i < count; i++) {
      index += 1;
      const id = await createTaskIpc(`Perf card ${index} in ${laneName}`, laneIds['To Do'], false);
      if (laneName !== 'To Do') await moveIpc(id, laneIds[laneName]);
      else todoTasks.push(id);
    }
  }
  for (let i = 1; i <= 15; i++) {
    const id = await createTaskIpc(`Archived perf card ${i}`, laneIds['To Do'], false);
    await moveIpc(id, laneIds['Done']);
  }
  sessionTaskX = await createTaskIpc('Perf session X', laneIds['To Do'], false);
  for (let i = 1; i <= 3; i++) worktreeTasks.push(await createTaskIpc(`Perf worktree session W${i}`, laneIds['To Do'], true));
  spawnWorktreeTask = await createTaskIpc('Perf spawn task with worktree', laneIds['To Do'], true);

  await page.reload();
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.evaluate(installProbe);
  await page.locator(`[data-swimlane-name="To Do"] [data-task-id="${todoTasks[0]}"]`).waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-done-drop-zone]').waitFor({ state: 'visible', timeout: 10000 });
  await sleep(1500);
  return { projectPath, barePath, dataDir };
}

async function teardown(paths) {
  results.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  if (app) {
    await Promise.race([app.close(), sleep(25000)]).catch(() => {});
  }
  for (const dir of [paths?.projectPath, paths?.barePath]) {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function scenarioS0() {
  for (let run = 0; run < RUNS; run++) {
    const idleStart = await nowInPage();
    await sleep(3000);
    const idleEnd = await nowInPage();
    record('S0-idle', await page.evaluate(summarizeWindow, { start: idleStart, end: idleEnd, extra: { run, control: 'idle' } }));
    const board = await page.locator('[data-swimlane-name="To Do"]').boundingBox();
    const target = await page.locator('[data-swimlane-name="Executing"]').boundingBox();
    const moveStart = await nowInPage();
    for (let i = 0; i <= 120; i++) {
      const t = i / 120;
      await page.mouse.move(board.x + 100 + (target.x - board.x) * t, board.y + 200 + Math.sin(t * Math.PI * 2) * 150);
      await sleep(16);
    }
    const moveEnd = await nowInPage();
    record('S0-move', await page.evaluate(summarizeWindow, { start: moveStart, end: moveEnd, extra: { run, control: 'mousemove-no-drag' } }));
  }
}

async function scenarioS1() {
  for (let warm = 0; warm < 2; warm++) {
    await heldDrag(todoTasks[0], '[data-swimlane-name="Executing"]', { holdMs: 800, sweep: true, laneName: 'Executing' });
    await resetToTodo(todoTasks[0]);
  }
  for (let run = 0; run < RUNS; run++) {
    const taskId = todoTasks[run % todoTasks.length];
    record('S1', await heldDrag(taskId, '[data-swimlane-name="Executing"]', { holdMs: 1500, sweep: true, laneName: 'Executing', extra: { run } }));
    await resetToTodo(taskId);
  }
}

async function scenarioS6() {
  for (let run = 0; run < RUNS; run++) {
    const taskId = todoTasks[run % todoTasks.length];
    const summary = await heldDrag(taskId, '[data-swimlane-name="Executing"]', { holdMs: 600, laneName: 'Executing', extra: { run } });
    record('S6', { run, overlayLatencyMs: summary.overlayLatencyMs, pointerupToPaint: summary.pointerupToPaint, loaf: summary.loaf });
    await resetToTodo(taskId);
  }
}

async function scenarioS4b() {
  for (let run = 0; run < RUNS; run++) {
    const cards = page.locator('[data-swimlane-name="To Do"] [data-task-id]');
    const firstId = await cards.first().getAttribute('data-task-id');
    const third = await cards.nth(2).boundingBox();
    if (!firstId || !third) throw new Error('need at least three To Do cards');
    record('S4b', await heldDrag(firstId, '[data-swimlane-name="To Do"]', {
      holdMs: 900,
      targetPoint: { x: third.x + third.width / 2, y: third.y + third.height - 8 },
      settle: 'overlay',
      extra: { run },
    }));
    await sleep(800);
  }
}

async function scenarioS5() {
  for (let run = 0; run < RUNS; run++) {
    const taskId = todoTasks[run % todoTasks.length];
    const scrollers = await page.evaluate(() => Array.from(document.querySelectorAll('.overflow-x-auto')).map((el) => {
      const rect = el.getBoundingClientRect();
      return { scrollLeft: el.scrollLeft, capacity: el.scrollWidth - el.clientWidth, width: el.clientWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    const inner = scrollers.find((s) => s.capacity > 0) ?? scrollers[scrollers.length - 1];
    const summary = await heldDrag(taskId, 'body', {
      holdMs: 1800,
      targetPoint: { x: inner.right - 24, y: inner.top + 260 },
      settle: 'overlay',
      cancel: true,
      extra: { run, scrollBefore: scrollers },
      screenshotAtHold: path.join(path.dirname(OUT), `drag-perf-${LABEL}-s5-run${run}.png`),
    });
    summary.scrollAfter = await page.evaluate(() => Array.from(document.querySelectorAll('.overflow-x-auto')).map((el) => el.scrollLeft));
    record('S5', summary);
    await page.evaluate(() => { for (const el of Array.from(document.querySelectorAll('.overflow-x-auto'))) el.scrollLeft = 0; });
    await sleep(600);
  }
}

// Runs BEFORE S2 so drop-A spawns the board's FIRST session: with no other session
// active, the new one becomes the bottom panel's active tab and mounts an xterm. The
// spawn task has a worktree, so its pane mounts about a second after the drop, inside
// drag-B, as a real task's does.
async function scenarioS3() {
  const spawnTask = spawnWorktreeTask;
  for (let run = 0; run < RUNS; run++) {
    const dragTask = todoTasks[run % todoTasks.length];
    const before = await page.evaluate(() => ({ xterm: document.querySelectorAll('.xterm').length, panes: document.querySelectorAll('[data-testid="terminal-session-pane"]').length }));
    const dropA = await heldDrag(spawnTask, '[data-swimlane-name="Planning"]', { holdMs: 500, laneName: 'Planning', quickReturn: true, extra: { run, phase: 'drop-A', before } });
    const xtermMountAt = page
      .waitForFunction((count) => (document.querySelectorAll('.xterm').length > count ? performance.now() : false), before.xterm, { polling: 'raf', timeout: 20000 })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    const dragB = await heldDrag(dragTask, '[data-swimlane-name="Executing"]', { holdMs: 2500, sweep: true, laneName: 'Executing', quickStart: true, extra: { run, phase: 'drag-B' } });
    const mountAt = await xtermMountAt;
    dragB.xtermMountAt = mountAt ? Math.round(mountAt) : null;
    dragB.xtermMountInsideGesture = mountAt !== null && mountAt >= dragB.pointerdownAt && mountAt <= dragB.releaseAt;
    dragB.after = await page.evaluate(() => ({ xterm: document.querySelectorAll('.xterm').length, panes: document.querySelectorAll('[data-testid="terminal-session-pane"]').length }));
    await sleep(1500);
    const mountWindow = mountAt ? await page.evaluate(summarizeWindow, { start: mountAt - 300, end: mountAt + 1200, extra: { run, phase: 'xterm-mount' } }) : null;
    record('S3', { dropA, dragB, mountWindow });
    await resetToTodo(dragTask);
    await resetToTodo(spawnTask);
    // The To Do move removes the worktree; give the removal and the kill grace time to finish.
    await sleep(6000);
  }
}

async function scenarioS2() {
  await moveIpc(sessionTaskX, laneIds['Planning']);
  await moveIpc(worktreeTasks[0], laneIds['Planning']);
  await waitRunningCount(2);
  await sleep(4000);
  const running = await runningTaskIds();
  for (let run = 0; run < RUNS; run++) {
    const taskId = todoTasks[run % todoTasks.length];
    record('S2', await heldDrag(taskId, '[data-swimlane-name="Executing"]', { holdMs: 1500, sweep: true, laneName: 'Executing', extra: { run, running } }));
    await resetToTodo(taskId);
  }
}

async function scenarioS4a() {
  for (let run = 0; run < RUNS; run++) {
    const taskId = todoTasks[run % todoTasks.length];
    record('S4a', await heldDrag(taskId, '[data-swimlane-name="Code Review"]', { holdMs: 700, laneName: 'Code Review', extra: { run } }));
    await resetToTodo(taskId);
  }
}

async function scenarioS4c() {
  for (let run = 0; run < worktreeTasks.length; run++) {
    const taskId = worktreeTasks[run];
    if (!(await runningTaskIds()).includes(taskId)) {
      await heldDrag(taskId, '[data-swimlane-name="Planning"]', { holdMs: 500, laneName: 'Planning' });
      await waitTaskRunning(taskId);
      await sleep(4000);
    }
    record('S4c', await heldDrag(taskId, '[data-done-drop-zone]', { holdMs: 900, settle: 'gone', extra: { run } }));
    await sleep(2500);
  }
}

const SCENARIOS = [
  ['S0', scenarioS0],
  ['S1', scenarioS1],
  ['S6', scenarioS6],
  ['S4b', scenarioS4b],
  ['S5', scenarioS5],
  ['S3', scenarioS3],
  ['S2', scenarioS2],
  ['S4a', scenarioS4a],
  ['S4c', scenarioS4c],
];

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function median(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function worst(values, direction = 'max') {
  const nums = values.filter((v) => typeof v === 'number');
  if (nums.length === 0) return null;
  return direction === 'max' ? Math.max(...nums) : Math.min(...nums);
}
const fmt = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));

function analyze(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  console.log(`\n=== ${data.label ?? file} (${file}) ===`);
  for (const [scenario, runs] of Object.entries(data.scenarios)) {
    const rows = runs.map((run) => (run.dragB ? run.dragB : run));
    const metric = (key) => rows.map((r) => r[key]);
    console.log(`\n${scenario}: ${rows.length} runs`);
    const table = [
      ['refreshMs', median(metric('refreshMs')), worst(metric('refreshMs'))],
      ['frames', median(metric('frames')), worst(metric('frames'), 'min')],
      ['gestureMs', median(metric('gestureMs')), worst(metric('gestureMs'))],
      ['p95 delta', median(metric('p95')), worst(metric('p95'))],
      ['max delta', median(metric('max')), worst(metric('max'))],
      ['missedVsync', median(metric('missedVsync')), worst(metric('missedVsync'))],
      ['dropped>33', median(metric('dropped33')), worst(metric('dropped33'))],
      ['stallMsOver16', median(metric('stallMsOver16')), worst(metric('stallMsOver16'))],
      ['overlayLatency', median(metric('overlayLatencyMs')), worst(metric('overlayLatencyMs'))],
      ['pointerupToPaint', median(metric('pointerupToPaint')), worst(metric('pointerupToPaint'))],
      ['releaseToSettle', median(metric('releaseToSettleMs')), worst(metric('releaseToSettleMs'))],
      ['loaf count', median(rows.map((r) => (r.loaf ?? []).length)), worst(rows.map((r) => (r.loaf ?? []).length))],
      ['longtask count', median(rows.map((r) => (r.longtasks ?? []).length)), worst(rows.map((r) => (r.longtasks ?? []).length))],
    ];
    console.log('  metric              median     worst');
    for (const [name, med, wst] of table) console.log(`  ${name.padEnd(18)} ${fmt(med).padStart(8)}  ${fmt(wst).padStart(8)}`);
    const eventMax = rows.map((r) => r.eventStats?.maxProcessing);
    if (eventMax.some((v) => typeof v === 'number')) {
      console.log(`  pointer event processing max (ms): median ${fmt(median(eventMax))} worst ${fmt(worst(eventMax))}`);
    }
    for (const r of rows) {
      if (r.slowFrames?.length) console.log(`  run ${r.run} slow frames (t:delta):`, r.slowFrames.slice(0, 20).map((f) => `${f.t}:${f.d}`).join(' '));
      if (r.xtermMountAt !== undefined) console.log(`  run ${r.run} xterm mount inside gesture: ${r.xtermMountInsideGesture}`);
    }
    if (runs[0]?.mountWindow) {
      console.log('  construction frame max (ms):', JSON.stringify(runs.map((r) => r.mountWindow?.max ?? null)));
    }
    const attribution = new Map();
    for (const r of rows) {
      for (const frame of r.loaf ?? []) {
        for (const script of frame.scripts ?? []) {
          const key = `${script.url} | ${script.fn || '(anon)'} | ${script.invoker}`;
          const entry = attribution.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
          entry.count += 1;
          entry.totalMs += script.duration ?? 0;
          entry.maxMs = Math.max(entry.maxMs, script.duration ?? 0);
          attribution.set(key, entry);
        }
      }
    }
    if (attribution.size) {
      console.log('  long-animation-frame scripts (count, total ms, max ms):');
      for (const [key, entry] of [...attribution.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
        console.log(`    ${entry.count}x ${entry.totalMs.toFixed(0)}ms max ${entry.maxMs.toFixed(0)}ms  ${key}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let paths;
try {
  paths = await setup();
  for (const [id, scenario] of SCENARIOS) {
    if (!wants(id)) continue;
    console.log(`[rig] ${id} ...`);
    await scenario();
  }
} catch (error) {
  console.error('[rig] failed:', error);
  process.exitCode = 1;
} finally {
  await teardown(paths);
}
if (fs.existsSync(OUT)) {
  console.log(`[rig] results: ${OUT}`);
  analyze(OUT);
}
