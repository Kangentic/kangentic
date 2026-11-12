/**
 * Which ports a server on an SSH host is listening on (#913), read from the kernel's tables. A dev
 * server's port is forwarded to this computer only once it appears here, so a row misread as listening
 * forwards a port with nothing behind it, and one missed leaves a server unreachable.
 *
 * The fixture rows are the kernel's own layout: the address as hex words in the host's byte order, the
 * port in hex after the colon, state `0A` for a listener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isReachableThroughLocalhost, parseListeningPorts, readListeningPorts } from '../../src/main/remote/helper/listening-ports';
import { RemoteLink } from '../../src/main/remote/link/remote-link';
import { dialHelper, makeHelperRig, settle } from './helpers/remote-link-rig';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const TAIL = '00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0';

const TCP = [
  HEADER,
  `   0: 0100007F:1C84 00000000:0000 0A ${TAIL}`, // 127.0.0.1:7300
  `   1: 00000000:0016 00000000:0000 0A ${TAIL}`, // 0.0.0.0:22
  `   2: 0100007F:1C85 0100007F:ABCD 01 ${TAIL}`, // 127.0.0.1:7301, established, not a listener
  `   3: 0500000A:1F90 00000000:0000 0A ${TAIL}`, // 10.0.0.5:8080, bound to one private address
  `   4: 0100007F:1C84 00000000:0000 0A ${TAIL}`, // the same port twice
].join('\n');

const TCP6 = [
  HEADER,
  `   0: 00000000000000000000000001000000:1C86 00000000000000000000000000000000:0000 0A ${TAIL}`, // [::1]:7302
  `   1: 00000000000000000000000000000000:1C87 00000000000000000000000000000000:0000 0A ${TAIL}`, // [::]:7303
  `   2: 0000000000000000FFFF00000100007F:1C88 00000000000000000000000000000000:0000 0A ${TAIL}`, // [::ffff:127.0.0.1]:7304
  `   3: B80D0120000000000000000001000000:1C89 00000000000000000000000000000000:0000 0A ${TAIL}`, // [2001:db8::1]:7305
].join('\n');

describe('reading a kernel table', () => {
  it('keeps listeners on loopback or the wildcard address in either family, once each', () => {
    expect(parseListeningPorts(TCP).sort((a, b) => a - b)).toEqual([22, 7300]);
    expect(parseListeningPorts(TCP6).sort((a, b) => a - b)).toEqual([7302, 7303, 7304]);
  });

  it('skips a malformed row instead of guessing', () => {
    expect(parseListeningPorts(`${HEADER}\n   0: garbage\n   1: 0100007F:ZZZZ 00000000:0000 0A ${TAIL}\n\n`)).toEqual([]);
  });

  it('knows which addresses localhost on the host reaches', () => {
    expect(isReachableThroughLocalhost('0100007F')).toBe(true);
    expect(isReachableThroughLocalhost('0200007F')).toBe(true);
    expect(isReachableThroughLocalhost('00000000')).toBe(true);
    expect(isReachableThroughLocalhost('0500000A')).toBe(false);
    expect(isReachableThroughLocalhost('00000000000000000000000001000000')).toBe(true);
    expect(isReachableThroughLocalhost('B80D0120000000000000000001000000')).toBe(false);
    expect(isReachableThroughLocalhost('not hex')).toBe(false);
  });
});

describe('reading the host\'s tables', () => {
  let proc: string;

  beforeEach(() => {
    proc = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-proc-'));
    fs.mkdirSync(path.join(proc, 'net'));
  });

  afterEach(() => {
    fs.rmSync(proc, { recursive: true, force: true });
  });

  it('merges both families, sorted', async () => {
    fs.writeFileSync(path.join(proc, 'net', 'tcp'), TCP);
    fs.writeFileSync(path.join(proc, 'net', 'tcp6'), TCP6);
    expect(await readListeningPorts(proc)).toEqual([22, 7300, 7302, 7303, 7304]);
  });

  it('accepts a host with IPv6 off, which has no tcp6 table', async () => {
    fs.writeFileSync(path.join(proc, 'net', 'tcp'), TCP);
    expect(await readListeningPorts(proc)).toEqual([22, 7300]);
  });

  it('fails, rather than answering "nothing is listening", when the IPv4 table cannot be read', async () => {
    await expect(readListeningPorts(proc)).rejects.toThrow();
  });
});

describe('the helper\'s listeningPorts request', () => {
  const teardown: Array<() => void> = [];
  let proc: string;

  beforeEach(() => {
    vi.useFakeTimers();
    proc = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-proc-'));
    fs.mkdirSync(path.join(proc, 'net'));
  });

  afterEach(() => {
    for (const undo of teardown.splice(0)) undo();
    vi.useRealTimers();
    fs.rmSync(proc, { recursive: true, force: true });
  });

  function connect(): RemoteLink {
    const helperRig = makeHelperRig(1, { homeDirectory: proc, baseEnv: { HOME: '/home/dev', SHELL: '/bin/sh', PATH: '/usr/bin' }, procDirectory: proc });
    const link = new RemoteLink({
      identity: { installId: 'install-a', bootId: 'boot-1', label: 'a test computer' },
      connect: async () => dialHelper(helperRig),
      reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
    });
    link.start();
    teardown.push(() => link.stop(), () => helperRig.helper.dispose());
    return link;
  }

  it('answers with the ports and carries a failed read back as an error', async () => {
    const link = connect();
    fs.writeFileSync(path.join(proc, 'net', 'tcp'), TCP);
    const answer = link.requestHelper('listeningPorts', {});
    await settle();
    expect(await answer).toEqual({ ports: [22, 7300] });

    fs.rmSync(path.join(proc, 'net', 'tcp'));
    const failed = link.requestHelper('listeningPorts', {});
    const outcome = failed.then(() => 'answered', () => 'failed');
    await settle();
    expect(await outcome).toBe('failed');
  });
});
