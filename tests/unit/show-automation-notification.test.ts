/**
 * Notify me reaches the desktop and every paired phone through one helper,
 * `showAutomationNotification`, which every place that builds an automation
 * context wires to `AutomationContext.showNotification`.
 *
 * The behavior half drives the helper with the desktop path mocked. The scan
 * half pins the wiring: a call to `showDesktopNotification` outside the files
 * allowed below is an automation context (or a new notification) that would
 * skip the phone, so it fails until it is routed through the helper or
 * classified here with its reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const hoisted = vi.hoisted(() => ({ showDesktopNotification: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: hoisted.showDesktopNotification }));

import { showAutomationNotification } from '../../src/main/automations/shared/show-automation-notification';

const INPUT = { title: 'Cap retries in the sync client', body: 'Blocked', projectId: 'proj-1', taskId: 'task-1' };

describe('showAutomationNotification', () => {
  beforeEach(() => hoisted.showDesktopNotification.mockReset());

  it('shows the desktop notification and pushes the same title and body to the phones', () => {
    const notifyAutomation = vi.fn();
    const context = { mobileBridgeService: { notifyAutomation } } as unknown as IpcContext;
    showAutomationNotification(context, INPUT);
    expect(hoisted.showDesktopNotification).toHaveBeenCalledWith(context, INPUT);
    expect(notifyAutomation).toHaveBeenCalledWith(INPUT);
  });

  it('still shows the desktop notification when there is no mobile bridge service', () => {
    const context = {} as unknown as IpcContext;
    showAutomationNotification(context, INPUT);
    expect(hoisted.showDesktopNotification).toHaveBeenCalledTimes(1);
  });
});

/** Files that may call `showDesktopNotification` directly, and why. */
const DESKTOP_ONLY_CALLERS: Record<string, string> = {
  'src/main/ipc/handlers/system.ts': 'defines it, and serves the renderer\'s NOTIFICATION_SHOW channel',
  'src/main/ipc/register-all.ts': 'the DesktopNotifier\'s own alerts, which reach the phone through the push notifier under its own settings',
  'src/main/automations/shared/show-automation-notification.ts': 'the helper itself',
};

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(entryPath));
    else if (entry.name.endsWith('.ts')) files.push(entryPath);
  }
  return files;
}

describe('showDesktopNotification call sites', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  it('only the classified files call it; every automation context goes through showAutomationNotification', () => {
    const offenders = listTypeScriptFiles(path.join(repoRoot, 'src/main'))
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
      .filter((relativePath) => !(relativePath in DESKTOP_ONLY_CALLERS))
      .filter((relativePath) => /\bshowDesktopNotification\s*\(/.test(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every classified file still exists and still calls it, so the list cannot rot', () => {
    for (const relativePath of Object.keys(DESKTOP_ONLY_CALLERS)) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source, relativePath).toMatch(/\bshowDesktopNotification\s*\(/);
    }
  });
});
