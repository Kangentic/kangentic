/**
 * A push the preload hears before the renderer has subscribed to it.
 *
 * An `ipcRenderer.on` registered inside an `on*` method exists only once React
 * has mounted the component that calls it, and a message main sends before
 * then reaches no listener and is gone. A push that main may send while the
 * page is still booting registers here at preload time instead: what arrives
 * with no subscriber waits, and the first subscriber takes it.
 */

export interface BufferedPush<Payload extends unknown[]> {
  /** Hand one message to every subscriber, or keep it until one arrives. */
  deliver(...payload: Payload): void;
  /** Take what waited, then every later message, until the returned function runs. */
  subscribe(callback: (...payload: Payload) => void): () => void;
}

export function createBufferedPush<Payload extends unknown[]>(): BufferedPush<Payload> {
  const waiting: Payload[] = [];
  const subscribers = new Set<(...payload: Payload) => void>();
  return {
    deliver: (...payload) => {
      if (subscribers.size === 0) {
        waiting.push(payload);
        return;
      }
      for (const callback of [...subscribers]) callback(...payload);
    },
    subscribe: (callback) => {
      subscribers.add(callback);
      for (const payload of waiting.splice(0)) callback(...payload);
      return () => { subscribers.delete(callback); };
    },
  };
}
