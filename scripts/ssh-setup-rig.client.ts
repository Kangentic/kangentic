// The client half of scripts/ssh-setup-rig.mjs (#913): the real first-time setup steps against a real sshd.
// Not shipped and not used by CI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createHostKey,
  defaultSshSetupDeps,
  deleteHostKeys,
  detectSshClient,
  forgetHostKey,
  installPublicKeyWithPassword,
  probeHostKey,
  trustHostKey,
} from '../src/main/remote/ssh-setup';

interface Options {
  sshPath: string;
  sshKeygenPath: string;
  work: string;
  destination: string;
  password: string;
  hostFingerprint: string;
  knownHostsFile: string;
  configFile: string;
}

const options = JSON.parse(process.argv[2]) as Options;
const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}\n`);
}

const deps = {
  ...defaultSshSetupDeps(path.join(options.work, 'config')),
  sshPath: options.sshPath,
  sshKeygenPath: options.sshKeygenPath,
  sshOptions: ['-F', options.configFile],
  temporaryDirectory: path.join(options.work, 'tmp'),
  homeDirectory: path.join(options.work, 'home'),
};
fs.mkdirSync(deps.temporaryDirectory, { recursive: true });

function signInWithKey(keyPath: string): string {
  return execFileSync(options.sshPath, [
    '-F', options.configFile, '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', options.destination, 'echo signed-in',
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main(): Promise<void> {
  const client = await detectSshClient(deps);
  record('finds the ssh client', client.found, client.version ?? client.error ?? '');

  const probe = await probeHostKey(options.destination, deps);
  record('learns the host key without trusting it', !fs.existsSync(options.knownHostsFile), `${probe.keyType} ${probe.fingerprint}`);
  record('the fingerprint is the host\'s own', probe.fingerprint === options.hostFingerprint, `host says ${options.hostFingerprint}`);

  await trustHostKey(options.destination, probe.fingerprint, deps);
  const known = fs.readFileSync(options.knownHostsFile, 'utf8');
  record('pins the key in known_hosts', known.includes(probe.knownHostsLine), known.trim().slice(0, 60));

  let refused = '';
  try {
    await trustHostKey(options.destination, 'SHA256:notTheFingerprintTheUserWasShown', deps);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  record('refuses to trust a key other than the one shown', refused.includes('different key'), refused.slice(0, 80));

  const hostId = '3f2a9c1e-0d4b-4c7a-9a1e-5b6c7d8e9f01';
  const pair = await createHostKey(hostId, deps);
  record('makes a key with no passphrase', fs.existsSync(pair.privateKeyPath) && pair.publicKey.startsWith('ssh-ed25519 '), pair.publicKey.slice(0, 30));

  let wrong = '';
  try {
    await installPublicKeyWithPassword(options.destination, pair.publicKey, 'not-the-password', deps);
  } catch (error) {
    wrong = error instanceof Error ? error.message : String(error);
  }
  record('shows ssh\'s own words for a wrong password', /permission denied/i.test(wrong), wrong.slice(0, 80));

  let beforeInstall = '';
  try {
    signInWithKey(pair.privateKeyPath);
  } catch (error) {
    beforeInstall = error instanceof Error ? error.message : String(error);
  }
  record('the key does not sign in before it is added', /permission denied/i.test(beforeInstall), beforeInstall.split('\n')[0].slice(0, 80));

  await installPublicKeyWithPassword(options.destination, pair.publicKey, options.password, deps);
  record('adds the key with the password, once', true, 'no error');

  record('then signs in with the key and no prompt', signInWithKey(pair.privateKeyPath) === 'signed-in', 'echo signed-in');

  await installPublicKeyWithPassword(options.destination, pair.publicKey, options.password, deps);
  const authorized = execFileSync(options.sshPath, ['-F', options.configFile, '-i', pair.privateKeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', options.destination, 'cat ~/.ssh/authorized_keys'], { encoding: 'utf8', windowsHide: true });
  const copies = authorized.split(/\r?\n/).filter((line) => line.trim() === pair.publicKey).length;
  record('adding it again does not add a second line', copies === 1, `${copies} line`);

  fs.writeFileSync(options.knownHostsFile, `${probe.knownHostsLine.split(' ')[0]} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n`);
  let changed = '';
  try {
    signInWithKey(pair.privateKeyPath);
  } catch (error) {
    changed = error instanceof Error ? error.message : String(error);
  }
  record('refuses a host whose key changed', /host key verification failed|identification has changed/i.test(changed), changed.split('\n').find((line) => /changed|verification/i.test(line))?.slice(0, 80) ?? changed.slice(0, 80));

  await forgetHostKey(options.destination, deps);
  record('forgets the old key', !fs.readFileSync(options.knownHostsFile, 'utf8').includes('AAAAAAAAAAAAAAAA'), 'removed');
  const again = await probeHostKey(options.destination, deps);
  await trustHostKey(options.destination, again.fingerprint, deps);
  record('then trusts the host again and signs in', signInWithKey(pair.privateKeyPath) === 'signed-in', again.fingerprint.slice(0, 20));

  await deleteHostKeys(hostId, deps);
  record('deletes the key with the host', !fs.existsSync(pair.privateKeyPath), 'gone');
}

main().then(() => {
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length} of ${results.length} steps passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}, (error) => {
  process.stderr.write(`setup rig client failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(2);
});
