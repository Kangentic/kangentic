/**
 * `copilotHomeDir`: Copilot CLI's config home, `$COPILOT_HOME` when set, else
 * `~/.copilot`. A session's own config home is seeded from it, so it must be
 * the folder the user's Copilot uses, or the session starts without the
 * user's sign-in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copilotHomeDir } from '../../src/main/agent/adapters/copilot/copilot-home';
import { writeSessionConfig } from '../../src/main/agent/adapters/copilot/hook-manager';

const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.COPILOT_HOME;
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('copilotHomeDir', () => {
  it('is ~/.copilot with no COPILOT_HOME, an empty one, or a relative one', () => {
    expect(copilotHomeDir()).toBe(path.join(os.homedir(), '.copilot'));
    process.env.COPILOT_HOME = ' ';
    expect(copilotHomeDir()).toBe(path.join(os.homedir(), '.copilot'));
    process.env.COPILOT_HOME = 'relative-copilot';
    expect(copilotHomeDir()).toBe(path.join(os.homedir(), '.copilot'));
  });

  it('is an absolute COPILOT_HOME, which seeds a session\'s config with the user\'s account', () => {
    const userHome = makeDirectory('kangentic-copilot-home-');
    process.env.COPILOT_HOME = userHome;
    expect(copilotHomeDir()).toBe(userHome);

    fs.writeFileSync(path.join(userHome, 'config.json'), JSON.stringify({ logged_in_users: [{ login: 'dev' }] }));
    const sessionConfig = path.join(makeDirectory('kangentic-copilot-session-'), 'copilot-config');
    writeSessionConfig(sessionConfig, path.join(sessionConfig, '..', 'events.jsonl'));
    const seeded = JSON.parse(fs.readFileSync(path.join(sessionConfig, 'config.json'), 'utf-8')) as { logged_in_users?: unknown };
    expect(seeded.logged_in_users).toEqual([{ login: 'dev' }]);
  });
});
