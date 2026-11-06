/**
 * First-time setup of an SSH host, done inside Kangentic with no terminal (#913): find the `ssh`
 * client, learn a host's key and pin it once the user trusts it, make or import the key Kangentic signs
 * in with, and, for a host that takes only a password, use that password once to add the key.
 *
 * Kept simple on purpose. A key Kangentic makes has no passphrase and lives in Kangentic's own folder,
 * and a reconnect never prompts (`BatchMode=yes`), so nothing here is ever asked twice. A password is
 * used once and never stored: it reaches `ssh` through the child's environment and a tiny askpass
 * program, never argv, never a file, never a log.
 *
 * Everything runs the user's own `ssh` and `ssh-keygen`, so their `~/.ssh/config` (jump hosts, ports,
 * certificates) applies exactly as it does in a terminal.
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { childProcessEnv } from '../shared/child-env';
import { killChildTreeNow } from '../shared/child-tree-stop';
import { posixShellCommand } from './link/ssh-run';
import { assertSafeDestination, defaultSshClientPaths, nativePathFromSsh } from './ssh-client';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunProgram = (file: string, args: string[], options?: ExecFileOptions & { env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<RunResult>;

/**
 * `execFile` that resolves with the exit status instead of rejecting on one, and never opens a window.
 *
 * Stdin is closed at once. Windows' `ssh` forwards its stdin to the remote command, and an `execFile` pipe
 * that stays open leaves it waiting after the command has finished: found by running Add host in the real
 * app, where the key was added on the host and `ssh` then sat until the 60 s kill (the rig's own helper
 * closed stdin, so it never showed).
 *
 * The timeout stops the child's whole tree, as `ssh-run.ts` does: `execFile`'s own timeout signals only
 * `ssh` itself, and a ProxyCommand or jump-host hop it started would keep running.
 */
export const runProgram: RunProgram = (file, args, options = {}) => new Promise((resolve, reject) => {
  const { timeout, ...execOptions } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const child = execFile(file, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...execOptions }, (error, stdout, stderr) => {
    if (timer) clearTimeout(timer);
    const spawnFailure = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
    if (!timedOut && spawnFailure && typeof spawnFailure.code === 'string' && spawnFailure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      reject(spawnFailure);
      return;
    }
    const code = timedOut ? null : error ? (typeof spawnFailure?.code === 'number' ? spawnFailure.code : null) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
  if (timeout !== undefined && timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killChildTreeNow(child, { leadsGroup: false });
    }, timeout);
  }
  // A child that exits before this runs has already closed its end; the error is the child's, not ours.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end();
});

export interface SshSetupDeps {
  sshPath: string;
  sshKeygenPath: string;
  /** Options put before every `ssh` call's own, such as `-F <file>` for a config file the user chose. */
  sshOptions?: string[];
  run: RunProgram;
  /** Kangentic's own folder, where keys it makes live: `<configDir>/ssh/<hostId>/`. */
  configDirectory: string;
  /** A folder for short-lived files (the temporary known_hosts, the askpass program). */
  temporaryDirectory: string;
  platform: NodeJS.Platform;
  homeDirectory: string;
}

export function defaultSshSetupDeps(configDirectory: string): SshSetupDeps {
  const client = defaultSshClientPaths();
  return {
    sshPath: client.ssh,
    sshKeygenPath: client.sshKeygen,
    run: runProgram,
    configDirectory,
    temporaryDirectory: os.tmpdir(),
    platform: process.platform,
    homeDirectory: os.homedir(),
  };
}

// ---------------------------------------------------------------------------------------------
// The ssh client

export interface SshClientInfo {
  found: boolean;
  /** The client's own version line, such as `OpenSSH_9.5p1`, as `ssh -V` prints it. */
  version: string | null;
  /** The raw error when it could not be started, shown as is. */
  error: string | null;
}

export async function detectSshClient(deps: SshSetupDeps): Promise<SshClientInfo> {
  try {
    const result = await deps.run(deps.sshPath, ['-V'], { env: childProcessEnv(), timeout: 10_000 });
    // `ssh -V` prints to stderr.
    const text = (result.stderr || result.stdout).trim();
    return { found: true, version: text.split(/\r?\n/)[0] || null, error: null };
  } catch (error) {
    return { found: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// A host's key

/** Where `ssh` would connect, as `ssh -G` resolves it through the user's config. */
export interface ResolvedTarget {
  hostname: string;
  port: number;
  user: string | null;
  /** The first file `ssh` records host keys in, `~` expanded. */
  userKnownHostsFile: string;
}

export function parseSshConfigDump(text: string, homeDirectory: string, platform: NodeJS.Platform = process.platform): ResolvedTarget {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const space = line.indexOf(' ');
    if (space > 0 && !values.has(line.slice(0, space))) values.set(line.slice(0, space), line.slice(space + 1).trim());
  }
  const hostname = values.get('hostname');
  if (!hostname) throw new Error('ssh did not say which host that address means.');
  const knownHosts = (values.get('userknownhostsfile') ?? '~/.ssh/known_hosts').split(/\s+/)[0];
  return {
    hostname,
    port: Number(values.get('port') ?? '22') || 22,
    user: values.get('user') ?? null,
    // An MSYS ssh on Windows names it `/c/Users/dev/.ssh/known_hosts`, which Node would read as `C:\c\Users\...`.
    userKnownHostsFile: nativePathFromSsh(expandHome(knownHosts, homeDirectory), platform),
  };
}

function expandHome(filePath: string, homeDirectory: string): string {
  if (filePath === '~') return homeDirectory;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(homeDirectory, filePath.slice(2));
  return filePath;
}

export async function resolveTarget(destination: string, deps: SshSetupDeps): Promise<ResolvedTarget> {
  assertSafeDestination(destination);
  const result = await deps.run(deps.sshPath, [...(deps.sshOptions ?? []), '-G', destination], { env: childProcessEnv(), timeout: 15_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'ssh could not read that address.');
  return parseSshConfigDump(result.stdout, deps.homeDirectory, deps.platform);
}

/** The token a known_hosts line names a host by: the name, or `[name]:port` off the default port. */
export function knownHostsToken(target: Pick<ResolvedTarget, 'hostname' | 'port'>): string {
  return target.port === 22 ? target.hostname : `[${target.hostname}]:${target.port}`;
}

export interface HostKeyProbe {
  hostname: string;
  port: number;
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, ... */
  keyType: string;
  /** `SHA256:` and the key's hash, the form `ssh-keygen -l` and every host-key prompt print. */
  fingerprint: string;
  /** The line to add to known_hosts to trust it. */
  knownHostsLine: string;
}

/** `SHA256:<base64 without padding>` of a base64-encoded public key blob. */
export function fingerprintOf(base64Key: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/** The key lines of known_hosts text as host field, key type and key, without comments or marked lines. */
function knownHostsEntries(text: string): string[][] {
  return text.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && !parts[0].startsWith('#') && !parts[0].startsWith('@'));
}

/** The key entry for a host in a known_hosts file's text, preferring the host asked for and falling back to the last line (the final hop's). */
export function pickKnownHostsEntry(text: string, token: string): { hostField: string; keyType: string; base64: string } | null {
  const entries = knownHostsEntries(text);
  const matched = entries.filter((parts) => parts[0].split(',').includes(token)).at(-1);
  const chosen = matched ?? entries.at(-1);
  if (!chosen) return null;
  // No match means ssh recorded the host under another name (a HostKeyAlias), and that name is the one
  // it looks up on a real connection, so it is the one to trust.
  return { hostField: matched ? token : chosen[0], keyType: chosen[1], base64: chosen[2] };
}

/**
 * Learn the key a host presents without trusting it: a throwaway connection that signs in with nothing
 * into a temporary known_hosts. `ssh` hands an askpass program only the first line of its host-key
 * question, which holds no fingerprint, so the fingerprint comes from here (Phase 0 measured 44 ms
 * direct and 245 ms through a jump host, and it matched the host's own key).
 */
export async function probeHostKey(destination: string, deps: SshSetupDeps, resolved?: ResolvedTarget): Promise<HostKeyProbe> {
  const target = resolved ?? await resolveTarget(destination, deps);
  const scratch = path.join(deps.temporaryDirectory, `kangentic-probe-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  const known = path.join(scratch, 'known_hosts');
  // `ssh` reads a known-hosts option as a list split on whitespace, so a temp folder under a profile
  // with a space in its name is quoted, which its config parser honors.
  const knownOption = /\s/.test(known) ? `"${known}"` : known;
  try {
    await deps.run(deps.sshPath, [
      ...(deps.sshOptions ?? []),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', `UserKnownHostsFile=${knownOption}`,
      '-o', `GlobalKnownHostsFile=${knownOption}`,
      '-o', 'HashKnownHosts=no',
      '-o', 'PreferredAuthentications=none',
      '-o', 'ConnectTimeout=10',
      '-o', 'LogLevel=ERROR',
      destination,
      'exit',
    ], { env: childProcessEnv(), timeout: 30_000 });
    const text = await fs.readFile(known, 'utf8').catch(() => '');
    const entry = pickKnownHostsEntry(text, knownHostsToken(target));
    if (!entry) throw new Error(`Could not reach ${target.hostname}${target.port === 22 ? '' : `:${target.port}`} to read its key. Check the address and that the host is on.`);
    return {
      hostname: target.hostname,
      port: target.port,
      keyType: entry.keyType,
      fingerprint: fingerprintOf(entry.base64),
      knownHostsLine: `${entry.hostField} ${entry.keyType} ${entry.base64}`,
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Trust a host: add its key to the user's own known_hosts, so a terminal `ssh` agrees. The key is
 * learned again and must still carry the fingerprint the user was shown, or nothing is written.
 */
export async function trustHostKey(destination: string, shownFingerprint: string, deps: SshSetupDeps): Promise<HostKeyProbe> {
  const target = await resolveTarget(destination, deps);
  const probe = await probeHostKey(destination, deps, target);
  if (probe.fingerprint !== shownFingerprint) {
    throw new Error('The host presented a different key than the one you were shown, so nothing was trusted. Try again, and compare the fingerprint.');
  }
  await recordKnownHostsLine(target, probe.knownHostsLine);
  return probe;
}

/** Add a key line to the user's own known_hosts, once. */
async function recordKnownHostsLine(target: ResolvedTarget, knownHostsLine: string): Promise<void> {
  await fs.mkdir(path.dirname(target.userKnownHostsFile), { recursive: true, mode: 0o700 });
  const existing = await fs.readFile(target.userKnownHostsFile, 'utf8').catch(() => '');
  if (existing.split(/\r?\n/).some((line) => line.trim() === knownHostsLine)) return;
  await fs.appendFile(target.userKnownHostsFile, `${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${knownHostsLine}\n`, { mode: 0o600 });
}

/**
 * Remove a host's recorded key, so the next connection asks again. The app replaces a changed key through
 * `replaceHostKey`. This is what the setup rig calls to walk the changed-key steps one at a time.
 */
export async function forgetHostKey(destination: string, deps: SshSetupDeps): Promise<void> {
  await removeRecordedKey(await resolveTarget(destination, deps), deps);
}

async function removeRecordedKey(target: ResolvedTarget, deps: SshSetupDeps, recordedHost: string = knownHostsToken(target)): Promise<void> {
  const result = await deps.run(deps.sshKeygenPath, ['-R', recordedHost, '-f', target.userKnownHostsFile], { env: childProcessEnv(), timeout: 15_000 });
  if (result.code !== 0 && !/not found/i.test(result.stdout + result.stderr)) throw new Error(result.stderr.trim() || 'ssh-keygen could not remove the old key.');
}

/**
 * The fingerprint the user trusted for a host before its key changed, read from their own known_hosts with
 * `ssh-keygen -F`, or null when there is none or it cannot be read. Never throws: it only adds a line to a
 * dialog that works without it.
 */
export async function readRecordedFingerprint(destination: string, deps: SshSetupDeps): Promise<string | null> {
  try {
    const target = await resolveTarget(destination, deps);
    const result = await deps.run(deps.sshKeygenPath, ['-F', knownHostsToken(target), '-f', target.userKnownHostsFile], { env: childProcessEnv(), timeout: 15_000 });
    if (result.code !== 0) return null;
    // `-F` prints a comment line, then the matching known_hosts line, whose host field is hashed by default.
    const entry = knownHostsEntries(result.stdout)[0];
    return entry ? fingerprintOf(entry[2]) : null;
  } catch {
    return null;
  }
}

/**
 * A host's key changed and the user, shown the new fingerprint, trusts it: forget the old key and record the
 * new one. The key is read again and must still carry the fingerprint the user was shown, or nothing is
 * touched, so the old key is never removed for a key the user did not see.
 */
export async function replaceHostKey(destination: string, shownFingerprint: string, deps: SshSetupDeps): Promise<HostKeyProbe> {
  const target = await resolveTarget(destination, deps);
  const probe = await probeHostKey(destination, deps, target);
  if (probe.fingerprint !== shownFingerprint) {
    throw new Error('The host presented a different key than the one you were shown, so nothing was changed. Try again, and compare the fingerprint.');
  }
  // The name ssh looks the host up under, which a HostKeyAlias makes something other than the address. ssh
  // accepts a host when any line matches, so an old line left under that name stays trusted.
  await removeRecordedKey(target, deps, probe.knownHostsLine.split(' ')[0]);
  await recordKnownHostsLine(target, probe.knownHostsLine);
  return probe;
}

// ---------------------------------------------------------------------------------------------
// The key Kangentic signs in with

export interface HostKeyPair {
  privateKeyPath: string;
  /** The public key line, `ssh-ed25519 AAAA... kangentic`. */
  publicKey: string;
}

const PUBLIC_KEY_PATTERN = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [\w.@:+-]{1,64})?$/;

export function isValidPublicKey(line: string): boolean {
  return PUBLIC_KEY_PATTERN.test(line.trim());
}

export function hostKeyDirectory(configDirectory: string, hostId: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(hostId)) throw new Error('That is not a valid host id.');
  return path.join(configDirectory, 'ssh', hostId);
}

/** Make an ed25519 key with no passphrase in Kangentic's own folder. Deleted with the host. */
export async function createHostKey(hostId: string, deps: SshSetupDeps): Promise<HostKeyPair> {
  const directory = hostKeyDirectory(deps.configDirectory, hostId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const privateKeyPath = path.join(directory, 'id_ed25519');
  await fs.rm(privateKeyPath, { force: true });
  await fs.rm(`${privateKeyPath}.pub`, { force: true });
  const result = await deps.run(deps.sshKeygenPath, ['-q', '-t', 'ed25519', '-N', '', '-C', 'kangentic', '-f', privateKeyPath], { env: childProcessEnv(), timeout: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'ssh-keygen could not make a key.');
  const publicKey = (await fs.readFile(`${privateKeyPath}.pub`, 'utf8')).trim();
  if (!isValidPublicKey(publicKey)) throw new Error('ssh-keygen made a key Kangentic could not read back.');
  return { privateKeyPath, publicKey };
}

/**
 * The text of a private key file Kangentic can use, with line ends a POSIX OpenSSH accepts. Refuses a file
 * that is not a private key and one with a passphrase, in words the user can act on.
 */
async function readUsablePrivateKey(sourcePath: string): Promise<string> {
  // A key saved on Windows can carry CRLF line ends, which a POSIX OpenSSH refuses as an invalid format.
  const content = (await fs.readFile(sourcePath, 'utf8')).replace(/\r\n/g, '\n');
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) throw new Error('That file is not a private key.');
  if (/ENCRYPTED/.test(content.split('\n').slice(0, 4).join('\n')) || isEncryptedOpenSshKey(content)) {
    throw new Error('That key has a passphrase, and Kangentic never asks for one. Add it to ssh-agent, or let Kangentic make its own key.');
  }
  return content;
}

/** Whether a key file the user chose is one Kangentic can use, checked when it is chosen instead of when the host is added. Throws the reason. */
export async function checkKeyFile(sourcePath: string): Promise<void> {
  await readUsablePrivateKey(sourcePath);
}

/**
 * Keep a copy of a key file the user chose, in Kangentic's folder with owner-only permissions. A key
 * in Downloads is mode 0644 on POSIX and `ssh` refuses it, and a copy also keeps working if the
 * original moves. The copy goes when the host does.
 */
export async function importHostKey(hostId: string, sourcePath: string, deps: SshSetupDeps): Promise<string> {
  const directory = hostKeyDirectory(deps.configDirectory, hostId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'id_imported');
  const content = await readUsablePrivateKey(sourcePath);
  await fs.rm(target, { force: true });
  await fs.writeFile(target, '', { mode: 0o600 });
  // Restricted while empty, so the key is never readable under the folder's ACL.
  if (deps.platform === 'win32') await restrictToOwnerOnWindows(target, deps);
  await fs.writeFile(target, content.endsWith('\n') ? content : `${content}\n`);
  return target;
}

/**
 * Give a file the ACL Windows' `ssh-keygen` gives a key it makes. A file mode means nothing there, so a new
 * file inherits its folder's ACL, and the profile can carry more than the user: Codex's Windows sandbox grants
 * a group read on it. `ssh.exe` then refuses the key as unprotected, for a sign-in that never reaches the host.
 */
async function restrictToOwnerOnWindows(filePath: string, deps: SshSetupDeps): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  const icacls = systemRoot ? path.win32.join(systemRoot, 'System32', 'icacls.exe') : 'icacls';
  const { username } = os.userInfo();
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
  const result = await deps.run(icacls, [filePath, '/inheritance:r', '/grant:r', `${account}:F`, '*S-1-5-18:F'], { timeout: 30_000 });
  if (result.code !== 0) throw new Error(result.stdout.trim() || result.stderr.trim() || 'Could not restrict who can read the key file.');
}

/**
 * Whether a key in OpenSSH's own format (`BEGIN OPENSSH PRIVATE KEY`, the default since OpenSSH 7.8)
 * has a passphrase. Such a key never says ENCRYPTED in its text: the cipher's name sits inside the
 * base64 body, right after the `openssh-key-v1` magic, and is `none` for a key with no passphrase.
 */
export function isEncryptedOpenSshKey(content: string): boolean {
  const match = content.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/);
  if (!match) return false;
  const blob = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  const magic = 'openssh-key-v1\0';
  if (blob.length < magic.length + 4 || blob.toString('latin1', 0, magic.length) !== magic) return false;
  const nameLength = blob.readUInt32BE(magic.length);
  const cipherName = blob.toString('latin1', magic.length + 4, magic.length + 4 + nameLength);
  return cipherName !== 'none';
}

/** Remove the keys Kangentic holds for a host. */
export async function deleteHostKeys(hostId: string, deps: SshSetupDeps): Promise<void> {
  await fs.rm(hostKeyDirectory(deps.configDirectory, hostId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Adding the key with a password, once

/** The program `ssh` runs to ask for the password: it prints the one in its environment, nothing else. */
export function askpassProgram(platform: NodeJS.Platform): { fileName: string; content: string } {
  if (platform === 'win32') {
    // cmd never sees the password's text: PowerShell reads it from the environment.
    return {
      fileName: 'askpass.cmd',
      content: '@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command "[Console]::Out.WriteLine($env:KANGENTIC_SSH_PASSWORD)"\r\n',
    };
  }
  return { fileName: 'askpass.sh', content: '#!/bin/sh\nprintf \'%s\\n\' "$KANGENTIC_SSH_PASSWORD"\n' };
}

/**
 * The command that adds a key to the host's authorized_keys once, run through sh whatever the login
 * shell. Only a validated key goes into it, and `PUBLIC_KEY_PATTERN` admits no quote, `$`, backtick or
 * backslash, so double quotes hold it. A file whose last line has no newline (a hand edit) gets one
 * first, or the key would be glued onto that line and neither would work.
 */
export function installKeyCommand(publicKey: string): string {
  if (!isValidPublicKey(publicKey)) throw new Error('That is not a public key Kangentic can add.');
  const line = publicKey.trim();
  const file = '~/.ssh/authorized_keys';
  return posixShellCommand([
    'umask 077',
    'mkdir -p ~/.ssh',
    `touch ${file}`,
    `grep -qxF "${line}" ${file} || { if [ -s ${file} ] && [ -n "$(tail -c 1 ${file})" ]; then echo >> ${file}; fi; echo "${line}" >> ${file}; }`,
  ].join('; '));
}

/**
 * Add a key to a host using its password, once. The password is in the child's environment only.
 * `ssh`'s own words come back on failure ("Permission denied", a refused connection), as they are.
 */
export async function installPublicKeyWithPassword(destination: string, publicKey: string, password: string, deps: SshSetupDeps): Promise<void> {
  assertSafeDestination(destination);
  const command = installKeyCommand(publicKey);
  const scratch = path.join(deps.temporaryDirectory, `kangentic-askpass-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  try {
    const program = askpassProgram(deps.platform);
    const askpass = path.join(scratch, program.fileName);
    await fs.writeFile(askpass, program.content, { mode: 0o700 });
    const result = await deps.run(deps.sshPath, [
      ...(deps.sshOptions ?? []),
      '-o', 'BatchMode=no',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'PubkeyAuthentication=no',
      // The key was pinned when the user trusted it. An unpinned host fails here at once, where the
      // default would ask a host-key question through askpass and wait until the 60 s kill.
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'ConnectTimeout=15',
      destination,
      command,
    ], {
      env: childProcessEnv({
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        // Older clients only use askpass when a display is set.
        DISPLAY: process.env.DISPLAY ?? 'kangentic:0',
        KANGENTIC_SSH_PASSWORD: password,
      }),
      timeout: 60_000,
    });
    if (result.code !== 0) {
      // ssh's own words when it printed any. With none, say what happened rather than guess a cause.
      throw new Error(result.stderr.trim() || (result.code === null
        ? 'The ssh program did not finish within 60 seconds and was stopped.'
        : `The ssh program exited with code ${result.code} and printed no message.`));
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Take a key out of a host's authorized_keys, signing in with that key. Best effort: the host may be
 * unreachable. The file is rewritten only when grep finished: exit 0 (lines kept) or 1 (no line left).
 * Exit 2 (a read error, a full disk) leaves a short temporary file, which must never replace the user's keys.
 */
export function removeKeyCommand(publicKey: string): string {
  if (!isValidPublicKey(publicKey)) throw new Error('That is not a public key Kangentic can remove.');
  const line = publicKey.trim();
  return posixShellCommand([
    'f=~/.ssh/authorized_keys',
    `if [ -f "$f" ]; then grep -vxF "${line}" "$f" > "$f.kangentic.tmp"; status=$?; if [ "$status" -le 1 ]; then cat "$f.kangentic.tmp" > "$f"; fi; rm -f "$f.kangentic.tmp"; fi`,
  ].join('; '));
}
