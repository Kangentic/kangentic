/**
 * Sentry DESKTOP-4R: Kangentic started from an account session's terminal inherited that
 * account's home variable, so the agent's own account (#1) read the folder account's login, and
 * its Sign in and sessions ran there. The boot step drops a home variable that names one of
 * Kangentic's own account folders, and only those.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderAccountSupport } from '../../src/main/accounts/account-support';
import { isLexicallyInside, withoutLongPathPrefix } from '../../src/main/accounts/account-folder';
import {
  adoptShellHomeVariables,
  defaultHomeOrigin,
  dropInheritedAccountHomes,
  folderHomeVariableNames,
  resetInheritedAccountHomes,
} from '../../src/main/accounts/inherited-home-env';
import { agentRegistry } from '../../src/main/agent/agent-registry';

let root: string;
let accountsRoot: string;

function folderAgent(name: string, homeEnvVars: string[]): { name: string; accounts: FolderAccountSupport } {
  return {
    name,
    accounts: {
      kind: 'folder',
      accountEnv: (folder) => Object.fromEntries(homeEnvVars.map((variable) => [variable, folder])),
      homeEnvVars,
      defaultHome: () => path.join(root, 'home'),
      loginArgs: [],
      sharedEntries: [],
      identify: async () => ({ signedIn: false, email: null, plan: null, hasSubscription: null }),
      overridingCredentialEnvVars: [],
    },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-inherited-home-'));
  accountsRoot = path.join(root, 'config', 'accounts');
  fs.mkdirSync(path.join(accountsRoot, 'claude', '2'), { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetInheritedAccountHomes();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('dropInheritedAccountHomes', () => {
  it('drops a home variable that names a Kangentic account folder, and says the home was ignored', () => {
    const env: NodeJS.ProcessEnv = { HOME_VAR: path.join(accountsRoot, 'claude', '2') };
    expect(dropInheritedAccountHomes(env, accountsRoot, [folderAgent('claude', ['HOME_VAR'])])).toEqual(['HOME_VAR']);
    expect(env.HOME_VAR).toBeUndefined();
    expect(defaultHomeOrigin('claude', ['HOME_VAR'], env)).toBe('inherited-ignored');
  });

  it('drops one that names a folder not made yet, by the path as written', () => {
    const env: NodeJS.ProcessEnv = { HOME_VAR: path.join(accountsRoot, 'codex', '5') };
    expect(dropInheritedAccountHomes(env, accountsRoot, [folderAgent('codex', ['HOME_VAR'])])).toEqual(['HOME_VAR']);
  });

  it('drops one that reaches the accounts folder through a link', () => {
    const link = path.join(root, 'linked-account');
    fs.symlinkSync(path.join(accountsRoot, 'claude', '2'), link, process.platform === 'win32' ? 'junction' : 'dir');
    const env: NodeJS.ProcessEnv = { HOME_VAR: link };
    expect(dropInheritedAccountHomes(env, accountsRoot, [folderAgent('claude', ['HOME_VAR'])])).toEqual(['HOME_VAR']);
  });

  it('keeps a home of the user\'s own, a relative value, and every variable no adapter names', () => {
    const own = path.join(root, 'my-claude');
    const env: NodeJS.ProcessEnv = {
      HOME_VAR: own,
      OTHER_HOME: 'config/accounts/claude/2',
      PWD: path.join(accountsRoot, 'claude', '2'),
    };
    expect(dropInheritedAccountHomes(env, accountsRoot, [folderAgent('claude', ['HOME_VAR', 'OTHER_HOME'])])).toEqual([]);
    expect(env).toEqual({ HOME_VAR: own, OTHER_HOME: 'config/accounts/claude/2', PWD: path.join(accountsRoot, 'claude', '2') });
    expect(defaultHomeOrigin('claude', ['HOME_VAR'], env)).toBe('inherited');
    expect(defaultHomeOrigin('claude', ['UNSET_VAR'], env)).toBe('builtin');
  });

  it('drops a value padded with whitespace, and one equal to the accounts root itself', () => {
    const padded: NodeJS.ProcessEnv = { HOME_VAR: `  ${path.join(accountsRoot, 'claude', '2')}  ` };
    expect(dropInheritedAccountHomes(padded, accountsRoot, [folderAgent('claude', ['HOME_VAR'])])).toEqual(['HOME_VAR']);
    expect(padded.HOME_VAR).toBeUndefined();

    const exact: NodeJS.ProcessEnv = { HOME_VAR: accountsRoot };
    expect(dropInheritedAccountHomes(exact, accountsRoot, [folderAgent('claude', ['HOME_VAR'])])).toEqual(['HOME_VAR']);
    expect(exact.HOME_VAR).toBeUndefined();
  });

  it('skips an agent with key-file accounts or none', () => {
    const env: NodeJS.ProcessEnv = { HOME_VAR: path.join(accountsRoot, 'claude', '2') };
    const dropped = dropInheritedAccountHomes(env, accountsRoot, [
      { name: 'plain' },
      { name: 'keys', accounts: { kind: 'key-file', keyEnvVars: ['HOME_VAR'], overridingCredentialEnvVars: [] } },
    ]);
    expect(dropped).toEqual([]);
    expect(env.HOME_VAR).toBeDefined();
  });
});

describe('adoptShellHomeVariables', () => {
  it('takes a home the login shell exports when Kangentic was started without one', () => {
    const own = path.join(root, 'xdg-claude');
    const env: NodeJS.ProcessEnv = {};
    expect(adoptShellHomeVariables(env, { HOME_VAR: own }, accountsRoot, [folderAgent('claude', ['HOME_VAR'])])).toEqual(['HOME_VAR']);
    expect(env.HOME_VAR).toBe(own);
    expect(defaultHomeOrigin('claude', ['HOME_VAR'], env)).toBe('login-shell');
  });

  it('keeps a home Kangentic was started with, and skips a relative one or one in the accounts folder', () => {
    const inherited = path.join(root, 'from-terminal');
    const env: NodeJS.ProcessEnv = { HOME_VAR: inherited };
    const sources = [folderAgent('claude', ['HOME_VAR']), folderAgent('codex', ['CODEX_VAR', 'OTHER_VAR'])];
    const adopted = adoptShellHomeVariables(
      env,
      { HOME_VAR: path.join(root, 'from-rc'), CODEX_VAR: 'relative/home', OTHER_VAR: path.join(accountsRoot, 'codex', '2') },
      accountsRoot,
      sources,
    );
    expect(adopted).toEqual([]);
    expect(env).toEqual({ HOME_VAR: inherited });
    expect(defaultHomeOrigin('claude', ['HOME_VAR'], env)).toBe('inherited');
  });

  it('adopts a shell value when the inherited value is only whitespace', () => {
    const own = path.join(root, 'xdg-claude');
    const env: NodeJS.ProcessEnv = { HOME_VAR: '   ' };
    expect(adoptShellHomeVariables(env, { HOME_VAR: own }, accountsRoot, [folderAgent('claude', ['HOME_VAR'])])).toEqual(['HOME_VAR']);
    expect(env.HOME_VAR).toBe(own);
  });

  it('reports login-shell while an adopted variable is set after a drop, and inherited-ignored once it is unset', () => {
    const sources = [folderAgent('claude', ['HOME_VAR'])];
    const env: NodeJS.ProcessEnv = { HOME_VAR: path.join(accountsRoot, 'claude', '2') };
    dropInheritedAccountHomes(env, accountsRoot, sources);
    adoptShellHomeVariables(env, { HOME_VAR: path.join(root, 'xdg-claude') }, accountsRoot, sources);
    expect(defaultHomeOrigin('claude', ['HOME_VAR'], env)).toBe('login-shell');
    delete env.HOME_VAR;
    expect(defaultHomeOrigin('claude', ['HOME_VAR'], env)).toBe('inherited-ignored');
  });

  it('gives the probe each folder adapter\'s variables once', () => {
    expect(folderHomeVariableNames([folderAgent('claude', ['A', 'B']), folderAgent('codex', ['B', 'C']), { name: 'plain' }])).toEqual(['A', 'B', 'C']);
  });
});

describe('withoutLongPathPrefix', () => {
  it('strips the extended-length prefix, turns the UNC form back into a share path, and leaves a plain path', () => {
    expect(withoutLongPathPrefix('\\\\?\\C:\\Users\\dev\\.claude\\projects')).toBe('C:\\Users\\dev\\.claude\\projects');
    expect(withoutLongPathPrefix('\\\\?\\UNC\\server\\share\\x')).toBe('\\\\server\\share\\x');
    expect(withoutLongPathPrefix('C:\\Users\\dev\\.claude')).toBe('C:\\Users\\dev\\.claude');
    expect(withoutLongPathPrefix('/home/dev/.claude')).toBe('/home/dev/.claude');
  });
});

describe('the boot step in main', () => {
  // `src/main/index.ts` cannot be imported, so its source is read. The drop must run at module
  // level, ahead of `app.whenReady()`: everything that starts a child, a worker or the pty host
  // runs from there or later, and each inherits the environment as it is when it starts.
  it('drops inherited account homes before the app is ready, against this instance\'s accounts folder', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8');
    const dropAt = source.indexOf('dropInheritedAccountHomes(');
    // The call itself, not a comment that names it.
    const readyAt = source.indexOf('app.whenReady().then(');
    expect(readyAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(-1);
    expect(dropAt).toBeLessThan(readyAt);
    expect(source.slice(dropAt, dropAt + 200)).toContain('accountsRootOf(PATHS.configDir)');
  });

  // `createWindow` runs `registerAllIpc`, which starts the pty host, so the first call to it in
  // the startup body is the bound.
  it('takes the login shell\'s home variables before the window, the IPC handlers and the pty host', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8');
    const readyAt = source.indexOf('app.whenReady().then(');
    const adoptAt = source.indexOf('adoptShellHomeVariables(process.env', readyAt);
    const windowAt = source.indexOf('createWindow(', readyAt);
    expect(adoptAt).toBeGreaterThan(readyAt);
    expect(windowAt).toBeGreaterThan(-1);
    expect(adoptAt).toBeLessThan(windowAt);
  });
});

describe('each folder adapter declares its home variables', () => {
  // `homeEnvVars` must name every variable of `accountEnv` that points inside the account folder.
  // One left out is neither dropped at boot nor set again over a shell's rc file.
  it('names exactly the accountEnv variables that point inside the account folder', () => {
    const probe = path.join(root, 'probe-account');
    const folderAdapters = agentRegistry.list()
      .flatMap((name) => agentRegistry.get(name) ?? [])
      .filter((adapter) => adapter.accounts?.kind === 'folder');
    expect(folderAdapters.length).toBeGreaterThan(0);
    for (const adapter of folderAdapters) {
      const support = adapter.accounts as FolderAccountSupport;
      const env = support.accountEnv(probe, path.join(root, 'home'));
      const inside = Object.entries(env)
        .filter(([, value]) => path.isAbsolute(value) && isLexicallyInside(value, probe))
        .map(([name]) => name)
        .sort();
      expect({ agent: adapter.name, homeEnvVars: [...support.homeEnvVars].sort() }).toEqual({ agent: adapter.name, homeEnvVars: inside });
    }
  });
});
