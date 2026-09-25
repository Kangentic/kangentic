/**
 * Every USER close of a board task-detail window must reach the park-or-drop
 * decision.
 *
 * A task-detail window whose Browser pane an agent is driving is PARKED on
 * close (hidden in place, guest and all) rather than removed, so reopening the
 * task re-attaches the same `<webview>` guest. That only holds if every close
 * gesture converges on the one place that asks the policy: `WindowFrame`'s
 * exit-animation `onClose`, which consults `WindowManagerLayerOptions.shouldParkOnClose`.
 *
 * `closeWindow` on the store is the unconditional DROP. A new board close path
 * that calls it directly would bypass parking and destroy the guest silently,
 * which is the bug this scan exists to catch. Every direct caller is therefore
 * listed here with its reason, and an unlisted one fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Every `.ts` / `.tsx` file under a directory, recursively. */
function sourceFiles(relativeDir: string): string[] {
  const root = path.join(REPO_ROOT, relativeDir);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Source with comments removed, so prose naming a call is never read as one. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

/**
 * Files allowed to call `closeWindow(` directly, and why each is a deliberate
 * DROP rather than a user close.
 */
const DIRECT_CLOSE_CALLERS: Record<string, string> = {
  'src/renderer/window-manager/components/WindowFrame.tsx': 'the policy chokepoint itself: drops only when shouldParkOnClose says so',
  'src/renderer/window-manager/bridge/useTaskDetailWindowBridge.ts': 'onCloseHere: main displaced this host, another host now mounts the task',
  'src/renderer/window-manager/bridge/useWindowAutoCloseOnDone.ts': 'the task left the board',
  'src/renderer/window-manager/bridge/window-parking.ts': 'the reaper: the pane closed or the session ended',
  'src/renderer/hooks/useProjectSwitchEffect.ts': 'conversation windows on a project switch (never a browser pane)',
  'src/renderer/components/command-bar/CommandTerminalWindow.tsx': 'command-terminal layer (never a browser pane)',
  'src/renderer/components/command-bar/CommandTerminalLayer.tsx': 'command-terminal layer (never a browser pane)',
  'src/renderer/components/monitor/useMonitorDetailOwnership.ts': 'monitor layer displacement (the monitor never parks)',
};

describe('every board close path reaches the park-or-drop decision', () => {
  it('only the listed files call closeWindow directly', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src/renderer')) {
      const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (!/\bcloseWindow\(/.test(code(fs.readFileSync(file, 'utf-8')))) continue;
      if (relative in DIRECT_CLOSE_CALLERS) continue;
      offenders.push(relative);
    }
    expect(
      offenders,
      'A new direct closeWindow caller bypasses parking, so a Browser pane an agent is driving '
      + 'would be destroyed on close. Route a user close through WindowFrame (requestClose), or '
      + 'add the file to DIRECT_CLOSE_CALLERS with the reason it is a deliberate drop.',
    ).toEqual([]);
  });

  it('every listed caller still exists and still calls closeWindow', () => {
    // A stale allowlist entry would let a renamed file drop out of the scan.
    for (const relative of Object.keys(DIRECT_CLOSE_CALLERS)) {
      expect(fs.existsSync(path.join(REPO_ROOT, relative)), `${relative} is listed but missing`).toBe(true);
      expect(/\bcloseWindow\(/.test(code(read(relative))), `${relative} no longer calls closeWindow`).toBe(true);
    }
  });

  it('WindowFrame consults the layer policy before dropping', () => {
    const source = code(read('src/renderer/window-manager/components/WindowFrame.tsx'));
    expect(source).toMatch(/shouldParkOnClose/);
    expect(source).toMatch(/parkWindow\(/);
  });

  it('the board layer supplies the policy and mounts the reaper', () => {
    const source = code(read('src/renderer/window-manager/components/WindowLayer.tsx'));
    expect(source).toMatch(/shouldParkOnClose:\s*shouldParkTaskDetailWindowOnClose/);
    expect(source).toMatch(/useParkedWindowReaper\(\)/);
  });

  it('the policy is bounded to a mounted Browser pane (showing or held) on a task with a running session', () => {
    const source = code(read('src/renderer/window-manager/bridge/window-parking.ts'));
    expect(source).toMatch(/browserOpenTasks\.has\(/);
    expect(source).toMatch(/browserHeldTasks\.has\(/);
    expect(source).toMatch(/status === 'running'/);
    // The reaper also ends a hold once the session stops, so a pane hidden under
    // one session never re-mounts invisibly under the task's next one.
    expect(source).toMatch(/releaseBrowserHold\(/);
  });
});
