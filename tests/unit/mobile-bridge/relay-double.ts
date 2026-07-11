/**
 * A minimal in-repo stand-in for the real relay server, which now lives in
 * the separate `kangentic-relay` repo (https://github.com/Kangentic/kangentic-relay):
 * a "blind" WebSocket rendezvous that pairs up exactly two connections
 * presenting the same `?slot=` query param and forwards raw frames between
 * them byte-for-byte, reading nothing from the payload. This is the
 * simplest possible interpretation of relay-client.ts's own documented
 * wire contract, and is the closest to end-to-end this repo can exercise
 * without standing up the real relay - RelayClient's production code
 * (real Node global WebSocket) connects to this exactly as it would to a
 * real `kangentic-relay` instance.
 */
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';

export interface RelayDouble {
  url: string;
  close: () => Promise<void>;
}

export async function startRelayDouble(): Promise<RelayDouble> {
  const waitingBySlot = new Map<string, InstanceType<typeof NodeWebSocket>>();
  const wss = new WebSocketServer({ port: 0 });

  wss.on('connection', (socket, request) => {
    const slot = new URL(request.url ?? '', 'http://localhost').searchParams.get('slot');
    if (!slot) {
      socket.close();
      return;
    }
    const waiting = waitingBySlot.get(slot);
    if (!waiting || waiting.readyState !== NodeWebSocket.OPEN) {
      waitingBySlot.set(slot, socket);
      socket.on('close', () => {
        if (waitingBySlot.get(slot) === socket) waitingBySlot.delete(slot);
      });
      return;
    }
    waitingBySlot.delete(slot);
    socket.on('message', (data, isBinary) => {
      if (waiting.readyState === NodeWebSocket.OPEN) waiting.send(data, { binary: isBinary });
    });
    waiting.on('message', (data, isBinary) => {
      if (socket.readyState === NodeWebSocket.OPEN) socket.send(data, { binary: isBinary });
    });
  });

  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Relay double failed to bind a port');
  const url = `ws://127.0.0.1:${address.port}`;

  return {
    url,
    // wss.close() stops accepting new connections and shuts down the
    // internally-created HTTP server, but does NOT terminate existing
    // client sockets - do that explicitly so a test's sockets never
    // linger past the test.
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
