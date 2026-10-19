/**
 * Which prompt-history files `CopilotAdapter.getSubmissionVerifier('command-injection')`
 * reads, driven through the real adapter.
 *
 * Every Kangentic session runs Copilot with `--config-dir <session dir>/copilot-config`,
 * and Copilot keeps `command-history-state.json` in its config home. So a
 * submission lands in THAT session's folder, never in the default `~/.copilot`.
 * The verifier has to read the files of the sessions the adapter built a command
 * for, scoped to the folder the injection is for (another folder's session is
 * another task's prompt history), and then the default one.
 *
 * `createCopilotCommandInjectionVerifier` takes its file list as a callback and
 * is covered with an injected one in copilot-command-injection-verifier.test.ts.
 * What only the ADAPTER can break is the callback it builds: that it names the
 * session config dirs it recorded at `buildCommand`, that it filters them by the
 * context's folder, and that the default home is still consulted. The callback is
 * private to `getSubmissionVerifier`, and the verifier returns one boolean, so
 * the ORDER of the files is not observable from here. What is pinned is which
 * files are read, by putting the proof of a submission in exactly one of them.
 *
 * `os.homedir()` is mocked to a temp dir and the submitted text is a unique
 * token, so a real `~/.copilot` on the machine running the test cannot confirm
 * or refute anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let temporaryHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => temporaryHome },
    homedir: () => temporaryHome,
  };
});

// copilot-hook-manager.test.ts covers the real file operations.
vi.mock('../../src/main/agent/adapters/copilot/hook-manager', () => ({
  writeSessionConfig: vi.fn(),
  removeSessionConfig: vi.fn(),
  buildHooks: vi.fn(() => ({})),
  COPILOT_HOOK_EVENTS: [],
}));
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn((name: string) => `/fake/scripts/${name}.js`),
}));

import { CopilotAdapter } from '../../src/main/agent/adapters/copilot';
import { COPILOT_HISTORY_FILE_NAME } from '../../src/main/agent/adapters/copilot/command-injection-verifier';
import type { SubmissionContext } from '../../src/shared/types';

describe('CopilotAdapter command-injection verifier: which history files it reads', () => {
  let root: string;
  let adapter: CopilotAdapter;
  let projectA: string;
  let projectB: string;
  let sentAt: number;
  const submittedText = `/review-token-${Date.now().toString(36)}`;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-copilot-history-'));
    temporaryHome = path.join(root, 'home');
    fs.mkdirSync(temporaryHome, { recursive: true });
    projectA = path.join(root, 'project-a');
    projectB = path.join(root, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    adapter = new CopilotAdapter();
    sentAt = Date.now();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Build a command the way the session layer does, and return the session's config dir. */
  function startSession(ptySessionId: string, cwd: string): string {
    const sessionDirectory = path.join(root, 'sessions', ptySessionId);
    adapter.buildCommand({
      agentPath: '/usr/local/bin/copilot',
      taskId: `task-of-${ptySessionId}`,
      ptySessionId,
      cwd,
      permissionMode: 'acceptEdits',
      eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    });
    return path.resolve(sessionDirectory, 'copilot-config');
  }

  /** Write a history file the way Copilot does, stamped as written just after the Enter. */
  function writeHistory(directory: string, commands: string[]): void {
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, COPILOT_HISTORY_FILE_NAME);
    fs.writeFileSync(filePath, JSON.stringify({ commandHistory: commands }));
    const stampSeconds = (sentAt + 20) / 1000;
    fs.utimesSync(filePath, stampSeconds, stampSeconds);
  }

  function defaultHomeDirectory(): string {
    return path.join(temporaryHome, '.copilot');
  }

  async function confirms(cwd: string | undefined): Promise<boolean> {
    const verifier = adapter.getSubmissionVerifier('command-injection');
    expect(verifier).not.toBeNull();
    const context: SubmissionContext = {
      type: 'command-injection',
      text: submittedText,
      sentAt,
      mode: 'submitted',
      ...(cwd === undefined ? {} : { cwd }),
    };
    return verifier!(context);
  }

  it('confirms a submission recorded only in the session\'s own config home', async () => {
    const configDirectory = startSession('session-a', projectA);
    writeHistory(configDirectory, [submittedText]);

    expect(await confirms(projectA)).toBe(true);
  });

  it('does not confirm when no history file holds the submission', async () => {
    const configDirectory = startSession('session-a', projectA);
    writeHistory(configDirectory, ['something else entirely']);
    writeHistory(defaultHomeDirectory(), ['and another thing']);

    expect(await confirms(projectA)).toBe(false);
  });

  it('still reads the default config home, for a Copilot that kept its history there', async () => {
    startSession('session-a', projectA);
    writeHistory(defaultHomeDirectory(), [submittedText]);

    expect(await confirms(projectA)).toBe(true);
  });

  it('reads the default config home when the adapter has built no session at all', async () => {
    writeHistory(defaultHomeDirectory(), [submittedText]);

    expect(await confirms(projectA)).toBe(true);
  });

  it('does not read the history of a session built for another folder', async () => {
    startSession('session-a', projectA);
    const otherConfigDirectory = startSession('session-b', projectB);
    writeHistory(otherConfigDirectory, [submittedText]);

    // Project B's prompt history is not proof that project A's Enter landed.
    expect(await confirms(projectA)).toBe(false);
    // The control: the same file is read for the folder it belongs to.
    expect(await confirms(projectB)).toBe(true);
  });

  it('reads every session built for the folder, not only the newest', async () => {
    const firstConfigDirectory = startSession('session-first', projectA);
    startSession('session-second', projectA);
    writeHistory(firstConfigDirectory, [submittedText]);

    expect(await confirms(projectA)).toBe(true);
  });

  it('reads every tracked session when the injection names no folder', async () => {
    // With no cwd there is nothing to scope by, so the filter must not drop
    // everything: a caller that omits it still gets an answer.
    startSession('session-a', projectA);
    const otherConfigDirectory = startSession('session-b', projectB);
    writeHistory(otherConfigDirectory, [submittedText]);

    expect(await confirms(undefined)).toBe(true);
  });
});
