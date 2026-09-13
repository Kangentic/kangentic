type Listener = (event: MessageEvent) => void;

/**
 * The live-updates socket for the dashboard. Opens once; a dropped connection is reported to
 * the listeners and never reopened, which is the gap the reconnection work closes.
 */
export class LiveUpdates {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly url: string) {}

  connect(): void {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      this.listeners.forEach((listener) => listener(event));
    });
    this.socket.addEventListener('close', () => {
      this.socket = null;
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Live updates are not connected');
    }
    this.socket.send(JSON.stringify(payload));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
