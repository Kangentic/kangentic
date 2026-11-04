/**
 * First-time setup of an SSH host inside Kangentic (#913): what `ssh` is asked, what is parsed back, and
 * what is written to disk. The program runner is injected, so these run on every OS with no ssh; the
 * real client is exercised against a container by `scripts/ssh-setup-rig.mjs`.
 *
 * What a user loses if it breaks: a host key trusted without being shown, a key or password where a
 * stranger could read it, a destination turned into an ssh option, or a host's old key refused with no
 * way to replace it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  askpassProgram,
  createHostKey,
  deleteHostKeys,
  detectSshClient,
  fingerprintOf,
  forgetHostKey,
  hostKeyDirectory,
  importHostKey,
  installKeyCommand,
  installPublicKeyWithPassword,
  isValidPublicKey,
  knownHostsToken,
  parseSshConfigDump,
  pickKnownHostsEntry,
  probeHostKey,
  removeKeyCommand,
  runProgram,
  trustHostKey,
  type RunProgram,
  type SshSetupDeps,
} from '../../src/main/remote/ssh-setup';

const KEY_BLOB = Buffer.from('a real looking public key blob, long enough to hash').toString('base64');
const EXPECTED_FINGERPRINT = `SHA256:${createHash('sha256').update(Buffer.from(KEY_BLOB, 'base64')).digest('base64').replace(/=+$/, '')}`;
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOgIJuDZuvCDEVMrBvKoQm4R5vVmmcYCuZ1F8rK2mSyP kangentic';

let scratch: string;
let home: string;

function configDump(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = { user: 'dev', hostname: 'lab.example.test', port: '22', userknownhostsfile: path.join(home, '.ssh', 'known_hosts'), ...overrides };
  return Object.entries(values).map(([key, value]) => `${key} ${value}`).join('\n');
}

/** A fake ssh: `-G` prints a config dump, a probe writes the key into the known_hosts file it was given. */
function makeRun(options: { keyLineHost?: string; keyBlob?: string; probeWritesNothing?: boolean; dump?: string } = {}): RunProgram & { calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> } {
  const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const run = (async (file: string, args: string[], runOptions?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ file, args, env: runOptions?.env });
    if (args[0] === '-G') return { code: 0, stdout: options.dump ?? configDump(), stderr: '' };
    if (args[0] === '-V') return { code: 0, stdout: '', stderr: 'OpenSSH_9.5p1, OpenSSL 3.2.0\n' };
    const knownIndex = args.findIndex((arg) => arg.startsWith('UserKnownHostsFile='));
    if (knownIndex >= 0 && !options.probeWritesNothing) {
      const file = args[knownIndex].slice('UserKnownHostsFile='.length).replace(/^"|"$/g, '');
      fs.writeFileSync(file, `${options.keyLineHost ?? 'lab.example.test'} ssh-ed25519 ${options.keyBlob ?? KEY_BLOB}\n`);
      return { code: 255, stdout: '', stderr: 'dev@lab.example.test: Permission denied (publickey).' };
    }
    if (file === 'ssh-keygen' && args.includes('-t')) {
      const target = args[args.indexOf('-f') + 1];
      fs.writeFileSync(target, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
      fs.writeFileSync(`${target}.pub`, `${PUBLIC_KEY}\n`);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }) as RunProgram & { calls: typeof calls };
  run.calls = calls;
  return run;
}

function makeDeps(run: RunProgram): SshSetupDeps {
  return { sshPath: 'ssh', sshKeygenPath: 'ssh-keygen', run, configDirectory: path.join(scratch, 'config'), temporaryDirectory: path.join(scratch, 'tmp'), platform: process.platform, homeDirectory: home };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-ssh-setup-'));
  home = path.join(scratch, 'home');
  fs.mkdirSync(path.join(scratch, 'tmp'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('reading ssh\'s own configuration', () => {
  it('takes the host, port, user and the first known_hosts file ssh would use, with ~ expanded', () => {
    const target = parseSshConfigDump('user dev\nhostname lab.example.test\nport 2222\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n', '/home/dev');
    expect(target).toEqual({ hostname: 'lab.example.test', port: 2222, user: 'dev', userKnownHostsFile: path.join('/home/dev', '.ssh', 'known_hosts') });
  });

  it('defaults the port and the file, and refuses a dump that names no host', () => {
    expect(parseSshConfigDump('hostname h\n', '/h').port).toBe(22);
    expect(() => parseSshConfigDump('port 22\n', '/h')).toThrow('did not say which host');
  });

  it('names a host in known_hosts by [host]:port off the default port', () => {
    expect(knownHostsToken({ hostname: 'lab', port: 22 })).toBe('lab');
    expect(knownHostsToken({ hostname: 'lab', port: 2222 })).toBe('[lab]:2222');
  });

  it('reports the client\'s version line, and the raw error when there is none', async () => {
    expect(await detectSshClient(makeDeps(makeRun()))).toEqual({ found: true, version: 'OpenSSH_9.5p1, OpenSSL 3.2.0', error: null });
    const missing = await detectSshClient(makeDeps((async () => { throw new Error('spawn ssh ENOENT'); }) as RunProgram));
    expect(missing).toEqual({ found: false, version: null, error: 'spawn ssh ENOENT' });
  });
});

describe('a host key', () => {
  it('fingerprints a key the way ssh-keygen -l prints it', () => {
    expect(fingerprintOf(KEY_BLOB)).toBe(EXPECTED_FINGERPRINT);
    expect(fingerprintOf(KEY_BLOB)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('picks the line for the host asked, else the last (the final hop\'s)', () => {
    const text = '# comment\njump ssh-ed25519 AAAA\n[lab]:2222 ssh-ed25519 BBBB\nother ssh-rsa CCCC\n';
    expect(pickKnownHostsEntry(text, '[lab]:2222')).toEqual({ hostField: '[lab]:2222', keyType: 'ssh-ed25519', base64: 'BBBB' });
    expect(pickKnownHostsEntry(text, 'missing')).toEqual({ hostField: 'other', keyType: 'ssh-rsa', base64: 'CCCC' });
    expect(pickKnownHostsEntry('', 'x')).toBeNull();
  });

  it('is learned by a throwaway connection that signs in with nothing, into a temporary file, never the user\'s', async () => {
    const run = makeRun();

    const probe = await probeHostKey('dev@lab.example.test', makeDeps(run));

    expect(probe).toMatchObject({ hostname: 'lab.example.test', port: 22, keyType: 'ssh-ed25519', fingerprint: EXPECTED_FINGERPRINT });
    expect(probe.knownHostsLine).toBe(`lab.example.test ssh-ed25519 ${KEY_BLOB}`);
    const probeArgs = run.calls.find((call) => call.args.some((arg) => arg.startsWith('UserKnownHostsFile=')))!.args;
    expect(probeArgs).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=no', 'PreferredAuthentications=none', 'HashKnownHosts=no']));
    expect(probeArgs.join(' ')).not.toContain(path.join(home, '.ssh'));
    expect(fs.readdirSync(path.join(scratch, 'tmp'))).toEqual([]);
  });

  it('carries the HostKeyAlias ssh recorded the key under, not the hostname, so a real connection finds it', async () => {
    const run = makeRun({ keyLineHost: 'build-box-alias' });

    const probe = await probeHostKey('dev@lab.example.test', makeDeps(run));

    expect(probe.hostname).toBe('lab.example.test');
    expect(probe.knownHostsLine).toBe(`build-box-alias ssh-ed25519 ${KEY_BLOB}`);
  });

  it('writes the token alone when the line names it, even if ssh wrote the host with its address', async () => {
    const text = 'lab.example.test,10.0.0.7 ssh-ed25519 AAAA\n';
    expect(pickKnownHostsEntry(text, 'lab.example.test')).toEqual({ hostField: 'lab.example.test', keyType: 'ssh-ed25519', base64: 'AAAA' });

    const probe = await probeHostKey('dev@lab.example.test', makeDeps(makeRun({ keyLineHost: 'lab.example.test,10.0.0.7' })));
    expect(probe.knownHostsLine).toBe(`lab.example.test ssh-ed25519 ${KEY_BLOB}`);
  });

  it('says it could not reach the host when nothing was learned', async () => {
    await expect(probeHostKey('lab', makeDeps(makeRun({ probeWritesNothing: true })))).rejects.toThrow('Could not reach lab.example.test');
  });

  it('refuses an address that ssh would read as an option, before running anything', async () => {
    const run = makeRun();
    await expect(probeHostKey('-oProxyCommand=calc', makeDeps(run))).rejects.toThrow('address is not valid');
    expect(run.calls).toEqual([]);
  });

  it('is trusted into the user\'s own known_hosts, so a terminal ssh agrees, once', async () => {
    const deps = makeDeps(makeRun());

    await trustHostKey('lab', EXPECTED_FINGERPRINT, deps);
    await trustHostKey('lab', EXPECTED_FINGERPRINT, deps);

    const written = fs.readFileSync(path.join(home, '.ssh', 'known_hosts'), 'utf8');
    expect(written).toBe(`lab.example.test ssh-ed25519 ${KEY_BLOB}\n`);
  });

  it('keeps what known_hosts already holds and starts a new line after a file with no final newline', async () => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'known_hosts'), 'other ssh-ed25519 ZZZZ');

    await trustHostKey('lab', EXPECTED_FINGERPRINT, makeDeps(makeRun()));

    expect(fs.readFileSync(path.join(home, '.ssh', 'known_hosts'), 'utf8')).toBe(`other ssh-ed25519 ZZZZ\nlab.example.test ssh-ed25519 ${KEY_BLOB}\n`);
  });

  it('is NOT trusted when the host now presents a different key than the one shown', async () => {
    const other = Buffer.from('a different key blob entirely, also long enough').toString('base64');

    await expect(trustHostKey('lab', EXPECTED_FINGERPRINT, makeDeps(makeRun({ keyBlob: other })))).rejects.toThrow('different key than the one you were shown');

    expect(fs.existsSync(path.join(home, '.ssh', 'known_hosts'))).toBe(false);
  });

  it('is forgotten with ssh-keygen -R on the right file and name', async () => {
    const run = makeRun();

    await forgetHostKey('lab', makeDeps(run));

    const call = run.calls.find((candidate) => candidate.file === 'ssh-keygen')!;
    expect(call.args).toEqual(['-R', 'lab.example.test', '-f', path.join(home, '.ssh', 'known_hosts')]);
  });
});

describe('the key Kangentic signs in with', () => {
  it('is made in Kangentic\'s own folder with no passphrase, and read back', async () => {
    const run = makeRun();
    const deps = makeDeps(run);
    const hostId = '3f2a9c1e-0d4b-4c7a-9a1e-5b6c7d8e9f01';

    const pair = await createHostKey(hostId, deps);

    expect(pair.privateKeyPath).toBe(path.join(hostKeyDirectory(deps.configDirectory, hostId), 'id_ed25519'));
    expect(pair.publicKey).toBe(PUBLIC_KEY);
    const keygen = run.calls.find((call) => call.file === 'ssh-keygen')!;
    expect(keygen.args).toEqual(expect.arrayContaining(['-t', 'ed25519']));
    expect(keygen.args[keygen.args.indexOf('-N') + 1]).toBe('');
  });

  it('refuses a host id that is not an id, so a key folder cannot be steered elsewhere', () => {
    expect(() => hostKeyDirectory('/cfg', '../../etc')).toThrow('not a valid host id');
    expect(() => hostKeyDirectory('/cfg', '')).toThrow('not a valid host id');
  });

  it('is deleted with the host', async () => {
    const deps = makeDeps(makeRun());
    const hostId = '3f2a9c1e-0d4b-4c7a-9a1e-5b6c7d8e9f01';
    await createHostKey(hostId, deps);

    await deleteHostKeys(hostId, deps);

    expect(fs.existsSync(hostKeyDirectory(deps.configDirectory, hostId))).toBe(false);
  });

  it('is copied from a chosen file into Kangentic\'s folder with owner-only permissions, never used in place', async () => {
    const source = path.join(scratch, 'Downloads-key');
    fs.writeFileSync(source, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', { mode: 0o644 });
    const deps = makeDeps(makeRun());
    const hostId = '3f2a9c1e-0d4b-4c7a-9a1e-5b6c7d8e9f01';

    const copy = await importHostKey(hostId, source, deps);

    expect(copy).not.toBe(source);
    expect(fs.readFileSync(copy, 'utf8').endsWith('\n')).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
  });

  it('refuses a file that is not a private key, and one with a passphrase, which Kangentic never asks for', async () => {
    const deps = makeDeps(makeRun());
    const hostId = '3f2a9c1e-0d4b-4c7a-9a1e-5b6c7d8e9f01';
    const notAKey = path.join(scratch, 'notes.txt');
    fs.writeFileSync(notAKey, 'hello');
    await expect(importHostKey(hostId, notAKey, deps)).rejects.toThrow('not a private key');

    const protectedKey = path.join(scratch, 'protected');
    fs.writeFileSync(protectedKey, '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,AB\n\nabc\n-----END RSA PRIVATE KEY-----\n');
    await expect(importHostKey(hostId, protectedKey, deps)).rejects.toThrow('passphrase');
  });

  /** An OpenSSH-format key body: the magic, then the cipher's name as a length-prefixed string. */
  function openSshKeyText(cipherName: string): string {
    const name = Buffer.from(cipherName, 'latin1');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(name.length);
    const blob = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), length, name, Buffer.alloc(24)]);
    return `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
  }

  it('refuses a passphrase key in OpenSSH\'s own format, which never says ENCRYPTED in its text', async () => {
    const deps = makeDeps(makeRun());
    const hostId = '3f2a9c1e-0d4b-4c7a-9a1e-5b6c7d8e9f01';
    const protectedKey = path.join(scratch, 'id_ed25519_protected');
    fs.writeFileSync(protectedKey, openSshKeyText('aes256-ctr'));
    await expect(importHostKey(hostId, protectedKey, deps)).rejects.toThrow('passphrase');

    const plainKey = path.join(scratch, 'id_ed25519_plain');
    fs.writeFileSync(plainKey, openSshKeyText('none'));
    await expect(importHostKey(hostId, plainKey, deps)).resolves.toContain('id_imported');
  });

  it('writes the copy with LF line ends, which a POSIX ssh needs, when the chosen file has CRLF', async () => {
    const source = path.join(scratch, 'crlf-key');
    fs.writeFileSync(source, openSshKeyText('none').replace(/\n/g, '\r\n'));
    const copy = await importHostKey('3f2a9c1e-0d4b-4c7a-9a1e-5b6c7d8e9f01', source, makeDeps(makeRun()));
    expect(fs.readFileSync(copy, 'utf8')).not.toContain('\r');
  });
});

describe('a public key', () => {
  it.each([
    PUBLIC_KEY,
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC kangentic',
    'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY= me@host',
  ])('is accepted: %s', (line) => {
    expect(isValidPublicKey(line)).toBe(true);
  });

  it.each([
    "ssh-ed25519 AAAA'; rm -rf ~; echo '",
    'ssh-ed25519 AAAA kangentic; id',
    'ssh-ed25519 AAAA $(id)',
    'ssh-ed25519 AAAA `id`',
    'ssh-ed25519 AAAA\nssh-ed25519 BBBB',
    'ssh-dss AAAA',
    'not a key',
    '',
  ])('is refused, so nothing but a key is ever written into a shell command: %j', (line) => {
    expect(isValidPublicKey(line)).toBe(false);
    expect(() => installKeyCommand(line)).toThrow('not a public key');
    expect(() => removeKeyCommand(line)).toThrow('not a public key');
  });

  it('is added once: the command checks for the line before appending, and leaves the file private', () => {
    const command = installKeyCommand(PUBLIC_KEY);
    expect(command).toContain('umask 077');
    expect(command).toContain(`grep -qxF "${PUBLIC_KEY}"`);
    expect(command).toContain('>> ~/.ssh/authorized_keys');
  });

  it('is sent as one sh -c argument that any login shell passes through unchanged', () => {
    for (const command of [installKeyCommand(PUBLIC_KEY), removeKeyCommand(PUBLIC_KEY)]) {
      expect(command.startsWith("sh -c '")).toBe(true);
      expect(/['\\\n\r]/.test(command.slice("sh -c '".length, -1))).toBe(false);
    }
  });

  // The commands run for real under sh, against a temporary home. POSIX only: Windows has no sh.
  describe.skipIf(process.platform === 'win32')('run under sh', () => {
    async function runOnHost(command: string, hostHome: string): Promise<void> {
      const inner = command.slice("sh -c '".length, -1);
      const result = await runProgram('sh', ['-c', inner], { env: { ...process.env, HOME: hostHome }, timeout: 15_000 });
      expect(result.code).toBe(0);
    }

    it('puts the key on its own line when authorized_keys ends without a newline, and adds it only once', async () => {
      const hostHome = path.join(scratch, 'host-home');
      fs.mkdirSync(path.join(hostHome, '.ssh'), { recursive: true });
      const keysFile = path.join(hostHome, '.ssh', 'authorized_keys');
      fs.writeFileSync(keysFile, 'ssh-rsa AAAAB3NzaC1yc2E me@laptop');

      await runOnHost(installKeyCommand(PUBLIC_KEY), hostHome);
      await runOnHost(installKeyCommand(PUBLIC_KEY), hostHome);

      expect(fs.readFileSync(keysFile, 'utf8')).toBe(`ssh-rsa AAAAB3NzaC1yc2E me@laptop\n${PUBLIC_KEY}\n`);
    });

    it('takes the key out and keeps every other line', async () => {
      const hostHome = path.join(scratch, 'host-home-remove');
      fs.mkdirSync(path.join(hostHome, '.ssh'), { recursive: true });
      const keysFile = path.join(hostHome, '.ssh', 'authorized_keys');
      fs.writeFileSync(keysFile, `ssh-rsa AAAAB3NzaC1yc2E me@laptop\n${PUBLIC_KEY}\n`);

      await runOnHost(removeKeyCommand(PUBLIC_KEY), hostHome);

      expect(fs.readFileSync(keysFile, 'utf8')).toBe('ssh-rsa AAAAB3NzaC1yc2E me@laptop\n');
      expect(fs.existsSync(`${keysFile}.kangentic.tmp`)).toBe(false);
    });
  });
});

describe('using a password once', () => {
  it('gives it to ssh only through the child\'s environment and an askpass program, never an argument', async () => {
    const run = makeRun();
    const secret = 'p@ss w0rd; $(id) "quoted"';

    await installPublicKeyWithPassword('dev@lab', PUBLIC_KEY, secret, makeDeps(run));

    const call = run.calls.at(-1)!;
    expect(call.args.join(' ')).not.toContain(secret);
    expect(call.args).toEqual(expect.arrayContaining(['PubkeyAuthentication=no', 'NumberOfPasswordPrompts=1']));
    expect(call.env?.KANGENTIC_SSH_PASSWORD).toBe(secret);
    expect(call.env?.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(path.basename(call.env?.SSH_ASKPASS ?? '')).toMatch(/^askpass\.(sh|cmd)$/);
  });

  it('leaves no askpass program behind, and the password in no file', async () => {
    const secret = 'sup3r-secret-value';
    const deps = makeDeps(makeRun());

    await installPublicKeyWithPassword('dev@lab', PUBLIC_KEY, secret, deps);

    expect(fs.readdirSync(path.join(scratch, 'tmp'))).toEqual([]);
  });

  it('writes an askpass program that prints the password from the environment and holds none itself', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const program = askpassProgram(platform);
      expect(program.content).toContain('KANGENTIC_SSH_PASSWORD');
      expect(program.content).not.toMatch(/%KANGENTIC_SSH_PASSWORD%/);
    }
    expect(askpassProgram('win32').fileName).toBe('askpass.cmd');
    expect(askpassProgram('linux').fileName).toBe('askpass.sh');
  });

  it('shows ssh\'s own words when the host refuses', async () => {
    const run = (async () => ({ code: 255, stdout: '', stderr: 'dev@lab: Permission denied (password).\n' })) as RunProgram;

    await expect(installPublicKeyWithPassword('dev@lab', PUBLIC_KEY, 'wrong', makeDeps(run))).rejects.toThrow('Permission denied (password).');
  });

  it('refuses an address that ssh would read as an option, before the password is used', async () => {
    const run = makeRun();
    await expect(installPublicKeyWithPassword('-oProxyCommand=x', PUBLIC_KEY, 'pw', makeDeps(run))).rejects.toThrow('address is not valid');
    expect(run.calls).toEqual([]);
  });

  it('refuses an unpinned host at once instead of asking a host-key question through askpass and waiting', async () => {
    const run = makeRun();

    await installPublicKeyWithPassword('dev@lab', PUBLIC_KEY, 'pw', makeDeps(run));

    expect(run.calls.at(-1)!.args).toEqual(expect.arrayContaining(['StrictHostKeyChecking=yes']));
  });

  it('says what happened when ssh printed nothing: a stop at the time limit, or an exit code', async () => {
    const stopped = (async () => ({ code: null, stdout: '', stderr: '' })) as unknown as RunProgram;
    const silent = (async () => ({ code: 255, stdout: '', stderr: '' })) as RunProgram;

    await expect(installPublicKeyWithPassword('dev@lab', PUBLIC_KEY, 'pw', makeDeps(stopped))).rejects.toThrow('The ssh program did not finish within 60 seconds');
    await expect(installPublicKeyWithPassword('dev@lab', PUBLIC_KEY, 'pw', makeDeps(silent))).rejects.toThrow('The ssh program exited with code 255 and printed no message');
  });
});

describe('running a program for ssh', () => {
  it('closes its stdin, so a program that waits for the end of its input finishes (ssh does, on Windows)', async () => {
    // A real child, not a fake: the whole point is what an open pipe does to a real process.
    const result = await runProgram(process.execPath, ['-e', "process.stdin.on('end', () => console.log('eof')); process.stdin.resume();"], { timeout: 15_000 });

    expect(result).toEqual({ code: 0, stdout: 'eof\n', stderr: '' });
  });

  it('stops a program that outlives its time limit and reports no exit code', async () => {
    const result = await runProgram(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 500 });

    expect(result.code).toBeNull();
  });
});

describe('an ssh that names its files the MSYS way (Git for Windows)', () => {
  it('reads /c/Users/dev/.ssh/known_hosts as the Windows path it is, never C:\\c\\Users\\dev', () => {
    const dump = 'hostname lab.example.test\nport 2262\nuserknownhostsfile /c/Users/dev/.ssh/known_hosts /c/Users/dev/.ssh/known_hosts2\n';

    expect(parseSshConfigDump(dump, 'C:\\Users\\dev', 'win32').userKnownHostsFile).toBe('C:\\Users\\dev\\.ssh\\known_hosts');
  });

  it('leaves a path alone on every other platform, where /c/ is a real folder', () => {
    const dump = 'hostname lab.example.test\nuserknownhostsfile /c/Users/dev/.ssh/known_hosts\n';

    expect(parseSshConfigDump(dump, '/home/dev', 'linux').userKnownHostsFile).toBe('/c/Users/dev/.ssh/known_hosts');
    expect(parseSshConfigDump(dump, '/Users/dev', 'darwin').userKnownHostsFile).toBe('/c/Users/dev/.ssh/known_hosts');
  });
});
