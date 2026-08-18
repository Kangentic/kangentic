/**
 * Static guard for `.claude/rules/agent-driven-focus.md`.
 *
 * The policy tests elsewhere prove the arbiter and the guard make the right
 * DECISIONS. Nothing proved that every path an agent can reach actually asks
 * them, and that is where this bug class lives: `kangentic_browser_open_pane`
 * arrives as an ordinary IPC push, indistinguishable from the user's own card
 * click, so a renderer that opens a window off that push and forgets to declare
 * the origin silently hands the agent the user's keyboard.
 *
 * That is not hypothetical. Writing this scan is what found the Agent Monitor
 * path: `useMonitorDetailOwnership` is a SECOND host for the same `onOpenHere`
 * push, and it opened its window unstamped - so an agent-opened detail that
 * landed on the monitor instead of the board took focus exactly as before the
 * fix, on the one path the board-side fix did not cover.
 *
 * The scan cannot decide agent-vs-user for a shared push (the rule says so
 * explicitly). What it CAN do is refuse to let the question go unanswered: a
 * file that both subscribes to a push and opens a window must either thread the
 * origin through, or carry an `// agent-focus-ok: <reason>` marker where a human
 * made the call.
 *
 * Tier: Unit (vitest, static scan).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_DIR = path.join(REPO_ROOT, 'src/renderer');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

const OK_MARKER = /agent-focus-ok/;
/** Opening or re-pointing a task detail. Both end in a window that can host a terminal. */
const OPENS_A_WINDOW = /\b(openWindow|setDetailTaskId)\s*\(/;
/** Threading the origin through, in either of its two spellings. */
const DECLARES_ORIGIN = /\b(agentInitiated|openedByAgent)\b/;
/**
 * Subscribing to a main -> renderer push. Matched loosely on the `.onX(` call
 * shape rather than on `window.electronAPI.…`, because the real sites
 * destructure the namespace first (`const browser = window.electronAPI?.browser`
 * then `browser.onPaneOpenRequest(...)`) and a prefixed pattern would skip
 * exactly the files this rule exists to protect. The `window.electronAPI`
 * co-requirement keeps unrelated `.onFoo(` callbacks out.
 */
const SUBSCRIBES_TO_PUSH = /\.on[A-Z]\w*\s*\(/;
const USES_ELECTRON_API = /window\.electronAPI/;

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectSourceFiles(full));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

const toPosix = (absolute: string) => path.relative(REPO_ROOT, absolute).split(path.sep).join('/');

/**
 * Blank out comment text so a file explaining WHY it avoids something is not
 * flagged for mentioning it. `BrowserEmptyState` documents the `autoFocus` it
 * deliberately does not use, and an unstripped scan reads that as the offence.
 * Markers are still read from the ORIGINAL source, since they live in exactly
 * the comments this removes.
 */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
      const inlineComment = line.indexOf('//');
      return inlineComment >= 0 ? line.slice(0, inlineComment) : line;
    })
    .join('\n');
}

/** Files that both take a push and open a window: the sites the rule governs. */
function agentReachableWindowOpeners(): { relative: string; source: string }[] {
  return collectSourceFiles(RENDERER_DIR)
    .map((absolute) => ({ relative: toPosix(absolute), source: fs.readFileSync(absolute, 'utf-8') }))
    .filter(({ source }) =>
      OPENS_A_WINDOW.test(source)
      && SUBSCRIBES_TO_PUSH.test(source)
      && USES_ELECTRON_API.test(source));
}

describe('agent-reachable window opens declare their origin', () => {
  it('every push-driven window opener threads the origin or carries a marker', () => {
    const offenders = agentReachableWindowOpeners()
      .filter(({ source }) => !DECLARES_ORIGIN.test(source) && !OK_MARKER.test(source))
      .map(({ relative }) => relative);

    expect(
      offenders,
      [
        'These renderer files subscribe to a main-process push AND open a task-detail window,',
        'but never say whether the open was agent-initiated.',
        '',
        'An agent open must pass `agentInitiated` / `openedByAgent` so the arrival-focus',
        'arbiter denies focus to every terminal; a user-initiated one must carry an',
        '`// agent-focus-ok: <reason>` marker saying so. The push itself cannot be told',
        'apart, which is why the decision has to be written down.',
        '',
        'See .claude/rules/agent-driven-focus.md.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('scans the sites it is meant to cover', () => {
    // Anti-vacuity pin, the same shape terminal-arrival-focus-sites.test.ts uses.
    // A renamed hook or a moved file would otherwise silently empty the scan, and
    // an empty scan passes.
    const scanned = agentReachableWindowOpeners().map(({ relative }) => relative).sort();
    expect(scanned).toEqual([
      'src/renderer/App.tsx',
      'src/renderer/components/monitor/useMonitorDetailOwnership.ts',
      'src/renderer/window-manager/bridge/useBrowserPaneRequestBridge.ts',
      'src/renderer/window-manager/bridge/useTaskDetailWindowBridge.ts',
    ]);
    // `useProjectSwitchEffect` is deliberately NOT here: it re-opens a task
    // detail from `_pendingOpenTaskId` but subscribes to no push itself, so it
    // is downstream of whoever parked the id rather than a site that can tell
    // agent from user. It carries an `agent-focus-ok` note anyway, recording
    // that the agent's open_pane refuses a backgrounded project outright rather
    // than parking an id - which is what keeps it off this list.
  });

  it('the agent-reachable bridges PASS the origin into the open, not merely mention it', () => {
    // Checked as a passed ARGUMENT (`openedByAgent:` / `agentInitiated: true`),
    // not as the identifier appearing anywhere in the file. A presence check
    // passes vacuously: deleting `openedByAgent: agentInitiated` from the
    // openWindow literal leaves the surrounding `const agentInitiated = ...` and
    // `markAgentOpened(...)` behind, so the token is still there while the stamp
    // no longer reaches the window. Verified by removing it and watching this
    // fail.
    const PASSES_ORIGIN = /\bopenedByAgent\s*:|\bagentInitiated\s*:\s*true/;
    for (const relative of [
      'src/renderer/window-manager/bridge/useBrowserPaneRequestBridge.ts',
      'src/renderer/window-manager/bridge/useTaskDetailWindowBridge.ts',
      'src/renderer/components/monitor/useMonitorDetailOwnership.ts',
    ]) {
      const source = codeOnly(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8'));
      expect(
        PASSES_ORIGIN.test(source),
        `${relative} must PASS the origin into its window open (openedByAgent: ... / agentInitiated: true), not just compute it`,
      ).toBe(true);
    }
  });
});

describe('the focus guarantee stays wired into the driver chokepoint', () => {
  const driver = fs.readFileSync(
    path.join(REPO_ROOT, 'src/main/browser/browser-pane-driver.ts'),
    'utf-8',
  );

  it('withGuest arms focus emulation', () => {
    expect(
      driver,
      'withGuest must call ensureFocusEmulation, or a restore of the user\'s focus leaves the guest unable to receive the next typed character',
    ).toMatch(/ensureFocusEmulation\(/);
  });

  it('withGuest announces the drive and ends it in a finally', () => {
    expect(driver).toMatch(/beginAgentInput\(/);
    expect(
      driver,
      'endAgentInput must run in a `finally`, or a throwing tool leaves the guard armed forever and keeps pulling focus out of the pane',
    ).toMatch(/finally\s*\{[\s\S]{0,400}endAgentInput\(/);
  });
});

describe('no agent-reachable browser surface autofocuses on mount', () => {
  it('components/browser carries no bare autoFocus', () => {
    // BrowserEmptyState can mount from kangentic_browser_open_pane, so a bare
    // `autoFocus` there is an agent-triggered focus steal.
    const browserDir = path.join(RENDERER_DIR, 'components/browser');
    const offenders = collectSourceFiles(browserDir)
      .map((absolute) => ({ relative: toPosix(absolute), source: fs.readFileSync(absolute, 'utf-8') }))
      .filter(({ source }) => /\bautoFocus\b/.test(codeOnly(source)) && !OK_MARKER.test(source))
      .map(({ relative }) => relative);

    expect(
      offenders,
      'A Browser pane surface can be mounted by an agent, so it must not autofocus on mount. Gate the focus on focusIsInTypingSurface(), or mark the site `// agent-focus-ok: <reason>`.',
    ).toEqual([]);
  });
});
