/**
 * The TCP ports a server on this host could be reached on through `localhost` (#913), read from
 * `/proc/net/tcp` and `/proc/net/tcp6`. No program is started: the kernel's tables are plain text, one row
 * per socket, and a socket in state `0A` is listening.
 *
 * Only a socket bound to a loopback or wildcard address counts. A server bound to one private address is
 * not reached by a forward whose far end is `localhost`, so reporting it would promise a port that fails.
 *
 * A row reads `sl local_address rem_address st ...` with the address as hex: IPv4 is one 32-bit word in the
 * host's byte order, IPv6 is four such words. On the little-endian hosts this ships to, `127.0.0.1` is
 * `0100007F` and `::1` is `00000000000000000000000001000000`.
 *
 * Imports only `node:` built-ins, so the helper bundle stays free of Electron.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const LISTEN_STATE = '0A';

/** 127.0.0.0/8: the last byte of the first word is 0x7F. */
function isLoopbackV4(hex: string): boolean {
  return hex.slice(6, 8).toUpperCase() === '7F';
}

/** Whether a row's address is one `localhost` on the host reaches: loopback or the wildcard, in either family. */
export function isReachableThroughLocalhost(addressHex: string): boolean {
  const hex = addressHex.toUpperCase();
  if (hex.length === 8) return hex === '00000000' || isLoopbackV4(hex);
  if (hex.length !== 32) return false;
  if (/^0{32}$/.test(hex)) return true;
  // ::1, in the kernel's four little-endian words.
  if (hex === '00000000000000000000000001000000') return true;
  // ::ffff:127.0.0.1 and ::ffff:0.0.0.0 (a dual-stack socket's view of an IPv4 bind).
  if (hex.startsWith('0000000000000000FFFF0000')) return hex.slice(24) === '00000000' || isLoopbackV4(hex.slice(24));
  return false;
}

/** The listening ports in one table's text. A malformed row is skipped, never guessed at. */
export function parseListeningPorts(tableText: string): number[] {
  const ports = new Set<number>();
  for (const line of tableText.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || columns[3] !== LISTEN_STATE) continue;
    const [addressHex, portHex] = columns[1].split(':');
    if (!addressHex || !portHex || !isReachableThroughLocalhost(addressHex)) continue;
    const port = Number.parseInt(portHex, 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

/**
 * The listening ports on this host, sorted. `/proc/net/tcp` must be readable: a failure to read it throws,
 * because an empty answer would read as "nothing is listening". A host with IPv6 switched off has no
 * `tcp6` table, which is the one absence this accepts.
 */
export async function readListeningPorts(procDirectory = '/proc'): Promise<number[]> {
  const version4 = await fs.readFile(path.posix.join(procDirectory, 'net', 'tcp'), 'utf8');
  let version6 = '';
  try {
    version6 = await fs.readFile(path.posix.join(procDirectory, 'net', 'tcp6'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return [...new Set([...parseListeningPorts(version4), ...parseListeningPorts(version6)])].sort((left, right) => left - right);
}
