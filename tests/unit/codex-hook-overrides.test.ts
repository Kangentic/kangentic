/**
 * Codex's hooks as `-c` overrides, and the trust Codex itself confirms for them
 * (task #859, measured on codex-cli 0.154.0 and 0.163.0).
 *
 * Codex runs a session-flags hook only with a matching `hooks.state` entry, and
 * its TUI opens a blocking "Hooks need review" dialog for any hook without one.
 * So Kangentic asks the binary's `app-server` for the key and hash of its exact
 * overrides (`hook-trust.ts`) and wires nothing when the answer is not whole.
 *
 * The values travel through the user's shell inside one quoted argument, where
 * `quoteArg` turns a content `"` into `'` on Windows. The round trips at the end
 * type the built command at every shell installed here and read back what the
 * program received.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fakeBridgeSource = '';
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn(() => fakeBridgeSource),
}));

import { buildCodexHookOverrides, codexHookDefinitions, codexHookStateOverride, CODEX_EVENT_BRIDGE_COPY_NAME, type CodexHookTrustEntry } from '../../src/main/agent/adapters/codex/hook-manager';
import { CodexHookTrustCheck, readCodexHookTrust, trustEntriesOf } from '../../src/main/agent/adapters/codex/hook-trust';
import { CodexCommandBuilder, type CodexCommandOptions } from '../../src/main/agent/adapters/codex/command-builder';
import type { CliChildProcess } from '../../src/main/utility-process/off-main-cli';
import { quoteArg } from '../../src/shared/paths';
import {
  createShellArgvProbe,
  gitBashPath,
  installedPosixShells,
  installedPowerShellHosts,
  lineWithPrinterHead,
  runAsHookShell,
  typeAtCmdPrompt,
  typeAtPosixShell,
  typeAtPowerShellPrompt,
  type ShellArgvProbe,
} from './helpers/shell-argv-probe';

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'PreCompact'];

/** Trust entries shaped like Codex 0.163.0's `hooks/list` answer on Windows. */
function reportedEntries(): Array<{ key: string; hash: string }> {
  return HOOK_EVENTS.map((event, index) => ({
    key: `C:\\<session-flags>\\config.toml:${event.replace(/[A-Z]/g, (letter, offset: number) => (offset ? '_' : '') + letter.toLowerCase())}:0:0`,
    hash: `sha256:${String(index).repeat(64).slice(0, 64)}`,
  }));
}

/** The command each override registers, read back out of its TOML literal. */
function commandOf(override: string): string {
  const match = /command='([^']*)'/.exec(override);
  if (!match) throw new Error(`no command in ${override}`);
  return match[1];
}

describe('buildCodexHookOverrides', () => {
  const overrides = buildCodexHookOverrides();

  it('registers one hook per Codex event Kangentic reads, with an explicit timeout', () => {
    expect(overrides.map((override) => /^hooks\.(\w+)=/.exec(override)?.[1])).toEqual(HOOK_EVENTS);
    // Codex hashes a hook with its timeout and fills 600 when absent.
    for (const override of overrides) expect(override).toMatch(/,timeout=10\}\]\}\]$/);
  });

  it('holds no double quote, so quoteArg keeps it whole on every shell', () => {
    for (const override of overrides) expect(override).not.toContain('"');
  });

  it('runs the bridge from its workspace copy with the events path from the environment, in bare tokens', () => {
    for (const override of overrides) {
      const tokens = commandOf(override).split(' ');
      expect(tokens.slice(0, 3)).toEqual(['node', `.kangentic/${CODEX_EVENT_BRIDGE_COPY_NAME}`, 'env:KANGENTIC_EVENTS_PATH']);
      for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_./:+=-]+$/);
    }
  });

  it('maps a permission prompt to a permission idle and a Stop to a plain idle', () => {
    const typeOf = (event: string): string => commandOf(overrides[HOOK_EVENTS.indexOf(event)]).split(' ')[3];
    expect(typeOf('PermissionRequest')).toBe('idle');
    expect(typeOf('Stop')).toBe('idle');
    expect(typeOf('PreToolUse')).toBe('tool_start');
    expect(typeOf('PostToolUse')).toBe('tool_end');
    const permissionDirectives = commandOf(overrides[HOOK_EVENTS.indexOf('PermissionRequest')]).split(' ').slice(4)
      .map((token) => JSON.parse(Buffer.from(token.slice(token.indexOf(':') + 1), 'base64').toString('utf8')));
    expect(permissionDirectives).toContainEqual({ value: 'permission' });
  });
});

describe('codexHookStateOverride', () => {
  it('writes each reported key and hash as a TOML literal entry', () => {
    const state = codexHookStateOverride(reportedEntries().slice(0, 1));
    expect(state).toBe(`hooks.state={'C:\\<session-flags>\\config.toml:session_start:0:0'={trusted_hash='sha256:${'0'.repeat(64)}'}}`);
  });

  it('refuses an entry it cannot write safely, and an empty answer', () => {
    expect(codexHookStateOverride([])).toBeNull();
    expect(codexHookStateOverride([{ key: "it's", hash: `sha256:${'a'.repeat(64)}` }])).toBeNull();
    expect(codexHookStateOverride([{ key: 'key', hash: 'md5:abc' }])).toBeNull();
  });

  // The key travels inside one pair of shell quotes (quoteArg), where a double
  // quote, a percent sign, a backtick and a dollar sign are each read by some
  // shell (cmd expands %NAME% even inside quotes, PowerShell reads $ and the
  // backtick inside its double quotes, and a double quote ends the quote on
  // Windows), so a key holding one must be refused rather than written.
  const VALID_HASH = `sha256:${'a'.repeat(64)}`;
  const WINDOWS_KEY_SHAPE = 'C:\\<session-flags>\\config.toml:stop:0:0';

  it.each([
    ['a double quote', '"'],
    ['a percent sign', '%'],
    ['a backtick', '`'],
    ['a dollar sign', '$'],
    ['a single quote', '\''],
    ['a carriage return', '\r'],
    ['a line feed', '\n'],
  ])('refuses a key holding %s', (_description, character) => {
    const key = `C:\\<session-flags>\\config.toml:${character}stop:0:0`;
    expect(codexHookStateOverride([{ key, hash: VALID_HASH }])).toBeNull();
    // The same key without the character is accepted, so the refusal is the character's.
    expect(codexHookStateOverride([{ key: key.replace(character, ''), hash: VALID_HASH }])).not.toBeNull();
  });

  it('refuses the whole answer when one entry of several holds an unsafe key', () => {
    const entries = [
      { key: WINDOWS_KEY_SHAPE, hash: VALID_HASH },
      { key: 'C:\\<session-flags>\\config.toml:%PATH%:0:0', hash: VALID_HASH },
    ];
    expect(codexHookStateOverride(entries)).toBeNull();
  });

  it('still accepts the key shape Codex reports on Windows', () => {
    expect(codexHookStateOverride([{ key: WINDOWS_KEY_SHAPE, hash: VALID_HASH }]))
      .toBe(`hooks.state={'${WINDOWS_KEY_SHAPE}'={trusted_hash='${VALID_HASH}'}}`);
  });
});

describe('trustEntriesOf', () => {
  const definitions = codexHookDefinitions().slice(0, 2);
  const listing = (hooks: unknown[], extra: Record<string, unknown> = {}): unknown => ({ data: [{ cwd: 'x', hooks, warnings: [], errors: [], ...extra }] });
  const sessionFlagHook = (key: string, command: string, timeoutSec = 10): Record<string, unknown> =>
    ({ key, source: 'sessionFlags', command, timeoutSec, currentHash: `sha256:${'b'.repeat(64)}` });

  it('takes the session-flags hooks when each is listed with the command and timeout passed', () => {
    const result = listing([
      sessionFlagHook('k2', definitions[1].command),
      sessionFlagHook('k1', definitions[0].command),
      { key: 'user', source: 'user', command: 'node user-hook.js', timeoutSec: 10, currentHash: 'sha256:x' },
    ]);
    expect(trustEntriesOf(result, definitions)).toEqual([
      { key: 'k2', hash: `sha256:${'b'.repeat(64)}` },
      { key: 'k1', hash: `sha256:${'b'.repeat(64)}` },
    ]);
  });

  it('answers null when the read delivered a command Kangentic did not pass, so Codex hashed other text', () => {
    // A session's command reaches Codex through the user's shell and the read's
    // through spawnCli; a difference between the two must never become a hash
    // the session's own hooks do not match.
    const altered = listing([sessionFlagHook('k1', definitions[0].command), sessionFlagHook('k2', `${definitions[1].command} `)]);
    expect(trustEntriesOf(altered, definitions)).toBeNull();
    const clamped = listing([sessionFlagHook('k1', definitions[0].command), sessionFlagHook('k2', definitions[1].command, 3)]);
    expect(trustEntriesOf(clamped, definitions)).toBeNull();
  });

  it('answers null for a missing hook, an error, or a warning such as a clamped timeout', () => {
    expect(trustEntriesOf(listing([sessionFlagHook('k1', definitions[0].command)]), definitions)).toBeNull();
    const both = [sessionFlagHook('k1', definitions[0].command), sessionFlagHook('k2', definitions[1].command)];
    expect(trustEntriesOf(listing(both, { errors: ['bad'] }), definitions)).toBeNull();
    expect(trustEntriesOf(listing(both, { warnings: ['clamping SessionEnd hook timeout to 3s'] }), definitions)).toBeNull();
    expect(trustEntriesOf({ data: [] }, definitions)).toBeNull();
  });
});

/** The `{ id, result }` message tests/fixtures/codex-hooks/codex-0.163.0-hooks-list.json holds. */
interface CapturedHooksListMessage {
  id: number;
  result: { data: Array<{ hooks: Array<{ key: string; currentHash: string }> }> };
}

// The fixture is a real `hooks/list` answer from codex-cli 0.163.0, captured for
// exactly Kangentic's overrides. If this block fails because the commands no
// longer match, the hook commands changed since the capture: capture the answer
// again for the new commands rather than editing the fixture.
describe('trustEntriesOf over the hooks/list answer captured from codex-cli 0.163.0', () => {
  const captured = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-hooks', 'codex-0.163.0-hooks-list.json'), 'utf-8'),
  ) as CapturedHooksListMessage;
  const capturedHooks = captured.result.data[0].hooks;

  it('lists all seven hooks with the key and hash Codex computed for the commands Kangentic passes', () => {
    const entries = trustEntriesOf(captured.result, codexHookDefinitions());
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(7);
    expect(entries).toEqual(capturedHooks.map((hook) => ({ key: hook.key, hash: hook.currentHash })));
    expect(entries).toContainEqual({
      key: 'C:\\<session-flags>\\config.toml:stop:0:0',
      hash: 'sha256:82de9976ca78913705bbf1ccdaccca84c4c3d4deae47f6c2defe8b13fa25bbe0',
    });
  });

  it('turns the captured entries into a hooks.state override that trusts every one of them', () => {
    const entries = trustEntriesOf(captured.result, codexHookDefinitions());
    const state = codexHookStateOverride(entries ?? []);
    expect(state).not.toBeNull();
    expect(state!.startsWith('hooks.state={')).toBe(true);
    for (const hook of capturedHooks) {
      expect(state).toContain(`'${hook.key}'={trusted_hash='${hook.currentHash}'}`);
    }
  });
});

/** A child that speaks app-server's side of the conversation from a script. */
function scriptedAppServer(answer: (method: string) => unknown): { child: CliChildProcess; written: string[]; argv: string[]; environment: Record<string, string> } {
  const stdout = Object.assign(new EventEmitter(), { resume: () => undefined });
  const stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  const written: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      written.push(chunk);
      const message = JSON.parse(chunk) as { id?: number; method: string };
      if (message.id === undefined) return true;
      const result = answer(message.method);
      if (result !== undefined) setImmediate(() => stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result })}\n`)));
      return true;
    },
    end: () => undefined,
  });
  // stopTree is what stopCli calls on a process running elsewhere (the pty host),
  // so a read's stop never reaches stopChildTree on this pid-less fake.
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdout, stderr, stdin, kill: () => true, stopTree: () => undefined }) as unknown as CliChildProcess;
  return { child, written, argv: [], environment: {} };
}

describe('readCodexHookTrust', () => {
  /**
   * Every scratch folder a read made, removed after the test whatever it asserted.
   * A fake app-server never exits on its own, so the read's own removal waits for
   * an exit that does not come.
   */
  const scratchFolders: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const folder of scratchFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  });

  /** A spawn that hands back `child` and records the scratch folder the read made for it. */
  function spawnReturning(child: CliChildProcess): NonNullable<Parameters<typeof readCodexHookTrust>[2]> {
    return (_cliPath, _args, workingDirectory) => {
      scratchFolders.push(path.dirname(workingDirectory));
      return child;
    };
  }

  /** hooks/list answered whole, so the read resolves with every entry. */
  function wholeAnswerServer(): ReturnType<typeof scriptedAppServer> {
    const definitions = codexHookDefinitions();
    return scriptedAppServer((method) => (method === 'initialize'
      ? {}
      : {
        data: [{
          hooks: reportedEntries().map((entry, index) => ({
            key: entry.key, source: 'sessionFlags', command: definitions[index].command, timeoutSec: 10, currentHash: entry.hash,
          })),
          warnings: [],
          errors: [],
        }],
      }));
  }

  it('asks app-server for the overrides in a scratch home and returns what hooks/list reported', async () => {
    const definitions = codexHookDefinitions();
    const overrides = definitions.map((definition) => definition.override);
    const server = wholeAnswerServer();
    let spawnedArgs: string[] = [];
    let spawnedEnvironment: Record<string, string> | undefined;
    const entries = await readCodexHookTrust('codex', definitions, (_cliPath, args, workingDirectory, environment) => {
      scratchFolders.push(path.dirname(workingDirectory));
      spawnedArgs = args;
      spawnedEnvironment = environment;
      return server.child;
    });
    expect(entries).toEqual(reportedEntries());
    expect(spawnedArgs[0]).toBe('app-server');
    expect(spawnedArgs.filter((arg) => arg !== '-c').slice(1)).toEqual(overrides);
    expect(spawnedEnvironment?.CODEX_HOME).toContain('kangentic-codex-hooks-');
    expect(server.written.map((line) => (JSON.parse(line) as { method: string }).method)).toEqual(['initialize', 'initialized', 'hooks/list']);
  });

  it('rejects when app-server exits without answering, so the check can read again later', async () => {
    const server = scriptedAppServer(() => undefined);
    const pending = readCodexHookTrust('codex', codexHookDefinitions().slice(0, 1), spawnReturning(server.child));
    setImmediate(() => server.child.emit('exit', 1, null));
    await expect(pending).rejects.toThrow(/exited before answering/);
  });

  it('survives an EPIPE on the app-server stdin, and rejects once the app-server exits', async () => {
    const server = scriptedAppServer(() => undefined);
    const stdin = server.child.stdin;
    const escaped: unknown[] = [];
    // The child has exited by the time the read stops it, so the scratch folder goes at once.
    Object.assign(server.child, { exitCode: 1 });
    stdin.write = (): boolean => {
      // Node emits a stream's error on a later tick, outside the write call. A
      // read with no 'error' listener on stdin therefore dies with an uncaught
      // exception, which is what an EventEmitter's throw from emit('error')
      // stands for here: it is caught and recorded instead of failing the run.
      setImmediate(() => {
        try {
          stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        } catch (thrown) {
          escaped.push(thrown);
        }
        server.child.emit('exit', 1, null);
      });
      return true;
    };
    await expect(readCodexHookTrust('codex', codexHookDefinitions().slice(0, 1), spawnReturning(server.child)))
      .rejects.toThrow(/exited before answering/);
    expect(escaped).toEqual([]);
  });

  it('keeps the scratch folder while the stopped app-server is still running, and removes it once it exits', async () => {
    const server = wholeAnswerServer();
    const entries = await readCodexHookTrust('codex', codexHookDefinitions(), spawnReturning(server.child));
    expect(entries).toEqual(reportedEntries());
    const scratch = scratchFolders[0];
    expect(path.basename(scratch)).toMatch(/^kangentic-codex-hooks-/);
    // The answer is in and the child was told to stop, but it has not exited: on
    // Windows a folder a live process works in cannot be removed.
    expect(fs.existsSync(scratch)).toBe(true);
    server.child.emit('exit', 0, null);
    await expect.poll(() => fs.existsSync(scratch), { timeout: 2000 }).toBe(false);
  });

  it('removes the scratch folder after the fallback wait when the stopped app-server never exits', async () => {
    // Only the timers the read arms are faked; the scripted server answers on setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = wholeAnswerServer();
    await readCodexHookTrust('codex', codexHookDefinitions(), spawnReturning(server.child));
    const scratch = scratchFolders[0];
    expect(fs.existsSync(scratch)).toBe(true);
    vi.advanceTimersByTime(9_999);
    expect(fs.existsSync(scratch)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fs.existsSync(scratch)).toBe(false);
  });
});

describe('CodexHookTrustCheck', () => {
  it('confirms once per binary file, waits in settle, and reads again after an in-place update', async () => {
    let stamp = 'v1';
    const read = vi.fn(async () => reportedEntries());
    const check = new CodexHookTrustCheck(read, () => stamp);
    expect(check.stateOverrideFor('codex')).toBeNull();
    check.start('codex');
    check.start('codex');
    await check.settle(1000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(check.stateOverrideFor('codex')).toMatch(/^hooks\.state=\{/);
    stamp = 'v2';
    // Until the new file is read, its sessions go without hooks.
    expect(check.stateOverrideFor('codex')).toBeNull();
    check.start('codex');
    await check.settle(1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(check.stateOverrideFor('codex')).not.toBeNull();
  });

  it('leaves the binary unconfirmed when the read fails or answers nothing', async () => {
    const check = new CodexHookTrustCheck(async () => null, () => 'stamp');
    check.start('codex');
    await check.settle(1000);
    expect(check.stateOverrideFor('codex')).toBeNull();
    const failing = new CodexHookTrustCheck(async () => { throw new Error('boom'); }, () => 'stamp');
    failing.start('codex');
    await failing.settle(1000);
    expect(failing.stateOverrideFor('codex')).toBeNull();
  });

  it('answers for an npm shim\'s sibling, which a spawn launches in place of the detected .cmd', async () => {
    const check = new CodexHookTrustCheck(async () => reportedEntries(), () => 'stamp');
    check.start('C:\\npm\\codex.cmd');
    await check.settle(1000);
    // resolveShimLaunch hands buildCommand the PowerShell or Git Bash sibling.
    expect(check.stateOverrideFor('C:\\npm\\codex.ps1')).not.toBeNull();
    expect(check.stateOverrideFor('C:\\npm\\codex')).not.toBeNull();
    expect(check.stateOverrideFor('C:\\other\\codex.ps1')).toBeNull();
  });

  describe('a read that failed to run', () => {
    // Five minutes, as FAILED_READ_RETRY_MS in hook-trust.ts. One slow cold start
    // must not leave hooks off for the whole run, and a broken Codex must not be
    // launched on every detect.
    const RETRY_AFTER_MS = 5 * 60_000;

    /** A check whose reads take their outcome from `outcomes` in order, on a clock the test moves. */
    function checkWithClock(outcomes: Array<'fails' | 'confirms'>): { check: CodexHookTrustCheck; read: ReturnType<typeof vi.fn>; advance: (milliseconds: number) => void } {
      let clock = 1_000_000;
      const read = vi.fn((): Promise<CodexHookTrustEntry[] | null> => (
        outcomes.shift() === 'confirms' ? Promise.resolve(reportedEntries()) : Promise.reject(new Error('timed out'))
      ));
      const check = new CodexHookTrustCheck(read, () => 'stamp', () => clock);
      return { check, read, advance: (milliseconds) => { clock += milliseconds; } };
    }

    it('is read again by a later start only once five minutes have passed, and a good second read confirms', async () => {
      const { check, read, advance } = checkWithClock(['fails', 'confirms']);
      check.start('codex');
      await check.settle(1000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(check.stateOverrideFor('codex')).toBeNull();

      advance(RETRY_AFTER_MS - 1);
      check.start('codex');
      expect(read).toHaveBeenCalledTimes(1);

      advance(1);
      check.start('codex');
      await check.settle(1000);
      expect(read).toHaveBeenCalledTimes(2);
      expect(check.stateOverrideFor('codex')).toMatch(/^hooks\.state=\{/);
    });

    it('waits another five minutes after a second failure', async () => {
      const { check, read, advance } = checkWithClock(['fails', 'fails', 'confirms']);
      check.start('codex');
      await check.settle(1000);
      advance(RETRY_AFTER_MS);
      check.start('codex');
      await check.settle(1000);
      expect(read).toHaveBeenCalledTimes(2);

      advance(RETRY_AFTER_MS - 1);
      check.start('codex');
      expect(read).toHaveBeenCalledTimes(2);

      advance(1);
      check.start('codex');
      await check.settle(1000);
      expect(read).toHaveBeenCalledTimes(3);
      expect(check.stateOverrideFor('codex')).not.toBeNull();
    });

    it.each([
      ['an unconfirmed answer', null],
      ['a confirmed answer', reportedEntries()],
    ])('is not read again after %s, however much time passes', async (_description, answer) => {
      let clock = 0;
      const read = vi.fn(async (): Promise<CodexHookTrustEntry[] | null> => answer);
      const check = new CodexHookTrustCheck(read, () => 'stamp', () => clock);
      check.start('codex');
      await check.settle(1000);
      clock += 24 * 60 * 60_000;
      check.start('codex');
      await check.settle(1000);
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  it('stops waiting at the bound', async () => {
    const check = new CodexHookTrustCheck(() => new Promise(() => undefined), () => 'stamp');
    check.start('codex');
    const startedAt = Date.now();
    await check.settle(50);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(check.stateOverrideFor('codex')).toBeNull();
  });
});

describe('CodexCommandBuilder hook wiring', () => {
  let scratch: string;
  const state = codexHookStateOverride(reportedEntries());

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-wiring-'));
    fakeBridgeSource = path.join(scratch, 'event-bridge-source.js');
    fs.writeFileSync(fakeBridgeSource, '// bridge');
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function options(overrides: Partial<CodexCommandOptions>): CodexCommandOptions {
    const cwd = path.join(scratch, 'worktree');
    fs.mkdirSync(cwd, { recursive: true });
    return {
      codexPath: 'codex',
      taskId: 'task-1',
      cwd,
      permissionMode: 'acceptEdits',
      eventsOutputPath: path.join(scratch, 'sessions', 's1', 'events.jsonl'),
      shell: 'bash',
      ...overrides,
    };
  }

  it('wires no hooks without a confirmed trust state, so the TUI cannot stop at the review dialog', () => {
    const command = new CodexCommandBuilder().buildCodexCommand(options({ codexHookStateOverride: null }));
    expect(command).not.toContain('hooks.');
    expect(fs.existsSync(path.join(options({}).cwd, '.kangentic', CODEX_EVENT_BRIDGE_COPY_NAME))).toBe(false);
  });

  // A hook command names the workspace copy of the bridge, so a command built
  // without the copy would fail every hook. The session runs without hooks
  // instead, on the PTY tracker, and the spawn does not fail.
  const COPY_FAILURES: Array<[description: string, breakCopy: (workspace: string) => void]> = [
    ['the bridge source cannot be read', () => { fakeBridgeSource = path.join(scratch, 'no-such-bridge.js'); }],
    ['the workspace .kangentic path is a file', (workspace) => { fs.writeFileSync(path.join(workspace, '.kangentic'), 'not a folder'); }],
  ];

  it.each(COPY_FAILURES)('builds the command without hooks, and does not throw, when %s', (_description, breakCopy) => {
    const builtOptions = options({ codexHookStateOverride: state });
    breakCopy(builtOptions.cwd);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let command = '';
      expect(() => { command = new CodexCommandBuilder().buildCodexCommand(builtOptions); }).not.toThrow();
      expect(command).not.toContain('hooks.');
      // The rest of the command is still built, so an empty string cannot pass.
      expect(command).toContain('check_for_update_on_startup=false');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not copy the event bridge'), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it('wires every hook and the trust state, and copies the bridge into the workspace', () => {
    const builtOptions = options({ codexHookStateOverride: state });
    const command = new CodexCommandBuilder().buildCodexCommand(builtOptions);
    for (const override of [...buildCodexHookOverrides(), state!]) expect(command).toContain(quoteArg(override, 'bash'));
    expect(fs.readFileSync(path.join(builtOptions.cwd, '.kangentic', CODEX_EVENT_BRIDGE_COPY_NAME), 'utf8')).toBe('// bridge');
  });

  it('keeps the bridge copy out of git in a checkout whose .gitignore does not list .kangentic/', () => {
    const builtOptions = options({ codexHookStateOverride: state });
    fs.mkdirSync(path.join(builtOptions.cwd, '.git', 'info'), { recursive: true });
    new CodexCommandBuilder().buildCodexCommand(builtOptions);
    expect(fs.readFileSync(path.join(builtOptions.cwd, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('.kangentic/');
  });

  it('builds byte-identical hook overrides for two sessions, so one trust read covers both', () => {
    const hookArgsOf = (command: string): string[] => command.split(' -c ').filter((part) => part.startsWith("'hooks."));
    const first = new CodexCommandBuilder().buildCodexCommand(options({ codexHookStateOverride: state, taskId: 'task-a', eventsOutputPath: path.join(scratch, 'a', 'events.jsonl') }));
    const second = new CodexCommandBuilder().buildCodexCommand(options({ codexHookStateOverride: state, taskId: 'task-b', eventsOutputPath: path.join(scratch, 'b', 'events.jsonl'), sessionId: 'resume-me', resume: true }));
    expect(hookArgsOf(first).length).toBe(HOOK_EVENTS.length + 1);
    expect(hookArgsOf(second)).toEqual(hookArgsOf(first));
  });

  it('keeps the hook arguments well inside cmd.exe\'s 8191-character line', () => {
    const hookArguments = [...buildCodexHookOverrides(), state!].map((value) => `-c ${quoteArg(value, 'cmd.exe')}`).join(' ');
    // Under 3,500, so a long task prompt still has more than half the line.
    expect(hookArguments.length).toBeLessThan(3500);
  });
});

/** The hook and trust `-c` values a printed argv carries. */
function configValuesOf(argv: readonly string[]): string[] {
  return argv.flatMap((arg, index) => (argv[index - 1] === '-c' && arg.startsWith('hooks.') ? [arg] : []));
}

describe.skipIf(process.platform !== 'win32')('Codex hook overrides through a Windows shell prompt', () => {
  let probe: ShellArgvProbe;
  let scratch: string;
  const state = codexHookStateOverride(reportedEntries());
  const expected = [...buildCodexHookOverrides(), state!];

  beforeAll(() => {
    probe = createShellArgvProbe();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-round-trip-'));
    fakeBridgeSource = path.join(scratch, 'event-bridge-source.js');
    fs.writeFileSync(fakeBridgeSource, '// bridge');
  });

  afterAll(() => {
    probe.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function commandFor(shell: string): string {
    return new CodexCommandBuilder().buildCodexCommand({
      codexPath: 'codex',
      taskId: 'task-1',
      cwd: scratch,
      permissionMode: 'acceptEdits',
      eventsOutputPath: path.join(scratch, 'events.jsonl'),
      shell,
      codexHookStateOverride: state,
    });
  }

  it('reaches Codex byte-identical from every PowerShell host', () => {
    for (const host of installedPowerShellHosts()) {
      const run = typeAtPowerShellPrompt(probe, host, [lineWithPrinterHead(probe, host, commandFor(host), 'codex')]);
      expect(run.strayLines, host).toEqual([]);
      expect(configValuesOf(run.printed[0] ?? []), host).toEqual(expected);
    }
  }, 60_000);

  it('reaches Codex byte-identical from a cmd prompt', () => {
    const printed = typeAtCmdPrompt([lineWithPrinterHead(probe, 'cmd.exe', commandFor('cmd.exe'), 'codex')]);
    expect(configValuesOf(printed[0] ?? [])).toEqual(expected);
  }, 30_000);

  it.skipIf(!gitBashPath())('reaches Codex byte-identical from Git Bash', () => {
    const bash = gitBashPath()!;
    const run = runAsHookShell('git-bash', lineWithPrinterHead(probe, bash, commandFor(bash), 'codex'));
    expect(configValuesOf(run.printed[0] ?? [])).toEqual(expected);
  }, 30_000);
});

/**
 * The POSIX half. Every value holds `'`, which `quoteArg` writes as `'\''` for
 * sh and bash, and its own way for fish and nushell. sh and bash run on Linux
 * CI; fish and nushell where installed (shell-quoting-posix.yml installs both).
 */
const POSIX_HOOK_ROUND_TRIP_SHELLS = installedPosixShells().filter((shell) => process.platform !== 'win32' || shell === 'nu');

describe.skipIf(process.platform === 'win32' && POSIX_HOOK_ROUND_TRIP_SHELLS.length === 0)('Codex hook overrides through a POSIX shell', () => {
  let probe: ShellArgvProbe;
  let scratch: string;
  const state = codexHookStateOverride(reportedEntries());
  const expected = [...buildCodexHookOverrides(), state!];

  beforeAll(() => {
    probe = createShellArgvProbe();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-round-trip-posix-'));
    fakeBridgeSource = path.join(scratch, 'event-bridge-source.js');
    fs.writeFileSync(fakeBridgeSource, '// bridge');
  });

  afterAll(() => {
    probe.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** The built command with the argv printer in Codex's place, quoted for `shell`. */
  function lineFor(shell: string): string {
    const command = new CodexCommandBuilder().buildCodexCommand({
      codexPath: 'codex',
      taskId: 'task-1',
      cwd: scratch,
      permissionMode: 'acceptEdits',
      eventsOutputPath: path.join(scratch, 'events.jsonl'),
      shell,
      codexHookStateOverride: state,
    });
    return `${quoteArg(process.execPath, shell)} ${quoteArg(probe.printerPath, shell)}${command.slice('codex'.length)}`;
  }

  it.skipIf(process.platform === 'win32')('reaches Codex byte-identical from sh and bash', () => {
    for (const host of ['sh', 'bash'] as const) {
      const run = runAsHookShell(host, lineFor(host));
      expect(configValuesOf(run.printed[0] ?? []), host).toEqual(expected);
    }
  }, 30_000);

  it.skipIf(POSIX_HOOK_ROUND_TRIP_SHELLS.length === 0)('reaches Codex byte-identical from fish and nushell', () => {
    for (const shell of POSIX_HOOK_ROUND_TRIP_SHELLS) {
      const run = typeAtPosixShell(probe, shell, [lineFor(shell)]);
      expect(configValuesOf(run.printed[0] ?? []), shell).toEqual(expected);
    }
  }, 30_000);
});
