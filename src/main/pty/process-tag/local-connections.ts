/**
 * Which local processes hold a TCP connection to a port another local process
 * listens on, from a platform's socket table. Pure, so every rule here is
 * pinned by fixture tests without a real socket.
 *
 * Each reader builds `SocketRow`s from its own source (Windows'
 * `GetExtendedTcpTable`, Linux's `/proc/net/tcp` and `tcp6` with the fd links,
 * macOS libproc's socket info) and returns only the pid pairs found here. An
 * address or a port never leaves a reader.
 *
 * A connection is paired through the socket the listener accepted, never by
 * matching a client's destination against a listening address (a wildcard or
 * dual-stack listener makes that ambiguous):
 * - a row in ESTABLISHED, owned by a listener, whose local port is one that
 *   listener listens on, is the server side of a connection;
 * - its peer row (local and remote swapped) is the client side, and the peer
 *   row's owner is the client.
 * A client on another host has no peer row, so it never pairs. A v4-mapped
 * address (`::ffff:127.0.0.1`) reads as its v4 form, so an IPv4 client of a
 * dual-stack listener pairs across the two tables.
 */

import type { LocalConnection } from './process-scan';

/** One TCP socket as a reader saw it. */
export interface SocketRow {
  state: 'listen' | 'established' | 'other';
  /** `ipv4FromBytes` / `ipv6FromBytes` form, so rows from both tables compare. */
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  /**
   * The processes holding the socket. Linux can find one inode in several
   * processes' fd tables (an inherited listener); empty when no reader found
   * the owner.
   */
  ownerPids: readonly number[];
  /** Linux only: the socket's inode, by which `/proc/<pid>/fd` links name it. */
  inode?: string;
}

/** The server side of one connection, the processes on that side, and its peer row when the table has one. */
export interface ListenerConnection {
  server: SocketRow;
  /** Who listens on the port, and who holds the accepted socket. */
  listenerSide: readonly number[];
  peer: SocketRow | null;
}

/** `a.b.c.d` from four bytes in network order. */
export function ipv4FromBytes(bytes: Uint8Array, offset = 0): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

/**
 * Eight lowercase hex groups from sixteen bytes in network order, without
 * zero compression, so one address has one spelling. A v4-mapped address
 * (`::ffff:a.b.c.d`) reads as `a.b.c.d`.
 */
export function ipv6FromBytes(bytes: Uint8Array, offset = 0): string {
  let mapped = bytes[offset + 10] === 0xff && bytes[offset + 11] === 0xff;
  for (let index = 0; mapped && index < 10; index += 1) {
    if (bytes[offset + index] !== 0) mapped = false;
  }
  if (mapped) return ipv4FromBytes(bytes, offset + 12);
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(((bytes[offset + index] << 8) | bytes[offset + index + 1]).toString(16));
  }
  return groups.join(':');
}

function endpointKey(address: string, port: number): string {
  return `${address}|${port}`;
}

function addTo(map: Map<number, Set<number>>, key: number, value: number): void {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = new Set();
    map.set(key, bucket);
  }
  bucket.add(value);
}

/** Which of `listenerPids` own a listening socket, connected to or not. */
export function listeningPidsOf(rows: readonly SocketRow[], listenerPids: ReadonlySet<number>): number[] {
  const listening = new Set<number>();
  for (const row of rows) {
    if (row.state !== 'listen') continue;
    for (const pid of row.ownerPids) if (listenerPids.has(pid)) listening.add(pid);
  }
  return [...listening];
}

/**
 * Every server-side row of a connection to a port one of `listenerPids`
 * listens on, with the peer row when the table holds it. A reader uses this
 * to decide whether it must read any more processes' sockets.
 */
export function connectionsToListeners(rows: readonly SocketRow[], listenerPids: ReadonlySet<number>): ListenerConnection[] {
  const listenersByPort = new Map<number, Set<number>>();
  for (const row of rows) {
    if (row.state !== 'listen') continue;
    for (const pid of row.ownerPids) if (listenerPids.has(pid)) addTo(listenersByPort, row.localPort, pid);
  }
  if (listenersByPort.size === 0) return [];
  const established = new Map<string, SocketRow>();
  for (const row of rows) {
    if (row.state === 'established') {
      established.set(`${endpointKey(row.localAddress, row.localPort)}>${endpointKey(row.remoteAddress, row.remotePort)}`, row);
    }
  }
  const found: ListenerConnection[] = [];
  for (const row of rows) {
    if (row.state !== 'established') continue;
    const portListeners = listenersByPort.get(row.localPort);
    if (!portListeners) continue;
    // The accepted socket is the listener's own, or a child's that inherited
    // the listening handle (a cluster worker).
    const serverOwners = row.ownerPids.filter((pid) => listenerPids.has(pid));
    if (serverOwners.length === 0) continue;
    const peer = established.get(`${endpointKey(row.remoteAddress, row.remotePort)}>${endpointKey(row.localAddress, row.localPort)}`) ?? null;
    found.push({ server: row, listenerSide: [...new Set([...portListeners, ...serverOwners])], peer });
  }
  return found;
}

/**
 * The (listener, client) pairs among `listenerPids` and `clientPids`. Every
 * process on the listener side of a connection is paired with every owner of
 * its peer, so a listener whose worker accepted the connection is paired too.
 * A process connected to itself is not a pair.
 */
export function pairLocalConnections(
  rows: readonly SocketRow[],
  listenerPids: ReadonlySet<number>,
  clientPids: ReadonlySet<number>,
): LocalConnection[] {
  const pairs = new Map<string, LocalConnection>();
  for (const { listenerSide, peer } of connectionsToListeners(rows, listenerPids)) {
    if (!peer) continue;
    for (const clientPid of peer.ownerPids) {
      if (!clientPids.has(clientPid) || listenerSide.includes(clientPid)) continue;
      for (const listenerPid of listenerSide) pairs.set(`${listenerPid}>${clientPid}`, { listenerPid, clientPid });
    }
  }
  return [...pairs.values()];
}
