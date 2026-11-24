/**
 * The OS machine id, hashed, for the anonymous analytics client id.
 *
 * This replaces the `node-machine-id` package, whose `machineId()` runs
 * `exec` from the thread that calls it: `REG.exe` through cmd on Windows,
 * `ioreg` on macOS, a `cat` pipeline on Linux. It runs when the client id file
 * is missing, which is a first launch, inside the burst of processes every
 * boot starts. On Windows CreateProcess holds the calling thread, so the read
 * goes through `execFileAsync` and starts on the pty host's spawn worker
 * (.claude/rules/main-starts-no-process.md). Linux reads the files directly.
 *
 * The id must not change for an existing install, so each platform's source
 * and normalization are the package's own (node-machine-id 1.1.12), and the
 * result is the same SHA-256 hex of the normalized id.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileAsync } from '../utility-process/off-main-exec';

/** The registry value Windows keeps its install-wide GUID in. */
const WINDOWS_MACHINE_GUID_KEY = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography';

/** Where Linux keeps its machine id, in the order the package's `cat` read them. */
const LINUX_MACHINE_ID_FILES: readonly string[] = ['/var/lib/dbus/machine-id', '/etc/machine-id'];

/** The GUID out of `REG.exe QUERY ... /v MachineGuid`: everything after `REG_SZ`, whitespace removed. */
export function parseWindowsMachineGuid(regOutput: string): string {
  const afterType = regOutput.split('REG_SZ')[1];
  if (afterType === undefined) throw new Error('REG.exe printed no MachineGuid');
  return afterType.replace(/\r+|\n+|\s+/gi, '').toLowerCase();
}

/** The UUID out of `ioreg -rd1 -c IOPlatformExpertDevice`: the rest of the `IOPlatformUUID` line. */
export function parseMacPlatformUuid(ioregOutput: string): string {
  const afterKey = ioregOutput.split('IOPlatformUUID')[1];
  if (afterKey === undefined) throw new Error('ioreg printed no IOPlatformUUID');
  return afterKey.split('\n')[0].replace(/=|\s+|"/gi, '').toLowerCase();
}

/**
 * What `( cat <files> 2> /dev/null || hostname ) | head -n 1` printed: the
 * first line of every readable file's content in order, followed by the host
 * name when any file could not be read (`cat` exits non-zero then, so
 * `hostname` runs too).
 */
export function linuxMachineIdSource(fileContents: ReadonlyArray<string | null>, hostName: string): string {
  const readable = fileContents.filter((content): content is string => content !== null);
  const anyUnreadable = readable.length < fileContents.length;
  const printed = `${readable.join('')}${anyUnreadable ? `${hostName}\n` : ''}`;
  return printed.split('\n')[0].replace(/\r+|\n+|\s+/gi, '').toLowerCase();
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // report-ok: a machine without this file is the case the next source covers.
    return null;
  }
}

async function readRawMachineId(platform: NodeJS.Platform, timeoutMs: number): Promise<string> {
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.windir;
    const regExecutable = systemRoot ? path.join(systemRoot, 'System32', 'reg.exe') : 'reg.exe';
    const { stdout } = await execFileAsync(regExecutable, ['QUERY', WINDOWS_MACHINE_GUID_KEY, '/v', 'MachineGuid'], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    return parseWindowsMachineGuid(stdout);
  }
  if (platform === 'darwin') {
    const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: timeoutMs });
    return parseMacPlatformUuid(stdout);
  }
  if (platform === 'linux') {
    return linuxMachineIdSource(LINUX_MACHINE_ID_FILES.map(readFileOrNull), os.hostname());
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * The machine id as `node-machine-id`'s `machineId()` returned it: the SHA-256
 * hex of the normalized OS id. Rejects when the OS source cannot be read.
 */
export async function readHashedMachineId(timeoutMs: number, platform: NodeJS.Platform = process.platform): Promise<string> {
  const rawMachineId = await readRawMachineId(platform, timeoutMs);
  return createHash('sha256').update(rawMachineId).digest('hex');
}
