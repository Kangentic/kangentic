#!/usr/bin/env node
/*
 * MANUAL PROBE - NEVER WIRED INTO TESTS OR CI.
 *
 * The gate an agent passes before its adapter declares folder accounts (task #1057,
 * docs/integrations/accounts.md). It builds a sandbox with two homes for one agent CLI: `home/`
 * stands in for the agent's own home, and `account/` is an account folder whose history entries
 * link back into it, the way `provisionAccountFolder` lays one out. Then it checks what the design
 * rests on:
 *
 *   status       each home's login stays its own (P2)
 *   history      a run on the account writes its conversation into the home through the link (P3)
 *   concurrent   a run on each home at once leaves both conversations whole (P6)
 *   resume       a conversation started on the home resumes on the account (P4, two sign-ins)
 *   shared       the prompt history is still one file, and the account's private entries are its own (P7)
 *
 * Everything it writes is under the sandbox, `~/.kangentic-account-probe/<agent>` unless `--sandbox`
 * names another. Not the temp folder: Codex 0.165 refuses to set up its helper binaries under it
 * ("Refusing to create helper binaries under temporary dir"), so a home there is not a fair test.
 * It never writes the agent's real home: it refuses a sandbox inside it, strips the
 * agent's home variable from every run, and reads the real home only to count its entries before
 * and after (`final`). Each print run costs one short prompt of the signed-in plan.
 *
 * Usage:
 *   node scripts/probe-agent-accounts.mjs <command> --agent <claude|codex> [--sandbox <dir>] [--cli <path>]
 *   node scripts/probe-agent-accounts.mjs setup --agent codex
 *   node scripts/probe-agent-accounts.mjs login --agent codex --which home     (then --which account)
 *   node scripts/probe-agent-accounts.mjs status --agent codex
 *   node scripts/probe-agent-accounts.mjs all --agent codex                    (history, concurrent, resume, shared, final)
 *   node scripts/probe-agent-accounts.mjs cleanup --agent codex
 *
 * Results are appended to `<sandbox>/results.json`. To probe another agent, add one entry to
 * AGENTS below: its home variable, the entries its account folder shares (copy them from the
 * adapter's `sharedEntries` once it has one), how to sign in, how to ask who is signed in, and a
 * print run that reports the conversation id.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

/** One entry per agent CLI. Shared entries are `[name, how]`, `how` one of link-dir, hardlink-file, copy-file. */
const AGENTS = {
  claude: {
    cli: 'claude',
    homeVar: 'CLAUDE_CONFIG_DIR',
    realHome: () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    shared: [
      ['projects', 'link-dir'], ['file-history', 'link-dir'], ['session-env', 'link-dir'], ['shell-snapshots', 'link-dir'],
      ['todos', 'link-dir'], ['plans', 'link-dir'], ['tasks', 'link-dir'], ['paste-cache', 'link-dir'], ['transcripts', 'link-dir'],
      ['history.jsonl', 'hardlink-file'], ['settings.json', 'copy-file'],
    ],
    privateEntries: ['sessions'],
    loginArgs: ['auth', 'login'],
    whoami: (home) => {
      const result = run(agent.cli, ['auth', 'status'], { home, homeVar: 'CLAUDE_CONFIG_DIR' });
      let parsed = null;
      try { parsed = JSON.parse(result.stdout); } catch { /* text output */ }
      return { signedIn: parsed?.loggedIn ?? false, who: parsed?.email ?? null, plan: parsed?.subscriptionType ?? null };
    },
    // The first-run answers a fresh home asks for, so a print run does not stop at a dialog.
    seed: (home, folders) => {
      const file = path.join(home, '.claude.json');
      let state = {};
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
      state.hasCompletedOnboarding = true;
      state.projects = state.projects ?? {};
      for (const folder of folders) {
        state.projects[folder.split(path.sep).join('/')] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
      }
      fs.writeFileSync(file, JSON.stringify(state, null, 2));
    },
    start: (prompt) => {
      const id = crypto.randomUUID();
      return { args: ['-p', '--session-id', id, '--model', 'haiku', prompt], idOf: () => id };
    },
    resume: (id, prompt) => ['-p', '--resume', id, '--model', 'haiku', prompt],
    findConversation: (home, id) => findFile(path.join(home, 'projects'), (name) => name === `${id}.jsonl`),
    historyFile: 'history.jsonl',
  },
  codex: {
    cli: 'codex',
    homeVar: 'CODEX_HOME',
    realHome: () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    shared: [
      ['sessions', 'link-dir'], ['prompts', 'link-dir'], ['skills', 'link-dir'],
      ['history.jsonl', 'hardlink-file'], ['config.toml', 'copy-file'], ['AGENTS.md', 'copy-file'],
    ],
    privateEntries: ['auth.json', 'log'],
    loginArgs: ['login'],
    whoami: (home) => {
      const result = run(agent.cli, ['login', 'status'], { home, homeVar: 'CODEX_HOME' });
      const text = `${result.stdout}\n${result.stderr}`;
      // Codex prints warnings ahead of the answer, so the line that says how it is signed in is the one kept.
      const line = text.split('\n').map((part) => part.trim()).find((part) => /logged in/i.test(part)) ?? null;
      return { signedIn: line !== null && !/not logged in/i.test(line), who: line, plan: null };
    },
    seed: () => {},
    // `codex exec --json` prints `thread.started` with the conversation's id.
    start: (prompt) => ({
      args: ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', prompt],
      idOf: (stdout) => threadIdOf(stdout),
    }),
    resume: (id, prompt) => ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', 'resume', id, prompt],
    findConversation: (home, id) => findFile(path.join(home, 'sessions'), (name) => name.endsWith(`-${id}.jsonl`)),
    historyFile: 'history.jsonl',
  },
};

function parseArguments(argv) {
  const options = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag.startsWith('--')) {
      options[flag.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const agent = AGENTS[options.agent];
if (!agent) {
  console.log(`usage: node scripts/probe-agent-accounts.mjs <setup|login|status|history|concurrent|resume|shared|final|all|report|cleanup> --agent <${Object.keys(AGENTS).join('|')}> [--sandbox <dir>] [--which home|account]`);
  process.exit(1);
}
// The CLI to run: an executable on PATH (claude.exe, codex.exe), or a path given with --cli. A .cmd shim
// needs its path, since the probe passes prompts as arguments and runs no shell to split them.
if (options.cli) agent.cli = options.cli;
const SANDBOX = path.resolve(options.sandbox ?? path.join(os.homedir(), '.kangentic-account-probe', options.agent));
const HOME = path.join(SANDBOX, 'home');
const ACCOUNT = path.join(SANDBOX, 'account');
const REPO = path.join(SANDBOX, 'repo');
const RESULTS = path.join(SANDBOX, 'results.json');

function comparable(folder) {
  const resolved = path.resolve(folder);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The sandbox and the agent's real home must not contain each other. */
function refuseRealHome() {
  const real = comparable(agent.realHome());
  const sandbox = comparable(SANDBOX);
  if (sandbox === real || sandbox.startsWith(real + path.sep) || real.startsWith(sandbox + path.sep)) {
    console.error(`refusing: the sandbox ${SANDBOX} overlaps the agent's real home`);
    process.exit(1);
  }
}
refuseRealHome();

/** The environment a run gets: this process's, minus the agent's home and any parent agent session's markers. */
function runEnv(home, homeVar) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === homeVar || /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|KANGENTIC_)/.test(key)) continue;
    env[key] = value;
  }
  if (home) env[homeVar] = home;
  return env;
}

function run(cli, args, { home, homeVar, cwd = os.tmpdir(), timeoutMs = 240_000 }) {
  const result = spawnSync(cli, args, { cwd, env: runEnv(home, homeVar), encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim().slice(0, 600) };
}

function runAsync(cli, args, home) {
  return new Promise((resolve) => {
    const child = spawn(cli, args, { cwd: REPO, env: runEnv(home, agent.homeVar), windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

function threadIdOf(stdout) {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (typeof event.thread_id === 'string') return event.thread_id;
    } catch { /* not an event line */ }
  }
  return null;
}

function findFile(root, matches) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, matches);
      if (found) return found;
    } else if (matches(entry.name)) {
      return full;
    }
  }
  return null;
}

/** Line count and unparsable lines of a JSONL conversation. */
function wholeness(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  let bad = 0;
  for (const line of lines) {
    try { JSON.parse(line); } catch { bad += 1; }
  }
  return { lines: lines.length, badLines: bad };
}

function saveResult(key, value) {
  let results = {};
  try { results = JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch { /* first result */ }
  results[key] = { ...value, at: new Date().toISOString() };
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ [key]: results[key] }, null, 2));
}

function realHomeCounts() {
  const real = agent.realHome();
  if (!fs.existsSync(real)) return { exists: false };
  return { exists: true, entries: fs.readdirSync(real).length };
}

function linkShared() {
  for (const [name, how] of agent.shared) {
    const source = path.join(HOME, name);
    const target = path.join(ACCOUNT, name);
    if (how === 'link-dir') {
      fs.mkdirSync(source, { recursive: true });
      fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    } else if (how === 'hardlink-file') {
      if (!fs.existsSync(source)) fs.writeFileSync(source, '');
      fs.linkSync(source, target);
    } else if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    }
  }
}

const commands = {
  setup() {
    if (fs.existsSync(SANDBOX)) {
      console.log(`sandbox already exists: ${SANDBOX}`);
      return;
    }
    for (const folder of [HOME, ACCOUNT, REPO]) fs.mkdirSync(folder, { recursive: true });
    linkShared();
    const git = (args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(REPO, 'README.md'), 'probe repo\n');
    git(['add', '.']);
    git(['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '-m', 'init']);
    for (const home of [HOME, ACCOUNT]) agent.seed(home, [REPO]);
    saveResult('setup', { sandbox: SANDBOX, realHomeBefore: realHomeCounts() });
    console.log(`Next: sign in to each folder with "login --which home" and "login --which account", using two different accounts.`);
  },

  login() {
    const home = options.which === 'account' ? ACCOUNT : HOME;
    console.log(`Signing ${options.which ?? 'home'} in with ${agent.homeVar}=${home}`);
    spawnSync(agent.cli, agent.loginArgs, { cwd: REPO, env: runEnv(home, agent.homeVar), stdio: 'inherit' });
  },

  status() {
    const home = agent.whoami(HOME);
    const account = agent.whoami(ACCOUNT);
    saveResult('P2_logins_apart', {
      home,
      account,
      apart: home.signedIn && account.signedIn && home.who !== null && home.who !== account.who,
    });
  },

  history() {
    const start = agent.start('Reverse the letters of ELPPAENIP and reply with only the result.');
    const result = run(agent.cli, start.args, { home: ACCOUNT, homeVar: agent.homeVar, cwd: REPO });
    const id = start.idOf(result.stdout);
    const inHome = id ? agent.findConversation(HOME, id) : null;
    saveResult('P3_history_through_link', {
      code: result.code,
      id,
      answered: /PINEAPPLE/.test(result.stdout),
      conversationInHome: inHome ? path.relative(SANDBOX, inHome) : null,
      readableFromAccount: inHome ? fs.existsSync(inHome.replace(HOME, ACCOUNT)) : false,
      ...(inHome ? wholeness(inHome) : {}),
      stderr: result.stderr || undefined,
    });
  },

  async concurrent() {
    const first = agent.start('Count from 1 to 60, separated by spaces, nothing else.');
    const second = agent.start('Count from 1 to 60, separated by spaces, nothing else.');
    const [onHome, onAccount] = await Promise.all([runAsync(agent.cli, first.args, HOME), runAsync(agent.cli, second.args, ACCOUNT)]);
    const ids = [first.idOf(onHome.stdout), second.idOf(onAccount.stdout)];
    const files = ids.map((id) => (id ? agent.findConversation(HOME, id) : null));
    saveResult('P6_concurrent_writes', {
      home: { code: onHome.code, found: !!files[0], ...(files[0] ? wholeness(files[0]) : {}) },
      account: { code: onAccount.code, found: !!files[1], ...(files[1] ? wholeness(files[1]) : {}) },
    });
  },

  resume() {
    const start = agent.start('Remember the word LIGHTHOUSE. Reply with only OK.');
    const first = run(agent.cli, start.args, { home: HOME, homeVar: agent.homeVar, cwd: REPO });
    const id = start.idOf(first.stdout);
    const second = id
      ? run(agent.cli, agent.resume(id, 'Which word did I ask you to remember? Reply with only the word.'), { home: ACCOUNT, homeVar: agent.homeVar, cwd: REPO })
      : null;
    const file = id ? agent.findConversation(HOME, id) : null;
    saveResult('P4_cross_account_resume', {
      id,
      startedOnHome: first.code,
      resumedOnAccount: second?.code ?? null,
      remembered: second ? /LIGHTHOUSE/i.test(second.stdout) : false,
      ...(file ? wholeness(file) : {}),
      stderr: second?.stderr || undefined,
    });
  },

  shared() {
    const homeHistory = path.join(HOME, agent.historyFile);
    const accountHistory = path.join(ACCOUNT, agent.historyFile);
    const sameFile = (() => {
      try {
        const first = fs.statSync(homeHistory, { bigint: true });
        const second = fs.statSync(accountHistory, { bigint: true });
        return first.ino === second.ino && first.dev === second.dev;
      } catch {
        return false;
      }
    })();
    const privateEntries = Object.fromEntries(agent.privateEntries.map((name) => {
      const entry = path.join(ACCOUNT, name);
      return [name, fs.existsSync(entry) ? (fs.lstatSync(entry).isSymbolicLink() ? 'linked' : 'own') : 'absent'];
    }));
    saveResult('P7_shared_history', { historyStillOneFile: sameFile, privateEntries });
  },

  final() {
    saveResult('final', { realHomeAfter: realHomeCounts() });
  },

  async all() {
    commands.status();
    commands.history();
    await commands.concurrent();
    commands.resume();
    commands.shared();
    commands.final();
  },

  report() {
    console.log(fs.existsSync(RESULTS) ? fs.readFileSync(RESULTS, 'utf8') : 'no results yet');
  },

  cleanup() {
    // The links are removed before the folders, so a removal never reads through one into the home.
    for (const [name, how] of agent.shared) {
      if (how === 'link-dir') fs.rmSync(path.join(ACCOUNT, name), { force: true, recursive: false });
    }
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    const parent = path.dirname(SANDBOX);
    if (!options.sandbox && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    console.log(`removed ${SANDBOX}`);
  },
};

const command = commands[options.command];
if (!command) {
  console.log(`unknown command: ${options.command}`);
  process.exit(1);
}
Promise.resolve(command()).catch((error) => {
  console.error(error);
  process.exit(1);
});
