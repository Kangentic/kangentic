/**
 * Pairing local TCP clients with the listeners they are connected to
 * (src/main/pty/process-tag/local-connections.ts), from socket rows shaped
 * like each platform's table. The real reads are in
 * tests/unit/task-process-readers.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  connectionsToListeners,
  ipv4FromBytes,
  ipv6FromBytes,
  listeningPidsOf,
  pairLocalConnections,
  type SocketRow,
} from '../../src/main/pty/process-tag/local-connections';

function row(state: SocketRow['state'], local: string, localPort: number, remote: string, remotePort: number, ownerPids: number[]): SocketRow {
  return { state, localAddress: local, localPort, remoteAddress: remote, remotePort, ownerPids };
}

/** One loopback connection: the server's accepted socket and the client's end. */
function connection(server: number, client: number, port: number, clientPort: number, address = '127.0.0.1'): SocketRow[] {
  return [
    row('established', address, port, address, clientPort, [server]),
    row('established', address, clientPort, address, port, [client]),
  ];
}

const all = (...pids: number[]) => new Set(pids);

describe('address forms', () => {
  it('reads IPv4 from network-order bytes, IPv6 as eight uncompressed groups, and a v4-mapped address as its IPv4 form', () => {
    expect(ipv4FromBytes(Uint8Array.from([127, 0, 0, 1]))).toBe('127.0.0.1');
    const loopback6 = new Uint8Array(16);
    loopback6[15] = 1;
    expect(ipv6FromBytes(loopback6)).toBe('0:0:0:0:0:0:0:1');
    const mapped = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1]);
    expect(ipv6FromBytes(mapped)).toBe('127.0.0.1');
    // Not mapped: a nonzero byte in the prefix.
    const notMapped = Uint8Array.from([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1]);
    expect(ipv6FromBytes(notMapped)).toBe('fe80:0:0:0:0:ffff:7f00:1');
  });
});

describe('pairLocalConnections', () => {
  it('pairs a client with the listener through the socket the listener accepted', () => {
    const rows = [row('listen', '0.0.0.0', 5037, '0.0.0.0', 0, [2001]), ...connection(2001, 3001, 5037, 52000)];
    expect(pairLocalConnections(rows, all(2001), all(3001))).toEqual([{ listenerPid: 2001, clientPid: 3001 }]);
  });

  it('pairs over IPv6, and an IPv4 client of a dual-stack listener whose accepted socket is filed in the IPv6 table', () => {
    const loopback6 = '0:0:0:0:0:0:0:1';
    const ipv6 = [row('listen', '0:0:0:0:0:0:0:0', 8080, '0:0:0:0:0:0:0:0', 0, [2001]), ...connection(2001, 3001, 8080, 52001, loopback6)];
    expect(pairLocalConnections(ipv6, all(2001), all(3001))).toEqual([{ listenerPid: 2001, clientPid: 3001 }]);
    // Linux: the server side reads `::ffff:127.0.0.1` in tcp6, already in its v4 form; the client end is in tcp.
    const dualStack = [
      row('listen', '0:0:0:0:0:0:0:0', 8080, '0:0:0:0:0:0:0:0', 0, [2001]),
      row('established', '127.0.0.1', 8080, '127.0.0.1', 52002, [2001]),
      row('established', '127.0.0.1', 52002, '127.0.0.1', 8080, [3001]),
    ];
    expect(pairLocalConnections(dualStack, all(2001), all(3001))).toEqual([{ listenerPid: 2001, clientPid: 3001 }]);
  });

  it('pairs the listener and the worker that accepted the connection, and every owner of a shared socket', () => {
    // A cluster: 2001 listens, its worker 2002 holds the accepted socket.
    const cluster = [
      row('listen', '0.0.0.0', 3000, '0.0.0.0', 0, [2001]),
      row('established', '127.0.0.1', 3000, '127.0.0.1', 52003, [2002]),
      row('established', '127.0.0.1', 52003, '127.0.0.1', 3000, [3001]),
    ];
    expect(pairLocalConnections(cluster, all(2001, 2002), all(3001))).toEqual([
      { listenerPid: 2001, clientPid: 3001 },
      { listenerPid: 2002, clientPid: 3001 },
    ]);
    // Linux: one client inode in two processes' fd tables.
    const sharedInode = [row('listen', '0.0.0.0', 3000, '0.0.0.0', 0, [2001]), ...connection(2001, 3001, 3000, 52004)];
    sharedInode[2] = { ...sharedInode[2], ownerPids: [3001, 3002] };
    expect(pairLocalConnections(sharedInode, all(2001), all(3001, 3002))).toEqual([
      { listenerPid: 2001, clientPid: 3001 },
      { listenerPid: 2001, clientPid: 3002 },
    ]);
  });

  it('pairs one listener with each of several clients, and only clients the caller named', () => {
    const rows = [
      row('listen', '127.0.0.1', 5037, '0.0.0.0', 0, [2001]),
      ...connection(2001, 3001, 5037, 52005),
      ...connection(2001, 3002, 5037, 52006),
    ];
    expect(pairLocalConnections(rows, all(2001), all(3001, 3002))).toEqual([
      { listenerPid: 2001, clientPid: 3001 },
      { listenerPid: 2001, clientPid: 3002 },
    ]);
    expect(pairLocalConnections(rows, all(2001), all(3002))).toEqual([{ listenerPid: 2001, clientPid: 3002 }]);
  });

  it('pairs nothing for a client on another host, a listener not asked about, a process connected to itself, or a socket in another state', () => {
    // A remote client: the server's accepted socket has no local peer row.
    const remote = [row('listen', '0.0.0.0', 8080, '0.0.0.0', 0, [2001]), row('established', '192.168.1.5', 8080, '192.168.1.9', 52007, [2001])];
    expect(pairLocalConnections(remote, all(2001), all(3001))).toEqual([]);
    expect(connectionsToListeners(remote, all(2001))).toEqual([{ server: remote[1], listenerSide: [2001], peer: null }]);
    const local = [row('listen', '0.0.0.0', 5037, '0.0.0.0', 0, [2001]), ...connection(2001, 3001, 5037, 52008)];
    expect(pairLocalConnections(local, all(4001), all(3001))).toEqual([]);
    // qemu connects to its own port (measured).
    const self = [row('listen', '127.0.0.1', 8554, '0.0.0.0', 0, [2011]), ...connection(2011, 2011, 8554, 65393)];
    expect(pairLocalConnections(self, all(2011), all(2011))).toEqual([]);
    const closing = [row('listen', '0.0.0.0', 5037, '0.0.0.0', 0, [2001]), row('other', '127.0.0.1', 5037, '127.0.0.1', 52009, [2001]), row('other', '127.0.0.1', 52009, '127.0.0.1', 5037, [3001])];
    expect(pairLocalConnections(closing, all(2001), all(3001))).toEqual([]);
  });

  it('never reads a client end as a server end: the client\'s own port is not one the listener listens on', () => {
    // 3001 is asked about as a listener too, but listens on nothing.
    const rows = [row('listen', '0.0.0.0', 5037, '0.0.0.0', 0, [2001]), ...connection(2001, 3001, 5037, 52010)];
    expect(pairLocalConnections(rows, all(2001, 3001), all(2001, 3001))).toEqual([{ listenerPid: 2001, clientPid: 3001 }]);
  });
});

describe('listeningPidsOf', () => {
  it('names the processes asked about that hold a listening socket, connected to or not', () => {
    const rows = [
      row('listen', '127.0.0.1', 5037, '0.0.0.0', 0, [2001]),
      row('listen', '0:0:0:0:0:0:0:1', 5037, '0:0:0:0:0:0:0:0', 0, [2001]),
      row('listen', '127.0.0.1', 5173, '0.0.0.0', 0, [2002]),
      row('listen', '127.0.0.1', 9000, '0.0.0.0', 0, [4001]),
      ...connection(2001, 3001, 5037, 52011),
    ];
    expect(listeningPidsOf(rows, all(2001, 2002, 3001))).toEqual([2001, 2002]);
  });
});
