// What ssh itself says when a key needs a passphrase, measured against a real sshd (#913).
//
//   node scripts/ssh-passphrase-rig.mjs --work <empty scratch dir> [--port 2471] [--ssh ssh]
//
// Starts a throwaway sshd container, writes three keys (a passphrase key the server knows, a key with no
// passphrase the server knows, and a passphrase key it does not), and runs `captureKeyPrompt` over each one
// through a scratch ssh config. Expected: the first prints ssh's `Enter passphrase for key '...'`, the other
// two print null (one connects, one is simply refused). Never reads or writes the user's ~/.ssh: every ssh
// call names its own config and identity files.
//
// Not shipped and not used by CI. Needs Docker and the `kangentic-ssh-rig` image (scripts/probe-ssh-rig),
// and esbuild from this repository's dev dependencies.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = 'kangentic-passphrase-rig';

function parseArguments(argumentList) {
  const parsed = { port: 2471, ssh: 'ssh', work: null };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === '--work') parsed.work = argumentList[(index += 1)];
    else if (argument === '--port') parsed.port = Number(argumentList[(index += 1)]);
    else if (argument === '--ssh') parsed.ssh = argumentList[(index += 1)];
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!parsed.work) throw new Error('--work <empty scratch dir> is required');
  return parsed;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

const forward = (value) => value.replace(/\\/g, '/');
const options = parseArguments(process.argv.slice(2));
const work = path.resolve(options.work);
fs.mkdirSync(path.join(work, 'keys'), { recursive: true });

const makeKey = (name, passphrase) => {
  const result = run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', name, '-f', path.join(work, 'keys', name)]);
  if (result.status !== 0) throw new Error(`ssh-keygen failed: ${result.stderr}`);
};
makeKey('enc', 'passphrase');
makeKey('plain', '');
makeKey('wrong', 'passphrase');
const authorized = ['enc', 'plain'].map((name) => fs.readFileSync(path.join(work, 'keys', `${name}.pub`), 'utf8').trim()).join('\n');

// Bundled from the real module, so the rig runs the code the app runs.
const entry = path.join(work, 'entry.ts');
fs.writeFileSync(entry, [
  `import { captureKeyPrompt } from '${forward(path.join(repository, 'src/main/remote/ssh-key-prompt'))}';`,
  `import { createSshRunner } from '${forward(path.join(repository, 'src/main/remote/link/ssh-run'))}';`,
  'const [, , sshPath, ...args] = process.argv;',
  'captureKeyPrompt(args, { sshPath, createRunner: createSshRunner }).then((result) => console.log(JSON.stringify(result)));',
  '',
].join('\n'));
const bundle = path.join(work, 'entry.cjs');
execFileSync('npx', ['esbuild', entry, '--bundle', '--platform=node', `--outfile=${bundle}`, '--log-level=error'], { shell: true, stdio: 'inherit', cwd: repository });

run('docker', ['rm', '-f', CONTAINER]);
const started = run('docker', ['run', '-d', '--name', CONTAINER, '--init', '-p', `127.0.0.1:${options.port}:22`, '-e', `AUTHORIZED_KEY=${authorized}`, 'kangentic-ssh-rig']);
if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr}`);
let failed = false;
try {
  let scanned = '';
  for (let attempt = 0; attempt < 40 && !scanned.includes('ssh-ed25519'); attempt += 1) {
    scanned = run('ssh-keyscan', ['-p', String(options.port), '-t', 'ed25519', '127.0.0.1']).stdout;
    if (!scanned.includes('ssh-ed25519')) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!scanned.includes('ssh-ed25519')) throw new Error('no sshd host key on the port');
  fs.writeFileSync(path.join(work, 'known_hosts'), scanned);
  const hostBlock = (alias, identity) => [
    `Host ${alias}`, '  HostName 127.0.0.1', `  Port ${options.port}`, '  User dev',
    `  IdentityFile ${forward(path.join(work, 'keys', identity))}`, '  IdentitiesOnly yes', '  IdentityAgent none',
    `  UserKnownHostsFile ${forward(path.join(work, 'known_hosts'))}`, '',
  ].join('\n');
  const config = path.join(work, 'config');
  fs.writeFileSync(config, [hostBlock('passphrase-key', 'enc'), hostBlock('plain-key', 'plain'), hostBlock('wrong-key', 'wrong')].join('\n'));

  const expectations = [
    { alias: 'passphrase-key', batchExit: 255, captured: (text) => /Enter passphrase for key/.test(text) },
    { alias: 'plain-key', batchExit: 0, captured: (text) => text === 'null' },
    { alias: 'wrong-key', batchExit: 255, captured: (text) => text === 'null' },
  ];
  for (const expectation of expectations) {
    const connection = ['-F', forward(config), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', expectation.alias];
    const batch = run(options.ssh, [...connection, 'true']);
    const captured = run('node', [bundle, options.ssh, ...connection]).stdout.trim();
    const ok = batch.status === expectation.batchExit && expectation.captured(captured);
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${expectation.alias}: BatchMode exit ${batch.status} (${batch.stderr.trim().split('\n').pop() || 'silent'}), captured ${captured}`);
  }
} finally {
  run('docker', ['rm', '-f', CONTAINER]);
}
process.exit(failed ? 1 : 0);
